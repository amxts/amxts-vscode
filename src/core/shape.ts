/**
 * The shape of a Menu Core menu file: the closed key sets of each level, the
 * kind of each value, the INI columns, and the built-in names.
 *
 * The key sets are Menu Core's own (`src/menu-file.ts` of @amxts/menu-core,
 * `FILE_KEYS`, `MENU_KEYS`, ... and `INI_*_KEYS`) in the same order;
 * `test/shape.test.ts` compares them with menu-core's source when it is next
 * to this repository.
 */

/**
 * What a name in a menu file names. A "requirement" is a name of `visible`,
 * `enabled` and `when` in YAML and JSON: a restriction answers it, else a
 * condition, else the "*" restriction.
 */
export type NameKind = "condition" | "action" | "restriction" | "requirement" | "placeholder";

/** The kind of a field's value. */
export type FieldKind
	/** Text: a lang key or the text itself; `%placeholders%` are read where `placeholders` is set. */
	= | "text"
		| "flag"
		| "number"
	/** A name, several space-separated, or a list of names. */
		| "names"
	/** A line of names, or a list of requirements: each a line of names or `{ when, message }` (`enabled`). */
		| "requirements"
		| "object"
		| "list";

/** A level of a YAML or JSON menu file. */
export type Level = "file" | "labels" | "menus" | "menu" | "item" | "fixed" | "view" | "variant" | "requirement" | "filter";

export interface Field {
	key: string;
	kind: FieldKind;
	description: string;
	/** For "names": what the names are. */
	names?: NameKind;
	/** For "text": whether `%placeholders%` in it are read. */
	placeholders?: boolean;
	/** For "object", "list" and "requirements": the level of the object, or of each object of the list. */
	level?: Level;
}

const TEXT = "A lang key or the text itself.";

/** What a line of names is, for the fields that take one. */
const NAMES = "One name, several space-separated (all must hold), or a list of them; `!NAME` turns one around; `NAME:param` hands the test a parameter and takes the rest of the line, so it goes last. A name is a restriction or a condition.";

const ITEM_FIELDS: Field[] = [
	{ key: "name", kind: "text", placeholders: true, description: `The item's text. ${TEXT}` },
	{ key: "placeholder", kind: "text", placeholders: true, description: "Text after the name, e.g. `%hp%`." },
	{ key: "action", kind: "names", names: "action", description: "Actions run when the item is chosen: registered ones, `SHOW_<MENU>`, `CLOSE_MENU`." },
	{ key: "visible", kind: "names", names: "requirement", description: `Whether the item is shown at all: while its names do not hold, it is left out and takes no slot (a fixed item leaves its slot blank). ${NAMES} INI has nothing that hides an item.` },
	{ key: "enabled", kind: "requirements", names: "requirement", level: "requirement", description: "Whether the item can be chosen: while not, it is greyed out with `message` beside it. A line of names - one, several space-separated (all must hold), `!NAME` turns one around, `NAME:param` hands the test a parameter and goes last - or a list of requirements, each a line of names or `{ when, message }` with a message of its own; the first that fails gives its message. A name is a restriction or a condition. INI: the condition column greys an item out without a message, the restriction column with the message column." },
	{ key: "message", kind: "text", description: "Beside the item while `enabled` greys it out, in place of the restriction's own message; a requirement's own `message` goes in place of this one." },
	{ key: "spaceBefore", kind: "number", description: "Blank lines before the item." },
	{ key: "spaceAfter", kind: "number", description: "Blank lines after the item." },
	{ key: "variants", kind: "list", level: "variant", description: "Several faces of the item: the first variant whose `when` holds is shown; when none does, the first, greyed out. INI: `A|B` in the name, condition and action columns." },
];

function pick(keys: string[]) {
	return keys.map(key => ITEM_FIELDS.find(field => field.key == key)!);
}

