/**
 * A menu file read as Menu Core reads it (`src/menu-file.ts` of
 * @amxts/menu-core), check by check and in the same words - with where each
 * problem, name and key is, for the editor:
 *
 * - problems: an unknown key (with "did you mean"), a value of the wrong kind,
 *   a menu without a title, an item without a name, `items` in a list menu, a
 *   slot outside 1-7, and what Config Core's reader cannot read at all;
 * - uses: each condition, action, restriction, requirement and placeholder a
 *   menu names, one token each - checked against the registrations by
 *   `registry.ts`;
 * - menus: the menus the file describes, for SHOW_<MENU>;
 * - hints: what a key or an INI column is, for hover.
 *
 * Parts Menu Core does not read (a menu without a title, `items` of a list
 * menu) are still read here, quietly: their names get hover and go to
 * definition, but no warning.
 */
import { entryOf, IniEntry, IniSection, parseIni } from "./ini";
import { fieldOf, IniColumn, iniKey, iniKeysOf, IniKey, INI_LABELS, INI_MAIN, INI_MENU, keysOf, Level, LEVELS, levelWords, meantKeys, NameKind } from "./shape";
import { closest, didYouMean } from "./suggest";
import { Kind, lineEndIn, parseJson, parseYaml, syntaxProblems, TNode } from "./tree";

export type Format = "ini" | "yaml" | "json";

export interface Fix {
	title: string;
	start: number;
	end: number;
	text: string;
}

export interface Problem {
	start: number;
	end: number;
	message: string;
	severity: "error" | "warning" | "info";
	code: "syntax" | "unknown-key" | "kind" | "shape" | "unknown-name" | "list" | "idle";
	fix?: Fix;
}

export interface NameUse {
	kind: NameKind;
	name: string;
	start: number;
	end: number;
	/** The menu it is in. */
	menu: string;
	/** Whether Menu Core reads it: false for a part it leaves out. */
	checked: boolean;
	/** The line of names it is in, one variant of it: "3:0" - names of a line are checked together. */
	line: string;
	/** The token as written: "!IS_ALIVE", or "VIP:Only for VIP" - NAME:param - whole. */
	token: string;
	/** Where the token starts, "!" included; -1 when it has no place of its own. */
	tokenStart: number;
	/** Where the space before the token starts - removing from here to `end` removes it; -1 when it cannot be removed so. */
	cut: number;
}

export interface MenuDef {
	name: string;
	start: number;
	end: number;
	/** Whether Menu Core reads it as a menu: it has a title. */
	read: boolean;
}

export interface Hint {
	start: number;
	end: number;
	markdown: string;
}

export interface Analysis {
	format: Format;
	problems: Problem[];
	uses: NameUse[];
	menus: MenuDef[];
	hints: Hint[];
}

export function formatOf(path: string): Format | null {
	const lower = path.toLowerCase();
	if (lower.endsWith(".ini")) return "ini";
	if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
	if (lower.endsWith(".json") || lower.endsWith(".jsonc")) return "json";
	return null;
}

const NAME_LETTERS = /^\w+$/;
const BACKSLASH = "\\";
/** The letters of a menu's colours: `!y` in a menu file, and a backslash before them in Pawn's text. */
const COLOUR_LETTERS = ["y", "r", "w", "d", "R"];

class Reader {
	problems: Problem[] = [];
	uses: NameUse[] = [];
	menus: MenuDef[] = [];
	hints: Hint[] = [];
	/** While set, what is read is not warned of: Menu Core leaves it out. */
	quiet = false;
	menu = "";
	/** The line of names being read, and its variant. */
	lineId = 0;
	variantIndex = 0;

	constructor(public source: string) {}

	warn(start: number, end: number, message: string, code: Problem["code"] = "shape", fix?: Fix) {
		if (this.quiet) return;
		this.problems.push({ start, end: Math.max(end, start + 1), message, severity: "warning", code, fix });
	}

