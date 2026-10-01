/**
 * A config file read as Config Core reads it for `configs.load(name,
 * defaults)` (src/typed.ts of @amxts/config-core, and the reader the build
 * writes for the call), check by check and in the same words - with where
 * each problem and key is, for the editor.
 *
 * Which file a load reads: `configs/<baseDir>/<name>` - the name as it is
 * when it ends in .ini, .yaml, .yml, .json or .jsonc, else the first of
 * those that is there. Here, a file whose path ends with the name.
 *
 * An INI file is read as Config Core's tree of it (src/ini-tree.ts): each
 * [section] an object at the top, its keys found in any case; a line of one
 * value is text, of several a list of text, of none empty; a `key = {` block
 * of `key = value` lines an object, of "quoted" rows a list of them.
 */
import { Fix, Format, Problem } from "./analyze";
import { ConfigField, ConfigLoad, ConfigShape, ObjectShape } from "./config-scan";
import { EXTENSIONS, normalName, readsFile } from "./detect";
import { entryOf, IniEntry, IniValue, parseIni } from "./ini";
import { closest, didYouMean } from "./suggest";
import { Kind, lineEndIn, parseJson, parseYaml, syntaxProblems, TNode } from "./tree";

/** The loads that read the file at `path`. */
export function loadsOf(path: string, loads: ConfigLoad[]) {
	return loads.filter(load => readsFile(path, load.name));
}

/**
 * For a name without an extension: the files of that name next to `path`, in
 * the order Config Core looks for them - `exists` says which are there. Two
 * or more are an error in the server console, and only the first is read.
 */
export function namesakes(path: string, name: string, exists: (path: string) => boolean) {
	const wanted = normalName(name);
	if (EXTENSIONS.some(extension => wanted.endsWith(extension))) return [];
	const lower = path.toLowerCase();
	const extension = EXTENSIONS.find(each => lower.endsWith(each));
	if (extension == null) return [];
	const stem = path.slice(0, path.length - extension.length);
	return EXTENSIONS.map(each => stem + each).filter(each => each.toLowerCase() == lower || exists(each));
}

/** The message of a file that is not read, a namesake before it being there - "" when it is read. */
export function namesakeMessage(path: string, found: string[]) {
	if (found.length < 2 || found[0].toLowerCase() == path.toLowerCase()) return "";
	const base = (each: string) => each.replaceAll("\\", "/").split("/").pop()!;
	return `${found.map(base).join(", ")} are all there - ${base(found[0])} is read; keep one of them`;
}

// ---------------------------------------------------------------- the file as a tree

/** A value of the file, with where it is: YAML and JSON as parsed, INI as Config Core's tree of it. */
export interface CNode extends TNode {
	items: CNode[];
	/** INI: the keys of this object are found in any case. */
	foldCase?: boolean;
}

function made(kind: Kind, key: string, start: number, end: number): CNode {
	return { kind, key, keyStart: -1, keyEnd: -1, start, end, text: "", textStart: -1, items: [] };
}

/** A line of values: none is empty, one is text, several are a list of text. */
function valuesNode(values: IniValue[], at: number): CNode {
	if (values.length == 0) return made("null", "", at, at);
	const text = (value: IniValue): CNode => ({ ...made("string", "", value.start, value.end), text: value.text, textStart: value.start });
	if (values.length == 1) return text(values[0]);
	const list = made("array", "", values[0].start, values[values.length - 1].end);
	list.items = values.map(text);
	return list;
}

function entryNode(entry: IniEntry): CNode {
	let node: CNode;
	if (entry.rows == null) {
		node = valuesNode(entry.values, entry.end);
	} else {
		const keyed = entry.rows.every(row => row.key.length > 0);
		node = made(keyed ? "object" : "array", "", entry.start, entry.end);
		node.foldCase = keyed;
		for (const row of entry.rows) {
			if (keyed && memberOf(node, row.key) != null) continue;
			if (row.key.length > 0 && !keyed) {
				// A `key = value` line among rows: an object with that one member.
				const one = made("object", "", row.start, row.end);
				one.foldCase = true;
				one.items.push(entryNode(row));
				node.items.push(one);
			} else {
				node.items.push(entryNode(row));
			}
		}
	}
	if (entry.key.length > 0) {
		node.key = entry.key;
		node.keyStart = entry.keyStart;
		node.keyEnd = entry.keyEnd;
	}
	return node;
}

