// Copied from @amxts/config-core 0.1.0 (f9978d1) src/yaml.ts by scripts/vendor.ts - do not edit.
// @ts-nocheck
/**
 * YAML for Config Core: the part of it configs are written in, read into the
 * tree and written back. Block and flow mappings and lists, plain, quoted and
 * block (| and >) text, comments, one document. Anchors, aliases, tags,
 * complex keys, directives and several documents in a file are not read:
 * the reader stops there and says where. Not part of the API.
 */
import { Place, TreeDocument, TreeNode } from "./internal";
import { jsonText } from "./json";
import { BACKSLASH, isControl, isDigits, isHexDigits, isScalar, lineStarts, makeNode, numberNode, placeOf, writeComments } from "./tree";

const NULLS = ["", "~", "null", "Null", "NULL"];
const TRUES = ["true", "True", "TRUE"];
const FALSES = ["false", "False", "FALSE"];
const INFINITIES = [".inf", ".Inf", ".INF"];
const NANS = [".nan", ".NaN", ".NAN"];
/** What a plain value cannot start with: YAML reads it as something else. */
const INDICATORS = "-?:,[]{}#&*!|>'\"%@`";
/** Escapes of double-quoted text: the letter after the backslash, and what it stands for, at the same place. */
const ESCAPE_LETTERS = "0abtnvfre \"/\\N";
const ESCAPED = "\u0000\u0007\u0008\u0009\u000A\u000B\u000C\u000D\u001B \"/\\\u0085";

function isSpace(character: string) {
	return character == " " || character == "\t";
}

/** A space, a line end, or the end of the text. */
function isBlank(character: string) {
	return character == " " || character == "\t" || character == "\n" || character == "";
}

/** A number as YAML's core schema reads one: 12, -3.5, 1e3, 0x1F, 0o17, .inf, .nan. */
function isNumber(text: string) {
	if (NANS.includes(text)) return true;
	if (text.startsWith("0x")) return isHexDigits(text.slice(2));
	if (text.startsWith("0o")) return isDigits(text.slice(2)) && !text.includes("8") && !text.includes("9");
	const body = text.startsWith("-") || text.startsWith("+") ? text.slice(1) : text;
	if (INFINITIES.includes(body)) return true;

	let mantissa = body;
	let exponent = body.indexOf("e");
	if (exponent < 0) exponent = body.indexOf("E");

	if (exponent >= 0) {
		mantissa = body.slice(0, exponent);
		const power = body.slice(exponent + 1);
		if (!isDigits(power.startsWith("-") || power.startsWith("+") ? power.slice(1) : power)) return false;
	}

	const dot = mantissa.indexOf(".");
	if (dot < 0) return isDigits(mantissa);
	const whole = mantissa.slice(0, dot);
	const fraction = mantissa.slice(dot + 1);
	if (whole.length == 0 && fraction.length == 0) return false;
	return (whole.length == 0 || isDigits(whole)) && (fraction.length == 0 || isDigits(fraction));
}

function numberValue(text: string) {
	if (NANS.includes(text)) return NaN;
	if (text.startsWith("0x")) return parseInt(text.slice(2), 16);
	if (text.startsWith("0o")) return parseInt(text.slice(2), 8);
	if (INFINITIES.includes(text.startsWith("-") || text.startsWith("+") ? text.slice(1) : text)) return text.startsWith("-") ? -Infinity : Infinity;
	return parseFloat(text);
}

/** A plain value with its type: null, a boolean, a number, or text. */
export function plainValue(text: string, place: Place) {
	if (NULLS.includes(text)) return makeNode("null", "", text, place);
	if (TRUES.includes(text)) return makeNode("boolean", "", "true", place);
	if (FALSES.includes(text)) return makeNode("boolean", "", "false", place);
	if (isNumber(text)) return numberNode(text, numberValue(text), place);
	return makeNode("string", "", text, place);
}