	/** The rest of the line from `start`, or up to `end`. */
	lineEnd(start: number, end: number) {
		return lineEndIn(this.source, start, end);
	}

	/**
	 * A text of the file: a colour in it is a tag, `!y` - Pawn's code, a
	 * backslash and the letter, is warned of with the tag to write, as Menu
	 * Core warns of it. The fix rewrites the text where it is written as it reads.
	 */
	colours(text: string, start: number, end: number) {
		const codes = COLOUR_LETTERS.filter(letter => text.includes(`${BACKSLASH}${letter}`));
		if (codes.length == 0 || start < 0) return;
		const fixes = codes.map(letter => `!${letter} for ${BACKSLASH}${letter}`).join(", ");
		let tagged = text;
		for (const letter of codes) tagged = tagged.replaceAll(`${BACKSLASH}${letter}`, `!${letter}`);
		const fix = this.source.slice(start, start + text.length) == text ? { title: "Write the colours as tags", start, end: start + text.length, text: tagged } : undefined;
		this.warn(start, Math.max(end, start + text.length), `"${text}": a colour is a tag in a menu file - write ${fixes}; the codes are left out`, "kind", fix);
	}

	/** An unknown key; `meant`: the keys an INI column's name stands for here - said without a fix. */
	unknownKey(key: string, start: number, end: number, known: string[], what: string, meant: string[] = []) {
		if (meant.length > 0) {
			this.warn(start, end, `unknown key "${key}" in ${what} - did you mean ${meant.map(each => `"${each}"`).join(" or ")}?`, "unknown-key");
			return;
		}
		const suggested = closest(key, known);
		const fix = suggested != null ? { title: `Change to "${suggested}"`, start, end, text: suggested } : undefined;
		this.warn(start, end, `unknown key "${key}" in ${what}${didYouMean(suggested)}`, "unknown-key", fix);
	}

	/** A new line of names: what `names()` reads until the next one is checked together, a variant at a time. */
	newLine() {
		this.lineId++;
		this.variantIndex = 0;
	}

	/**
	 * Each name of a line - "A B", "!A|B" - at its place; `newLine()` first,
	 * unless it goes on the line before (an item of a list). `A|B` are
	 * variants in INI only. A restriction or a requirement "NAME:param" takes
	 * the rest of the line, as Menu Core reads it.
	 */
	names(kind: NameKind, value: string, textStart: number, fallbackStart: number, fallbackEnd: number, sameLine = false, variants = true) {
		if (!sameLine) this.newLine();
		if (value.trim().length == 0) return;
		const parameters = kind == "restriction" || kind == "requirement";
		const pattern = parameters || !variants ? /[^ ]+/g : /[^ |]+|\|/g;
		for (let match = pattern.exec(value); match != null; match = pattern.exec(value)) {
			if (match[0] == "|") {
				this.variantIndex++;
				continue;
			}

			const text = value.slice(match.index).trimEnd();
			const parameterized = parameters && match[0].includes(":");
			const token = parameterized ? text : match[0];
			let word = token;
			let from = match.index;
			if (word.startsWith("!")) {
				word = word.slice(1);
				from++;
			}
			if (parameterized) word = word.slice(0, word.indexOf(":"));

			if (word.length > 0) {
				const before = value.slice(0, match.index).trimEnd().length;
				const placed = textStart >= 0;
				this.use(kind, word, textStart, from, fallbackStart, fallbackEnd, {
					line: `${this.lineId}:${this.variantIndex}`,
					token,
					tokenStart: placed ? textStart + match.index : -1,
					cut: placed && before > 0 ? textStart + before : -1,
				});
			}

			if (parameterized) return;
		}
	}

	/** Each %placeholder% of a text. */
	placeholders(value: string, textStart: number, fallbackStart: number, fallbackEnd: number) {
		const parts = value.split("%");
		let at = parts[0].length + 1;
		for (let i = 1; i < parts.length - 1; i++) {
			if (i % 2 == 1 && NAME_LETTERS.test(parts[i])) this.use("placeholder", parts[i], textStart, at, fallbackStart, fallbackEnd);
			at += parts[i].length + 1;
		}
	}

