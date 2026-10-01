/**
 * Completion, hover and go to definition in a menu file, without the editor:
 * plain objects with offsets, which the extension turns into VS Code's.
 */
import { Analysis, MenuDef, NameUse } from "./analyze";
import { Context } from "./context";
import { menuNames, reaches, Registration, Registry } from "./registry";
import { BUILT_IN_ACTIONS, BUILT_IN_CONDITIONS, BUILT_IN_PLACEHOLDERS, builtInConditionDoc, NameKind, PLACEHOLDER_DOCS } from "./shape";

export interface Item {
	label: string;
	kind: "key" | NameKind | "menu" | "value" | "builtin";
	/** Where it is registered, or what it is. */
	detail?: string;
	/** Markdown. */
	documentation?: string;
	insertText: string;
	start: number;
	end: number;
	/** Built-ins after what the workspace registers. */
	sortText: string;
	filterText?: string;
}

/** "plugins/vip.ts:12" - how the extension names a registration's place. */
export type Describe = (registration: Registration) => string;

function registrationsDoc(registrations: Registration[], describe: Describe) {
	return registrations
		.map((each) => {
			const where = `${each.language == "pawn" ? "Pawn" : "TypeScript"}: \`${each.via}("${each.name}")\` in ${describe(each)}`;
			const menu = each.menu ? ` (menu ${each.menu})` : each.menu === "" ? " (a menu's own placeholder)" : "";
			return each.doc ? `${where}${menu}\n\n${each.doc}` : `${where}${menu}`;
		})
		.join("\n\n---\n\n");
}

/** The name as it goes in: in quotes for a YAML value that starts with ! or %. */
function wrapped(context: Context, text: string) {
	if (context.type == "names" && context.wrap) return JSON.stringify(`!${text}`);
	if (context.type == "placeholder" && context.wrap) return JSON.stringify(`%${text}%`);
	return text;
}

function nameItems(context: Extract<Context, { type: "names" }>, registry: Registry, fileMenus: MenuDef[], describe: Describe): Item[] {
	const items: Item[] = [];
	const seen = new Set<string>();
	const push = (label: string, kind: Item["kind"], detail: string, documentation: string | undefined, sort: string) => {
		const key = kind == "condition" || kind == "restriction" ? label.toUpperCase() : label;
		if (seen.has(key)) return;
		seen.add(key);
		const insertText = wrapped(context, label);
		items.push({ label, kind, detail, documentation, insertText, start: context.start, end: context.end, sortText: `${sort}${label}`, filterText: context.wrap ? insertText : undefined });
	};
	const registered = (kind: Exclude<NameKind, "requirement">, sort: string) => {
		for (const name of registry.names(kind)) {
			if (kind == "action" && name.includes("#")) continue;
			const found = registry.find(kind, name);
			push(name, kind, `${kind} - ${found.map(describe).join(", ")}`, registrationsDoc(found, describe), sort);
		}
	};
	const conditions = (sort: string) => {
		registered("condition", sort);
		for (const [name, doc] of Object.entries(BUILT_IN_CONDITIONS)) {
			if (registry.find("condition", name).length == 0) push(name, "builtin", "built-in condition", doc, "9");
		}
	};

	// An entry of `enabled` may be a `{ when, message }` too.
	if (context.keys != null) {
		for (const { key, description } of context.keys) items.push({ label: key, kind: "key", documentation: description, insertText: `${key}: `, start: context.start, end: context.end, sortText: `0${key}` });
	}

	if (context.kind == "condition") conditions("1");

	// A requirement is a restriction, else a condition - the order Menu Core looks them up in.
	if (context.kind == "restriction" || context.kind == "requirement") {
		registered("restriction", "1");
		conditions("2");
	}

	if (context.kind == "action") {
		registered("action", "1");
		push("CLOSE_MENU", "builtin", "built-in action", BUILT_IN_ACTIONS.CLOSE_MENU, "8");
		for (const menu of menuNames(registry, fileMenus)) {
			const inFile = fileMenus.find(each => each.name == menu && each.read);
			const inCode = registry.find("menu", menu);
			const where = [inFile ? "this file" : "", ...inCode.map(describe)].filter(each => each.length > 0).join(", ");
			push(`SHOW_${menu}`, "menu", `opens the menu ${menu} - ${where}`, `Built into Menu Core: opens the menu \`${menu}\`.`, "7");
		}
	}

	if (context.kind == "placeholder") return placeholderItems({ type: "placeholder", menu: context.menu, start: context.start, end: context.end, close: false, wrap: false }, registry, describe);
	return items;
}

function placeholderItems(context: Extract<Context, { type: "placeholder" }>, registry: Registry, describe: Describe): Item[] {
	return registry.placeholderNames(context.menu).map((name) => {
		const found = registry.find("placeholder", name).filter(each => reaches(each, context.menu));
		const builtIn = BUILT_IN_PLACEHOLDERS.includes(name);
		const insertText = context.wrap ? wrapped(context, name) : context.close ? `${name}%` : name;
		return {
			label: `%${name}%`,
			kind: builtIn ? "builtin" : "placeholder",
			detail: builtIn ? "built-in placeholder" : `placeholder - ${found.map(describe).join(", ")}`,
			documentation: builtIn ? PLACEHOLDER_DOCS[name] : registrationsDoc(found, describe),
			insertText,
			start: context.start,
			end: context.end,
			sortText: `${builtIn ? "9" : "1"}${name}`,
			filterText: context.wrap ? insertText : name,
		} satisfies Item;
	});
}

