/**
 * What goes where the cursor is in a menu file: a key of the level it is at, a
 * name of a kind (a condition, an action...), a placeholder after `%`, or one
 * of a few values (YES/NO, true/false). Worked out from the text around the
 * cursor, so it works while the file is half written.
 */
import * as jsonc from "jsonc-parser";
import { Format } from "./analyze";
import { around, blockPath, inJsonString, lineShape } from "./cursor";
import { lineOf, parseIni } from "./ini";
import { Field, fieldOf, iniKey, IniKey, INI_LABELS, INI_MAIN, INI_MENU, Level, LEVELS, NameKind } from "./shape";

export interface Replace {
	start: number;
	end: number;
}

export type Context
	= | (Replace & { type: "key"; format: Format; keys: { key: string; description: string }[]; /** JSON: the cursor is inside the key's quotes. */ quoted: boolean })
		| (Replace & { type: "names"; kind: NameKind; menu: string; /** YAML: the value must be put in quotes (it starts with !). */ wrap: boolean; negated: boolean; /** YAML: an entry of `enabled` may be a `{ when, message }` too - its keys. */ keys?: { key: string; description: string }[] })
		| (Replace & { type: "placeholder"; menu: string; /** Whether to add the closing %. */ close: boolean; /** YAML: the value starts with % - it goes in quotes. */ wrap: boolean })
		| (Replace & { type: "values"; values: string[] });

function odd(text: string, character: string) {
	return text.split(character).length % 2 == 0;
}

/** Inside a text value: a placeholder after an open `%`, or nothing. */
function placeholderIn(text: string, offset: number, valueSoFar: string, menu: string, wrap = false): Context | null {
	if (!odd(valueSoFar, "%")) return null;
	const word = around(text, offset);
	return { type: "placeholder", menu, start: word.start, end: word.end, close: text[word.end] != "%", wrap };
}

/** A name of a line of names: the word at the cursor, after its `!`. */
function namesAt(text: string, offset: number, kind: NameKind, menu: string, wrap = false): Context {
	const word = around(text, offset);
	const negated = text[word.start - 1] == "!";
	return { type: "names", kind, menu, start: wrap && negated ? word.start - 1 : word.start, end: word.end, wrap, negated };
}

function fieldKeys(level: Level) {
	return LEVELS[level].map(field => ({ key: field.key, description: field.description }));
}

function iniKeys(list: IniKey[]) {
	return list.map(each => ({ key: each.key, description: each.description }));
}

// ---------------------------------------------------------------- INI

function iniContext(text: string, offset: number): Context | null {
	const document = parseIni(text);
	const line = lineOf(document.lineStarts, offset);
	const state = document.lines[line];
	if (state?.section == null) return null;
	const prefix = text.slice(document.lineStarts[line], offset);
	if (prefix.trimStart().startsWith(";") || prefix.trimStart().startsWith("[")) return null;
	const section = state.section;
	const main = section.name == "MAIN";
	const blocks = state.blocks;
	const menu = section.name;
	const typingKey = /^\s*[A-Z_]*$/i.test(prefix);

	if (blocks.length == 0) {
		const list = main ? INI_MAIN : INI_MENU;
		if (typingKey) {
			const word = around(text, offset);
			return { type: "key", format: "ini", keys: iniKeys(list), start: word.start, end: word.end, quoted: false };
		}

		const keyed = /^\s*([A-Z_]+)\s*=(.*)$/i.exec(prefix);
		if (keyed == null) return null;
		const key = iniKey(list, keyed[1]);
		if (key == null) return null;
		const value = keyed[2].split(";");
		if (value.length > 1) return null;
		if (key.kind == "names") return namesAt(text, offset, key.names!, menu);
		if (key.kind == "flag") {
			const word = around(text, offset);
			return { type: "values", values: ["YES", "NO"], start: word.start, end: word.end };
		}
		if (key.key == "TITLE") return placeholderIn(text, offset, value[0], menu);
		return null;
	}

	const block = blocks[blocks.length - 1];
	if (main && block.key.toUpperCase() == "KEY") {
		if (!typingKey) return null;
		const word = around(text, offset);
		return { type: "key", format: "ini", keys: iniKeys(INI_LABELS), start: word.start, end: word.end, quoted: false };
	}

	const columns = iniKey(INI_MENU, block.key)?.columns;
	const row = prefix.trimStart();
	if (columns == null || !row.startsWith("\"") || !odd(row, "\"")) return null;
	const index = (row.split("\"").length - 2) / 2;
	const column = columns[index];
	if (column == null) return null;
	const valueSoFar = row.slice(row.lastIndexOf("\"") + 1);
	if (column.kind == "names") return namesAt(text, offset, column.names!, menu);
	if (column.placeholders) return placeholderIn(text, offset, valueSoFar, menu);
	return null;
}