	use(kind: NameKind, name: string, textStart: number, index: number, fallbackStart: number, fallbackEnd: number, list?: Pick<NameUse, "line" | "token" | "tokenStart" | "cut">) {
		const placed = textStart >= 0;
		const start = placed ? textStart + index : fallbackStart;
		const end = placed ? start + name.length : fallbackEnd;
		const where = list ?? { line: "", token: name, tokenStart: -1, cut: -1 };
		this.uses.push({ kind, name, start, end, menu: this.menu, checked: !this.quiet, ...where });
	}

	/** What may be meant but is worth a look: an information, not a warning. */
	note(start: number, end: number, message: string) {
		if (this.quiet) return;
		this.problems.push({ start, end: Math.max(end, start + 1), message, severity: "info", code: "idle" });
	}

	/** While `read` runs, what is read is not warned of. */
	quietly(read: () => void) {
		const was = this.quiet;
		this.quiet = true;
		read();
		this.quiet = was;
	}

	result(format: Format): Analysis {
		return { format, problems: this.problems, uses: this.uses, menus: this.menus, hints: this.hints };
	}
}

// ---------------------------------------------------------------- YAML and JSON

/** "a list", "true or false", ... - a value's kind as a message says it. */
function kindWords(kind: Kind) {
	if (kind == "object") return "an object";
	if (kind == "array") return "a list";
	if (kind == "boolean") return "true or false";
	if (kind == "number") return "a number";
	if (kind == "string") return "text";
	return "null";
}

/** A menu's true/false fields, as the tables say them. */
const MENU_FLAGS = LEVELS.menu.filter(field => field.kind == "flag");
const INI_MENU_FLAGS = INI_MENU.filter(key => key.kind == "flag");

class TreeReader extends Reader {
	/** Where a node is: its key, or the first line of its value. */
	place(node: TNode) {
		if (node.keyStart >= 0) return [node.keyStart, node.keyEnd];
		return [node.start, this.lineEnd(node.start, node.end)];
	}

	warnAt(node: TNode, message: string, code: Problem["code"] = "shape") {
		const [start, end] = this.place(node);
		this.warn(start, end, message, code);
	}

	/** Where a value is: the value, or its key when it has none written. */
	valuePlace(node: TNode) {
		return node.end > node.start ? [node.start, node.end] : this.place(node);
	}

	get(node: TNode, key: string) {
		return node.kind == "object" ? node.items.find(each => each.key == key) ?? null : null;
	}

	checkKeys(node: TNode, level: Level, what: string) {
		const known = keysOf(level);
		for (const child of node.items) {
			if (child.keyStart < 0) continue;
			const field = fieldOf(level, child.key);
			if (field == null) this.unknownKey(child.key, child.keyStart, child.keyEnd, known, what, meantKeys(level, child.key));
			else this.hints.push({ start: child.keyStart, end: child.keyEnd, markdown: `**${field.key}** - ${field.description}` });
		}
	}

	kindProblem(value: TNode, message: string) {
		const [start, end] = this.valuePlace(value);
		this.warn(start, end, message, "kind");
	}

	text(node: TNode, key: string, placeholders = false) {
		const value = this.get(node, key);
		if (value == null || value.kind == "null") return "";

		if (value.kind == "string" || value.kind == "number") {
			if (placeholders && value.kind == "string") this.placeholders(value.text, value.textStart, value.start, value.end);
			// An escaped text has no place of its own in the source: the value's, and no fix.
			if (value.kind == "string") this.colours(value.text, value.textStart >= 0 ? value.textStart : value.start, value.end);
			return value.text;
		}

		this.kindProblem(value, `"${key}" is text, not ${kindWords(value.kind)}`);
		return "";
	}

