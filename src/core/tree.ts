/**
 * A YAML or JSON menu file as one tree with offsets - read by tolerant
 * parsers, so a file that is half written still has its keys and values -
 * and the file checked by Config Core's own reader, which says whether the
 * server reads it at all.
 */
import * as jsonc from "jsonc-parser";
import { isAlias, isMap, isPair, isScalar, isSeq, LineCounter, parseDocument, Scalar } from "yaml";
import { JsonReader } from "../vendor/config-core/json";
import { YamlReader } from "../vendor/config-core/yaml";
import type { Problem } from "./analyze";
import { lineStartsOf } from "./ini";

export type Kind = "object" | "array" | "string" | "number" | "boolean" | "null";

export interface TNode {
	kind: Kind;
	/** Its key in its object; "" in a list and at the top. */
	key: string;
	keyStart: number;
	keyEnd: number;
	/** Where the value is written, quotes and tag included. */
	start: number;
	end: number;
	/** A string's text; a number or a boolean as text. */
	text: string;
	/** Where a string's text is, inside its quotes - or -1 when it is not written as it reads (escapes, block text). */
	textStart: number;
	items: TNode[];
}

/** A value YAML reads as something else - a tag, a directive - with the fix: the value quoted. */
export interface SyntaxProblem {
	start: number;
	end: number;
	message: string;
	severity: "error" | "warning";
	/** For a value YAML takes for a tag or a directive: the value, quoted. */
	replacement?: string;
}

export interface TreeResult {
	root: TNode | null;
	problems: SyntaxProblem[];
}

function node(kind: Kind, start: number, end: number): TNode {
	return { kind, key: "", keyStart: -1, keyEnd: -1, start, end, text: "", textStart: -1, items: [] };
}

// ---------------------------------------------------------------- YAML

function yamlScalar(scalar: Scalar, text: string, problems: SyntaxProblem[]) {
	const [start, valueEnd] = scalar.range!;
	const value = scalar.value;
	let made: TNode;
	if (value == null) made = node("null", start, valueEnd);
	else if (typeof value == "boolean") made = { ...node("boolean", start, valueEnd), text: `${value}` };
	else if (typeof value == "number" || typeof value == "bigint") made = { ...node("number", start, valueEnd), text: text.slice(start, valueEnd) };
	else made = { ...node("string", start, valueEnd), text: `${value}` };

	if (made.kind == "string") {
		const quoted = scalar.type == "QUOTE_DOUBLE" || scalar.type == "QUOTE_SINGLE";
		const inner = quoted ? start + 1 : start;
		if (text.slice(inner, inner + made.text.length) == made.text) made.textStart = inner;
	}

	// `condition: !IS_ALIVE` - YAML takes `!IS_ALIVE` for a tag.
	if (scalar.tag != null && !scalar.tag.startsWith("tag:yaml.org")) {
		const tagAt = text.lastIndexOf(scalar.tag, start);
		const from = tagAt >= 0 ? tagAt : start;
		const written = text.slice(from, valueEnd).trim();
		problems.push({
			start: from,
			end: Math.max(valueEnd, from + scalar.tag.length),
			severity: "error",
			message: `YAML reads ${scalar.tag} as a tag, and Config Core does not read tags - the server reads the whole file as empty. Quote the value: "${written}"`,
			replacement: JSON.stringify(written),
		});
		made = { ...node("string", from, valueEnd), text: written, textStart: from };
	}

	return made;
}

function yamlNode(value: unknown, text: string, problems: SyntaxProblem[], at: number): TNode {
	if (value == null) return node("null", at, at);

	// Config Core does not read aliases: its own reader says so (configCoreError).
	if (isAlias(value)) return node("null", value.range?.[0] ?? at, value.range?.[1] ?? at);

	if (isScalar(value)) return yamlScalar(value, text, problems);

	if (isMap(value)) {
		const made = node("object", value.range![0], value.range![1]);
		for (const pair of value.items) {
			if (!isPair(pair)) continue;
			const key = pair.key;
			const keyRange = isScalar(key) && key.range ? key.range : [made.start, made.start];
			const child = yamlNode(pair.value, text, problems, keyRange[1]);
			child.key = isScalar(key) ? `${key.value ?? ""}` : "";
			child.keyStart = keyRange[0];
			child.keyEnd = keyRange[1];
			made.items.push(child);
		}
		return made;
	}

	if (isSeq(value)) {
		const made = node("array", value.range![0], value.range![1]);
		for (const item of value.items) made.items.push(yamlNode(item, text, problems, made.end));
		return made;
	}

	return node("null", at, at);
}

