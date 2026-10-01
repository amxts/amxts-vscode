/**
 * The extension: keeps the index of names the workspace registers up to date
 * as files are typed and saved, and gives menu files completion, checks,
 * hover, go to definition, references and quick fixes. Everything it knows
 * comes from `core/`, which has no editor in it.
 */
import { existsSync, promises as fs, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as vscode from "vscode";
import { analyze, Analysis, Format, formatOf, NameUse, Problem } from "./core/analyze";
import { checkConfig, ConfigAnalysis, loadsOf, namesakeMessage, namesakes } from "./core/config-check";
import { configCompletions, configContextAt, configDefinition, configHover } from "./core/config-features";
import { ConfigLoad, scanConfigLoads, SourcePlace } from "./core/config-scan";
import { contextAt } from "./core/context";
import { menuFileFormat } from "./core/detect";
import { lineOf, lineStartsOf } from "./core/ini";
import { completions, Describe, hoverOf, Item, menuAt, registrationsOf, shownMenu, useAt } from "./core/features";
import { checkLines, checkNames, Registration, Registry } from "./core/registry";
import { menuFilesOfConfig } from "./core/scan-ts";
import { findMenuCandidates, findSources, isSource, scanSource } from "./core/workspace";

const SOURCE_EXTENSIONS = /\.(?:ts|sma)$/i;
const MENU_SELECTOR: vscode.DocumentSelector = [
	{ language: "ini" },
	{ language: "yaml" },
	{ language: "json" },
	{ language: "jsonc" },
	{ scheme: "file", pattern: "**/*.{ini,yaml,yml,json,jsonc}" },
	{ scheme: "untitled", pattern: "**/*.{ini,yaml,yml,json,jsonc}" },
];
const SOURCE_SELECTOR: vscode.DocumentSelector = [{ language: "typescript" }, { scheme: "file", pattern: "**/*.sma" }];

function settings() {
	const config = vscode.workspace.getConfiguration("amxts");
	return {
		files: config.get<string[]>("menus.files", []),
		detectByContent: config.get<boolean>("menus.detectByContent", true),
		excludeFolders: config.get<string[]>("index.excludeFolders", [".git", "node_modules", "dist", ".amxts", "test", "tests"]),
		unknownNames: config.get<boolean>("diagnostics.unknownNames", true),
	};
}

/** Debounces by key: the last call of a key runs after `wait` ms. */
function debouncer(wait: number) {
	const timers = new Map<string, NodeJS.Timeout>();
	const run = (key: string, action: () => void) => {
		clearTimeout(timers.get(key));
		timers.set(
			key,
			setTimeout(() => {
				timers.delete(key);
				action();
			}, wait),
		);
	};
	run.dispose = () => timers.forEach(timer => clearTimeout(timer));
	return run;
}

class Extension {
	registry = new Registry();
	diagnostics = vscode.languages.createDiagnosticCollection("amxts");
	output = vscode.window.createOutputChannel("amxts");
	/** The menu files each workspace folder's amxts.config.ts names. */
	configNames = new Map<string, string[]>();
	/** Each document's analysis by its version: null for one that is no menu file. */
	analyses = new Map<string, { version: number; found: { format: Format; analysis: Analysis } | null }>();
	published = new Map<string, Published>();
	debounce = debouncer(150);
	recheckSoon = debouncer(300);
	ready: Promise<void> = Promise.resolve();
	/** The folders no source is read from: the setting's, and node_modules. */
	excluded = new Set<string>();

	constructor(private context: vscode.ExtensionContext) {}

	// ------------------------------------------------------------ the index

	/** Whether a source file's registrations are read: not in an excluded folder, or a module's sources. */
	isIndexed(path: string) {
		if (!isSource(path)) return false;
		const normal = path.replaceAll("\\", "/");
		if (/\/node_modules\/@amxts\/[^/]+\/src\//.test(normal)) return !normal.includes("/node_modules/@amxts/core/");
		const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(path));
		const relative = folder != null ? normal.slice(folder.uri.fsPath.replaceAll("\\", "/").length) : normal;
		return !relative.split("/").some(part => this.excluded.has(part));
	}

	indexText(path: string, text: string) {
		if (!this.isIndexed(path)) return;
		this.indexConfigLoads(path, text);
		let found: Registration[] = [];
		try {
			found = scanSource(path, text);
		} catch (error) {
			this.output.appendLine(`${path}: ${error}`);
		}
		if (this.registry.set(path, found)) this.recheckSoon("all", () => this.recheckAll());
	}

	async indexDisk(path: string) {
		const open = openDocument(path);
		if (open != null) return this.indexText(path, open.getText());
		try {
			this.indexText(path, await fs.readFile(path, "utf8"));
		} catch {
			this.forgetConfigLoads(path);
			if (this.registry.delete(path)) this.recheckSoon("all", () => this.recheckAll());
		}
	}

	async readConfig(folder: string) {
		const file = join(folder, "amxts.config.ts");
		const open = openDocument(file);
		let text: string | null = open?.getText() ?? null;
		if (text == null && existsSync(file)) text = await fs.readFile(file, "utf8").catch(() => null);
		this.configNames.set(folder, text != null ? menuFilesOfConfig(text) : ["menu"]);
		// Which files are menu files may have changed with the names.
		this.analyses.clear();
	}

	async indexAll() {
		const started = Date.now();
		this.excluded = new Set([...settings().excludeFolders, "node_modules"]);
		const folders = vscode.workspace.workspaceFolders ?? [];
		for (const folder of folders) {
			await this.readConfig(folder.uri.fsPath);
			const sources = await findSources(folder.uri.fsPath, settings().excludeFolders);
			for (const path of sources) await this.indexDisk(path);
		}
		const all = this.registry.all();
		this.output.appendLine(`indexed ${all.length} registrations in ${Date.now() - started} ms: ${["condition", "action", "restriction", "placeholder", "filter", "menu"].map(kind => `${all.filter(each => each.kind == kind).length} ${kind}`).join(", ")}`);
		this.recheckAll();
	}

	// ------------------------------------------------------------ menu files

	names(uri: vscode.Uri) {
		const folder = vscode.workspace.getWorkspaceFolder(uri);
		const fromConfig = folder != null ? this.configNames.get(folder.uri.fsPath) ?? ["menu"] : [...new Set([...this.configNames.values()].flat().concat(["menu"]))];
		return fromConfig.concat(settings().files);
	}

	formatOf(document: vscode.TextDocument) {
		if (document.uri.scheme != "file" && document.uri.scheme != "untitled") return null;
		const path = document.uri.scheme == "file" ? document.uri.fsPath : document.fileName;
		return menuFileFormat(path, document.getText(), { names: this.names(document.uri), detectByContent: settings().detectByContent });
	}

	analysisOf(document: vscode.TextDocument) {
		const key = document.uri.toString();
		const cached = this.analyses.get(key);
		if (cached != null && cached.version == document.version) return cached.found;
		const format = this.formatOf(document);
		const found = format == null ? null : { format, analysis: analyze(document.getText(), format) };
		this.analyses.set(key, { version: document.version, found });
		return found;
	}

	check(document: vscode.TextDocument) {
		const found = this.analysisOf(document);
		const key = document.uri.toString();
		if (found == null) {
			this.diagnostics.delete(document.uri);
			this.published.delete(key);
			return;
		}
		const { analysis } = found;
		this.acceptComments(document, found.format);
		const unknown = settings().unknownNames ? checkNames(this.registry, analysis.uses, analysis.menus) : [];
		const entries = published(document, analysis.problems.concat(unknown, checkLines(analysis.uses)));
		this.published.set(key, entries);
		this.diagnostics.set(document.uri, entries.map(entry => entry.diagnostic));
	}

	/**
	 * A `.json` menu file is JSON with comments to Config Core: it is opened as
	 * JSONC, so VS Code's JSON support accepts comments and trailing commas.
	 */
	acceptComments(document: vscode.TextDocument, format: Format) {
		if (format != "json" || document.languageId != "json") return;
		void vscode.languages.setTextDocumentLanguage(document, "jsonc");
	}

	recheckAll() {
		for (const document of vscode.workspace.textDocuments) this.check(document);
	}

	/** Whether the editor's own JSON or YAML support has the schema for this file - then it offers the keys. */
	schemaCovers(document: vscode.TextDocument, format: Format) {
		const name = document.fileName.replaceAll("\\", "/").split("/").pop()!.toLowerCase();
		if (format == "json") return name == "menu.json" || name == "menu.jsonc";
		if (format == "yaml") return (name == "menu.yaml" || name == "menu.yml") && vscode.extensions.getExtension("redhat.vscode-yaml") != null;
		return false;
	}

	// ------------------------------------------------------------ features

	describe: Describe = (registration) => {
		const normal = registration.file.replaceAll("\\", "/");
		const module = /\/node_modules\/(@amxts\/[^/]+\/.*)$/.exec(normal);
		const where = module != null ? module[1] : vscode.workspace.asRelativePath(registration.file);
		return `${where}:${registration.line + 1}`;
	};

	location(registration: Registration) {
		return new vscode.Location(vscode.Uri.file(registration.file), new vscode.Range(registration.line, registration.column, registration.line, registration.endColumn));
	}

	completionItem(item: Item, document: vscode.TextDocument) {
		const kinds: Record<Item["kind"], vscode.CompletionItemKind> = {
			key: vscode.CompletionItemKind.Property,
			condition: vscode.CompletionItemKind.Function,
			action: vscode.CompletionItemKind.Event,
			restriction: vscode.CompletionItemKind.Interface,
			requirement: vscode.CompletionItemKind.Function,
			placeholder: vscode.CompletionItemKind.Variable,
			menu: vscode.CompletionItemKind.Module,
			value: vscode.CompletionItemKind.Value,
			builtin: vscode.CompletionItemKind.Constant,
		};
		const completion = new vscode.CompletionItem(item.label, kinds[item.kind]);
		completion.insertText = item.insertText;
		completion.range = new vscode.Range(document.positionAt(item.start), document.positionAt(item.end));
		completion.detail = item.detail;
		if (item.documentation) completion.documentation = new vscode.MarkdownString(item.documentation);
		completion.sortText = item.sortText;
		if (item.filterText) completion.filterText = item.filterText;
		if (item.kind == "key" && item.insertText.endsWith(" ")) completion.command = { title: "Suggest", command: "editor.action.triggerSuggest" };
		return completion;
	}

	provideCompletion(document: vscode.TextDocument, position: vscode.Position) {
		const found = this.analysisOf(document);
		if (found == null) return undefined;
		const context = contextAt(document.getText(), document.offsetAt(position), found.format);
		if (context == null) return undefined;
		if (context.type == "key" && this.schemaCovers(document, found.format)) return undefined;
		return completions(context, this.registry, found.analysis.menus, this.describe).map(item => this.completionItem(item, document));
	}

	provideHover(document: vscode.TextDocument, position: vscode.Position) {
		const found = this.analysisOf(document);
		if (found == null) return undefined;
		const offset = document.offsetAt(position);
		const range = (start: number, end: number) => new vscode.Range(document.positionAt(start), document.positionAt(end));
		const use = useAt(found.analysis, offset);
		if (use != null) return new vscode.Hover(new vscode.MarkdownString(hoverOf(use, this.registry, found.analysis.menus, this.describe)), range(use.start, use.end));
		const hint = found.analysis.hints.find(each => each.start <= offset && offset <= each.end);
		if (hint != null && !this.schemaCovers(document, found.format)) return new vscode.Hover(new vscode.MarkdownString(hint.markdown), range(hint.start, hint.end));
		const menu = menuAt(found.analysis, offset);
		if (menu != null) {
			const words = menu.read ? `**Menu** \`${menu.name}\` - \`SHOW_${menu.name}\` opens it.` : `**Menu** \`${menu.name}\` - without a title it is not read as a menu.`;
			return new vscode.Hover(new vscode.MarkdownString(words), range(menu.start, menu.end));
		}
		return undefined;
	}

	provideDefinition(document: vscode.TextDocument, position: vscode.Position) {
		const found = this.analysisOf(document);
		if (found == null) return undefined;
		const use = useAt(found.analysis, document.offsetAt(position));
		if (use == null) return undefined;
		const locations = registrationsOf(use, this.registry).map(each => this.location(each));
		if (use.kind == "action" && use.name.startsWith("SHOW_")) {
			const menu = found.analysis.menus.find(each => each.name == use.name.slice(5) && each.read);
			if (menu != null) locations.unshift(new vscode.Location(document.uri, new vscode.Range(document.positionAt(menu.start), document.positionAt(menu.end))));
		}
		return locations;
	}

	/** Every menu file of the workspace, open ones as they are typed, with what it uses. */
	async menuFiles() {
		const files: { uri: vscode.Uri; text: string; analysis: Analysis; document?: vscode.TextDocument }[] = [];
		const seen = new Set<string>();
		for (const document of vscode.workspace.textDocuments) {
			const found = this.analysisOf(document);
			if (found == null) continue;
			seen.add(document.uri.fsPath);
			files.push({ uri: document.uri, text: document.getText(), analysis: found.analysis, document });
		}
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			for (const path of await findMenuCandidates(folder.uri.fsPath, settings().excludeFolders)) {
				if (seen.has(path)) continue;
				const text = await fs.readFile(path, "utf8").catch(() => "");
				const format = menuFileFormat(path, text, { names: this.names(vscode.Uri.file(path)), detectByContent: settings().detectByContent });
				if (format != null) files.push({ uri: vscode.Uri.file(path), text, analysis: analyze(text, format) });
			}
		}
		return files;
	}

	/** The uses of a name in every menu file, and its registrations. */
	async referencesTo(target: { kind: NameUse["kind"]; name: string } | { menu: string }, includeDeclaration: boolean) {
		const locations: vscode.Location[] = [];
		const folded = "kind" in target && (target.kind == "condition" || target.kind == "restriction" || target.kind == "requirement");
		const matches = (use: NameUse) => {
			if ("menu" in target) return use.kind == "action" && use.name == `SHOW_${target.menu}`;
			if (folded) return (use.kind == "condition" || use.kind == "restriction" || use.kind == "requirement") && use.name.toUpperCase() == target.name.toUpperCase();
			return use.kind == target.kind && use.name == target.name;
		};
		for (const file of await this.menuFiles()) {
			const starts = file.document == null ? lineStartsOf(file.text) : [];
			const positionAt = (offset: number) => (file.document != null ? file.document.positionAt(offset) : positionIn(starts, offset));
			for (const use of file.analysis.uses.filter(matches)) locations.push(new vscode.Location(file.uri, new vscode.Range(positionAt(use.start), positionAt(use.end))));
			if (includeDeclaration && "menu" in target) {
				for (const menu of file.analysis.menus.filter(each => each.name == target.menu)) locations.push(new vscode.Location(file.uri, new vscode.Range(positionAt(menu.start), positionAt(menu.end))));
			}
		}
		if (includeDeclaration) {
			const registrations = "menu" in target ? this.registry.find("menu", target.menu) : registrationsOf({ kind: target.kind, name: target.name, menu: "" }, this.registry);
			locations.push(...registrations.map(each => this.location(each)));
		}
		return locations;
	}

	async provideMenuReferences(document: vscode.TextDocument, position: vscode.Position, context: vscode.ReferenceContext) {
		const found = this.analysisOf(document);
		if (found == null) return undefined;
		const offset = document.offsetAt(position);
		const use = useAt(found.analysis, offset);
		const shown = use != null ? shownMenu(use, this.registry) : null;
		if (shown != null) return this.referencesTo({ menu: shown }, context.includeDeclaration);
		if (use != null) return this.referencesTo(use, context.includeDeclaration);
		const menu = menuAt(found.analysis, offset);
		if (menu != null) return this.referencesTo({ menu: menu.name }, context.includeDeclaration);
		return undefined;
	}

	/** In a plugin: the uses, in menu files, of the name registered at the cursor. */
	async provideSourceReferences(document: vscode.TextDocument, position: vscode.Position, context: vscode.ReferenceContext) {
		const registration = this.registry
			.all()
			.find(each => each.file == document.uri.fsPath && each.line == position.line && each.column <= position.character && position.character <= each.endColumn);
		if (registration == null || registration.kind == "filter") return undefined;
		if (registration.kind == "menu") return this.referencesTo({ menu: registration.name }, context.includeDeclaration);
		return this.referencesTo({ kind: registration.kind, name: registration.name }, context.includeDeclaration);
	}

	provideCodeActions(document: vscode.TextDocument, context: vscode.CodeActionContext) {
		return quickFixes(document, this.published.get(document.uri.toString()) ?? [], context);
	}

	// ------------------------------------------------------------ config files

	/** The typed `configs.load(name, defaults)` calls of each source file. */
	configLoads = new Map<string, ConfigLoad[]>();
	/** Counts the changes of the loads: an analysis made before one is stale. */
	configRevision = 0;
	configAnalyses = new Map<string, { version: number; revision: number; load: ConfigLoad; analysis: ConfigAnalysis }>();
	configPublished = new Map<string, Published>();
	configDiagnostics = vscode.languages.createDiagnosticCollection("amxts-configs");

	/** A type imported from another file: an open document's text, or the file's. */
	readImport = (from: string, spec: string) => {
		if (!spec.startsWith(".")) return null;
		const base = join(dirname(from), spec);
		for (const path of [`${base}.ts`, join(base, "index.ts"), base]) {
			const open = openDocument(path);
			if (open != null) return { path, text: open.getText() };
			try {
				if (existsSync(path) && path.endsWith(".ts")) return { path, text: readFileSync(path, "utf8") };
			} catch {
				// unreadable: the type stays unknown
			}
		}
		return null;
	};

	/** Reads the typed loads of a source file, and again those of the files whose types it holds. */
	indexConfigLoads(path: string, text: string) {
		let changed = this.scanConfigLoads(path, text);
		const dependents = [...this.configLoads].filter(([other, loads]) => other != path && loads.some(load => load.dependencies.includes(path)));
		for (const [other] of dependents) {
			const open = openDocument(other);
			try {
				if (this.scanConfigLoads(other, open?.getText() ?? readFileSync(other, "utf8"))) changed = true;
			} catch {
				// gone: its loads are forgotten when the watcher says so
			}
		}
		if (changed) this.recheckSoon("configs", () => this.recheckConfigFiles());
	}

	/** Whether the loads of a file changed. */
	scanConfigLoads(path: string, text: string) {
		let found: ConfigLoad[] = [];
		try {
			found = scanConfigLoads(path, text, this.readImport);
		} catch (error) {
			this.output.appendLine(`${path}: ${error}`);
		}
		const before = this.configLoads.get(path) ?? [];
		if (JSON.stringify(before) == JSON.stringify(found)) return false;
		if (found.length > 0) this.configLoads.set(path, found);
		else this.configLoads.delete(path);
		this.configRevision++;
		return true;
	}

	forgetConfigLoads(path: string) {
		if (!this.configLoads.delete(path)) return;
		this.configRevision++;
		this.recheckSoon("configs", () => this.recheckConfigFiles());
	}

	/** The load that reads a document - null for a file no plugin loads, and for a menu file. */
	configLoadOf(document: vscode.TextDocument) {
		if (document.uri.scheme != "file" || formatOf(document.uri.fsPath) == null) return null;
		const loads = loadsOf(document.uri.fsPath, [...this.configLoads.values()].flat());
		if (loads.length == 0 || this.analysisOf(document) != null) return null;
		return loads[0];
	}

	configAnalysisOf(document: vscode.TextDocument) {
		const key = document.uri.toString();
		const cached = this.configAnalyses.get(key);
		if (cached != null && cached.version == document.version && cached.revision == this.configRevision) return cached;
		const load = this.configLoadOf(document);
		const format = formatOf(document.uri.fsPath);
		if (load == null || format == null) {
			this.configAnalyses.delete(key);
			return null;
		}
		const analysis = checkConfig(document.getText(), format, load.shape);
		const path = document.uri.fsPath;
		const unread = namesakeMessage(path, namesakes(path, load.name, existsSync));
		// Config Core reads another file of that name: what this one says does not count.
		if (unread.length > 0) analysis.problems = [{ start: 0, end: Math.max(document.getText().indexOf("\n"), 1), message: unread, severity: "warning", code: "shape" }];
		const fresh = { version: document.version, revision: this.configRevision, load, analysis };
		this.configAnalyses.set(key, fresh);
		return fresh;
	}

	checkConfigFile(document: vscode.TextDocument) {
		const key = document.uri.toString();
		const found = this.configAnalysisOf(document);
		if (found == null) {
			// Only what was published here is taken back: the menu files' diagnostics are another collection's.
			if (this.configPublished.delete(key)) this.configDiagnostics.delete(document.uri);
			return;
		}
		const entries = published(document, found.analysis.problems);
		this.configPublished.set(key, entries);
		this.configDiagnostics.set(document.uri, entries.map(entry => entry.diagnostic));
	}

	recheckConfigFiles() {
		for (const document of vscode.workspace.textDocuments) this.checkConfigFile(document);
	}

	forgetConfigFile(uri: vscode.Uri) {
		this.configAnalyses.delete(uri.toString());
		if (this.configPublished.delete(uri.toString())) this.configDiagnostics.delete(uri);
	}

	describePlace = (place: SourcePlace) => `${vscode.workspace.asRelativePath(place.file)}:${place.line + 1}`;

	provideConfigCompletion(document: vscode.TextDocument, position: vscode.Position) {
		const found = this.configAnalysisOf(document);
		if (found == null) return undefined;
		const context = configContextAt(document.getText(), document.offsetAt(position), found.analysis.format);
		if (context == null) return undefined;
		return configCompletions(context, found.load).map(item => this.completionItem(item, document));
	}

	provideConfigHover(document: vscode.TextDocument, position: vscode.Position) {
		const found = this.configAnalysisOf(document);
		if (found == null) return undefined;
		const hover = configHover(found.analysis, document.offsetAt(position), found.load, this.describePlace);
		if (hover == null) return undefined;
		return new vscode.Hover(new vscode.MarkdownString(hover.markdown), new vscode.Range(document.positionAt(hover.start), document.positionAt(hover.end)));
	}

	provideConfigDefinition(document: vscode.TextDocument, position: vscode.Position) {
		const found = this.configAnalysisOf(document);
		if (found == null) return undefined;
		return configDefinition(found.analysis, document.offsetAt(position)).map(place => new vscode.Location(vscode.Uri.file(place.file), new vscode.Range(place.line, place.column, place.line, place.endColumn)));
	}

	provideConfigCodeActions(document: vscode.TextDocument, context: vscode.CodeActionContext) {
		return quickFixes(document, this.configPublished.get(document.uri.toString()) ?? [], context);
	}

	/** The providers of config files: after the menu files' own, which answer nothing for them. */
	startConfigs(subscriptions: vscode.Disposable[]) {
		subscriptions.push(
			this.configDiagnostics,
			vscode.languages.registerCompletionItemProvider(MENU_SELECTOR, { provideCompletionItems: (document, position) => this.provideConfigCompletion(document, position) }, "\"", " ", "[", "-"),
			vscode.languages.registerHoverProvider(MENU_SELECTOR, { provideHover: (document, position) => this.provideConfigHover(document, position) }),
			vscode.languages.registerDefinitionProvider(MENU_SELECTOR, { provideDefinition: (document, position) => this.provideConfigDefinition(document, position) }),
			vscode.languages.registerCodeActionsProvider(MENU_SELECTOR, { provideCodeActions: (document, _range, context) => this.provideConfigCodeActions(document, context) }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
		);
	}

	// ------------------------------------------------------------ wiring

	onDocument(document: vscode.TextDocument) {
		const path = document.uri.fsPath;
		if (document.uri.scheme == "file" && SOURCE_EXTENSIONS.test(path)) {
			if (path.replaceAll("\\", "/").endsWith("/amxts.config.ts")) this.readConfig(dirname(path)).then(() => this.recheckAll());
			this.debounce(`source:${path}`, () => this.indexText(path, document.getText()));
			return;
		}
		this.debounce(`menu:${document.uri}`, () => this.check(document));
		this.debounce(`config:${document.uri}`, () => this.checkConfigFile(document));
	}

	start() {
		const subscriptions = this.context.subscriptions;
		subscriptions.push(this.diagnostics, this.output, { dispose: () => this.debounce.dispose() }, { dispose: () => this.recheckSoon.dispose() });

		subscriptions.push(
			vscode.workspace.onDidOpenTextDocument(document => this.onDocument(document)),
			vscode.workspace.onDidChangeTextDocument((event) => {
				if (event.contentChanges.length > 0) this.onDocument(event.document);
			}),
			vscode.workspace.onDidCloseTextDocument((document) => {
				this.analyses.delete(document.uri.toString());
				this.published.delete(document.uri.toString());
				this.diagnostics.delete(document.uri);
				this.forgetConfigFile(document.uri);
				// Unsaved changes are gone: the file on disk counts again.
				if (document.uri.scheme == "file" && SOURCE_EXTENSIONS.test(document.uri.fsPath)) this.indexDisk(document.uri.fsPath);
			}),
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration("amxts")) this.ready = this.reindex();
			}),
			vscode.workspace.onDidChangeWorkspaceFolders(() => {
				this.ready = this.reindex();
			}),
		);

		const sources = vscode.workspace.createFileSystemWatcher("**/*.{ts,sma}");
		const changed = (uri: vscode.Uri) => {
			if (openDocument(uri.fsPath) != null) return;
			if (uri.fsPath.replaceAll("\\", "/").endsWith("/amxts.config.ts")) this.readConfig(dirname(uri.fsPath)).then(() => this.recheckAll());
			this.debounce(`disk:${uri.fsPath}`, () => this.indexDisk(uri.fsPath));
		};
		sources.onDidChange(changed);
		sources.onDidCreate(changed);
		sources.onDidDelete((uri) => {
			this.forgetConfigLoads(uri.fsPath);
			if (this.registry.delete(uri.fsPath)) this.recheckSoon("all", () => this.recheckAll());
		});
		subscriptions.push(sources);

		subscriptions.push(
			vscode.languages.registerCompletionItemProvider(MENU_SELECTOR, { provideCompletionItems: (document, position) => this.provideCompletion(document, position) }, "%", "!", "|", "\"", " ", ",", "["),
			vscode.languages.registerHoverProvider(MENU_SELECTOR, { provideHover: (document, position) => this.provideHover(document, position) }),
			vscode.languages.registerDefinitionProvider(MENU_SELECTOR, { provideDefinition: (document, position) => this.provideDefinition(document, position) }),
			vscode.languages.registerReferenceProvider(MENU_SELECTOR, { provideReferences: (document, position, context) => this.provideMenuReferences(document, position, context) }),
			vscode.languages.registerReferenceProvider(SOURCE_SELECTOR, { provideReferences: (document, position, context) => this.provideSourceReferences(document, position, context) }),
			vscode.languages.registerCodeActionsProvider(MENU_SELECTOR, { provideCodeActions: (document, _range, context) => this.provideCodeActions(document, context) }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
			vscode.commands.registerCommand("amxts.reindex", () => {
				this.ready = this.reindex();
				return this.ready;
			}),
		);

		this.startConfigs(subscriptions);

		this.ready = this.indexAll();
		for (const document of vscode.workspace.textDocuments) this.onDocument(document);
	}

	async reindex() {
		for (const registration of this.registry.all()) this.registry.delete(registration.file);
		this.analyses.clear();
		this.configLoads.clear();
		await this.indexAll();
	}
}

