/**
 * An INI file as Config Core reads it (`readSections()` of
 * @amxts/config-core's `src/index.ts`), line by line - with where each key and
 * value is, for the editor.
 *
 * - a line starting with `;` is a comment, `[NAME]` starts a section, and
 *   lines before the first section belong to none;
 * - `KEY = {` opens a block and `}` closes it; inside a block, a line
 *   starting with `"` is a row of "quoted" "values" (only spaces between them,
 *   a tab ends the row), anything else `key = value`;
 * - a value is cut at `;`, split on spaces and tabs, a "quoted" word kept
 *   whole and an empty "" dropped.
 */

/** A value with where its text is (inside its quotes, when it has them). */
export interface IniValue {
	text: string;
	start: number;
	end: number;
}

export interface IniEntry {
	/** "" for a row of quoted values. */
	key: string;
	keyStart: number;
	keyEnd: number;
	line: number;
	/** Where the line's text starts and ends, spaces aside. */
	start: number;
	end: number;
	values: IniValue[];
	/** The rows of a block; null for a line with values. */
	rows: IniEntry[] | null;
}

export interface IniSection {
	name: string;
	nameStart: number;
	nameEnd: number;
	line: number;
	/** From the `[` to the end of the section's last line. */
	start: number;
	end: number;
	entries: IniEntry[];
}

/** Where the reader is at the start of a line: its section and the blocks open, innermost last. */
export interface LineState {
	section: IniSection | null;
	blocks: IniEntry[];
}

export interface IniDocument {
	sections: IniSection[];
	/** What each line is inside of, by line number from 0. */
	lines: LineState[];
	lineStarts: number[];
}

export function lineStartsOf(text: string) {
	const starts = [0];
	for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) starts.push(at + 1);
	return starts;
}

function isSpace(character: string) {
	return character == " " || character == "\t";
}

/** `"a b" c ""` from `offset`: the words and where each is. */
function splitValues(text: string, offset: number) {
	const words: IniValue[] = [];
	let at = 0;
	while (at < text.length) {
		while (at < text.length && isSpace(text[at])) at++;
		if (at >= text.length) break;

		if (text[at] == "\"") {
			let close = text.indexOf("\"", at + 1);
			if (close < 0) close = text.length;
			const word = text.slice(at + 1, close);
			if (word.length > 0) words.push({ text: word, start: offset + at + 1, end: offset + close });
			at = close + 1;
			continue;
		}

		let end = at;
		while (end < text.length && !isSpace(text[end])) end++;
		words.push({ text: text.slice(at, end), start: offset + at, end: offset + end });
		at = end;
	}
	return words;
}

/** A row of "quoted" "values", each trimmed; only spaces may stand between them. */
function quotedRow(text: string, offset: number) {
	const values: IniValue[] = [];
	let at = 0;
	while (text[at] == "\"") {
		let close = text.indexOf("\"", at + 1);
		if (close < 0) close = text.length;
		const raw = text.slice(at + 1, close);
		const lead = raw.length - raw.trimStart().length;
		const trimmed = raw.trim();
		values.push({ text: trimmed, start: offset + at + 1 + lead, end: offset + at + 1 + lead + trimmed.length });
		at = close + 1;
		while (text[at] == " ") at++;
	}
	return values;
}

/** `key = value ; comment` as the key and the values. */
function keyedLine(line: string, offset: number, lineNumber: number, end: number) {
	const equals = line.indexOf("=");
	const rawKey = equals < 0 ? "" : line.slice(0, equals);
	const key = rawKey.trim();
	const keyStart = offset + (rawKey.length - rawKey.trimStart().length);
	const valueFrom = equals < 0 ? 0 : equals + 1;
	const value = line.slice(valueFrom).split(";")[0];
	const entry: IniEntry = { key, keyStart, keyEnd: keyStart + key.length, line: lineNumber, start: offset, end, values: splitValues(value, offset + valueFrom), rows: null };
	return entry;
}

export function parseIni(text: string): IniDocument {
	const lineStarts = lineStartsOf(text);
	const sections: IniSection[] = [];
	const lines: LineState[] = [];
	let section: IniSection | null = null;
	const open: IniEntry[] = [];

	for (let number = 0; number < lineStarts.length; number++) {
		const lineStart = lineStarts[number];
		let raw = text.slice(lineStart, number + 1 < lineStarts.length ? lineStarts[number + 1] - 1 : text.length);
		if (raw.endsWith("\r")) raw = raw.slice(0, -1);
		const lead = raw.length - raw.trimStart().length;
		const line = raw.trim();
		const start = lineStart + lead;
		const end = start + line.length;

		if (line.startsWith("[")) {
			const close = line.indexOf("]");
			const name = close < 0 ? line.slice(1) : line.slice(1, close);
			section = { name, nameStart: start + 1, nameEnd: start + 1 + name.length, line: number, start, end, entries: [] };
			sections.push(section);
			open.length = 0;
			lines.push({ section, blocks: [] });
			continue;
		}

		lines.push({ section, blocks: open.slice() });
		if (line.length == 0 || line.startsWith(";")) continue;
		// Lines before the first section belong to none.
		if (section == null) continue;
		section.end = end;

		if (line.startsWith("}")) {
			open.pop();
			continue;
		}

		const into = open.length > 0 ? open[open.length - 1].rows! : section.entries;

		if (line.includes("=") && line.endsWith("{")) {
			const block = keyedLine(line, start, number, end);
			block.values = [];
			block.rows = [];
			into.push(block);
			open.push(block);
			continue;
		}

		if (open.length > 0 && line.startsWith("\"")) {
			into.push({ key: "", keyStart: start, keyEnd: start, line: number, start, end, values: quotedRow(line, start), rows: null });
			continue;
		}

		into.push(keyedLine(line, start, number, end));
	}

	return { sections, lines, lineStarts };
}

/** The first entry of that key, case aside - the one Config Core reads. */
export function entryOf(entries: IniEntry[], key: string) {
	const lower = key.toLowerCase();
	return entries.find(entry => entry.key.toLowerCase() == lower);
}

/** The line of an offset, from 0. */
export function lineOf(lineStarts: number[], offset: number) {
	let low = 0;
	let high = lineStarts.length - 1;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (lineStarts[middle] <= offset) low = middle;
		else high = middle - 1;
	}
	return low;
}
