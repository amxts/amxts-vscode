import { describe, expect, test } from "bun:test";
import { analyze, Analysis } from "../src/core/analyze";
import { parseIni } from "../src/core/ini";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./helpers";

/** "condition IS_ADMIN @MAIN_MENU" for each name a menu uses, in order - the ones Menu Core checks. */
function uses(analysis: Analysis) {
	return analysis.uses.filter(use => use.checked).map(use => `${use.kind} ${use.name} @${use.menu}`);
}

/**
 * The same, sorted, a condition, a restriction and a requirement all "a test":
 * INI's condition and restriction columns are YAML's and JSON's `enabled`, `when`.
 */
function tests(analysis: Analysis) {
	return uses(analysis).map(use => use.replace(/^(condition|restriction|requirement) /, "test ")).sort();
}

/** The warnings and errors; a note of an item that does nothing is tested on its own. */
function messages(analysis: Analysis) {
	return analysis.problems.filter(problem => problem.severity != "info").map(problem => problem.message);
}

/** The text each problem points at. */
function marked(text: string, analysis: Analysis) {
	return analysis.problems.filter(problem => problem.severity != "info").map(problem => text.slice(problem.start, problem.end));
}

describe("INI as Config Core reads it", () => {
	test("sections, keys, blocks and rows with their places", () => {
		const text = `; top\n[MAIN]\nPREFIX = "My prefix" ; comment\nKEY = {\n\tEXIT = X\n}\n[A]\nITEMS = {\n\t"Name"  "" "IS_A"\n}\n`;
		const document = parseIni(text);
		expect(document.sections.map(section => section.name)).toEqual(["MAIN", "A"]);
		const prefix = document.sections[0].entries[0];
		expect(prefix.values.map(value => text.slice(value.start, value.end))).toEqual(["My prefix"]);
		expect(document.sections[0].entries[1].rows?.map(row => row.key)).toEqual(["EXIT"]);
		const row = document.sections[1].entries[0].rows![0];
		expect(row.values.map(value => value.text)).toEqual(["Name", "", "IS_A"]);
		expect(text.slice(row.values[2].start, row.values[2].end)).toBe("IS_A");
		expect(document.lines[8].blocks.map(block => block.key)).toEqual(["ITEMS"]);
	});

	test("CRLF line ends", () => {
		const text = "[A]\r\nTITLE = T\r\nACTIVE_ON = X\r\n";
		const analysis = analyze(text, "ini");
		expect(analysis.uses.map(use => text.slice(use.start, use.end))).toEqual(["X"]);
	});
});

describe("the same menus in three formats", () => {
	const ini = analyze(fixture("configs/playground/menu.ini"), "ini");
	const yaml = analyze(fixture("configs/playground/menu.yaml"), "yaml");
	const json = analyze(fixture("configs/playground/menu.json"), "json");

	test("read without a problem", () => {
		expect(messages(ini)).toEqual([]);
		expect(messages(yaml)).toEqual([]);
		expect(messages(json)).toEqual([]);
	});

	test("name the same conditions, actions, restrictions and placeholders", () => {
		expect(uses(yaml).sort()).toEqual(uses(json).sort());
		expect(tests(ini)).toEqual(tests(yaml));
		expect(uses(yaml)).toContain("requirement IS_SPECTATOR @MAIN_MENU");
		expect(uses(ini)).toContain("condition IS_SPECTATOR @MAIN_MENU");
		expect(uses(yaml)).toContain("placeholder dm_status @ADMIN_MENU");
		expect(uses(yaml)).toContain("action SHOW_ADMIN_MENU @MAIN_MENU");
	});

	test("each name at its place", () => {
		for (const [analysis, file] of [[ini, "menu.ini"], [yaml, "menu.yaml"], [json, "menu.json"]] as const) {
			const text = fixture(`configs/playground/${file}`);
			for (const use of analysis.uses) expect(text.slice(use.start, use.end)).toBe(use.name);
		}
	});

	test("describe the same menus", () => {
		const names = (analysis: Analysis) => analysis.menus.map(menu => menu.name);
		expect(names(ini)).toEqual(names(yaml));
		expect(names(json)).toEqual(names(yaml));
	});
});