	flag(node: TNode, key: string) {
		const value = this.get(node, key);
		if (value == null || value.kind == "null" || value.kind == "boolean") return;
		this.kindProblem(value, `"${key}" is true or false, not ${kindWords(value.kind)}`);
	}

	number(node: TNode, key: string) {
		const value = this.get(node, key);
		if (value == null || value.kind == "null") return 0;
		if (value.kind == "number") return Math.trunc(Number(value.text));
		this.kindProblem(value, `"${key}" is a number, not ${kindWords(value.kind)}`);
		return 0;
	}

	list(node: TNode, key: string) {
		const value = this.get(node, key);
		if (value == null || value.kind == "null") return [];
		if (value.kind == "array") return value.items;
		this.kindProblem(value, `"${key}" is a list, not ${kindWords(value.kind)}`);
		return [];
	}

	/** A line of names: one name, several space-separated, or a list of them. */
	namesOf(node: TNode, key: string, kind: NameKind) {
		const value = this.get(node, key);
		if (value == null || value.kind == "null") return "";
		const listed = value.kind == "array" && value.items.every(each => each.kind == "string");

		if (value.kind != "string" && !listed) {
			this.kindProblem(value, `"${key}" is a name or a list of names, not ${kindWords(value.kind)}`);
			return "";
		}

		return this.line(value, kind);
	}

	/** A line of names written as a string or a list of strings; its text. */
	line(value: TNode, kind: NameKind) {
		const strings = value.kind == "string" ? [value] : value.items;
		// A list is one line to Menu Core: "NAME:param" takes the entries after it too.
		const parameterized = kind == "requirement" ? strings.findIndex(each => each.text.includes(":")) : -1;
		if (parameterized >= 0 && parameterized < strings.length - 1) {
			const entry = strings[parameterized];
			this.kindProblem(entry, `"${entry.text}" takes the rest of the line - NAME:param goes last`);
		}
		const read = parameterized >= 0 ? strings.slice(0, parameterized + 1) : strings;
		read.forEach((each, index) => this.names(kind, each.text, each.textStart, each.start, each.end, index > 0, false));
		return strings.map(each => each.text).join(" ");
	}

	/** `enabled`: a line of names, or a list of requirements - each a line of names or `{ when, message }`. */
	enabled(node: TNode) {
		const value = this.get(node, "enabled");
		if (value == null || value.kind == "null") return;

		if (value.kind == "string") {
			this.line(value, "requirement");
			return;
		}

		if (value.kind != "array") {
			this.kindProblem(value, `"enabled" is a name, a list of names or a list of { when, message }, not ${kindWords(value.kind)}`);
			return;
		}

		for (const each of value.items) {
			if (each.kind == "string") this.line(each, "requirement");
			else if (each.kind == "object") this.requirement(each);
			else this.kindProblem(each, `a requirement is a name or { when: ..., message: ... }, not ${kindWords(each.kind)}`);
		}
	}

	/** A requirement of `enabled` with a message of its own: `{ when, message }`. */
	requirement(node: TNode) {
		this.checkKeys(node, "requirement", "a requirement");
		const when = this.namesOf(node, "when", "requirement");
		this.text(node, "message");
		if (when.length == 0) this.warnAt(node, `a requirement without "when"`);
	}

	isObject(node: TNode, what: string, shape: string) {
		if (node.kind == "object") return true;
		this.warnAt(node, `${what} is an object: ${shape}, not ${kindWords(node.kind)}`);
		return false;
	}

	variant(node: TNode) {
		if (!this.isObject(node, "a variant", "{ name: ..., when: ..., action: ... }")) return null;
		this.checkKeys(node, "variant", "a variant");
		const name = this.text(node, "name", true);
		this.namesOf(node, "when", "requirement");
		this.namesOf(node, "action", "action");
		if (name.length == 0) this.warnAt(node, "a variant without a name");
		return name.length > 0 ? name : null;
	}