/** Each level of a YAML or JSON menu file and its fields, in Menu Core's order. */
export const LEVELS: Record<Level, Field[]> = {
	file: [
		{ key: "chatPrefix", kind: "text", description: "The chat prefix of Menu Core's messages (the \"nothing to list\" message). INI: `[MAIN]` `PREFIX`." },
		{ key: "labels", kind: "object", level: "labels", description: "The words of the buttons, the page and the countdown. INI: `[MAIN]` `KEY = { ... }`." },
		{ key: "menus", kind: "object", level: "menus", description: "The menus: `{ NAME: menu }`; a name starting with `LIST_` is a list menu. INI: a `[NAME]` section each." },
	],
	labels: [
		{ key: "exit", kind: "text", description: `The exit button. ${TEXT}` },
		{ key: "back", kind: "text", description: `The back button. ${TEXT}` },
		{ key: "next", kind: "text", description: `The next page button. ${TEXT}` },
		{ key: "number", kind: "text", description: "The number before an item: `!y[%d]!w` unless the dictionary says otherwise." },
		{ key: "disabled", kind: "text", description: "The number before a greyed-out item." },
		{ key: "page", kind: "text", description: `The page counter. ${TEXT}` },
		{ key: "time", kind: "text", description: `The countdown. ${TEXT}` },
	],
	menus: [],
	menu: [
		{ key: "title", kind: "text", placeholders: true, description: `The title; a menu has one. ${TEXT} INI: \`TITLE\`.` },
		{ key: "activeOn", kind: "names", names: "condition", description: "Conditions the menu opens only under. INI: `ACTIVE_ON`." },
		{ key: "hideBack", kind: "flag", description: "`true` leaves the back button out. INI: `HIDE_BACK`." },
		{ key: "hideExit", kind: "flag", description: "`true` leaves the exit button out. INI: `HIDE_EXIT`." },
		{ key: "locked", kind: "flag", description: "Items cannot be chosen, and the menu cannot be closed or replaced. INI: `LOCKED`." },
		{ key: "sharedTimer", kind: "flag", description: "One countdown for everyone who looks at the menu. INI: `GLOBAL`." },
		{ key: "time", kind: "number", description: "A countdown in seconds. INI: `TIME`." },
		{ key: "onTimeout", kind: "names", names: "action", description: "Actions run when the countdown ends. INI: `ON_TIMEOUT`." },
		{ key: "items", kind: "list", level: "item", description: "An items menu's items. INI: `ITEMS`." },
		{ key: "fixedItems", kind: "list", level: "fixed", description: "Items that keep their `slot`, 1-7, on every page. INI: `FIXED_ITEMS`." },
		{ key: "filters", kind: "list", level: "filter", description: "A list menu's filters: rows the `when` of one does not hold for are left out. INI: `FILTER`." },
		{ key: "view", kind: "object", level: "view", description: "A list menu's row, drawn per player or per row of its list source. INI: `VIEW`." },
	],
	item: ITEM_FIELDS,
	fixed: [{ key: "slot", kind: "number", description: "The item's key, 1 to 7." }, ...ITEM_FIELDS],
	view: pick(["name", "action", "enabled", "message", "variants"]),
	variant: [
		{ key: "name", kind: "text", placeholders: true, description: `The variant's text. ${TEXT}` },
		{ key: "when", kind: "names", names: "requirement", description: `The names the variant is shown under: the first variant whose \`when\` holds is shown; one without \`when\` always holds. ${NAMES}` },
		{ key: "action", kind: "names", names: "action", description: "Actions run when the variant is chosen." },
	],
	requirement: [
		{ key: "when", kind: "names", names: "requirement", description: `The names that must hold for the item to be chosen. ${NAMES}` },
		{ key: "message", kind: "text", description: "Beside the item while these names do not hold - instead of the item's `message`." },
	],
	filter: [
		{ key: "when", kind: "names", names: "requirement", description: `Rows the names do not hold for are left out. ${NAMES}` },
		{ key: "message", kind: "text", description: "Said when no row is left." },
	],
};

/**
 * The names of INI's columns where a YAML or JSON file has other keys: an
 * item's condition is `visible` or `enabled`, its restriction `enabled`, a
 * variant's or a filter's condition `when`. The "did you mean" of such an
 * unknown key names those a level has, as Menu Core says it (`iniName()` of
 * its `src/menu-file.ts`).
 */
const INI_NAMES = new Map([
	["condition", ["visible", "enabled", "when"]],
	["restriction", ["enabled"]],
	["restrictionMessage", ["message"]],
]);

/** The keys of a level meant by an INI column's name: `["visible", "enabled"]` for "condition" in an item; [] for any other key. */
export function meantKeys(level: Level, key: string) {
	const known = keysOf(level);
	return (INI_NAMES.get(key) ?? []).filter(each => known.includes(each));
}