/** An INI text as Config Core's tree: its sections an object of objects; a name found twice is the last section of that name. */
export function iniTree(text: string): CNode {
	const document = parseIni(text);
	const root = made("object", "", 0, text.length);
	for (const section of document.sections) {
		const node = made("object", section.name, section.start, section.end);
		node.keyStart = section.nameStart;
		node.keyEnd = section.nameEnd;
		node.foldCase = true;
		for (const entry of section.entries) {
			// The first of a key found twice is the one read.
			if (entry.key.length > 0 && entryOf(section.entries, entry.key) != entry) continue;
			node.items.push(entryNode(entry));
		}
		const known = root.items.findIndex(each => each.key == section.name);
		if (known >= 0) root.items[known] = node;
		else root.items.push(node);
	}
	return root;
}

/** A member of an object by its key: in any case where the object folds case (INI). */
export function memberOf(node: CNode | null, key: string) {
	if (node == null || node.kind != "object") return null;
	const lower = key.toLowerCase();
	return node.items.find(each => (node.foldCase ? each.key.toLowerCase() == lower : each.key == key)) ?? null;
}

// ---------------------------------------------------------------- the checks

/** A key of the file that is a field of the object: for hover and go to definition. */
export interface KeyPlace {
	start: number;
	end: number;
	/** "round.time", "items[].name". */
	path: string;
	field: ConfigField;
}

export interface ConfigAnalysis {
	format: Format;
	problems: Problem[];
	keys: KeyPlace[];
}

const YES = ["true", "yes", "on"];
const NO = ["false", "no", "off"];

/** "a list", "true or false", ... - a value's kind as Config Core's messages say it. */
function kindWords(kind: Kind) {
	if (kind == "object") return "an object";
	if (kind == "array") return "a list";
	if (kind == "boolean") return "true or false";
	if (kind == "number") return "a number";
	if (kind == "string") return "text";
	return "empty";
}

/** What a kind asks for, as a message says it. */
function wantWords(kind: string) {
	if (kind == "number" || kind == "numbers") return "a number";
	if (kind == "boolean" || kind == "booleans") return "true or false";
	return "text";
}

function isScalar(node: CNode) {
	return node.kind == "string" || node.kind == "number" || node.kind == "boolean";
}

function numberOf(node: CNode) {
	if (node.kind == "number") return Number(node.text);
	if (node.kind != "string") return NaN;
	const text = node.text.trim();
	return text.length > 0 ? parseFloat(text) : NaN;
}

/** 1 true, 0 false, -1 neither - Config Core's one rule (booleanText of src/tree.ts): true or false, a number, or yes, no, on, off, true, false in any case or a number as text. */
function booleanOf(node: CNode) {
	if (node.kind == "boolean") return node.text == "true" ? 1 : 0;
	if (node.kind == "number") return Number(node.text) != 0 ? 1 : 0;
	if (node.kind != "string") return -1;
	const text = node.text.trim().toLowerCase();
	if (YES.includes(text)) return 1;
	if (NO.includes(text)) return 0;
	const value = parseFloat(text);
	if (isNaN(value)) return -1;
	return value != 0 ? 1 : 0;
}

/** A list's kind for Config Core's checks: "texts", "numbers", "booleans", "names". */
function listKind(of: ConfigShape) {
	if (of.kind == "name") return "names";
	return of.kind == "text" ? "texts" : `${of.kind}s`;
}

function isKind(node: CNode, kind: string, known: string[]) {
	if (kind == "text" || kind == "texts") return isScalar(node);
	if (kind == "number" || kind == "numbers") return !isNaN(numberOf(node));
	if (kind == "boolean" || kind == "booleans") return booleanOf(node) >= 0;
	return isScalar(node) && known.includes(node.text);
}

/** The fields of an object the file leaves out that the object needs. */
function required(shape: ObjectShape) {
	return shape.fields.filter(field => !field.optional).map(field => field.name);
}

class Checker {
	problems: Problem[] = [];
	keys: KeyPlace[] = [];

	constructor(
		private source: string,
		private format: Format,
	) {}

	lineEnd(start: number, end: number) {
		return lineEndIn(this.source, start, end);
	}

	warn(start: number, end: number, message: string, code: Problem["code"], fix?: Fix) {
		this.problems.push({ start, end: Math.max(end, start + 1), message, severity: "warning", code, fix });
	}

	/** Where a node is: its key, or the first line of its value. */
	place(node: CNode) {
		if (node.keyStart >= 0) return [node.keyStart, node.keyEnd];
		return [node.start, this.lineEnd(node.start, node.end)];
	}

	/** Where a value is: the value, or its key when it has none written. */
	valuePlace(node: CNode) {
		if (node.end > node.start) return [node.start, this.lineEnd(node.start, node.end)];
		return this.place(node);
	}