	/** An item, a fixed item or a list menu's view; whether it can be drawn. */
	item(node: TNode, level: Level) {
		const what = levelWords(level, this.menu);
		if (!this.isObject(node, what, "{ name: ..., action: ... }")) return false;
		this.checkKeys(node, level, what);
		const keys = keysOf(level);
		let name = this.text(node, "name", true);
		if (keys.includes("placeholder")) this.text(node, "placeholder", true);
		const action = this.namesOf(node, "action", "action");
		if (keys.includes("visible")) this.namesOf(node, "visible", "requirement");
		this.enabled(node);
		this.text(node, "message");
		if (keys.includes("spaceBefore")) this.number(node, "spaceBefore");
		if (keys.includes("spaceAfter")) this.number(node, "spaceAfter");
		const listed = this.list(node, "variants");

		if (listed.length > 0) {
			const named = name.length > 0 || action.length > 0;
			if (named) this.warnAt(node, `${what} with variants takes its name and action from them`);
			const names = listed.map(each => this.variant(each)).filter(each => each != null);
			name = names.length > 0 ? names[0]! : "";
		}

		if (name.length == 0) this.warnAt(node, `${what} without a name`);
		const actions = listed.length > 0 ? listed.map(each => this.actionText(each)) : [action];
		// A list menu's rows may bring actions of their own.
		if (name.length > 0 && level != "view" && actions.every(each => each.trim().length == 0)) {
			const [start, end] = this.place(node);
			this.note(start, end, idleWords(name));
		}
		return name.length > 0;
	}

	/** A variant's action line, without reading it as names again. */
	actionText(node: TNode) {
		const value = this.get(node, "action");
		if (value == null) return "";
		if (value.kind == "array") return value.items.map(each => each.text).join(" ");
		return value.kind == "string" ? value.text : "";
	}

	filter(node: TNode) {
		if (!this.isObject(node, "a filter", "{ when: ..., message: ... }")) return;
		this.checkKeys(node, "filter", "a filter");
		const when = this.namesOf(node, "when", "requirement");
		this.text(node, "message");
		if (when.length == 0) this.warnAt(node, `a filter without "when"`);
	}

	fixed(node: TNode) {
		if (!this.item(node, "fixed")) return;
		const slot = this.number(node, "slot");
		if (slot < 1 || slot > 7) this.warnAt(node, `"slot" is the item's key, 1 to 7`);
	}

	menuOf(node: TNode) {
		const name = node.key;
		this.menu = name;
		const def: MenuDef = { name, start: node.keyStart, end: node.keyEnd, read: false };
		this.menus.push(def);
		if (!this.isObject(node, `the menu "${name}"`, "{ title: ..., items: [...] }")) return;
		this.checkKeys(node, "menu", `the menu "${name}"`);
		const title = this.text(node, "title");

		if (title.length == 0) {
			this.warnAt(node, `the menu "${name}" has no title`);
			this.quietly(() => this.menuContent(node));
			return;
		}

		def.read = true;
		this.menuContent(node);
	}

	menuContent(node: TNode) {
		const title = this.get(node, "title");
		if (title != null && title.kind == "string") this.placeholders(title.text, title.textStart, title.start, title.end);
		this.namesOf(node, "activeOn", "condition");
		for (const field of MENU_FLAGS) this.flag(node, field.key);
		this.number(node, "time");
		this.namesOf(node, "onTimeout", "action");

		const list = this.menu.startsWith("LIST_");
		const items = this.get(node, "items");
		const view = this.get(node, "view");
		const filters = this.get(node, "filters");
		if (list && items != null) this.warnAt(items, `a list menu draws its rows with "view" - "items" is not read`);
		if (!list && view != null) this.warnAt(view, `"view" is for a list menu, whose name starts with LIST_`);
		if (!list && filters != null) this.warnAt(filters, `"filters" are for a list menu, whose name starts with LIST_`);

		const readItems = () => {
			for (const each of this.list(node, "items")) this.item(each, "item");
		};
		const readView = () => {
			if (view != null) this.item(view, "view");
			for (const each of this.list(node, "filters")) this.filter(each);
		};
		if (list) this.quietly(readItems);
		else readItems();
		if (list) readView();
		else this.quietly(readView);

		for (const each of this.list(node, "fixedItems")) this.fixed(each);
	}

