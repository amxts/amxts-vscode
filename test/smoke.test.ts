/**
 * The bundled extension (dist/extension.js, `npm run build` first) activated
 * against a small stand-in for the `vscode` module: it reads the fixture
 * workspace, and a name typed in a plugin that is open - not saved - is
 * offered in a menu file right away.
 */
import { beforeAll, describe, expect, mock, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WORKSPACE } from "./helpers";

const BUNDLE = join(import.meta.dir, "../dist/extension.js");

type Listener<T> = (value: T) => void;

function emitter<T>() {
	const listeners: Listener<T>[] = [];
	const event = (listener: Listener<T>) => {
		listeners.push(listener);
		return { dispose() {} };
	};
	return { event, fire: (value: T) => listeners.forEach(listener => listener(value)) };
}

class Position {
	constructor(
		public line: number,
		public character: number,
	) {}
}

class Range {
	start: Position;
	end: Position;
	constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
		this.start = typeof a == "number" ? new Position(a, b as number) : a;
		this.end = typeof a == "number" ? new Position(c!, d!) : (b as Position);
	}

	isEqual(other: Range) {
		return JSON.stringify(this) == JSON.stringify(other);
	}
}

const uri = (path: string) => ({ fsPath: path, scheme: "file", toString: () => `file:///${path.replaceAll("\\", "/")}` });

function document(path: string, text: string, languageId: string, version = 1) {
	const lines = () => text.split("\n");
	return {
		uri: uri(path),
		fileName: path,
		languageId,
		version,
		getText: () => text,
		positionAt(offset: number) {
			const before = text.slice(0, offset);
			return new Position(before.split("\n").length - 1, offset - (before.lastIndexOf("\n") + 1));
		},
		offsetAt(position: Position) {
			return lines().slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.character;
		},
	};
}

const providers: Record<string, { provider: any }[]> = {};
const opened = emitter<unknown>();
const changed = emitter<{ document: unknown; contentChanges: unknown[] }>();
const textDocuments: ReturnType<typeof document>[] = [];
const diagnostics = new Map<string, { message: string }[]>();
const languageSwitches: string[] = [];
function register(kind: string) {
	return (_selector: unknown, provider: unknown) => {
		(providers[kind] ??= []).push({ provider });
		return { dispose() {} };
	};
}