type Published = { diagnostic: vscode.Diagnostic; problem: Problem }[];

const SEVERITIES = { error: vscode.DiagnosticSeverity.Error, warning: vscode.DiagnosticSeverity.Warning, info: vscode.DiagnosticSeverity.Information };

/** A document's problems as the editor shows them, each with the problem it is, for its quick fix. */
function published(document: vscode.TextDocument, problems: Problem[]): Published {
	return problems.map((problem) => {
		const range = new vscode.Range(document.positionAt(problem.start), document.positionAt(problem.end));
		const diagnostic = new vscode.Diagnostic(range, problem.message, SEVERITIES[problem.severity]);
		diagnostic.source = "amxts";
		diagnostic.code = problem.code;
		return { diagnostic, problem };
	});
}

/** The quick fixes of the diagnostics asked about: the fixes of the problems published for them. */
function quickFixes(document: vscode.TextDocument, entries: Published, context: vscode.CodeActionContext) {
	const actions: vscode.CodeAction[] = [];
	for (const diagnostic of context.diagnostics) {
		const fix = entries.find(each => each.diagnostic.message == diagnostic.message && each.diagnostic.range.isEqual(diagnostic.range))?.problem.fix;
		if (fix == null) continue;
		const action = new vscode.CodeAction(fix.title, vscode.CodeActionKind.QuickFix);
		action.edit = new vscode.WorkspaceEdit();
		action.edit.replace(document.uri, new vscode.Range(document.positionAt(fix.start), document.positionAt(fix.end)), fix.text);
		action.diagnostics = [diagnostic];
		action.isPreferred = true;
		actions.push(action);
	}
	return actions;
}

/** The document open in the editor for a file, if it is open. */
function openDocument(path: string) {
	return vscode.workspace.textDocuments.find(document => document.uri.fsPath == path);
}

/** A position in a text that is not open in the editor, by where its lines start. */
function positionIn(lineStarts: number[], offset: number) {
	const line = lineOf(lineStarts, offset);
	return new vscode.Position(line, offset - lineStarts[line]);
}

export function activate(context: vscode.ExtensionContext) {
	const extension = new Extension(context);
	extension.start();
	return {
		/** For tests: the index, and a promise of the first reading of the workspace. */
		registry: extension.registry,
		ready: () => extension.ready,
	};
}

export function deactivate() {}