/** The keys of a level, as Menu Core lists them. */
export function keysOf(level: Level) {
	return LEVELS[level].map(field => field.key);
}

export function fieldOf(level: Level, key: string) {
	return LEVELS[level].find(field => field.key == key);
}

/** What a level is called in a message, as Menu Core says it. */
export function levelWords(level: Level, menu: string) {
	if (level == "file") return "the menu file";
	if (level == "labels") return "\"labels\"";
	if (level == "menu") return `the menu "${menu}"`;
	if (level == "item") return "an item";
	if (level == "fixed") return "a fixed item";
	if (level == "view") return "the view";
	if (level == "variant") return "a variant";
	if (level == "requirement") return "a requirement";
	if (level == "filter") return "a filter";
	return "\"menus\"";
}

/** An INI key of a menu section or [MAIN], and what it holds. */
export interface IniKey {
	key: string;
	description: string;
	/** "names" is a line of names; "flag" YES or NO; "block" rows in quotes; "labels" a block of `KEY = value`. */
	kind: "text" | "names" | "flag" | "number" | "block" | "labels";
	names?: NameKind;
	/** For "names": only the first value of the line is read (ON_TIMEOUT). */
	firstOnly?: boolean;
	/** For "block": its columns. */
	columns?: IniColumn[];
}

export interface IniColumn {
	name: string;
	kind: "text" | "names" | "slot" | "spacing";
	names?: NameKind;
	placeholders?: boolean;
	description: string;
}

const COLUMN: Record<string, IniColumn> = {
	slot: { name: "slot", kind: "slot", description: "The item's key, 1 to 7." },
	name: { name: "name", kind: "text", placeholders: true, description: "The item's text; `A|B` are variants, the first whose condition holds shown (YAML: `variants`)." },
	placeholder: { name: "placeholder", kind: "text", placeholders: true, description: "Text after the name, e.g. `%hp%`." },
	condition: { name: "condition", kind: "names", names: "condition", description: "Conditions the item needs; without them it is greyed out, with no message beside it (YAML: `enabled` without `message`). `!NAME` turns one around; `A|B` one per variant." },
	action: { name: "action", kind: "names", names: "action", description: "Actions run when the item is chosen; `A|B` one per variant." },
	restriction: { name: "restriction", kind: "names", names: "restriction", description: "Restrictions: while one says no, the item is greyed out with the message column beside it, else the restriction's own message (YAML: `enabled` with `message`). `NAME:text` hands it a text and takes the rest of the column." },
	message: { name: "message", kind: "text", description: "Beside the item while a restriction greys it out (YAML: `message`)." },
	spacing: { name: "spacing", kind: "spacing", description: "Blank lines: `2` after the item, `1 2` one before and two after." },
	filter: { name: "condition", kind: "names", names: "condition", description: "Rows the condition does not hold for are left out." },
	filterMessage: { name: "message", kind: "text", description: "Said when no row is left." },
};

function columns(names: string[]) {
	return names.map(name => COLUMN[name]);
}

export const INI_MAIN: IniKey[] = [
	{ key: "PREFIX", kind: "text", description: "The chat prefix of Menu Core's messages." },
	{ key: "KEY", kind: "labels", description: "The words of the buttons, the page and the countdown: `KEY = { EXIT = ... }`." },
];

export const INI_LABELS: IniKey[] = [
	{ key: "EXIT", kind: "text", description: "The exit button." },
	{ key: "BACK", kind: "text", description: "The back button." },
	{ key: "NEXT", kind: "text", description: "The next page button." },
	{ key: "NUMBER", kind: "text", description: "The number before an item: `!y[%d]!w` unless the dictionary says otherwise." },
	{ key: "DISABLED", kind: "text", description: "The number before a greyed-out item." },
	{ key: "PAGE", kind: "text", description: "The page counter." },
	{ key: "TIME", kind: "text", description: "The countdown." },
];