/** Lines of a > block folded: lines of text joined by spaces, a blank line a line end, more indented lines kept as they are. */
function fold(lines: string[]) {
	let folded = "";
	let first = true;
	let plainBefore = false;
	let blanks = 0;
	for (const line of lines) {
		if (line.length == 0) {
			blanks++;
			continue;
		}

		const indented = isSpace(line.charAt(0));
		if (first) folded += "\n".repeat(blanks);
		else if (plainBefore && !indented) folded += blanks == 0 ? " " : "\n".repeat(blanks);
		else folded += "\n".repeat(blanks + 1);
		folded += line;
		first = false;
		plainBefore = !indented;
		blanks = 0;
	}
	return folded;
}

/** Reads a YAML text into the tree; the first thing it cannot read stops it, with the place. */
export class YamlReader {
	pos = 0;
	/** What stopped the reading; "" while nothing has. */
	error = "";
	errorAt = 0;
	/** Where a quoted text read last ends: just past its closing quote. */
	after = 0;
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

	/** The column of a position, from 0: how far in it is. */
	columnOf(at: number) {
		return this.placeAt(at).column - 1;
	}

	lineEnd(at: number) {
		const end = this.text.indexOf("\n", at);
		return end < 0 ? this.text.length : end;
	}

	nextLine(at: number) {
		const end = this.lineEnd(at);
		return end < this.text.length ? end + 1 : this.text.length;
	}

	/** The spaces a line starts with. */
	indentAt(start: number) {
		let at = start;
		while (this.text.charAt(at) == " ") at++;
		return at - start;
	}

	/** The comment and blank lines kept so far, handed to whoever takes them. */
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
	 * Moves to the next line with a value on it, keeping the comment and blank
	 * lines on the way. False at the end of the text, and at a "---" or "..."
	 * line, where the document ends.
	 */
	skipToContent() {
		while (this.pos < this.text.length) {
			const start = this.pos;
			const line = this.text.slice(start, this.lineEnd(start));
			const content = line.trim();

			if (content.length == 0 || content.startsWith("#")) {
				this.keep(content);
				this.pos = this.nextLine(start);
				continue;
			}

			if (line == "---" || line.startsWith("--- ") || line == "..." || line.startsWith("... ")) return false;
			const indent = this.indentAt(start);

			if (this.text.charAt(start + indent) == "\t") {
				this.fail(start + indent, "a tab indents this line - YAML indents with spaces");
				return false;
			}

			if (indent > 0 && this.indent.length == 0) this.indent = " ".repeat(indent);
			return true;
		}
		return false;
	}

	/** The document: its value - an empty object for none - after an optional "---". */
	read() {
		let root = makeNode("object", "", "", { line: 1, column: 1 });
		let marked = false;
		let found = false;
		let ended = false;

		for (;;) {
			const content = this.skipToContent();
			if (this.failed || this.pos >= this.text.length) break;
			const start = this.pos;
			const line = this.text.slice(start, this.lineEnd(start));

			if (!content && line.startsWith("---") && (marked || found)) {
				this.fail(start, "a second document (---) - a config file holds one");
				break;
			}

			if (!content && line.startsWith("---")) {
				marked = true;
				if (!line.slice(3).trim().startsWith("#") && line.slice(3).trim().length > 0) this.fail(start + 4, "a value on the --- line - write it on the next line");
				this.pos = this.nextLine(start);
				continue;
			}

			if (!content) {
				ended = true;
				this.pos = this.nextLine(start);
				continue;
			}

			const at = start + this.indentAt(start);

			if (this.text.charAt(at) == "%") {
				this.fail(at, "directives (%YAML, %TAG) are not supported - remove the line");
				break;
			}

			if (found || ended) {
				this.fail(at, "this line does not belong to the value above it - check its indentation");
				break;
			}

			root = this.valueAt(at, -1);
			found = true;
		}

		return root;
	}

	/** A value that starts at `at`: a list, a mapping, or a value on this line. */
	valueAt(at: number, parent: number) {
		if (this.text.charAt(at) == "-" && isBlank(this.text.charAt(at + 1))) return this.sequence(at, false);
		if (this.keyEnd(at) >= 0) return this.mapping(at);
		return this.inline(at, parent, false);
	}