	file(root: TNode) {
		if (!this.isObject(root, "a menu file", "{ menus: { ... } }")) return;
		this.checkKeys(root, "file", "the menu file");
		this.text(root, "chatPrefix");
		const labels = this.get(root, "labels");

		if (labels != null && this.isObject(labels, "\"labels\"", "{ exit: ..., back: ... }")) {
			this.checkKeys(labels, "labels", "\"labels\"");
			for (const key of keysOf("labels")) this.text(labels, key);
		}

		const menus = this.get(root, "menus");
		if (menus == null || !this.isObject(menus, "\"menus\"", "{ MAIN_MENU: { ... } }")) return;
		for (const node of menus.items) this.menuOf(node);
	}
}

function analyzeTree(text: string, format: "yaml" | "json") {
	const reader = new TreeReader(text);
	const parsed = format == "yaml" ? parseYaml(text) : parseJson(text);
	reader.problems.push(...syntaxProblems(text, format, parsed));

	if (parsed.root != null) reader.file(parsed.root);
	return reader.result(format);
}

// ---------------------------------------------------------------- INI

const DIGITS = /^-?\d+$/;

function toInt(text: string) {
	const value = parseInt(text, 10);
	return isNaN(value) ? 0 : value;
}

/** Whether an action line does nothing: no action in any variant. */
function isIdle(action: string) {
	return action.split("|").every(part => part.trim().length == 0);
}

function idleWords(name: string) {
	return `the item "${name}" has no action: choosing it does nothing`;
}

/** Whether an item name gives an item - "A|B" gives two variants; "" and "|" give none. */
function givesItem(name: string) {
	return name.split("|").some(part => part.trim().length > 0);
}

class IniReader extends Reader {
	checkKeys(entries: IniEntry[], known: IniKey[], what: string) {
		for (const entry of entries) {
			if (entry.key.length == 0) continue;
			const key = iniKey(known, entry.key);
			if (key == null) this.unknownKey(entry.key, entry.keyStart, entry.keyEnd, iniKeysOf(known), what);
			else this.hints.push({ start: entry.keyStart, end: entry.keyEnd, markdown: `**${key.key}** - ${key.description}` });
		}
	}

	first(entry: IniEntry | undefined) {
		return entry != null && entry.values.length > 0 ? entry.values[0].text : "";
	}

	namesOf(entry: IniEntry | undefined, kind: NameKind, firstOnly: boolean) {
		if (entry == null) return;
		const values = firstOnly ? entry.values.slice(0, 1) : entry.values;
		values.forEach((value, index) => this.names(kind, value.text, value.start, value.start, value.end, index > 0));
	}

	/** A flag is YES or NO; another word is warned of with the one to write, as Menu Core warns of it. */
	flag(entries: IniEntry[], key: string) {
		const entry = entryOf(entries, key);
		if (entry == null || entry.rows != null) return;
		const value = this.first(entry);
		if (value.length == 0 || value == "YES" || value == "NO") return;
		const lower = value.toLowerCase();
		let word = "";
		if (["yes", "true", "on", "1"].includes(lower)) word = "YES";
		if (["no", "false", "off", "0"].includes(lower)) word = "NO";
		const written = entry.values[0];
		const fix = word.length > 0 ? { title: `Change to ${word}`, start: written.start, end: written.end, text: word } : undefined;
		this.warn(entry.keyStart, entry.end, `${key} is YES or NO, not "${value}"${word.length > 0 ? ` - write ${word}` : ""}`, "kind", fix);
	}

	/** The first value of an entry, as a text of the file. */
	firstText(entry: IniEntry | undefined) {
		const value = entry?.values[0];
		if (value != null) this.colours(value.text, value.start, value.end);
	}