export function completions(context: Context, registry: Registry, fileMenus: MenuDef[], describe: Describe): Item[] {
	if (context.type == "key") {
		return context.keys.map(({ key, description }) => {
			let insertText = key;
			if (context.format == "yaml") insertText = `${key}: `;
			if (context.format == "ini") insertText = `${key} = `;
			if (context.format == "json") insertText = context.quoted ? key : `"${key}": `;
			return { label: key, kind: "key", documentation: description, insertText, start: context.start, end: context.end, sortText: `0${key}` } satisfies Item;
		});
	}

	if (context.type == "values") {
		return context.values.map(value => ({ label: value, kind: "value", insertText: value, start: context.start, end: context.end, sortText: `0${value}` }) satisfies Item);
	}

	if (context.type == "placeholder") return placeholderItems(context, registry, describe);
	return nameItems(context, registry, fileMenus, describe);
}

// ---------------------------------------------------------------- hover and definition

export function useAt(analysis: Analysis, offset: number) {
	return analysis.uses.find(use => use.start <= offset && offset <= use.end && use.end > use.start);
}

/** A menu file's menu at an offset: its section or key. */
export function menuAt(analysis: Analysis, offset: number) {
	return analysis.menus.find(menu => menu.start <= offset && offset <= menu.end);
}

const KIND_WORDS: Record<NameKind, string> = { condition: "Condition", action: "Action", restriction: "Restriction", requirement: "Condition", placeholder: "Placeholder" };

/** What a name is called in its hover: a requirement a restriction answers is a restriction. */
function kindWord(use: NameUse, registry: Registry) {
	if (use.kind == "requirement" && registry.find("restriction", use.name).length > 0) return "Restriction";
	return KIND_WORDS[use.kind];
}

/** The menu `SHOW_<MENU>` opens, when no plugin registers that action itself; null for any other name. */
export function shownMenu(use: Pick<NameUse, "kind" | "name">, registry: Registry) {
	return use.kind == "action" && use.name.startsWith("SHOW_") && registry.find("action", use.name).length == 0 ? use.name.slice(5) : null;
}

/** The registrations a name use points to. */
export function registrationsOf(use: Pick<NameUse, "kind" | "name" | "menu">, registry: Registry): Registration[] {
	const menu = shownMenu(use, registry);
	if (menu != null) return registry.find("menu", menu);
	if (use.kind == "restriction" || use.kind == "requirement") {
		const own = registry.find("restriction", use.name);
		return own.length > 0 ? own : registry.find("condition", use.name);
	}
	if (use.kind == "placeholder") return registry.find("placeholder", use.name).filter(each => reaches(each, use.menu));
	return registry.find(use.kind, use.name);
}

/** What a hover over a name says, in markdown. */
export function hoverOf(use: NameUse, registry: Registry, fileMenus: MenuDef[], describe: Describe) {
	const shown = use.kind == "placeholder" ? `%${use.name}%` : use.name;
	const title = `**${kindWord(use, registry)}** \`${shown}\``;
	const found = registrationsOf(use, registry);
	const parts = [title];

	const target = shownMenu(use, registry);
	if (target != null) {
		const inFile = fileMenus.find(menu => menu.name == target && menu.read);
		parts.push(`Built into Menu Core: opens the menu \`${target}\`.`);
		if (inFile) parts.push("The menu is in this file.");
		if (found.length > 0) parts.push(registrationsDoc(found, describe));
		if (!inFile && found.length == 0) parts.push(`The menu \`${target}\` is neither in this file nor made in code in the workspace.`);
		return parts.join("\n\n");
	}

	if (found.length > 0) {
		if (use.kind == "restriction" && registry.find("restriction", use.name).length == 0) parts.push("No restriction of this name: the condition is asked instead.");
		parts.push(registrationsDoc(found, describe));
		const filters = use.kind == "condition" || use.kind == "requirement" ? registry.find("filter", use.name) : [];
		if (filters.length > 0) parts.push(`Filtered by:\n\n${registrationsDoc(filters, describe)}`);
		return parts.join("\n\n");
	}

	if (use.kind == "action" && use.name == "CLOSE_MENU") parts.push(BUILT_IN_ACTIONS.CLOSE_MENU);
	else if ((use.kind == "condition" || use.kind == "restriction" || use.kind == "requirement") && builtInConditionDoc(use.name) != null) parts.push(builtInConditionDoc(use.name)!);
	else if (use.kind == "placeholder" && BUILT_IN_PLACEHOLDERS.includes(use.name)) parts.push(`Built into Menu Core: ${PLACEHOLDER_DOCS[use.name]}`);
	else if ((use.kind == "restriction" || use.kind == "requirement") && registry.names("restriction").includes("*")) parts.push(`Answered by the restriction \`*\`:\n\n${registrationsDoc(registry.find("restriction", "*"), describe)}`);
	else parts.push("Not registered anywhere in the workspace. A Pawn plugin on the server that is not in the workspace may still register it.");
	return parts.join("\n\n");
}