	/** The ":" that ends a key starting at `at`, on the same line; -1 when it is not a key. */
	keyEnd(at: number) {
		const first = this.text.charAt(at);
		const end = this.lineEnd(at);

		if (first == "\"" || first == "'") {
			const close = this.quoteEnd(at);
			if (close < 0) return -1;
			let colon = close + 1;
			while (isSpace(this.text.charAt(colon))) colon++;
			return this.text.charAt(colon) == ":" && isBlank(this.text.charAt(colon + 1)) ? colon : -1;
		}

		if (first == "[" || first == "{" || first == "#") return -1;
		for (let i = at; i < end; i++) {
			const character = this.text.charAt(i);
			if (character == "#" && isSpace(this.text.charAt(i - 1))) return -1;
			if (character == ":" && isBlank(this.text.charAt(i + 1))) return i;
		}
		return -1;
	}

	/** Where a quoted text that starts at `at` closes on its line; -1 when it goes on to the next. */
	quoteEnd(at: number) {
		const quote = this.text.charAt(at);
		const end = this.lineEnd(at);
		let i = at + 1;
		while (i < end) {
			const character = this.text.charAt(i);

			if (character == BACKSLASH && quote == "\"") {
				i += 2;
				continue;
			}

			if (character == quote && quote == "'" && this.text.charAt(i + 1) == "'") {
				i += 2;
				continue;
			}

			if (character == quote) return i;
			i++;
		}
		return -1;
	}

	/** A key's text: quoted, or plain up to its ":". */
	keyText(at: number, colon: number) {
		const first = this.text.charAt(at);
		if (first == "\"" || first == "'") return this.quoted(at).text;
		if (first == "?" && isBlank(this.text.charAt(at + 1))) this.fail(at, "complex keys (?) are not supported");
		else if ("&*!|>%@`".includes(first)) this.fail(at, `a key cannot start with ${first} - quote it`);
		return this.text.slice(at, colon).trim();
	}

	mapping(at: number) {
		const node = makeNode("object", "", "", this.placeAt(at));
		const indent = this.columnOf(at);
		let start = at;

		while (!this.failed) {
			const comments = this.takeComments();
			const colon = this.keyEnd(start);

			if (colon < 0) {
				this.fail(start, "expected a key: \"name: value\"");
				return node;
			}

			const key = this.keyText(start, colon);
			if (this.failed) return node;
			const twice = node.items.find(each => each.key == key);

			if (twice != null) {
				this.fail(start, `"${key}" is here twice - first on line ${twice.line}`);
				return node;
			}

			const value = this.memberValue(colon + 1, indent);
			if (this.failed) return node;
			const place = this.placeAt(start);
			value.key = key;
			value.line = place.line;
			value.column = place.column;
			value.comments = comments;
			node.items.push(value);

			if (!this.skipToContent()) return node;
			const lineIndent = this.indentAt(this.pos);
			if (lineIndent < indent) return node;
			start = this.pos + lineIndent;

			if (lineIndent > indent) {
				this.fail(start, "indented deeper than the key above - a value that goes on for several lines is quoted, or written after | or >");
				return node;
			}

			if (this.text.charAt(start) == "-" && isBlank(this.text.charAt(start + 1))) {
				this.fail(start, "a list item among keys - indent the list under its key");
				return node;
			}
		}
		return node;
	}

	/** A key's value: on its line, or on the lines under it. */
	memberValue(after: number, indent: number) {
		let at = after;
		while (isSpace(this.text.charAt(at))) at++;
		const first = this.text.charAt(at);
		if (at < this.lineEnd(at) && first != "#") return this.inline(at, indent, true);
		this.pos = this.nextLine(at);
		return this.below(indent, true, this.placeAt(at));
	}

	/**
	 * The value on the lines under a key or a "-": more indented than it, or -
	 * under a key - a list at the key's own indentation. Null when there is none.
	 */
	below(indent: number, underKey: boolean, place: Place) {
		if (!this.skipToContent()) return makeNode("null", "", "", place);
		const lineIndent = this.indentAt(this.pos);
		const at = this.pos + lineIndent;
		if (lineIndent > indent) return this.valueAt(at, indent);
		const listHere = this.text.charAt(at) == "-" && isBlank(this.text.charAt(at + 1));
		if (underKey && lineIndent == indent && listHere) return this.sequence(at, true);
		return makeNode("null", "", "", place);
	}