describe("the example of Menu Core's README, in three formats", () => {
	const read = (file: string, format: "ini" | "yaml" | "json") => analyze(readFileSync(join(import.meta.dir, "fixtures/readme", file), "utf8"), format);
	const ini = read("menu.ini", "ini");
	const yaml = read("menu.yaml", "yaml");
	const json = read("menu.jsonc", "json");

	test("reads without a problem, naming the same things", () => {
		for (const analysis of [ini, yaml, json]) expect(messages(analysis)).toEqual([]);
		expect(tests(ini)).toEqual(tests(yaml));
		expect(uses(json).sort()).toEqual(uses(yaml).sort());
	});
});

describe("YAML and JSON checks, in Menu Core's words", () => {
	test("an unknown key, with the one it may be and its fix", () => {
		const text = `menus:\n  A:\n    title: T\n    items:\n      - name: X\n        enabeld: IS_A\n`;
		const analysis = analyze(text, "yaml");
		expect(messages(analysis)).toEqual([`unknown key "enabeld" in an item - did you mean "enabled"?`]);
		expect(analysis.problems[0].fix).toMatchObject({ text: "enabled" });
		expect(marked(text, analysis)).toEqual(["enabeld"]);
	});

	test("a key Menu Core read before: the ones it reads instead, and no fix", () => {
		const text = [
			"menus:",
			"  A:",
			"    title: T",
			"    items:",
			"      - { name: X, condition: C, restriction: R, restrictionMessage: M }",
			"      - variants:",
			"          - { name: V, condition: C }",
			"      - { name: Y, enabled: [{ condition: C, restrictionMessage: M }] }",
			"    fixedItems:",
			"      - { slot: 1, name: F, condition: C }",
			"  LIST_B:",
			"    title: T",
			"    view: { name: V, condition: C }",
			"    filters:",
			"      - { condition: C, restriction: R }",
		].join("\n");
		const analysis = analyze(text, "yaml");
		expect(messages(analysis)).toEqual([
			`unknown key "condition" in an item - did you mean "visible" or "enabled"?`,
			`unknown key "restriction" in an item - did you mean "enabled"?`,
			`unknown key "restrictionMessage" in an item - did you mean "message"?`,
			`unknown key "condition" in a variant - did you mean "when"?`,
			`unknown key "condition" in a requirement - did you mean "when"?`,
			`unknown key "restrictionMessage" in a requirement - did you mean "message"?`,
			`a requirement without "when"`,
			`unknown key "condition" in a fixed item - did you mean "visible" or "enabled"?`,
			`unknown key "condition" in the view - did you mean "enabled"?`,
			`unknown key "condition" in a filter - did you mean "when"?`,
			`unknown key "restriction" in a filter`,
			`a filter without "when"`,
		]);
		expect(analysis.problems.filter(problem => problem.code == "unknown-key").every(problem => problem.fix == null)).toBe(true);
	});

	test("a value of the wrong kind", () => {
		const text = `menus:\n  A:\n    title: T\n    hideBack: yes\n    time: soon\n    items: {}\n`;
		expect(messages(analyze(text, "yaml"))).toEqual([`"hideBack" is true or false, not text`, `"time" is a number, not text`, `"items" is a list, not an object`]);
	});

	test("a menu without a title is left out - its names not checked", () => {
		const analysis = analyze(`{ "menus": { "A": { "items": [{ "name": "X", "action": "NOPE" }] } } }`, "json");
		expect(messages(analysis)).toEqual([`the menu "A" has no title`]);
		expect(analysis.uses.map(use => [use.name, use.checked])).toEqual([["NOPE", false]]);
	});

	test("items, variants, filters, fixed items", () => {
		const text = [
			"menus:",
			"  A:",
			"    title: T",
			"    items:",
			"      - action: X",
			"      - name: N",
			"        variants:",
			"          - { when: C }",
			"    fixedItems:",
			"      - { slot: 9, name: F }",
			"    view: { name: V }",
			"  LIST_B:",
			"    title: T",
			"    items: []",
			"    filters:",
			"      - message: M",
		].join("\n");
		expect(messages(analyze(text, "yaml"))).toEqual([
			`"view" is for a list menu, whose name starts with LIST_`,
			"an item without a name",
			"an item with variants takes its name and action from them",
			"a variant without a name",
			"an item without a name",
			`"slot" is the item's key, 1 to 7`,
			`a list menu draws its rows with "view" - "items" is not read`,
			`a filter without "when"`,
		]);
	});

	test("enabled: a line of names, or a list of requirements - a line each, or { when, message }", () => {
		const text = [
			"menus:",
			"  A:",
			"    title: T",
			"    items:",
			"      - { name: a, action: CLOSE_MENU, visible: IS_ALIVE, enabled: VIP IS_ADMIN, message: M }",
			"      - name: b",
			"        action: CLOSE_MENU",
			"        enabled:",
			"          - IS_ALIVE",
			"          - { when: [VIP, \"!IS_BOT\"], message: Only for VIP }",
			"          - when: LEVEL:5",
			"    fixedItems:",
			"      - { slot: 7, name: c, action: CLOSE_MENU, visible: [TEAM_CT, IS_ALIVE] }",
		].join("\n");
		const analysis = analyze(text, "yaml");
		expect(messages(analysis)).toEqual([]);
		expect(uses(analysis).filter(use => use.startsWith("requirement"))).toEqual([
			"requirement IS_ALIVE @A",
			"requirement VIP @A",
			"requirement IS_ADMIN @A",
			"requirement IS_ALIVE @A",
			"requirement VIP @A",
			"requirement IS_BOT @A",
			"requirement LEVEL @A",
			"requirement TEAM_CT @A",
			"requirement IS_ALIVE @A",
		]);
		// Each requirement is a line of its own: the names of one are checked together.
		const lines = analysis.uses.filter(use => use.kind == "requirement").map(use => use.line);
		expect(new Set(lines.slice(3, 7)).size).toBe(3);
		const hint = analysis.hints.find(each => text.slice(each.start, each.end) == "when");
		expect(hint?.markdown).toStartWith("**when** - The names that must hold");
	});

	test("enabled, visible and when of the wrong kind; a requirement neither a name nor an object", () => {
		const text = [
			"menus:",
			"  A:",
			"    title: T",
			"    items:",
			"      - { name: a, action: CLOSE_MENU, enabled: 5 }",
			"      - { name: b, action: CLOSE_MENU, enabled: { when: X } }",
			"      - { name: c, action: CLOSE_MENU, enabled: [X, 5, true, [Y]] }",
			"      - { name: d, action: CLOSE_MENU, visible: 5 }",
			"      - variants:",
			"          - { name: e, when: true, action: CLOSE_MENU }",
			"      - { name: f, action: CLOSE_MENU, enabled: [{ message: M }, { when: \"\" }] }",
		].join("\n");
		expect(messages(analyze(text, "yaml"))).toEqual([
			`"enabled" is a name, a list of names or a list of { when, message }, not a number`,
			`"enabled" is a name, a list of names or a list of { when, message }, not an object`,
			"a requirement is a name or { when: ..., message: ... }, not a number",
			"a requirement is a name or { when: ..., message: ... }, not true or false",
			"a requirement is a name or { when: ..., message: ... }, not a list",
			`"visible" is a name or a list of names, not a number`,
			`"when" is a name or a list of names, not true or false`,
			`a requirement without "when"`,
			`a requirement without "when"`,
		]);
	});

	test("the view has no visible; a variant, a filter and a requirement have their own keys", () => {
		const text = `menus:\n  LIST_A:\n    title: T\n    view: { name: V, visible: X, enabled: Y, message: M }\n`;
		expect(messages(analyze(text, "yaml"))).toEqual([`unknown key "visible" in the view`]);
	});

	test("a line of names: one, several, a list, !negated, NAME:param - and no A|B in YAML", () => {
		const text = `menus:\n  A:\n    title: T\n    activeOn: [IS_ALIVE, "!IS_SPECTATOR"]\n    items:\n      - { name: "%hp% HP|X", action: "RUN|STOP", visible: "A !B", enabled: "VIP:Only for VIP" }\n`;
		// NAME:param takes the rest of the line: "for VIP" are words of its parameter.
		const analysis = analyze(text, "yaml");
		expect(uses(analysis)).toEqual([
			"condition IS_ALIVE @A",
			"condition IS_SPECTATOR @A",
			"placeholder hp @A",
			"action RUN|STOP @A",
			"requirement A @A",
			"requirement B @A",
			"requirement VIP @A",
		]);
		expect(analysis.uses.find(use => use.name == "VIP")?.token).toBe("VIP:Only for VIP");
	});

	test("an unquoted !NAME is a YAML tag: the file would read as empty - the fix quotes it", () => {
		const text = `menus:\n  A:\n    title: T\n    activeOn: !IS_SPECTATOR\n`;
		const analysis = analyze(text, "yaml");
		expect(analysis.problems).toHaveLength(1);
		expect(analysis.problems[0]).toMatchObject({ severity: "error", fix: { text: `"!IS_SPECTATOR"` } });
		expect(marked(text, analysis)).toEqual(["!IS_SPECTATOR"]);
	});

	test("an unquoted %name% cannot start a YAML value", () => {
		const text = `menus:\n  A:\n    title: T\n    view:\n      name: %name% here\n`;
		const analysis = analyze(text, "yaml");
		expect(analysis.problems[0]).toMatchObject({ severity: "error", fix: { text: `"%name% here"` } });
	});

	test("what Config Core cannot read, in its words", () => {
		const yaml = analyze(`menus:\n  A: &anchor\n    title: T\n`, "yaml");
		expect(messages(yaml)).toEqual(["anchors and aliases (& and *) are not supported - write the value out - Config Core stops here and the server reads the file as empty"]);
		const json = analyze(`{ "menus": { 'A': {} } }`, "json");
		expect(messages(json)[0]).toBe("a key is written in double quotes - Config Core stops here and the server reads the file as empty");
	});

	test("JSONC: comments and a trailing comma are read", () => {
		expect(messages(analyze(`{\n  // c\n  "menus": { "A": { "title": "T", }, },\n}`, "json"))).toEqual([]);
	});
});

