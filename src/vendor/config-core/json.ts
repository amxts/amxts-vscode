// Copied from @amxts/config-core 0.1.0 (f9978d1) src/json.ts by scripts/vendor.ts - do not edit.
// @ts-nocheck
/**
 * JSON for Config Core, with what JSONC adds: // and /* *\/ comments and a
 * comma after the last member or item. Read into the tree and written back.
 * Not part of the API.
 */
import { TreeDocument, TreeNode } from "./internal";
import { BACKSLASH, isControl, isDigits, isHexDigits, isScalar, lineStarts, makeNode, numberNode, placeOf, unicodeEscape, writeComments } from "./tree";

/** Escapes of JSON text: the letter after the backslash, and what it stands for, at the same place. */
const ESCAPE_LETTERS = "\"\\/bfnrt";
const ESCAPED = "\"\\/\u0008\u000C\u000A\u000D\u0009";

function isWhitespace(character: string) {
	return character == " " || character == "\t" || character == "\n";
}

/** A number as JSON writes one: -12, 3.5, 1e-3 - no +, no leading zeros, no bare dot. */
function isJsonNumber(text: string) {
	const body = text.startsWith("-") ? text.slice(1) : text;
	let exponent = body.indexOf("e");
	if (exponent < 0) exponent = body.indexOf("E");
	let mantissa = body;

	if (exponent >= 0) {
		mantissa = body.slice(0, exponent);
		const power = body.slice(exponent + 1);
		if (!isDigits(power.startsWith("-") || power.startsWith("+") ? power.slice(1) : power)) return false;
	}

	const dot = mantissa.indexOf(".");
	const whole = dot < 0 ? mantissa : mantissa.slice(0, dot);
	if (!isDigits(whole) || (whole.length > 1 && whole.startsWith("0"))) return false;
	return dot < 0 || isDigits(mantissa.slice(dot + 1));
}

/** Reads a JSON or JSONC text into the tree; the first thing it cannot read stops it, with the place. */
export class JsonReader {
	pos = 0;
	/** What stopped the reading; "" while nothing has. */
	error = "";
	errorAt = 0;
	/** One level of indentation as the text has it; "" until an indented line is met. */
	indent = "";
	/** Comment and blank lines waiting for the value they are written before. */
	pending: string[] | null = null;
	starts: number[];

	constructor(public text: string) {
		this.starts = lineStarts(text);
	}

	get failed() {
		return this.error.length > 0;
	}

	fail(at: number, message: string) {
		if (this.failed) return;
		this.error = message;
		this.errorAt = at;
	}

	placeAt(at: number) {
		return placeOf(this.starts, at);
	}

	takeComments() {
		const taken = this.pending;
		this.pending = null;
		return taken;
	}

	keep(line: string) {
		let list = this.pending;

		if (list == null) {
			list = [];
			this.pending = list;
		}

		list.push(line);
	}

	/**
	 * Skips spaces and comments. A comment on a line of its own is kept for the
	 * value after it, and so is a blank line; one after a value on its line is
	 * dropped.
	 */
	skip() {
		let lineEnds = 0;
		let blankKept = false;

		for (;;) {
			const character = this.text.charAt(this.pos);

			if (isWhitespace(character)) {
				if (character == "\n") lineEnds++;
				if (character == "\n" && lineEnds >= 2 && !blankKept) this.keep("");
				if (character == "\n" && lineEnds >= 2) blankKept = true;
				if (character == "\n" && this.indent.length == 0) this.noteIndent(this.pos + 1);
				this.pos++;
				continue;
			}

			if (character != "/") return;
			const next = this.text.charAt(this.pos + 1);
			const own = lineEnds > 0 || this.pos == 0;

			if (next == "/") {
				const end = this.text.indexOf("\n", this.pos);
				const stop = end < 0 ? this.text.length : end;
				if (own) this.keep(this.text.slice(this.pos, stop).trim());
				this.pos = stop;
			} else if (next == "*") {
				const end = this.text.indexOf("*/", this.pos + 2);

				if (end < 0) {
					this.fail(this.pos, "a /* comment that is never closed with */");
					return;
				}

				if (own) {
					for (const line of this.text.slice(this.pos, end + 2).split("\n")) this.keep(line.trim());
				}

				this.pos = end + 2;
			} else {
				return;
			}

			lineEnds = 0;
			blankKept = false;
		}
	}