	/** A list of "- " items; `atKey` when it is written at its key's own indentation, where the next key is the key's neighbour. */
	sequence(at: number, atKey: boolean) {
		const node = makeNode("array", "", "", this.placeAt(at));
		const indent = this.columnOf(at);
		let start = at;

		while (!this.failed) {
			const comments = this.takeComments();
			let content = start + 1;
			while (isSpace(this.text.charAt(content))) content++;
			const first = this.text.charAt(content);
			let item = makeNode("null", "", "", this.placeAt(start));

			if (content < this.lineEnd(start) && first != "#") {
				item = this.valueAt(content, indent);
			} else {
				this.pos = this.nextLine(start);
				item = this.below(indent, false, this.placeAt(start));
			}

			if (this.failed) return node;
			item.comments = comments;
			node.items.push(item);

			if (!this.skipToContent()) return node;
			const lineIndent = this.indentAt(this.pos);
			if (lineIndent < indent) return node;
			start = this.pos + lineIndent;
			const another = this.text.charAt(start) == "-" && isBlank(this.text.charAt(start + 1));

			if (lineIndent > indent) {
				this.fail(start, "indented deeper than the item above - a value that goes on for several lines is quoted, or written after | or >");
				return node;
			}

			if (!another && !atKey) this.fail(start, "a key among the items of a list - an item starts with \"- \"");
			if (!another) return node;
		}
		return node;
	}

	/** A value written on its line: [ ] or { }, quoted or plain text, or a | or > block that starts here. */
	inline(at: number, parent: number, afterKey: boolean) {
		const first = this.text.charAt(at);
		const second = this.text.charAt(at + 1);
		const place = this.placeAt(at);
		if (first == "|" || first == ">") return this.block(at, parent);

		if (first == "[" || first == "{") {
			this.pos = at;
			const node = this.flowValue();
			this.endLine(this.pos);
			return node;
		}

		if (first == "\"" || first == "'") {
			const node = this.quoted(at);
			this.endLine(this.after);
			return node;
		}

		if (first == "-" && isBlank(second)) this.fail(at, "a list cannot start on the line of its key - put it on the next line");
		else if (first == "&" || first == "*") this.fail(at, "anchors and aliases (& and *) are not supported - write the value out");
		else if (first == "!") this.fail(at, "tags (!) are not supported - write the value as it is");
		else if (first == "?" && isBlank(second)) this.fail(at, "complex keys (?) are not supported");
		else if ("%@`,]}".includes(first)) this.fail(at, `a value cannot start with ${first} - quote it: "${first}..."`);
		if (this.failed) return makeNode("null", "", "", place);
		return this.plain(at, afterKey);
	}

	/** Plain text to the end of the line or a comment, with its type. */
	plain(at: number, afterKey: boolean) {
		const end = this.lineEnd(at);
		let stop = end;
		for (let i = at; i < end; i++) {
			const character = this.text.charAt(i);

			if (character == "#" && isSpace(this.text.charAt(i - 1))) {
				stop = i;
				break;
			}

			if (afterKey && character == ":" && isBlank(this.text.charAt(i + 1))) this.fail(i, "\": \" in a value - quote the value");
		}
		this.pos = this.nextLine(at);
		return plainValue(this.text.slice(at, stop).trim(), this.placeAt(at));
	}

	/** After a value on a line only spaces and a comment may follow. */
	endLine(at: number) {
		let i = at;
		while (isSpace(this.text.charAt(i))) i++;
		const next = this.text.charAt(i);
		if (next != "" && next != "\n" && !(next == "#" && i > at)) this.fail(i, "unexpected text after the value");
		this.pos = this.nextLine(i);
	}