const vscode = {
	Position,
	Range,
	Location: class {
		constructor(
			public uri: unknown,
			public range: Range,
		) {}
	},
	Hover: class {
		constructor(
			public contents: { value: string },
			public range: Range,
		) {}
	},
	MarkdownString: class {
		constructor(public value: string) {}
	},
	CompletionItem: class {
		[key: string]: unknown;
		constructor(
			public label: string,
			public kind: number,
		) {}
	},
	Diagnostic: class {
		[key: string]: unknown;
		constructor(
			public range: Range,
			public message: string,
			public severity: number,
		) {}
	},
	CodeAction: class {
		[key: string]: unknown;
		constructor(public title: string) {}
	},
	WorkspaceEdit: class {
		edits: unknown[] = [];
		replace(...args: unknown[]) {
			this.edits.push(args);
		}
	},
	CodeActionKind: { QuickFix: "quickfix" },
	DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
	CompletionItemKind: new Proxy({}, { get: () => 1 }),
	Uri: { file: uri },
	window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
	commands: { registerCommand: () => ({ dispose() {} }) },
	extensions: { getExtension: () => undefined },
	languages: {
		createDiagnosticCollection: () => ({
			set: (target: { toString: () => string }, list: { message: string }[]) => diagnostics.set(target.toString(), list),
			delete: (target: { toString: () => string }) => diagnostics.delete(target.toString()),
			dispose() {},
		}),
		registerCompletionItemProvider: register("completion"),
		registerHoverProvider: register("hover"),
		registerDefinitionProvider: register("definition"),
		registerReferenceProvider: register("references"),
		registerCodeActionsProvider: register("codeActions"),
		setTextDocumentLanguage: async (target: { fileName: string }, language: string) => {
			languageSwitches.push(`${target.fileName.split(/[\\/]/).pop()} ${language}`);
			return target;
		},
	},
	workspace: {
		workspaceFolders: [{ uri: uri(WORKSPACE), name: "workspace", index: 0 }],
		textDocuments,
		getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
		getWorkspaceFolder: (target: { fsPath: string }) => (target.fsPath.startsWith(WORKSPACE) ? { uri: uri(WORKSPACE) } : undefined),
		asRelativePath: (path: string) => path.slice(WORKSPACE.length + 1).replaceAll("\\", "/"),
		onDidOpenTextDocument: opened.event,
		onDidChangeTextDocument: changed.event,
		onDidCloseTextDocument: emitter().event,
		onDidChangeConfiguration: emitter().event,
		onDidChangeWorkspaceFolders: emitter().event,
		createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }),
	},
};

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe.skipIf(!existsSync(BUNDLE))("the bundled extension", () => {
	let api: { ready: () => Promise<void>; registry: { names: (kind: string) => string[] } };
	const menuPath = join(WORKSPACE, "configs", "playground", "menu.yaml");

	beforeAll(async () => {
		mock.module("vscode", () => vscode);
		// oxlint-disable-next-line typescript/no-require-imports -- the bundle is CommonJS, loaded after mock.module("vscode")
		const extension = require(BUNDLE);
		const subscriptions: unknown[] = [];
		api = extension.activate({ subscriptions });
		await api.ready();
		// The first run transpiles the bundle, which takes a while.
	}, 30000);

	test("activates and registers its providers", () => {
		expect(Object.keys(providers).sort()).toEqual(["codeActions", "completion", "definition", "hover", "references"]);
	});

	test("reads the workspace's registrations", () => {
		expect(api.registry.names("action")).toContain("RESET_SCORE");
		expect(api.registry.names("action")).toContain("TOGGLE_HIDE_KNIFE");
	});

	test("a name typed in an open plugin is offered in the menu file before it is saved", async () => {
		const text = readFileSync(menuPath, "utf8").replace("when: IS_SPECTATOR", "when: MY_");
		const menu = document(menuPath, text, "yaml");
		textDocuments.push(menu);
		const position = menu.positionAt(text.indexOf("when: MY_") + "when: MY_".length);
		const complete = () => providers.completion[0].provider.provideCompletionItems(menu, position).map((item: { label: string }) => item.label);
		expect(complete()).not.toContain("MY_VIP");

		const plugin = document(join(WORKSPACE, "plugins", "vip.ts"), `import * as menus from "@amxts/menu-core";\nmenus.addCondition("MY_VIP", () => true);\n`, "typescript");
		textDocuments.push(plugin);
		changed.fire({ document: plugin, contentChanges: [{}] });
		await wait(250);
		expect(complete()).toContain("MY_VIP");
	});

	test("checks the menu file as it is typed, and the fix of a slip", async () => {
		const text = readFileSync(menuPath, "utf8").replace("action: JOIN_TEAM", "action: JOIN_TEM");
		const menu = document(menuPath, text, "yaml", 2);
		textDocuments.splice(0, textDocuments.length, menu);
		changed.fire({ document: menu, contentChanges: [{}] });
		await wait(250);
		const published = diagnostics.get(menu.uri.toString())!;
		const slip = published.find(each => each.message.includes("JOIN_TEM"))!;
		expect(slip.message).toContain(`did you mean "JOIN_TEAM"?`);
		const actions = providers.codeActions[0].provider.provideCodeActions(menu, null, { diagnostics: [slip] });
		expect(actions.map((action: { title: string }) => action.title)).toEqual([`Change to "JOIN_TEAM"`]);
	});

	test("hover and go to definition", () => {
		const text = readFileSync(menuPath, "utf8");
		const menu = document(menuPath, text, "yaml", 3);
		textDocuments.splice(0, textDocuments.length, menu);
		const position = menu.positionAt(text.indexOf("action: RESET_SCORE") + "action: RE".length);
		const hover = providers.hover[0].provider.provideHover(menu, position);
		expect(hover.contents.value).toContain("plugins/admin.ts:9");
		const [location] = providers.definition[0].provider.provideDefinition(menu, position);
		expect(location.uri.fsPath).toBe(join(WORKSPACE, "plugins", "admin.ts"));
		expect(location.range.start.line).toBe(8);
	});

	test("finds the uses of a registration from the plugin", async () => {
		const path = join(WORKSPACE, "plugins", "admin.ts");
		const plugin = document(path, readFileSync(path, "utf8"), "typescript");
		const found = await providers.references[1].provider.provideReferences(plugin, new Position(8, 20), { includeDeclaration: false });
		const files = found.map((location: { uri: { fsPath: string } }) => location.uri.fsPath.split(/[\\/]/).pop()).sort();
		expect(files).toEqual(["menu.ini", "menu.json", "menu.yaml"]);
	});

	test("a .json menu file is opened as JSONC: comments are Config Core's to read", async () => {
		const path = join(WORKSPACE, "configs", "playground", "menu.json");
		const menu = document(path, readFileSync(path, "utf8"), "json");
		textDocuments.splice(0, textDocuments.length, menu);
		opened.fire(menu);
		await wait(250);
		expect(languageSwitches).toEqual(["menu.json jsonc"]);
	});
});