	/** The rows of a block: quoted values each; a warning for anything that is not a block of rows. */
	rows(entries: IniEntry[], key: string) {
		const entry = entryOf(entries, key);
		if (entry == null) return [];

		if (entry.rows == null) {
			// `ITEMS = { }` on one line: Config Core reads the values "{" and "}" - Menu Core, an empty block.
			if (entry.values.map(value => value.text).join("") == "{}") return [];
			// A line of several values is a list: each value a row of one.
			if (entry.values.length > 1) return entry.values.map(value => [value]);
			this.warn(entry.keyStart, entry.end, `${key} is a block of rows in quotes: ${key} = { "..." "..." }`, "kind");
			return [];
		}

		const block = entry.rows;
		const keyed = block.every(row => row.key.length > 0);
		// A block of `key = value` lines is an object to Config Core, not rows; an empty block is left alone here.
		if (keyed && block.length > 0) {
			this.warn(entry.keyStart, entry.end, `${key} is a block of rows in quotes: ${key} = { "..." "..." }`, "kind");
			return [];
		}

		const found = [];
		for (const row of block) {
			if (row.key.length > 0) this.warn(row.start, row.end, `a row of ${key} is values in quotes, not "key = value"`, "kind");
			else found.push(row.values);
		}
		return found;
	}

	columnHints(entries: IniEntry[], key: string) {
		const entry = entryOf(entries, key);
		const block = iniKey(INI_MENU, key);
		if (entry?.rows == null || block?.columns == null) return;
		for (const row of entry.rows) {
			row.values.forEach((value, index) => {
				const column = block.columns![index];
				if (column != null) this.hints.push({ start: value.start - 1, end: value.end + 1, markdown: columnWords(column, index, block.key) });
			});
		}
	}

	/** An item's row from column `at`; `idle` notes one with no action - a list menu's view is not, its rows may bring their own. */
	item(columns: { text: string; start: number; end: number }[], at: number, placeholder: boolean, idle = true) {
		const column = (index: number) => columns[index] ?? { text: "", start: -1, end: -1 };
		let next = at;
		const name = column(next++);
		this.placeholders(name.text, name.start, name.start, name.end);
		this.colours(name.text, name.start, name.end);

		if (placeholder) {
			const text = column(next++);
			this.placeholders(text.text, text.start, text.start, text.end);
			this.colours(text.text, text.start, text.end);
		}

		for (const kind of ["condition", "action", "restriction"] as const) {
			const value = column(next++);
			this.names(kind, value.text, value.start, value.start, value.end);
			if (kind == "action" && idle && isIdle(value.text) && name.start >= 0) this.note(name.start - 1, name.end + 1, idleWords(name.text));
		}

		const message = column(next);
		this.colours(message.text, message.start, message.end);
	}

	menuOf(section: IniSection) {
		const name = section.name;
		this.menu = name;
		const entries = section.entries;
		const title = this.first(entryOf(entries, "TITLE"));
		const content = ["ITEMS", "VIEW", "FIXED_ITEMS"].some(key => entryOf(entries, key) != null);
		this.menus.push({ name, start: section.nameStart, end: section.nameEnd, read: title.length > 0 });

		if (title.length == 0) {
			if (content) this.warn(section.nameStart, section.nameEnd, `[${name}] has no TITLE, so it is not a menu`);
			this.quietly(() => this.menuContent(section));
			return;
		}

		this.checkKeys(entries, INI_MENU, `[${name}]`);
		this.menuContent(section);
	}