	/** Text in quotes: '' is a quote in '...', escapes in "...", and a line break is a space. */
	quoted(at: number) {
		const quote = this.text.charAt(at);
		let value = "";
		let i = at + 1;

		for (;;) {
			if (i >= this.text.length) {
				this.fail(at, "a quoted value that is never closed");
				break;
			}

			const character = this.text.charAt(i);

			if (character == quote && quote == "'" && this.text.charAt(i + 1) == "'") {
				value += "'";
				i += 2;
				continue;
			}

			if (character == quote) {
				i++;
				break;
			}

			if (character == BACKSLASH && quote == "\"") {
				value += this.escape(i);
				i = this.after;
				continue;
			}

			if (character == "\n") {
				value = value.trimEnd() + this.lineBreak(i);
				i = this.after;
				continue;
			}

			value += character;
			i++;
		}

		this.after = i;
		return makeNode("string", "", value, this.placeAt(at));
	}

	/** A line break inside quotes: a space, or a line end for each blank line after it. */
	lineBreak(at: number) {
		let i = at + 1;
		let blanks = 0;
		for (;;) {
			while (isSpace(this.text.charAt(i))) i++;
			if (this.text.charAt(i) != "\n") break;
			blanks++;
			i++;
		}
		this.after = i;
		return blanks > 0 ? "\n".repeat(blanks) : " ";
	}

	/** The escape at `at` in "...": the text it stands for. */
	escape(at: number) {
		const letter = this.text.charAt(at + 1);
		this.after = at + 2;

		if (letter == "\n") {
			let i = at + 2;
			while (isSpace(this.text.charAt(i))) i++;
			this.after = i;
			return "";
		}

		const known = ESCAPE_LETTERS.indexOf(letter);
		if (known >= 0 && letter.length == 1) return ESCAPED.charAt(known);
		// A no-break space, and the line and paragraph separators - which the compiler takes for line ends in a string literal.
		if (letter == "_") return String.fromCharCode(0xA0);
		if (letter == "L" || letter == "P") return String.fromCharCode(letter == "L" ? 0x2028 : 0x2029);
		const digits = letter == "x" ? 2 : letter == "u" ? 4 : letter == "U" ? 8 : 0;
		const hex = this.text.slice(at + 2, at + 2 + digits);

		if (digits == 0 || hex.length < digits || !isHexDigits(hex)) {
			this.fail(at, `an unknown escape ${BACKSLASH}${letter}`);
			return "";
		}

		this.after = at + 2 + digits;
		return String.fromCodePoint(parseInt(hex, 16));
	}

	/** A | or > block: the lines under it that are more indented than `parent`. */
	block(at: number, parent: number) {
		const place = this.placeAt(at);
		const literal = this.text.charAt(at) == "|";
		let chomp = "clip";
		let explicit = 0;
		let i = at + 1;

		for (let n = 0; n < 2; n++) {
			const character = this.text.charAt(i);
			if (character == "-") chomp = "strip";
			else if (character == "+") chomp = "keep";
			else if (character.length == 1 && "123456789".includes(character)) explicit = parseInt(character, 10);
			else break;
			i++;
		}

		this.endLine(i);
		const lines: string[] = [];
		let indent = explicit > 0 ? Math.max(parent, 0) + explicit : -1;

		while (this.pos < this.text.length && !this.failed) {
			const start = this.pos;
			const line = this.text.slice(start, this.lineEnd(start));

			if (line.trim().length == 0) {
				lines.push("");
				this.pos = this.nextLine(start);
				continue;
			}

			const lineIndent = this.indentAt(start);
			if (indent < 0 && lineIndent > parent) indent = lineIndent;
			if (indent < 0 || lineIndent < indent) break;
			lines.push(line.slice(indent));
			this.pos = this.nextLine(start);
		}

		let trailing = 0;

		while (lines.length > 0 && lines[lines.length - 1].length == 0) {
			lines.pop();
			trailing++;
		}

		let value = literal ? lines.join("\n") : fold(lines);
		if (lines.length > 0 && chomp == "clip") value += "\n";
		if (chomp == "keep") value += "\n".repeat(lines.length > 0 ? trailing + 1 : trailing);
		return makeNode("string", "", value, place);
	}