describe("INI checks, in Menu Core's words", () => {
	test("keys, flags, TIME, blocks, slots", () => {
		const text = [
			"[MAIN]",
			"PREFX = P",
			"KEY = {",
			"\tEXT = E",
			"}",
			"[A]",
			"TITLE = T",
			"HIDE_BACK = maybe",
			"TIME = soon",
			"ITMES = {",
			"}",
			"FIXED_ITEMS = {",
			`\t"9" "F" "" "" "" "" "" ""`,
			"\tNAME = X",
			"}",
			"VIEW = {",
			"}",
			"[B]",
			"ITEMS = {",
			`\t"N" "" "" "X"`,
			"}",
			"[LIST_C]",
			"TITLE = C",
			"ITEMS = x",
		].join("\n");
		const analysis = analyze(text, "ini");
		expect(messages(analysis)).toEqual([
			`unknown key "PREFX" in [MAIN] - did you mean "PREFIX"?`,
			`unknown key "EXT" in KEY - did you mean "EXIT"?`,
			`unknown key "ITMES" in [A] - did you mean "ITEMS"?`,
			`HIDE_BACK is YES or NO, not "maybe"`,
			`TIME is a number of seconds, not "soon"`,
			"VIEW is for a list menu, whose name starts with LIST_",
			`a row of FIXED_ITEMS is values in quotes, not "key = value"`,
			`the slot of a fixed item is its key, 1 to 7, not "9"`,
			"[B] has no TITLE, so it is not a menu",
			"a list menu draws its rows with VIEW - ITEMS is not read",
		]);
		expect(analysis.menus.map(menu => [menu.name, menu.read])).toEqual([["A", true], ["B", false], ["LIST_C", true]]);
	});

	test("the columns: ON_TIMEOUT reads its first value, VIEW its first row", () => {
		// An unquoted TITLE is its first word: Menu Core reads the first value of the line.
		const text = `[LIST_A]\nTITLE = "T %who%"\nACTIVE_ON = A !B\nON_TIMEOUT = X Y\nVIEW = {\n\t"%name%" "C" "D" "R" ""\n\t"x" "NOT_READ" "" "" ""\n}\nFILTER = {\n\t"F" "msg"\n}\n`;
		expect(uses(analyze(text, "ini"))).toEqual([
			"placeholder who @LIST_A",
			"condition A @LIST_A",
			"condition B @LIST_A",
			"action X @LIST_A",
			"condition F @LIST_A",
			"placeholder name @LIST_A",
			"condition C @LIST_A",
			"action D @LIST_A",
			"restriction R @LIST_A",
		]);
	});

	test("hints: what a key and a column are", () => {
		const text = `[A]\nTITLE = T\nITEMS = {\n\t"N" "" "IS_A" "" "" "" ""\n}\n`;
		const analysis = analyze(text, "ini");
		const at = text.indexOf("IS_A");
		const hint = analysis.hints.find(each => each.start <= at && at <= each.end);
		expect(hint?.markdown).toStartWith("**condition** - column 3 of ITEMS");
		expect(analysis.hints.find(each => each.start == 4)?.markdown).toStartWith("**TITLE**");
	});
});

