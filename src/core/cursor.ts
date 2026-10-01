/**
 * The text around the cursor, as the menu and the config completions both read
 * it: the word it is in, the YAML block it is in, and whether it is inside a
 * JSON string.
 */
import * as jsonc from "jsonc-parser";

/** The run of `letters` the cursor is in or beside. */
export function around(text: string, offset: number, letters = /\w/) {
	let start = offset;
	while (start > 0 && letters.test(text[start - 1])) start--;
	let end = offset;
	while (end < text.length && letters.test(text[end])) end++;
	return { start, end };
}

export interface LineShape {
	/** Columns of the "- " a line starts with. */
	dashes: number[];
	/** Where its content starts. */
	content: number;
	/** The key it starts with, if any. */
	key: string | null;
	blank: boolean;
}

export function lineShape(line: string): LineShape {
	const lead = /^(\s*)(?:-(?:\s+|$))*/.exec(line)!;
	const dashes: number[] = [];
	for (let i = lead[1].length; i < lead[0].length; i++) {
		if (line[i] == "-") dashes.push(i);
	}
	const content = line.slice(lead[0].length);
	const key = /^("[^"]*"|'[^']*'|[^\s#'"{[!&*%@`|>][^#]*?)\s*:(\s|$)/.exec(content);
	return {
		dashes,
		content: lead[0].length,
		key: key != null ? key[1].replace(/^["']|["']$/g, "") : null,
		blank: (content.trim().length == 0 && dashes.length == 0) || content.trimStart().startsWith("#"),
	};
}

/** The path of the block a line's content is in, from the lines above it; a list item is "#". */
export function blockPath(lines: string[], shape: LineShape) {
	const path: string[] = [];
	let target = shape.content;
	if (shape.dashes.length > 0) {
		for (const _ of shape.dashes) path.unshift("#");
		target = shape.dashes[0];
	}

	for (let i = lines.length - 1; i >= 0 && target > 0; i--) {
		const above = lineShape(lines[i]);
		if (above.blank) continue;
		const lastDash = above.dashes[above.dashes.length - 1];
		if (lastDash != null && lastDash >= target) continue;

		if (above.content == target && above.dashes.length > 0) {
			// The first line of the item our map is: `- name: X`.
			for (const _ of above.dashes) path.unshift("#");
			target = above.dashes[0];
			continue;
		}

		if (above.content < target && above.key != null) {
			path.unshift(above.key);
			for (const _ of above.dashes) path.unshift("#");
			target = above.dashes.length > 0 ? above.dashes[0] : above.content;
		}
	}
	return path;
}

/** Whether the cursor is inside the quotes of the JSON string it follows: not past its closing quote. */
export function inJsonString(text: string, offset: number, node: jsonc.Node | undefined): boolean {
	return node != null && node.type == "string" && offset > node.offset && offset <= node.offset + node.length && !(offset == node.offset + node.length && text[offset - 1] == "\"" && node.length > 1);
}