	/** A value's problem: at the value. */
	say(node: CNode, message: string, code: Problem["code"] = "kind", fix?: Fix) {
		const [start, end] = this.valuePlace(node);
		this.warn(start, end, message, code, fix);
	}

	nameOf(node: CNode) {
		return node.key.length > 0 ? `"${node.key}"` : "the item";
	}

	outcome(node: CNode) {
		return node.key.length > 0 ? "the default stays" : "it is left out";
	}

	/** Whether one value is what `kind` asks for; says so when it is not. */
	fits(node: CNode, kind: string, known: string[]) {
		if (isKind(node, kind, known)) return true;

		if ((kind == "name" || kind == "names") && isScalar(node)) {
			const listed = known.map(name => `"${name}"`).join(", ");
			const suggested = closest(node.text, known);
			const fix = suggested != null && node.kind == "string" && node.textStart >= 0 ? { title: `Change to "${suggested}"`, start: node.textStart, end: node.textStart + node.text.length, text: suggested } : undefined;
			this.say(node, `${this.nameOf(node)} is "${node.text}", not one of ${listed}${didYouMean(suggested)} - ${this.outcome(node)}`, "kind", fix);
			return false;
		}

		const what = isScalar(node) ? `${kindWords(node.kind)} ("${node.text}")` : kindWords(node.kind);
		this.say(node, `${this.nameOf(node)} is ${what}, not ${wantWords(kind)} - ${this.outcome(node)}`);
		return false;
	}

	/** Config Core's `is()`: whether a value is there and of the kind; a list's items are checked after. */
	is(node: CNode | null, kind: string, known: string[] = []) {
		if (node == null) return false;
		if (node.kind == "null") return this.format == "ini" && ["text", "texts", "numbers", "booleans", "names"].includes(kind);
		const list = kind == "texts" || kind == "numbers" || kind == "booleans" || kind == "names";
		if (!list) return this.fits(node, kind, known);
		if (node.kind == "array" || isScalar(node)) return true;
		this.say(node, `${this.nameOf(node)} is ${kindWords(node.kind)}, not a list - the default stays`);
		return false;
	}

	/** Config Core's `objectOf()`: an object, its keys checked against the fields. */
	objectOf(node: CNode | null, shape: ObjectShape, path: string, defaults: string) {
		if (node == null || node.kind == "null") return null;

		if (node.kind != "object") {
			this.say(node, `${this.nameOf(node)} is ${kindWords(node.kind)}, not an object - ${defaults}`);
			return null;
		}

		const known = shape.fields.map(field => field.name);
		const inside = node.key.length > 0 ? ` in "${node.key}"` : "";
		for (const child of node.items) {
			const field = shape.fields.find(each => memberOf(node, each.name) == child);
			if (field != null) {
				if (child.keyStart >= 0) this.keys.push({ start: child.keyStart, end: child.keyEnd, path: path.length > 0 ? `${path}.${field.name}` : field.name, field });
				continue;
			}
			const suggested = closest(child.key, known);
			const [start, end] = this.place(child);
			const fix = suggested != null && child.keyStart >= 0 ? { title: `Change to "${suggested}"`, start: child.keyStart, end: child.keyEnd, text: this.keyText(child, suggested) } : undefined;
			this.warn(start, end, `unknown key "${child.key}"${inside}${didYouMean(suggested)}`, "unknown-key", fix);
		}
		return node;
	}

	/** A key as it goes in where `node`'s key is written: in its quotes, when it has them. */
	keyText(node: CNode, key: string) {
		const written = this.source.slice(node.keyStart, node.keyEnd);
		const quote = written[0] == "\"" || written[0] == "'" ? written[0] : "";
		return `${quote}${key}${quote}`;
	}

	/** Config Core's `need()`: the fields an object made from the file leaves out. */
	need(node: CNode, keys: string[]) {
		for (const key of keys) {
			const found = memberOf(node, key);
			if (found == null || found.kind == "null") {
				const [start, end] = this.place(node);
				this.warn(start, end, `"${key}" is missing - it is left empty`, "shape");
			}
		}
	}

	/** The fields of an object read from `node`, an object checked. */
	read(shape: ObjectShape, node: CNode, path: string) {
		for (const field of shape.fields) {
			const at = path.length > 0 ? `${path}.${field.name}` : field.name;
			this.value(field, memberOf(node, field.name), at);
		}
	}