describe("one way to write it, as Menu Core says", () => {
	test("a flag is YES or NO: another word is warned of, with a fix to the one to write", () => {
		const text = `[A]\nTITLE = T\nHIDE_BACK = true\nHIDE_EXIT = 0\nLOCKED = yes\nGLOBAL = YES\n`;
		const analysis = analyze(text, "ini");
		expect(messages(analysis)).toEqual([
			`HIDE_BACK is YES or NO, not "true" - write YES`,
			`HIDE_EXIT is YES or NO, not "0" - write NO`,
			`LOCKED is YES or NO, not "yes" - write YES`,
		]);
		const fixed = analysis.problems.map(problem => problem.fix!).sort((a, b) => b.start - a.start).reduce((out, fix) => out.slice(0, fix.start) + fix.text + out.slice(fix.end), text);
		expect(fixed).toBe(`[A]\nTITLE = T\nHIDE_BACK = YES\nHIDE_EXIT = NO\nLOCKED = YES\nGLOBAL = YES\n`);
	});

	test("a colour in a menu file is a tag: a code is warned of, with a fix that writes the tags", () => {
		const ini = `[MAIN]\nPREFIX = \\r[X]\nKEY = {\n\tNUMBER = \\y[%d]\\w\n}\n[A]\nTITLE = "\\yMain"\nITEMS = {\n\t"\\dOne" "" "" "CLOSE_MENU" "" "\\rno"\n}\n`;
		const analysis = analyze(ini, "ini");
		expect(messages(analysis)).toEqual([
			`"\\r[X]": a colour is a tag in a menu file - write !r for \\r; the codes are left out`,
			`"\\y[%d]\\w": a colour is a tag in a menu file - write !y for \\y, !w for \\w; the codes are left out`,
			`"\\yMain": a colour is a tag in a menu file - write !y for \\y; the codes are left out`,
			`"\\dOne": a colour is a tag in a menu file - write !d for \\d; the codes are left out`,
			`"\\rno": a colour is a tag in a menu file - write !r for \\r; the codes are left out`,
		]);
		const fixed = analysis.problems.map(problem => problem.fix!).sort((a, b) => b.start - a.start).reduce((out, fix) => out.slice(0, fix.start) + fix.text + out.slice(fix.end), ini);
		expect(fixed).toBe(`[MAIN]\nPREFIX = !r[X]\nKEY = {\n\tNUMBER = !y[%d]!w\n}\n[A]\nTITLE = "!yMain"\nITEMS = {\n\t"!dOne" "" "" "CLOSE_MENU" "" "!rno"\n}\n`);

		const yaml = `menus:\n  A:\n    title: '\\yMain'\n    items:\n      - { name: One, action: CLOSE_MENU, message: "\\\\rno" }\n`;
		expect(analyze(yaml, "yaml").problems.map(problem => [problem.message, problem.fix != null])).toEqual([
			[`"\\yMain": a colour is a tag in a menu file - write !y for \\y; the codes are left out`, true],
			[`"\\rno": a colour is a tag in a menu file - write !r for \\r; the codes are left out`, false],
		]);
	});
});

