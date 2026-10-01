/**
 * Completion, hover and go to definition in a config file a plugin loads
 * with `configs.load(name, defaults)`: the keys of the object at the cursor,
 * true/false and the names of a union as values, and what a key is - its
 * type, its JSDoc, its default and where the code says it.
 */
import * as jsonc from "jsonc-parser";
import { Format } from "./analyze";
import { ConfigAnalysis } from "./config-check";
import { ConfigField, ConfigLoad, ConfigShape, describe, ObjectShape, SourcePlace } from "./config-scan";
import { around, blockPath, inJsonString, lineShape } from "./cursor";
import { Item } from "./features";
import { lineOf, parseIni } from "./ini";

/** What goes at the cursor: a key of the object at `path`, or the value of `key` in it. */
export type ConfigContext
	= | { type: "key"; format: Format; path: string[]; start: number; end: number; quoted: boolean; section: boolean }
		| { type: "value"; format: Format; path: string[]; key: string; item: boolean; start: number; end: number; quoted: boolean };

const KEY = /[\w$]/;
const VALUE = /[^\s"',[\]{}:#;=]/;

// ---------------------------------------------------------------- INI

function iniContext(text: string, offset: number): ConfigContext | null {
	const document = parseIni(text);
	const line = lineOf(document.lineStarts, offset);
	const prefix = text.slice(document.lineStarts[line], offset);
	const trimmed = prefix.trimStart();
	if (trimmed.startsWith(";")) return null;

	if (trimmed.startsWith("[")) {
		const word = around(text, offset, VALUE);
		return { type: "key", format: "ini", path: [], start: word.start, end: word.end, quoted: false, section: true };
	}

	const state = document.lines[line];
	if (state?.section == null) return null;
	const path = [state.section.name, ...state.blocks.map(block => block.key)];
	if (state.blocks.some(block => block.key.length == 0)) return null;

	if (/^\s*[\w$]*$/.test(prefix)) {
		const word = around(text, offset, KEY);
		return { type: "key", format: "ini", path, start: word.start, end: word.end, quoted: false, section: false };
	}

	const keyed = /^\s*([^=;"]+?)\s*=([^;]*)$/.exec(prefix);
	if (keyed == null) return null;
	const word = around(text, offset, VALUE);
	return { type: "value", format: "ini", path, key: keyed[1], item: false, start: word.start, end: word.end, quoted: false };
}

// ---------------------------------------------------------------- YAML

function yamlContext(text: string, offset: number): ConfigContext | null {
	const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
	const prefix = text.slice(lineStart, offset);
	const lines = text.slice(0, lineStart).split("\n").map(line => line.replace(/\r$/, ""));
	lines.pop();
	const shape = lineShape(prefix);
	const path = blockPath(lines, shape);
	const rest = prefix.slice(shape.content);
	if (/(?:^|\s)#/.test(rest)) return null;

	const keyed = /^("[^"]*"|'[^']*'|[^\s#'"{[][^#]*?)\s*:\s(.*)$/.exec(rest);
	if (keyed != null) {
		const key = keyed[1].replace(/^["']|["']$/g, "");
		const value = keyed[2];
		const word = around(text, offset, VALUE);
		const quoted = (value.split("\"").length - 1) % 2 == 1 || (value.split("'").length - 1) % 2 == 1;
		// `modes: [normal, d` - an item of a list written in [ ].
		const item = value.trimStart().startsWith("[");
		return { type: "value", format: "yaml", path, key, item, start: word.start, end: word.end, quoted };
	}

	if (!/^[\w$"']*$/.test(rest)) return null;
	// `- norm` in a list of values, or the first key of an item of a list of objects.
	if (path.length >= 2 && path[path.length - 1] == "#" && shape.dashes.length > 0 && !/^["']/.test(rest)) {
		const word = around(text, offset, VALUE);
		return { type: "value", format: "yaml", path: path.slice(0, -2), key: path[path.length - 2], item: true, start: word.start, end: word.end, quoted: false };
	}
	const word = around(text, offset, KEY);
	return { type: "key", format: "yaml", path, start: word.start, end: word.end, quoted: false, section: false };
}

// ---------------------------------------------------------------- JSON

function jsonContext(text: string, offset: number): ConfigContext | null {
	const location = jsonc.getLocation(text, offset);
	const path = location.path.map(segment => (typeof segment == "number" ? "#" : segment));
	const node = location.previousNode;
	const inString = inJsonString(text, offset, node);

	if (location.isAtPropertyKey) {
		const word = around(text, offset, KEY);
		return { type: "key", format: "json", path: path.slice(0, -1), start: word.start, end: word.end, quoted: inString, section: false };
	}
	if (path.length == 0) return null;
	const word = inString ? around(text, offset, /[^"]/) : around(text, offset, VALUE);
	if (path[path.length - 1] == "#") {
		if (path.length < 2) return null;
		return { type: "value", format: "json", path: path.slice(0, -2), key: path[path.length - 2], item: true, start: word.start, end: word.end, quoted: inString };
	}
	return { type: "value", format: "json", path: path.slice(0, -1), key: path[path.length - 1], item: false, start: word.start, end: word.end, quoted: inString };
}

export function configContextAt(text: string, offset: number, format: Format): ConfigContext | null {
	if (format == "ini") return iniContext(text, offset);
	if (format == "yaml") return yamlContext(text, offset);
	return jsonContext(text, offset);
}

// ---------------------------------------------------------------- the shape at a path

function fieldOf(shape: ObjectShape, key: string, foldCase: boolean) {
	const lower = key.toLowerCase();
	return shape.fields.find(field => (foldCase ? field.name.toLowerCase() == lower : field.name == key)) ?? null;
}

/** The shape a path of keys leads to; "#" is an item of a list. INI: keys below a section are found in any case. */
export function shapeAt(root: ConfigShape, path: string[], format: Format) {
	let shape: ConfigShape | null = root;
	for (let i = 0; i < path.length && shape != null; i++) {
		const segment = path[i];
		if (shape.kind == "list") shape = segment == "#" ? shape.of : null;
		else if (shape.kind == "map") shape = segment == "#" ? null : shape.of;
		else if (shape.kind == "object") shape = fieldOf(shape, segment, format == "ini" && i > 0)?.shape ?? null;
		else shape = null;
	}
	return shape;
}

// ---------------------------------------------------------------- completion

/** "plugins/settings.ts:3" - how the extension names a place in the code. */
export type DescribePlace = (place: SourcePlace) => string;

function fieldDoc(field: ConfigField) {
	const parts = [`\`${field.name}${field.optional ? "?" : ""}: ${describe(field.shape)}\``];
	if (field.doc) parts.push(field.doc);
	if (field.value != null) parts.push(`Default: \`${field.value}\``);
	return parts.join("\n\n");
}

/** A value as it goes in: in quotes where the format needs them. */
function valueText(context: Extract<ConfigContext, { type: "value" }>, value: string, text: boolean) {
	if (context.quoted) return value;
	if (context.format == "json") return text ? JSON.stringify(value) : value;
	if (context.format == "ini") return /[\s;"]/.test(value) || value.length == 0 ? `"${value}"` : value;
	const plain = /^[^-?:,[\]{}#&*!|>'"%@`\s]/.test(value) && !/[:#]\s|\s$/.test(value) && !/^(?:true|false|null|~|[-+.0-9].*)$/i.test(value);
	return text && !plain ? JSON.stringify(value) : value;
}

function keyItems(shape: ObjectShape, context: { format: Format; start: number; end: number; quoted: boolean; section: boolean }): Item[] {
	const fields = context.section ? shape.fields.filter(field => field.shape.kind == "object" || field.shape.kind == "map") : shape.fields;
	return fields.map((field) => {
		let insertText = field.name;
		const nested = field.shape.kind == "object" || field.shape.kind == "map" || (field.shape.kind == "list" && field.shape.of.kind == "object");
		if (context.format == "yaml") insertText = nested ? `${field.name}:` : `${field.name}: `;
		if (context.format == "ini" && !context.section) insertText = nested ? `${field.name} = {` : `${field.name} = `;
		if (context.format == "json") insertText = context.quoted ? field.name : `"${field.name}": `;
		return { label: field.name, kind: "key", detail: describe(field.shape), documentation: fieldDoc(field), insertText, start: context.start, end: context.end, sortText: `0${field.name}` } satisfies Item;
	});
}

export function configCompletions(context: ConfigContext, load: ConfigLoad): Item[] {
	if (load.shape.kind != "object") return [];

	if (context.type == "key") {
		const shape = shapeAt(load.shape, context.path, context.format);
		return shape?.kind == "object" ? keyItems(shape, context) : [];
	}

	const container = shapeAt(load.shape, context.path, context.format);
	let shape: ConfigShape | null = null;
	if (container?.kind == "object") shape = fieldOf(container, context.key, context.format == "ini" && context.path.length > 0)?.shape ?? null;
	if (container?.kind == "map") shape = container.of;
	// A single value where a list goes is a list of one: a list's values are offered as its items are.
	if (shape?.kind == "list") shape = shape.of;
	if (shape == null) return [];
	// `- ` of a list of objects: the first key of an item.
	if (shape.kind == "object") return context.item && context.format == "yaml" ? keyItems(shape, { ...context, section: false }) : [];

	const values = shape.kind == "boolean" ? ["true", "false"] : shape.kind == "name" ? shape.names : [];
	const kind = shape;
	return values.map((value, index) => {
		const insertText = valueText(context, value, kind.kind == "name");
		return { label: value, kind: "value", detail: describe(kind), insertText, start: context.start, end: context.end, sortText: `0${String(index).padStart(3, "0")}`, filterText: insertText } satisfies Item;
	});
}

// ---------------------------------------------------------------- hover and definition

/** The key of the file at an offset that is a field of the object. */
export function configKeyAt(analysis: ConfigAnalysis, offset: number) {
	return analysis.keys.find(key => key.start <= offset && offset <= key.end) ?? null;
}

/** What a hover over a key says, in markdown. */
export function configHover(analysis: ConfigAnalysis, offset: number, load: ConfigLoad, describePlace: DescribePlace) {
	const key = configKeyAt(analysis, offset);
	if (key == null) return null;
	const parts = [`**${key.path}** - ${fieldDoc(key.field)}`, `Read by \`${load.call}("${load.name}")\` in ${describePlace(load.place)}`];
	return { start: key.start, end: key.end, markdown: parts.join("\n\n") };
}

/** Where the key at an offset is said in the code: the interface member, the defaults' property. */
export function configDefinition(analysis: ConfigAnalysis, offset: number) {
	return configKeyAt(analysis, offset)?.field.places ?? [];
}