export const INI_MENU: IniKey[] = [
	{ key: "TITLE", kind: "text", description: "The title; a section without one is not a menu." },
	{ key: "ACTIVE_ON", kind: "names", names: "condition", description: "Conditions the menu opens only under." },
	{ key: "HIDE_BACK", kind: "flag", description: "`YES` leaves the back button out." },
	{ key: "HIDE_EXIT", kind: "flag", description: "`YES` leaves the exit button out." },
	{ key: "TIME", kind: "number", description: "A countdown in seconds." },
	{ key: "ON_TIMEOUT", kind: "names", names: "action", firstOnly: true, description: "The action run when the countdown ends (the first value of the line)." },
	{ key: "LOCKED", kind: "flag", description: "`YES`: items cannot be chosen, and the menu cannot be closed or replaced." },
	{ key: "GLOBAL", kind: "flag", description: "`YES`: one countdown for everyone who looks at the menu." },
	{ key: "ITEMS", kind: "block", columns: columns(["name", "placeholder", "condition", "action", "restriction", "message", "spacing"]), description: "An items menu's items, a row in quotes each: name | placeholder | condition | action | restriction | message | spacing. INI has nothing that hides an item (YAML: `visible`)." },
	{ key: "FIXED_ITEMS", kind: "block", columns: columns(["slot", "name", "placeholder", "condition", "action", "restriction", "message", "spacing"]), description: "Items that keep their slot on every page: slot | name | placeholder | condition | action | restriction | message | spacing." },
	{ key: "FILTER", kind: "block", columns: columns(["filter", "filterMessage"]), description: "A list menu's filters: condition | message." },
	{ key: "VIEW", kind: "block", columns: columns(["name", "condition", "action", "restriction", "message"]), description: "A list menu's row (the first row of the block): name | condition | action | restriction | message." },
];

export function iniKeysOf(list: IniKey[]) {
	return list.map(each => each.key);
}

export function iniKey(list: IniKey[], key: string) {
	const upper = key.toUpperCase();
	return list.find(each => each.key == upper);
}

/** The placeholders every menu has. */
export const BUILT_IN_PLACEHOLDERS = ["name", "target", "time"];

export const PLACEHOLDER_DOCS: Record<string, string> = {
	name: "A list row's text: the player's name, or the row's own text.",
	target: "The name of the menu's target player.",
	time: "The seconds left of the countdown.",
};

const OVERRIDE = "A plugin that registers the name answers instead.";

/** The conditions built into Menu Core, answered while no plugin registers the name; FLAG_ stands for FLAG_<letters>. */
export const BUILT_IN_CONDITIONS: Record<string, string> = {
	IS_ALIVE: `Built into Menu Core: the player is alive. ${OVERRIDE}`,
	IS_DEAD: `Built into Menu Core: the player is not alive - a spectator too. ${OVERRIDE}`,
	TEAM_CT: `Built into Menu Core: the player is in the CT team. ${OVERRIDE}`,
	TEAM_TERRORIST: `Built into Menu Core: the player is in the TERRORIST team. ${OVERRIDE}`,
	TEAM_SPECTATOR: `Built into Menu Core: the player is a spectator. ${OVERRIDE}`,
	TEAM_UNASSIGNED: `Built into Menu Core: the player has no team yet. ${OVERRIDE}`,
	IS_BOT: `Built into Menu Core: the player is a bot. ${OVERRIDE}`,
	IS_ADMIN: `Built into Menu Core: the player has any access but a plain user's \`z\` - AMX Mod X's \`is_user_admin\`. ${OVERRIDE}`,
	FLAG_: `Built into Menu Core: \`FLAG_<letters>\` - the player has any of those users.ini flags, e.g. \`FLAG_abc\`. ${OVERRIDE}`,
};

/** A condition built into Menu Core, case aside: IS_ALIVE, TEAM_CT, IS_ADMIN, FLAG_abc ... */
export function isBuiltInCondition(name: string) {
	return builtInConditionDoc(name) != null;
}

/** What a built-in condition is; undefined for any other name. */
export function builtInConditionDoc(name: string): string | undefined {
	const upper = name.toUpperCase();
	if (upper != "FLAG_" && BUILT_IN_CONDITIONS[upper] != null) return BUILT_IN_CONDITIONS[upper];
	return upper.startsWith("FLAG_") ? BUILT_IN_CONDITIONS.FLAG_ : undefined;
}

export const BUILT_IN_ACTIONS: Record<string, string> = {
	CLOSE_MENU: "Built into Menu Core: closes the menu.",
};
