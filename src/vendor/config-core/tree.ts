// Copied from @amxts/config-core 0.1.0 (f9978d1) src/tree.ts by scripts/vendor.ts - do not edit.
// @ts-nocheck
/**
 * Config Core's tree: the values of a YAML, JSON or INI file as one shape,
 * and what reading and writing them have in common. Not part of the API.
 */
import { ConfigKind } from "./types";
import { Place, TreeNode } from "./internal";

const DIGITS = "0123456789";
const HEX_DIGITS = "0123456789abcdefABCDEF";
/** The characters below a space, in order: a control character's code is its place here. */
const CONTROLS = "\u0000\u0001\u0002\u0003\u0004\u0005\u0006\u0007\u0008\u0009\u000A\u000B\u000C\u000D\u000E\u000F\u0010\u0011\u0012\u0013\u0014\u0015\u0016\u0017\u0018\u0019\u001A\u001B\u001C\u001D\u001E\u001F";

export const BACKSLASH = "\\";

export function makeNode(kind: ConfigKind, key: string, text: string, place: Place) {
	const made: TreeNode = { kind, key, text, value: 0, items: [], comments: null, line: place.line, column: place.column, foldCase: false, block: false };
	return made;
}

export function numberNode(text: string, value: number, place: Place) {
	const made = makeNode("number", "", text, place);
	made.value = value;
	return made;
}

export function nowhere() {
	const place: Place = { line: 0, column: 0 };
	return place;
}

/** Text as one kind of line end, without a byte order mark. */
export function normalize(text: string) {
	const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
	return lines.startsWith(String.fromCharCode(0xFEFF)) ? lines.slice(1) : lines;
}

/** Where each line of the text starts. */
export function lineStarts(text: string) {
	const starts = [0];
	let at = text.indexOf("\n");
	while (at >= 0) {
		starts.push(at + 1);
		at = text.indexOf("\n", at + 1);
	}
	return starts;
}

/** The line and column of a position, from 1. */
export function placeOf(starts: number[], at: number) {
	let low = 0;
	let high = starts.length - 1;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (starts[middle] <= at) low = middle;
		else high = middle - 1;
	}
	const place: Place = { line: low + 1, column: at - starts[low] + 1 };
	return place;
}

export function isDigits(text: string) {
	return text.length > 0 && text.split("").every(each => DIGITS.includes(each));
}

export function isHexDigits(text: string) {
	return text.length > 0 && text.split("").every(each => HEX_DIGITS.includes(each));
}

/** A character below a space, "\n" and "\t" among them. */
export function isControl(character: string) {
	return character.length == 1 && CONTROLS.includes(character);
}

/** "\u001b" for a control character: its code in four hex digits. */
export function unicodeEscape(character: string) {
	const code = CONTROLS.indexOf(character);
	const hex = "0123456789abcdef";
	return `${BACKSLASH}u00${hex.charAt(Math.floor(code / 16))}${hex.charAt(code % 16)}`;
}

/** "a.b[0].c" as its parts: "a", "b", "[0]", "c" - an item of a list keeps its brackets. */
export function pathParts(path: string) {
	return path.replaceAll("[", ".[").split(".").map(part => part.trim()).filter(part => part.length > 0);
}

/** The index a part "[3]" gives an item of a list; -1 for a part that is not one. */
export function itemIndex(part: string) {
	if (!part.startsWith("[") || !part.endsWith("]")) return -1;
	const digits = part.slice(1, -1).trim();
	return isDigits(digits) ? parseInt(digits, 10) : -1;
}

function sameKey(object: TreeNode, a: string, b: string) {
	return object.foldCase ? a.toLowerCase() == b.toLowerCase() : a == b;
}

/** A member of an object by its key, or an item of an array by its index in brackets, "[0]". */
export function member(node: TreeNode, part: string) {
	if (node.kind == "array") {
		const index = itemIndex(part);
		return index >= 0 && index < node.items.length ? node.items[index] : null;
	}

	if (node.kind != "object" || itemIndex(part) >= 0) return null;
	return node.items.find(each => sameKey(node, each.key, part)) ?? null;
}

/** The node a path leads to; the node itself for "". */
export function follow(node: TreeNode, path: string) {
	let found: TreeNode | null = node;
	for (const part of pathParts(path)) {
		if (found == null) return null;
		found = member(found, part);
	}
	return found;
}

/** The index of an object's member with that key; -1 for none. */
export function memberIndex(object: TreeNode, key: string) {
	return object.items.findIndex(each => sameKey(object, each.key, key));
}

export function isScalar(node: TreeNode) {
	return node.kind == "string" || node.kind == "number" || node.kind == "boolean";
}

/** A scalar as text: a number as it was written; null for anything else. */
export function scalarText(node: TreeNode | null) {
	if (node == null || !isScalar(node)) return null;
	return node.text;
}

/** A value as a number: a number, or text that is one; NaN for anything else. */
export function numberOf(node: TreeNode | null) {
	if (node == null) return NaN;
	if (node.kind == "number") return node.value;
	if (node.kind != "string") return NaN;
	const text = node.text.trim();
	return text.length > 0 ? parseFloat(text) : NaN;
}

const YES = ["true", "yes", "on"];
const NO = ["false", "no", "off"];

/**
 * Text as a boolean - the one rule a config's true and false are read by:
 * 1 for true, yes, on (in any case) or a number other than 0; 0 for false,
 * no, off or 0; -1 for anything else.
 */
export function booleanText(text: string) {
	const word = text.trim().toLowerCase();
	if (YES.includes(word)) return 1;
	if (NO.includes(word)) return 0;
	const value = word.length > 0 ? parseFloat(word) : NaN;
	if (isNaN(value)) return -1;
	return value != 0 ? 1 : 0;
}

/** A value as a boolean: 1 true, 0 false, -1 neither - true or false, a number (0 is false), or text as `booleanText()` reads it. */
export function booleanOf(node: TreeNode | null) {
	if (node == null) return -1;
	if (node.kind == "boolean") return node.text == "true" ? 1 : 0;
	if (node.kind == "number") return node.value != 0 ? 1 : 0;
	return node.kind == "string" ? booleanText(node.text) : -1;
}

/** The comment and blank lines written before a node, at its indentation. */
export function writeComments(lines: string[], comments: string[] | null, pad: string) {
	if (comments == null) return;
	for (const comment of comments) lines.push(comment.length > 0 ? `${pad}${comment}` : "");
}
