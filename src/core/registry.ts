/**
 * The names the workspace registers - conditions, actions, restrictions,
 * placeholders, condition filters and menus made in code - by file, so one
 * file is replaced as it changes; and what Menu Core knows of a name a menu
 * file uses, with the same rules as its checks on the server's first frame
 * (`checkNames()` of @amxts/menu-core's `src/index.ts`).
 */
import { Problem, NameUse, MenuDef } from "./analyze";
import { BUILT_IN_CONDITIONS, BUILT_IN_PLACEHOLDERS, isBuiltInCondition, NameKind } from "./shape";
import { closest, didYouMean } from "./suggest";

/** What a plugin registers: a name of a kind, a condition filter, a menu made in code. A requirement is not registered as one - it is a restriction or a condition. */
export type RegistrationKind = Exclude<NameKind, "requirement"> | "filter" | "menu";

export interface Registration {
	kind: RegistrationKind;
	name: string;
	/** The file's path. */
	file: string;
	/** Where the name is written, from 0, its quotes aside. */
	line: number;
	column: number;
	endColumn: number;
	language: "ts" | "pawn";
	/** How it is registered: "menus.addCondition", "mc_register_condition". */
	via: string;
	/** Its JSDoc, or the comment above it. */
	doc?: string;
	/** A placeholder of one menu (`menu.addPlaceholder()`): that menu; "" when it cannot be told which. */
	menu?: string;
}

/** Whether a placeholder reaches a menu: it is that menu's, or every menu's. */
export function reaches(placeholder: Registration, menu: string) {
	return !placeholder.menu || placeholder.menu == menu;
}

/** Conditions and restrictions are found case aside; actions, placeholders and menus as written. */
function sameName(kind: RegistrationKind, a: string, b: string) {
	if (kind == "condition" || kind == "restriction" || kind == "filter") return a.toUpperCase() == b.toUpperCase();
	return a == b;
}

export class Registry {
	private files = new Map<string, Registration[]>();
	/** The registrations by kind, grouped on the first lookup after a change. */
	private kinds: Map<RegistrationKind, Registration[]> | null = null;
	/** Grows on every change: what was worked out from the registrations is stale when it has. */
	version = 0;

	set(file: string, registrations: Registration[]) {
		const before = this.files.get(file);
		if (before == null && registrations.length == 0) return false;
		if (before != null && same(before, registrations)) return false;
		if (registrations.length == 0) this.files.delete(file);
		else this.files.set(file, registrations);
		this.kinds = null;
		this.version++;
		return true;
	}

	delete(file: string) {
		return this.set(file, []);
	}

	all() {
		return [...this.files.values()].flat();
	}

	ofKind(kind: RegistrationKind) {
		if (this.kinds == null) {
			this.kinds = new Map();
			for (const each of this.all()) {
				const list = this.kinds.get(each.kind);
				if (list != null) list.push(each);
				else this.kinds.set(each.kind, [each]);
			}
		}
		return this.kinds.get(kind) ?? [];
	}

	find(kind: RegistrationKind, name: string) {
		return this.ofKind(kind).filter(each => sameName(kind, each.name, name));
	}

	names(kind: RegistrationKind) {
		const seen = new Set<string>();
		for (const each of this.ofKind(kind)) seen.add(each.name);
		return [...seen];
	}

	/** Placeholders a menu has: its own, those whose menu is not known, and the global ones. */
	placeholderNames(menu: string) {
		const seen = new Set<string>(BUILT_IN_PLACEHOLDERS);
		for (const each of this.ofKind("placeholder")) {
			if (reaches(each, menu)) seen.add(each.name);
		}
		return [...seen];
	}
}

function same(a: Registration[], b: Registration[]) {
	return a.length == b.length && a.every((each, i) => JSON.stringify(each) == JSON.stringify(b[i]));
}

/** The menus SHOW_<MENU> can open: those the file reads, and those made in code. */
export function menuNames(registry: Registry, fileMenus: MenuDef[]) {
	const names = new Set(fileMenus.filter(menu => menu.read).map(menu => menu.name));
	for (const name of registry.names("menu")) names.add(name);
	return [...names];
}

export function conditionNames(registry: Registry) {
	const builtIn = Object.keys(BUILT_IN_CONDITIONS).filter(name => name != "FLAG_");
	return registry.names("condition").concat(builtIn);
}

export function knownCondition(registry: Registry, name: string) {
	return registry.find("condition", name).length > 0 || isBuiltInCondition(name);
}

/** A name of `visible`, `enabled` or `when`: a restriction, a condition, or anything while "*" is registered. */
export function knownRequirement(registry: Registry, name: string) {
	return registry.find("restriction", name).length > 0 || knownCondition(registry, name) || registry.names("restriction").includes("*");
}

const NOT_SEEN = "Nothing in the workspace registers it; a Pawn plugin on the server may.";
const NOT_MADE = "Nothing in the workspace makes it; a Pawn plugin on the server may.";

