/**
 * The names a Pawn plugin (.sma) registers through Menu Core's natives
 * (`include/menu_core.inc`), read with a tolerant pattern - comments are
 * blanked out first, and only a name written as a string is read:
 *
 *     mc_register_condition("IS_VIP", "OnIsVip");
 *     mc_create_menu("SHOP", "Shop");
 */
import { Registration, RegistrationKind } from "./registry";
import { lineOf, lineStartsOf } from "./ini";

const NATIVES: Record<string, RegistrationKind> = {
	mc_register_condition: "condition",
	mc_register_action: "action",
	mc_register_restriction: "restriction",
	mc_register_placeholder: "placeholder",
	mc_register_condition_filter: "filter",
	mc_create_menu: "menu",
};

/** The text with its comments turned to spaces, strings and line ends kept where they are. */
function withoutComments(text: string) {
	const out = text.split("");
	let i = 0;
	while (i < text.length) {
		const two = text.slice(i, i + 2);
		if (text[i] == "\"") {
			// Pawn escapes with ^ as well as \.
			i++;
			while (i < text.length && text[i] != "\"" && text[i] != "\n") i += text[i] == "^" || text[i] == "\\" ? 2 : 1;
			i++;
		} else if (two == "//") {
			while (i < text.length && text[i] != "\n") out[i++] = " ";
		} else if (two == "/*") {
			while (i < text.length && text.slice(i, i + 2) != "*/") {
				if (text[i] != "\n") out[i] = " ";
				i++;
			}
			if (i < text.length) out[i] = out[i + 1] = " ";
			i += 2;
		} else {
			i++;
		}
	}
	return out.join("");
}

/** The comment lines right above a line: `// ...` or a `/* ... *\/` block. */
function commentAbove(lines: string[], line: number) {
	const found: string[] = [];
	for (let at = line - 1; at >= 0; at--) {
		const text = lines[at].trim();
		if (text.startsWith("//")) {
			found.unshift(text.slice(2).trim());
		} else if (text.endsWith("*/")) {
			let start = at;
			while (start > 0 && !lines[start].includes("/*")) start--;
			const block = lines.slice(start, at + 1).join("\n").replace(/^\s*\/\*+/, "").replace(/\*+\/\s*$/, "");
			found.unshift(...block.split("\n").map(each => each.replace(/^\s*\* ?/, "").trim()));
			break;
		} else {
			break;
		}
	}
	const doc = found.join("\n").trim();
	return doc.length > 0 ? doc : undefined;
}

export function scanPawn(file: string, text: string): Registration[] {
	const clean = withoutComments(text);
	const starts = lineStartsOf(text);
	const lines = text.split("\n");
	const found: Registration[] = [];
	const pattern = /\b(mc_register_condition_filter|mc_register_condition|mc_register_action|mc_register_restriction|mc_register_placeholder|mc_create_menu)\s*\(\s*"([^"\n]*)"/g;

	for (let match = pattern.exec(clean); match != null; match = pattern.exec(clean)) {
		const name = match[2];
		if (name.length == 0) continue;
		const at = match.index + match[0].length - 1 - name.length;
		const line = lineOf(starts, at);
		const column = at - starts[line];
		found.push({ kind: NATIVES[match[1]], name, file, line, column, endColumn: column + name.length, language: "pawn", via: match[1], doc: commentAbove(lines, line) });
	}
	return found;
}