// ---------------------------------------------------------------- YAML and JSON

/** The level a path leads to - ["menus", "SHOP", "items", "#"] is an item - with the menu it is in. */
export function levelOfPath(path: string[]) {
	let level: Level = "file";
	let menu = "";
	for (let i = 0; i < path.length; i++) {
		const segment = path[i];
		if (level == "menus") {
			menu = segment;
			level = "menu";
			continue;
		}
		const field = fieldOf(level, segment);
		if (field == null || field.level == null) return null;
		if (field.kind == "list" || field.kind == "requirements") {
			if (path[i + 1] != "#") return null;
			i++;
		}
		level = field.level;
	}
	return { level, menu };
}

/** What goes as the value of `key` in the object `container` leads to. */
function valueContext(text: string, offset: number, container: string[], key: string, valueSoFar: string, format: Format, quoted: boolean): Context | null {
	const found = levelOfPath(container);
	if (found == null) return null;
	const field: Field | undefined = fieldOf(found.level, key);
	if (field == null) return null;
	const unquotedYaml = format == "yaml" && !quoted;

	if (field.kind == "names" || field.kind == "requirements") {
		// `visible: !IS_ALIVE` - an unquoted value starting with ! is a YAML tag: the name goes in quotes.
		const wrap = unquotedYaml && valueSoFar.trimStart().startsWith("!");
		if (format == "json" && !quoted) return null;
		return namesAt(text, offset, field.names!, found.menu, wrap);
	}

	if (field.kind == "text" && field.placeholders) {
		if (format == "json" && !quoted) return null;
		const wrap = unquotedYaml && valueSoFar.trimStart().startsWith("%");
		const context = placeholderIn(text, offset, valueSoFar, found.menu, wrap);
		if (context != null && wrap && context.type == "placeholder") context.start = offset - valueSoFar.trimStart().length;
		return context;
	}

	if (field.kind == "flag" && !quoted) {
		const word = around(text, offset);
		return { type: "values", values: ["true", "false"], start: word.start, end: word.end };
	}

	return null;
}