/** Sentences joined: each ends with a stop, "?" or "!" as written, or "." when it has none. */
export function sentences(...parts: string[]) {
	return parts.map(part => (/[.?!]$/.test(part) ? part : `${part}.`)).join(" ");
}

/** The problem of a name nobody registers, as Menu Core says it - or null when it is known. */
export function unknownName(registry: Registry, use: NameUse, fileMenus: MenuDef[]): Problem | null {
	const found = (suggested: string | undefined, message: string, replace = suggested) => {
		const fix = replace != null ? { title: `Change to "${replace}"`, start: use.start, end: use.end, text: replace } : undefined;
		const seen = use.kind == "action" && use.name.startsWith("SHOW_") ? NOT_MADE : NOT_SEEN;
		const problem: Problem = { start: use.start, end: use.end, severity: "warning", code: "unknown-name", message: sentences(`${use.menu}: ${message}${didYouMean(suggested)}`, seen), fix };
		return problem;
	};
	const name = use.name;

	if (use.kind == "condition") {
		if (knownCondition(registry, name)) return null;
		return found(closest(name, conditionNames(registry)), `the condition "${name}" is not registered`);
	}

	if (use.kind == "requirement") {
		if (knownRequirement(registry, name)) return null;
		const known = registry.names("restriction").filter(each => each != "*").concat(conditionNames(registry));
		return found(closest(name, known), `the condition "${name}" is not registered`);
	}

	if (use.kind == "restriction") {
		if (registry.find("restriction", name).length > 0 || registry.names("restriction").includes("*") || knownCondition(registry, name)) return null;
		const known = registry.names("restriction").concat(conditionNames(registry));
		return found(closest(name, known), `the restriction "${name}" is not registered`);
	}

	if (use.kind == "action") {
		if (name == "CLOSE_MENU" || registry.find("action", name).length > 0) return null;
		const menus = menuNames(registry, fileMenus);

		if (name.startsWith("SHOW_")) {
			const target = name.slice(5);
			if (menus.includes(target)) return null;
			const suggested = closest(target, menus);
			return found(suggested, `${name} opens the menu "${target}", which is not there`, suggested != null ? `SHOW_${suggested}` : undefined);
		}

		// The actions items made in code were given ("SHOP#1") are no one's to name.
		const known = registry.names("action").filter(each => !each.includes("#")).concat(["CLOSE_MENU"]);
		return found(closest(name, known), `the action "${name}" is not registered`);
	}

	const all = registry.placeholderNames(use.menu);
	if (all.includes(name)) return null;
	return found(closest(name, all), `the placeholder %${name}% is not registered`);
}

/** The warnings of the names a menu file uses that nobody registers. */
export function checkNames(registry: Registry, uses: NameUse[], fileMenus: MenuDef[]) {
	const problems: Problem[] = [];
	for (const use of uses) {
		if (!use.checked) continue;
		const problem = unknownName(registry, use, fileMenus);
		if (problem != null) problems.push(problem);
	}
	return problems;
}

/**
 * What Menu Core says of a line of names on the server's first frame, a
 * variant at a time: a name listed twice - with a fix that removes it - and a
 * name with its opposite. Conditions and restrictions are compared case
 * aside, actions as written.
 */
export function checkLines(uses: NameUse[]) {
	const problems: Problem[] = [];
	const lines = new Map<string, NameUse[]>();
	for (const use of uses) {
		if (!use.checked || use.kind == "placeholder" || use.line.length == 0) continue;
		const key = `${use.kind} ${use.line}`;
		lines.set(key, [...(lines.get(key) ?? []), use]);
	}

	for (const line of lines.values()) {
		const seen = new Map<string, NameUse>();
		for (const use of line) {
			const negated = use.kind != "action" && use.token.startsWith("!");
			const tokenName = negated ? use.token.slice(1) : use.token;
			const key = use.kind == "action" ? tokenName : tokenName.toUpperCase();
			const own = `${negated ? "!" : ""}${key}`;
			const opposite = `${negated ? "" : "!"}${key}`;
			const start = use.tokenStart >= 0 ? use.tokenStart : use.start;
			const end = use.tokenStart >= 0 ? use.tokenStart + use.token.length : use.end;
			const earlier = seen.get(opposite) ?? seen.get(own);

			if (earlier == null) {
				seen.set(own, use);
				continue;
			}

			if (seen.has(opposite)) {
				problems.push({ start, end, severity: "warning", code: "list", message: `${use.menu}: ${earlier.token} and ${use.token} together can never hold` });
				continue;
			}

			const message = `${use.token} is listed more than once`;
			const fix = use.cut >= 0 ? { title: `Remove ${use.token}`, start: use.cut, end, text: "" } : undefined;
			problems.push({ start, end, severity: "warning", code: "list", message: `${use.menu}: ${message}`, fix });
		}
	}
	return problems;
}