	noteIndent(start: number) {
		let end = start;
		while (this.text.charAt(end) == " " || this.text.charAt(end) == "\t") end++;
		const next = this.text.charAt(end);
		if (end > start && next != "\n" && next != "") this.indent = this.text.slice(start, end);
	}

	/** The document: one value, spaces and comments around it. */
	read() {
		this.skip();

		if (this.pos >= this.text.length) {
			const empty = makeNode("object", "", "", { line: 1, column: 1 });
			empty.comments = this.takeComments();
			return empty;
		}

		const comments = this.takeComments();
		const root = this.value();
		root.comments = comments;
		this.skip();
		if (this.pos < this.text.length) this.fail(this.pos, "unexpected text after the end of the value");
		return root;
	}

	value() {
		const at = this.pos;
		const first = this.text.charAt(at);
		if (first == "{") return this.object();
		if (first == "[") return this.array();
		if (first == "\"") return this.string();
		let end = at;
		while (end < this.text.length && !",]}/ \t\n".includes(this.text.charAt(end))) end++;
		const word = this.text.slice(at, end);
		const place = this.placeAt(at);
		this.pos = end;
		if (word == "true" || word == "false") return makeNode("boolean", "", word, place);
		if (word == "null") return makeNode("null", "", word, place);
		if (isJsonNumber(word)) return numberNode(word, parseFloat(word), place);
		if (word.length == 0) this.fail(at, first.length > 0 ? `unexpected ${first}` : "the text ends where a value should be");
		else if (first == "'") this.fail(at, "text is written in double quotes");
		else this.fail(at, `"${word}" is not a value - text is written in double quotes`);
		return makeNode("null", "", "", place);
	}

	object() {
		const node = makeNode("object", "", "", this.placeAt(this.pos));
		this.pos++;

		while (!this.failed) {
			this.skip();
			if (this.failed) return node;

			if (this.text.charAt(this.pos) == "}") {
				this.pos++;
				this.takeComments();
				return node;
			}

			if (this.text.charAt(this.pos) != "\"") {
				this.fail(this.pos, this.pos >= this.text.length ? "the object is never closed with }" : "a key is written in double quotes");
				return node;
			}

			const comments = this.takeComments();
			const keyAt = this.pos;
			const key = this.string().text;
			this.skip();

			if (this.text.charAt(this.pos) != ":") {
				this.fail(this.pos, "expected : after the key");
				return node;
			}

			this.pos++;
			this.skip();
			this.takeComments();
			const value = this.value();
			if (this.failed) return node;
			const twice = node.items.find(each => each.key == key);

			if (twice != null) {
				this.fail(keyAt, `"${key}" is here twice - first on line ${twice.line}`);
				return node;
			}

			const place = this.placeAt(keyAt);
			value.key = key;
			value.line = place.line;
			value.column = place.column;
			value.comments = comments;
			node.items.push(value);
			if (!this.comma("}")) return node;
		}
		return node;
	}

	array() {
		const node = makeNode("array", "", "", this.placeAt(this.pos));
		this.pos++;

		while (!this.failed) {
			this.skip();
			if (this.failed) return node;

			if (this.text.charAt(this.pos) == "]") {
				this.pos++;
				this.takeComments();
				return node;
			}

			if (this.pos >= this.text.length) {
				this.fail(this.pos, "the array is never closed with ]");
				return node;
			}

			const comments = this.takeComments();
			const item = this.value();
			if (this.failed) return node;
			item.comments = comments;
			node.items.push(item);
			if (!this.comma("]")) return node;
		}
		return node;
	}