describe("what Menu Core reads without a word", () => {
	test("an empty block, on one line or over two, has no rows", () => {
		const text = `[M]\nTITLE = M\nITEMS = { }\nFIXED_ITEMS = {\n}\n[LIST_X]\nTITLE = X\nFILTER = {}\nVIEW = {\n\t"%name%"\n}\n`;
		const analysis = analyze(text, "ini");
		expect(analysis.problems).toEqual([]);
		expect(uses(analysis)).toEqual(["placeholder name @LIST_X"]);
	});

	test("NAME:param in a YAML list of names takes the entries after it - it goes last", () => {
		const text = [
			"menus:",
			"  A:",
			"    title: T",
			"    items:",
			"      - { name: a, action: CLOSE_MENU, visible: [\"LEVEL:5\", VIP] }",
			"      - { name: b, action: CLOSE_MENU, enabled: [{ when: [VIP, \"LEVEL:5 or more\"] }] }",
			"      - { name: c, action: CLOSE_MENU, enabled: [\"LEVEL:5\", VIP] }",
			"      - variants:",
			"          - { name: d, action: CLOSE_MENU, when: [\"LEVEL:5\", VIP] }",
		].join("\n");
		const analysis = analyze(text, "yaml");
		// A list of enabled is a list of requirements, each its own line: "LEVEL:5" there is last in its line.
		expect(messages(analysis)).toEqual([`"LEVEL:5" takes the rest of the line - NAME:param goes last`, `"LEVEL:5" takes the rest of the line - NAME:param goes last`]);
		expect(uses(analysis).filter(use => use.startsWith("requirement"))).toEqual(["requirement LEVEL @A", "requirement VIP @A", "requirement LEVEL @A", "requirement LEVEL @A", "requirement VIP @A", "requirement LEVEL @A"]);
	});
});