function yamlContext(text: string, offset: number): Context | null {
	const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
	const prefix = text.slice(lineStart, offset);
	const lines = text.slice(0, lineStart).split("\n");
	lines.pop();
	const shape = lineShape(prefix);
	const path = blockPath(lines.map(line => line.replace(/\r$/, "")), shape);
	const rest = prefix.slice(shape.content);

	// The flow of the rest of the line: `key: value`, `{ a: b, c: `, `[A, B`.
	const frames: { kind: "map" | "seq"; length: number; owner: string | null }[] = [];
	let key: string | null = null;
	let token = 0;
	let quote: string | null = null;
	let quoteAt = -1;
	for (let i = 0; i < rest.length; i++) {
		const character = rest[i];
		if (quote != null) {
			if (character == quote) quote = null;
			continue;
		}
		if (character == "\"" || character == "'") {
			quote = character;
			quoteAt = i;
			continue;
		}
		if (character == "#" && (i == 0 || rest[i - 1] == " ")) return null;
		if (character == ":" && (i + 1 == rest.length || rest[i + 1] == " ")) {
			key = rest.slice(token, i).trim().replace(/^["']|["']$/g, "");
			token = i + 1;
		} else if (character == "{") {
			const top = frames[frames.length - 1];
			frames.push({ kind: "map", length: path.length, owner: key });
			if (key != null) path.push(key);
			else if (top?.kind == "seq") path.push("#");
			key = null;
			token = i + 1;
		} else if (character == "[") {
			frames.push({ kind: "seq", length: path.length, owner: key });
			path.push(key ?? "#");
			key = null;
			token = i + 1;
		} else if (character == ",") {
			if (frames[frames.length - 1]?.kind == "map") key = null;
			token = i + 1;
		} else if (character == "}" || character == "]") {
			const frame = frames.pop();
			if (frame != null) path.length = frame.length;
			key = null;
			token = i + 1;
		}
	}

	const quoted = quote != null;
	const valueSoFar = quoted ? rest.slice(quoteAt + 1) : rest.slice(token);
	const top = frames[frames.length - 1];

	if (key != null) return valueContext(text, offset, path, key, valueSoFar, "yaml", quoted);
	if (top?.kind == "seq" && top.owner != null) return valueContext(text, offset, path.slice(0, -1), top.owner, valueSoFar, "yaml", quoted);
	if (quoted) return null;

	// `- IS_ALIVE` in a block list of names; in `enabled`, or `- when: ...`.
	if (path.length >= 2 && path[path.length - 1] == "#" && shape.dashes.length > 0 && frames.length == 0) {
		const owner = path[path.length - 2];
		const container = levelOfPath(path.slice(0, -2));
		const field = container != null ? fieldOf(container.level, owner) : undefined;
		if (field?.kind == "names") return valueContext(text, offset, path.slice(0, -2), owner, valueSoFar, "yaml", false);
		if (field?.kind == "requirements") {
			const context = valueContext(text, offset, path.slice(0, -2), owner, valueSoFar, "yaml", false);
			if (context?.type == "names" && /^\s*\w*$/.test(valueSoFar)) context.keys = fieldKeys(field.level!);
			return context;
		}
	}

	if (!/^\s*[A-Z_]*$/i.test(valueSoFar)) return null;
	const found = levelOfPath(path);
	if (found == null || found.level == "menus") return null;
	const word = around(text, offset);
	return { type: "key", format: "yaml", keys: fieldKeys(found.level), start: word.start, end: word.end, quoted: false };
}

function jsonContext(text: string, offset: number): Context | null {
	const location = jsonc.getLocation(text, offset);
	const path = location.path.map(segment => (typeof segment == "number" ? "#" : segment));
	const node = location.previousNode;
	const inString = inJsonString(text, offset, node);

	if (location.isAtPropertyKey) {
		const found = levelOfPath(path.slice(0, -1));
		if (found == null || found.level == "menus") return null;
		const word = around(text, offset);
		return { type: "key", format: "json", keys: fieldKeys(found.level), start: word.start, end: word.end, quoted: inString };
	}

	if (path.length == 0) return null;
	const valueSoFar = inString ? text.slice(node!.offset + 1, offset) : "";
	if (path[path.length - 1] == "#") {
		if (path.length < 2) return null;
		return valueContext(text, offset, path.slice(0, -2), path[path.length - 2], valueSoFar, "json", inString);
	}
	return valueContext(text, offset, path.slice(0, -1), path[path.length - 1], valueSoFar, "json", inString);
}

export function contextAt(text: string, offset: number, format: Format): Context | null {
	if (format == "ini") return iniContext(text, offset);
	if (format == "yaml") return yamlContext(text, offset);
	return jsonContext(text, offset);
}