	/** After a member or an item: a comma, or the bracket that closes; false when it is neither. */
	comma(close: string) {
		this.skip();
		const next = this.text.charAt(this.pos);

		if (next == ",") {
			this.pos++;
			return true;
		}

		if (next != close) this.fail(this.pos, `expected , or ${close}`);
		return next == close;
	}

	string() {
		const at = this.pos;
		let value = "";
		let i = at + 1;

		for (;;) {
			const character = this.text.charAt(i);

			if (character == "\"") {
				i++;
				break;
			}

			if (character == "" || character == "\n") {
				this.fail(at, "text that is never closed with \"");
				break;
			}

			if (character == BACKSLASH) {
				const letter = this.text.charAt(i + 1);
				const known = ESCAPE_LETTERS.indexOf(letter);
				const hex = this.text.slice(i + 2, i + 6);

				if (known >= 0 && letter.length == 1) {
					value += ESCAPED.charAt(known);
					i += 2;
				} else if (letter == "u" && hex.length == 4 && isHexDigits(hex)) {
					value += String.fromCharCode(parseInt(hex, 16));
					i += 6;
				} else {
					this.fail(i, `an unknown escape ${BACKSLASH}${letter}`);
					break;
				}

				continue;
			}

			value += character;
			i++;
		}

		this.pos = i;
		return makeNode("string", "", value, this.placeAt(at));
	}
}

/** Text in double quotes, escaped as JSON escapes it. */
export function jsonText(text: string) {
	let quoted = "";
	for (const character of text.split("")) {
		if (character == "\"" || character == BACKSLASH) quoted += `${BACKSLASH}${character}`;
		else if (character == "\n") quoted += `${BACKSLASH}n`;
		else if (character == "\t") quoted += `${BACKSLASH}t`;
		else if (isControl(character)) quoted += unicodeEscape(character);
		else quoted += character;
	}
	return `"${quoted}"`;
}

function scalar(node: TreeNode) {
	if (node.kind == "string") return jsonText(node.text);
	if (node.kind == "number" && node.text.length > 0) return node.text;
	// JSON has no NaN and no Infinity.
	if (node.kind == "number") return isFinite(node.value) ? `${node.value}` : "null";
	if (node.kind == "boolean") return node.text;
	return "null";
}

/** An array of a few short scalars fits on one line: ["a", "b"]. */
function oneLine(array: TreeNode) {
	if (!array.items.every(item => (isScalar(item) || item.kind == "null") && item.comments == null)) return "";
	const line = `[${array.items.map(scalar).join(", ")}]`;
	return line.length <= 60 ? line : "";
}

/** A value's lines at `pad`: its first line goes after `head` (a key, or nothing), its last gets `end` (a comma, or nothing). */
function writeValue(lines: string[], node: TreeNode, head: string, end: string, pad: string, unit: string) {
	const container = node.kind == "object" || node.kind == "array";

	if (!container || node.items.length == 0) {
		const empty = node.kind == "object" ? "{}" : "[]";
		lines.push(`${pad}${head}${container ? empty : scalar(node)}${end}`);
		return;
	}

	const short = node.kind == "array" ? oneLine(node) : "";

	if (short.length > 0) {
		lines.push(`${pad}${head}${short}${end}`);
		return;
	}

	lines.push(`${pad}${head}${node.kind == "object" ? "{" : "["}`);
	const inner = pad + unit;
	for (let i = 0; i < node.items.length; i++) {
		const each = node.items[i];
		writeComments(lines, each.comments, inner);
		const key = node.kind == "object" ? `${jsonText(each.key)}: ` : "";
		writeValue(lines, each, key, i < node.items.length - 1 ? "," : "", inner, unit);
	}
	lines.push(`${pad}${node.kind == "object" ? "}" : "]"}${end}`);
}

/** The document as JSON lines, its comments kept. */
export function writeJson(document: TreeDocument) {
	const lines: string[] = [];
	const unit = document.indent.length > 0 ? document.indent : "  ";
	writeComments(lines, document.root.comments, "");
	writeValue(lines, document.root, "", "", "", unit);
	writeComments(lines, document.tail, "");
	return lines;
}
