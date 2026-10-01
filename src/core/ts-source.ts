/** What both TypeScript scanners read the same way: an official module's import, and the comment above a node. */
import ts from "typescript";

/** Whether an import names the official module `name`: by its package, or by its folder in a checkout. */
export function isModule(specifier: string, name: string) {
	return specifier == `@amxts/${name}` || [`/${name}`, `/${name}/src`, `/${name}/src/index`].some(end => specifier.endsWith(end));
}

/** The JSDoc (or the run of // comments) right before a position, without its stars. */
export function commentBefore(text: string, at: number) {
	const ranges = ts.getLeadingCommentRanges(text, at) ?? [];
	const last = ranges[ranges.length - 1];
	if (last == null) return undefined;
	const raw = text.slice(last.pos, last.end);
	if (raw.startsWith("/**")) {
		return raw.slice(3, -2).split(/\r?\n/).map(line => line.replace(/^\s*\* ?/, "")).join("\n").trim() || undefined;
	}
	if (raw.startsWith("//")) {
		const lines = ranges.filter(range => text.slice(range.pos, range.pos + 2) == "//").map(range => text.slice(range.pos + 2, range.end).trim());
		return lines.join("\n").trim() || undefined;
	}
	return undefined;
}