export function parseYaml(text: string): TreeResult {
	const problems: SyntaxProblem[] = [];
	const document = parseDocument(text, { lineCounter: new LineCounter(), uniqueKeys: false, prettyErrors: false });

	for (const error of document.errors) {
		const [start] = error.pos;

		// `name: %name%` - a plain value cannot start with %.
		if (error.code == "BAD_SCALAR_START") {
			const lineEnd = text.indexOf("\n", start);
			const written = text.slice(start, lineEnd < 0 ? text.length : lineEnd).split(" #")[0].trim();
			problems.push({ start, end: start + written.length, severity: "error", message: `a YAML value cannot start with ${text[start]} - quote it: "${written}"`, replacement: JSON.stringify(written) });
		}
		// Anything else the parser stumbles on, Config Core's own reader says in its words (configCoreError).
	}

	const root = document.contents == null ? node("object", 0, 0) : yamlNode(document.contents, text, problems, 0);
	return { root, problems };
}

// ---------------------------------------------------------------- JSON

function jsonNode(value: jsonc.Node, text: string): TNode {
	const start = value.offset;
	const end = value.offset + value.length;

	if (value.type == "object") {
		const made = node("object", start, end);
		for (const property of value.children ?? []) {
			const [key, child] = property.children ?? [];
			if (key == null) continue;
			const made2 = child != null ? jsonNode(child, text) : node("null", key.offset + key.length, key.offset + key.length);
			made2.key = `${key.value ?? ""}`;
			made2.keyStart = key.offset;
			made2.keyEnd = key.offset + key.length;
			made.items.push(made2);
		}
		return made;
	}

	if (value.type == "array") {
		const made = node("array", start, end);
		for (const item of value.children ?? []) made.items.push(jsonNode(item, text));
		return made;
	}

	if (value.type == "string") {
		const made = { ...node("string", start, end), text: `${value.value}` };
		if (text.slice(start + 1, start + 1 + made.text.length) == made.text) made.textStart = start + 1;
		return made;
	}

	if (value.type == "number") return { ...node("number", start, end), text: text.slice(start, end) };
	if (value.type == "boolean") return { ...node("boolean", start, end), text: `${value.value}` };
	return node("null", start, end);
}

export function parseJson(text: string): TreeResult {
	// What does not parse, Config Core's own reader says in its words (configCoreError).
	const tree = jsonc.parseTree(text, [], { allowTrailingComma: true, disallowComments: false });
	return { root: tree ? jsonNode(tree, text) : null, problems: [] };
}

// ---------------------------------------------------------------- Config Core

/**
 * What Config Core's own reader says of the text - the first thing it cannot
 * read, where the server stops and reads the file as an empty object - or null
 * when it reads it.
 */
export function configCoreError(text: string, format: "yaml" | "json") {
	// The reader works on "\n" line ends; its line and column are the same in the text as it is.
	const clean = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replace(/^\uFEFF/, "");
	const reader = format == "yaml" ? new YamlReader(clean) : new JsonReader(clean);
	reader.read();
	if (!reader.failed) return null;
	const place = reader.placeAt(reader.errorAt) as { line: number; column: number };
	const starts = lineStartsOf(text);
	const lineStart = starts[Math.min(place.line - 1, starts.length - 1)];
	const offset = Math.min(lineStart + place.column - 1 + (text.startsWith("﻿") && place.line == 1 ? 1 : 0), text.length);
	return { offset, line: place.line, column: place.column, message: reader.error as string };
}

/** Where the line `start` is on ends, before its \r - or `end`, when that comes first. */
export function lineEndIn(source: string, start: number, end: number) {
	const newline = source.indexOf("\n", start);
	const line = newline < 0 ? source.length : newline;
	return Math.min(end, source[line - 1] == "\r" ? line - 1 : line);
}

/**
 * A file's syntax problems, a quick fix with each that has one, and where
 * Config Core stops reading it - unless a problem there already says so.
 */
export function syntaxProblems(text: string, format: "yaml" | "json", parsed: TreeResult): Problem[] {
	const problems: Problem[] = parsed.problems.map((problem) => {
		const fix = problem.replacement != null ? { title: `Quote the value: ${problem.replacement}`, start: problem.start, end: problem.end, text: problem.replacement } : undefined;
		return { start: problem.start, end: problem.end, message: problem.message, severity: problem.severity, code: "syntax", fix };
	});
	const error = configCoreError(text, format);
	// Config Core stops there, and the server reads the file as an empty object.
	if (error != null && !parsed.problems.some(problem => Math.abs(problem.start - error.offset) <= 1)) {
		const end = Math.max(lineEndIn(text, error.offset, text.length), error.offset + 1);
		problems.push({ start: error.offset, end, message: `${error.message} - Config Core stops here and the server reads the file as empty`, severity: "error", code: "syntax" });
	}
	return problems;
}