	/** Spaces, line ends and comments inside [ ] and { }. */
	skipFlowSpace() {
		for (;;) {
			const character = this.text.charAt(this.pos);

			if (character == " " || character == "\t" || character == "\n") {
				this.pos++;
				continue;
			}

			if (character == "#" && isBlank(this.text.charAt(this.pos - 1))) {
				this.pos = this.lineEnd(this.pos);
				continue;
			}

			return;
		}
	}

	/** A value inside [ ] or { }, or one of them. */
	flowValue() {
		this.skipFlowSpace();
		const at = this.pos;
		const first = this.text.charAt(at);
		if (first == "[") return this.flowSequence();
		if (first == "{") return this.flowMapping();

		if (first == "\"" || first == "'") {
			const node = this.quoted(at);
			this.pos = this.after;
			return node;
		}

		if (first == "&" || first == "*") this.fail(at, "anchors and aliases (& and *) are not supported - write the value out");
		else if (first == "!") this.fail(at, "tags (!) are not supported - write the value as it is");
		else if (first == "|" || first == ">") this.fail(at, "| and > blocks cannot be inside [ ] or { }");
		else if ("%@`".includes(first)) this.fail(at, `a value cannot start with ${first} - quote it: "${first}..."`);
		return this.flowPlain(at);
	}

	/** Plain text inside [ ] or { }: up to a comma, a bracket, ": " or the end of the line. */
	flowPlain(at: number) {
		let i = at;
		while (i < this.text.length) {
			const character = this.text.charAt(i);
			const next = this.text.charAt(i + 1);
			if (",[]{}\n".includes(character)) break;
			if (character == ":" && (isBlank(next) || ",[]{}".includes(next))) break;
			if (character == "#" && isBlank(this.text.charAt(i - 1))) break;
			i++;
		}
		const text = this.text.slice(at, i).trim();
		if (text.length == 0 && !this.failed) this.fail(at, "expected a value");
		this.pos = i;
		return plainValue(text, this.placeAt(at));
	}

	flowSequence() {
		const node = makeNode("array", "", "", this.placeAt(this.pos));
		this.pos++;

		while (!this.failed) {
			this.skipFlowSpace();

			if (this.text.charAt(this.pos) == "]") {
				this.pos++;
				return node;
			}

			if (this.pos >= this.text.length) this.fail(this.pos, "the list is never closed with ]");
			if (this.failed) return node;
			const item = this.flowValue();
			this.skipFlowSpace();
			if (this.text.charAt(this.pos) == ":") this.fail(this.pos, "a key inside [ ] is not supported - write { key: value }");
			if (this.failed) return node;
			node.items.push(item);
			const next = this.text.charAt(this.pos);
			if (next == "," || next == "]") this.pos += next == "," ? 1 : 0;
			else this.fail(this.pos, "expected , or ] after an item");
			if (this.failed) return node;
		}
		return node;
	}

	flowMapping() {
		const node = makeNode("object", "", "", this.placeAt(this.pos));
		this.pos++;

		while (!this.failed) {
			this.skipFlowSpace();

			if (this.text.charAt(this.pos) == "}") {
				this.pos++;
				return node;
			}

			if (this.pos >= this.text.length) this.fail(this.pos, "the mapping is never closed with }");
			else if ("[{".includes(this.text.charAt(this.pos))) this.fail(this.pos, "a key is text, not a list or a mapping");
			if (this.failed) return node;
			const keyAt = this.pos;
			const keyNode = this.flowValue();
			const key = keyNode.text;
			this.skipFlowSpace();
			let value = makeNode("null", "", "", this.placeAt(this.pos));

			if (this.text.charAt(this.pos) == ":") {
				this.pos++;
				this.skipFlowSpace();
				if (!",}".includes(this.text.charAt(this.pos))) value = this.flowValue();
				this.skipFlowSpace();
			}

			if (this.failed) return node;
			const twice = node.items.find(each => each.key == key);
			if (twice != null) this.fail(keyAt, `"${key}" is here twice - first on line ${twice.line}`);
			if (this.failed) return node;
			value.key = key;
			value.line = keyNode.line;
			value.column = keyNode.column;
			node.items.push(value);
			const next = this.text.charAt(this.pos);
			if (next == "," || next == "}") this.pos += next == "," ? 1 : 0;
			else this.fail(this.pos, "expected , or } after a value");
			if (this.failed) return node;
		}
		return node;
	}
}