	menuContent(section: IniSection) {
		const entries = section.entries;
		if (this.quiet) this.checkKeys(entries, INI_MENU, `[${section.name}]`);
		const title = entryOf(entries, "TITLE");
		if (title != null && title.values.length > 0) this.placeholders(title.values[0].text, title.values[0].start, title.values[0].start, title.values[0].end);
		this.firstText(title);
		this.namesOf(entryOf(entries, "ACTIVE_ON"), "condition", false);
		for (const key of INI_MENU_FLAGS) this.flag(entries, key.key);
		const time = entryOf(entries, "TIME");
		if (time != null && !DIGITS.test(this.first(time))) this.warn(time.keyStart, time.end, `TIME is a number of seconds, not "${this.first(time)}"`, "kind");
		this.namesOf(entryOf(entries, "ON_TIMEOUT"), "action", true);
		for (const key of ["ITEMS", "FIXED_ITEMS", "FILTER", "VIEW"]) this.columnHints(entries, key);

		const list = section.name.startsWith("LIST_");
		const items = entryOf(entries, "ITEMS");
		if (list && items != null) this.warn(items.keyStart, items.keyEnd, "a list menu draws its rows with VIEW - ITEMS is not read");
		for (const key of ["VIEW", "FILTER"]) {
			const found = entryOf(entries, key);
			if (!list && found != null) this.warn(found.keyStart, found.keyEnd, `${key} is for a list menu, whose name starts with LIST_`);
		}

		const readItems = () => {
			for (const columns of this.rows(entries, "ITEMS")) {
				if (givesItem(columns[0]?.text ?? "")) this.item(columns, 0, true);
			}
		};
		const readList = () => {
			for (const columns of this.rows(entries, "FILTER")) {
				const condition = columns[0];
				if (condition != null) this.names("condition", condition.text, condition.start, condition.start, condition.end);
				const message = columns[1];
				if (message != null) this.colours(message.text, message.start, message.end);
			}
			const views = this.rows(entries, "VIEW");
			if (views.length > 0 && givesItem(views[0][0]?.text ?? "")) this.item(views[0], 0, false, false);
			// Rows after the first are not read: the view is one row.
			this.quietly(() => views.slice(1).forEach(columns => this.item(columns, 0, false, false)));
		};
		if (list) this.quietly(readItems);
		else readItems();
		if (list) readList();
		else this.quietly(readList);

		const fixed = entryOf(entries, "FIXED_ITEMS");
		for (const columns of this.rows(entries, "FIXED_ITEMS")) {
			if (!givesItem(columns[1]?.text ?? "")) continue;
			this.item(columns, 1, true);
			const slot = columns[0];
			const value = toInt(slot?.text ?? "");
			if (value < 1 || value > 7) {
				const row = fixed?.rows?.find(each => each.values == columns);
				this.warn(row?.start ?? slot.start, row?.end ?? slot.end, `the slot of a fixed item is its key, 1 to 7, not "${slot?.text ?? ""}"`);
			}
		}
	}

	file(text: string) {
		const document = parseIni(text);
		// A name found twice is the last section of that name, as Config Core finds it.
		const last = new Map<string, IniSection>();
		for (const section of document.sections) last.set(section.name, section);

		for (const section of document.sections) {
			if (section.name == "MAIN") {
				if (last.get("MAIN") != section) continue;
				this.checkKeys(section.entries, INI_MAIN, "[MAIN]");
				this.firstText(entryOf(section.entries, "PREFIX"));
				const key = entryOf(section.entries, "KEY");
				if (key?.rows != null && key.rows.length > 0 && key.rows.every(row => row.key.length > 0)) this.checkKeys(key.rows, INI_LABELS, "KEY");
				for (const label of key?.rows ?? []) this.firstText(label);
				continue;
			}

			if (section.name.toUpperCase() == "MAIN") continue;
			if (last.get(section.name) != section) this.quietly(() => this.menuOf(section));
			else this.menuOf(section);
		}
	}
}

export function columnWords(column: IniColumn, index: number, block: string) {
	return `**${column.name}** - column ${index + 1} of ${block}: ${column.description}`;
}

function analyzeIni(text: string) {
	const reader = new IniReader(text);
	reader.file(text);
	return reader.result("ini");
}

/** A menu file read as Menu Core reads it: problems, names, menus and hints, with their places. */
export function analyze(text: string, format: Format): Analysis {
	return format == "ini" ? analyzeIni(text) : analyzeTree(text, format);
}