describe("an item that does nothing", () => {
	test("an item of a file with no action in any variant is noted - not the view of a list menu", () => {
		const ini = `[M]\nTITLE = M\nITEMS = {\n\t"Text" "" "" ""\n\t"A|B" "" "" "|"\n\t"Go" "" "" "CLOSE_MENU"\n}\n[LIST_X]\nTITLE = X\nVIEW = {\n\t"%name%"\n}\n`;
		const fromIni = analyze(ini, "ini");
		expect(fromIni.problems.map(problem => `${problem.severity} ${problem.message}`)).toEqual([
			`info the item "Text" has no action: choosing it does nothing`,
			`info the item "A|B" has no action: choosing it does nothing`,
		]);
		expect(marked(ini, { ...fromIni, problems: fromIni.problems.map(problem => ({ ...problem, severity: "warning" as const })) })).toEqual([`"Text"`, `"A|B"`]);

		const yaml = `menus:\n  M:\n    title: M\n    items:\n      - name: Text\n      - variants:\n          - { name: A, when: X }\n          - { name: B, action: CLOSE_MENU }\n    fixedItems:\n      - { slot: 7, name: Seven }\n`;
		expect(analyze(yaml, "yaml").problems.map(problem => problem.message)).toEqual([
			`the item "Text" has no action: choosing it does nothing`,
			`the item "Seven" has no action: choosing it does nothing`,
		]);
	});
});