	value(field: ConfigField, node: CNode | null, path: string) {
		const shape = field.shape;
		switch (shape.kind) {
			case "text":
			case "number":
			case "boolean":
				this.is(node, shape.kind);
				return;
			case "name":
				this.is(node, "name", shape.names);
				return;
			case "list":
				this.list(shape.of, node, path);
				return;
			case "map":
				this.map(shape.of, node);
				return;
			case "object": {
				const object = this.objectOf(node, shape, path, "the defaults stay");
				if (object == null) return;
				if (field.optional && field.value == null) this.need(object, required(shape));
				this.read(shape, object, path);
			}
		}
	}

	list(of: ConfigShape, node: CNode | null, path: string) {
		if (of.kind == "unknown") return;
		if (of.kind == "list") {
			this.lists(of.of, node);
			return;
		}

		if (of.kind != "object") {
			const kind = listKind(of);
			if (!this.is(node, kind)) return;
			const items = node!.kind == "array" ? node!.items : node!.kind != "null" ? [node!] : [];
			for (const item of items) this.fits(item, kind, of.kind == "name" ? of.names : []);
			return;
		}

		if (node == null || node.kind == "null") return;
		if (node.kind != "array") {
			this.say(node, `${this.nameOf(node)} is ${kindWords(node.kind)}, not a list - the default stays`);
			return;
		}
		for (const item of node.items) {
			if (item.kind != "object") {
				this.say(item, `the item is ${kindWords(item.kind)}, not an object - it is left out`);
				continue;
			}
			this.objectOf(item, of, `${path}[]`, "the defaults stay");
			this.need(item, required(of));
			this.read(of, item, `${path}[]`);
		}
	}

	/** Config Core's `lists()`: rows of values - each a list or one value; in INI an empty value or block is none. */
	lists(of: ConfigShape, node: CNode | null) {
		if (node == null || node.kind == "null") return;
		if (this.format == "ini" && node.kind == "object" && node.items.length == 0) return;
		if (node.kind != "array") {
			this.say(node, `${this.nameOf(node)} is ${kindWords(node.kind)}, not a list - the default stays`);
			return;
		}
		const kind = listKind(of);
		for (const row of node.items) {
			if (row.kind != "array" && !isScalar(row)) {
				this.say(row, `the item is ${kindWords(row.kind)}, not a list - it is left out`);
				continue;
			}
			for (const item of row.kind == "array" ? row.items : [row]) this.fits(item, kind, of.kind == "name" ? of.names : []);
		}
	}

	map(of: ConfigShape, node: CNode | null) {
		if (node == null || node.kind == "null" || of.kind == "unknown") return;
		if (node.kind != "object") {
			this.say(node, `${this.nameOf(node)} is ${kindWords(node.kind)}, not an object - the default stays`);
			return;
		}
		const kind = of.kind == "name" ? "name" : of.kind;
		for (const entry of node.items) this.is(entry, kind, of.kind == "name" ? of.names : []);
	}

	/** Config Core's `open()`: what an INI file has no place for, said at the top of the file. */
	iniMisfits(shape: ObjectShape) {
		const first = Math.max(this.source.search(/\S/), 0);
		const report = (path: string, why: string) => {
			const [start, end] = [first, this.lineEnd(first, this.source.length)];
			this.warn(start, end, `"${path}" cannot be in an INI file, ${why} - it stays the default; write the config in YAML or JSON`, "shape");
		};
		const walk = (object: ObjectShape, path: string) => {
			for (const field of object.fields) {
				const at = path.length > 0 ? `${path}.${field.name}` : field.name;
				if (field.shape.kind == "list" && field.shape.of.kind == "object") report(at, "which has no lists of objects");
				else if (path.length == 0 && field.shape.kind != "object" && field.shape.kind != "map") report(at, "whose values are in [sections]");
				else if (field.shape.kind == "object") walk(field.shape, at);
			}
		};
		walk(shape, "");
	}
}

/** A config file checked against the object a load reads it into. */
export function checkConfig(text: string, format: Format, shape: ObjectShape | { kind: "unknown" }): ConfigAnalysis {
	const checker = new Checker(text, format);
	let root: CNode | null;

	if (format == "ini") {
		root = iniTree(text);
	} else {
		const parsed = format == "yaml" ? parseYaml(text) : parseJson(text);
		root = parsed.root as CNode | null;
		checker.problems.push(...syntaxProblems(text, format, parsed));
	}

	if (shape.kind == "object") {
		if (format == "ini") checker.iniMisfits(shape);
		const top = checker.objectOf(root, shape, "", "the defaults stay");
		if (top != null) checker.read(shape, top, "");
	}
	return { format, problems: checker.problems, keys: checker.keys };
}