/** Text written plain when YAML reads it back as the same text; else in double quotes. */
export function yamlText(text: string) {
	return plainSafe(text) ? text : jsonText(text);
}

function plainSafe(text: string) {
	if (text.length == 0 || text.trim() != text) return false;
	if (INDICATORS.includes(text.charAt(0))) return false;
	if (text.includes(": ") || text.includes(" #") || text.endsWith(":")) return false;
	if (text.split("").some(isControl)) return false;
	// YAML 1.1 reads these as booleans: other tools may still.
	if (["yes", "no", "on", "off", "y", "n"].includes(text.toLowerCase())) return false;
	return plainValue(text, { line: 0, column: 0 }).kind == "string";
}

/** A scalar as YAML writes it. */
function scalar(node: TreeNode) {
	if (node.kind == "string") return yamlText(node.text);
	if (node.kind == "number") return node.text.length > 0 ? node.text : yamlNumber(node.value);
	return node.text;
}

/** A number made at run time: .nan and .inf are YAML's words for what JavaScript prints NaN and Infinity. */
function yamlNumber(value: number) {
	if (isNaN(value)) return ".nan";
	if (value == Infinity) return ".inf";
	if (value == -Infinity) return "-.inf";
	return `${value}`;
}

function isEmpty(node: TreeNode) {
	return (node.kind == "object" || node.kind == "array") && node.items.length == 0;
}

/** What follows a key or a "-" on its line: a scalar, {} or [], or nothing for a value on the lines under it. */
function inlineValue(node: TreeNode) {
	if (isScalar(node)) return ` ${scalar(node)}`;
	if (node.kind == "null") return node.text.length > 0 ? ` ${node.text}` : "";
	if (isEmpty(node)) return node.kind == "object" ? " {}" : " []";
	return "";
}

function writeMembers(lines: string[], object: TreeNode, pad: string, unit: string) {
	for (const each of object.items) {
		writeComments(lines, each.comments, pad);
		lines.push(`${pad}${yamlText(each.key)}:${inlineValue(each)}`);
		if (inlineValue(each).length == 0 && each.kind != "null") writeBlock(lines, each, pad + unit, unit);
	}
}

function writeItems(lines: string[], array: TreeNode, pad: string, unit: string) {
	for (const item of array.items) {
		writeComments(lines, item.comments, pad);
		const inline = inlineValue(item);

		if (inline.length > 0 || item.kind == "null") {
			lines.push(`${pad}-${inline}`);
			continue;
		}

		// A mapping starts on the "- " line: its first key there, the rest under it.
		const nested: string[] = [];
		writeBlock(nested, item, `${pad}  `, unit);
		const first = nested.findIndex(line => line.startsWith(`${pad}  `) && !line.trim().startsWith("#"));
		for (let i = 0; i < nested.length; i++) {
			if (i < first) lines.push(nested[i].length > 0 ? `${pad}${nested[i].trim()}` : "");
			else if (i == first) lines.push(`${pad}- ${nested[i].slice(pad.length + 2)}`);
			else lines.push(nested[i]);
		}
	}
}

function writeBlock(lines: string[], node: TreeNode, pad: string, unit: string) {
	if (node.kind == "object") writeMembers(lines, node, pad, unit);
	else if (node.kind == "array") writeItems(lines, node, pad, unit);
}

/** The document as YAML lines. */
export function writeYaml(document: TreeDocument) {
	const lines: string[] = [];
	const root = document.root;
	const unit = document.indent.length > 0 ? document.indent : "  ";
	writeComments(lines, root.comments, "");
	if (root.kind == "object" || root.kind == "array") writeBlock(lines, root, "", unit);
	else lines.push(scalar(root));
	writeComments(lines, document.tail, "");
	return lines;
}
