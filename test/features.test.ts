import { beforeAll, describe, expect, test } from "bun:test";
import { analyze, Format } from "../src/core/analyze";
import { contextAt } from "../src/core/context";
import { completions, hoverOf, registrationsOf, useAt } from "../src/core/features";
import { checkLines, checkNames, Registry } from "../src/core/registry";
import { scanTypeScript } from "../src/core/scan-ts";
import { cursor, fixture, where, workspaceRegistry } from "./helpers";

let registry: Registry;
beforeAll(async () => {
	registry = await workspaceRegistry();
});

/** What completion offers at the ¦: the labels, and the context. */
function complete(marked: string, format: Format) {
	const { text, offset } = cursor(marked);
	const context = contextAt(text, offset, format);
	if (context == null) return { context, labels: [] as string[], items: [] };
	const items = completions(context, registry, analyze(text, format).menus, where);
	return { context, labels: items.map(item => item.label), items, text };
}

describe("completion: YAML", () => {
	test("the keys of each level", () => {
		expect(complete("me¦", "yaml").labels).toEqual(["chatPrefix", "labels", "menus"]);
		expect(complete("labels:\n  ¦", "yaml").labels).toContain("exit");
		expect(complete("menus:\n  A:\n    ti¦", "yaml").labels).toContain("hideBack");
		expect(complete("menus:\n  A:\n    items:\n      - ¦", "yaml").labels).toContain("spaceBefore");
		expect(complete("menus:\n  A:\n    items:\n      - name: X\n        ¦", "yaml").labels).toEqual(["name", "placeholder", "action", "visible", "enabled", "message", "spaceBefore", "spaceAfter", "variants"]);
		expect(complete("menus:\n  LIST_A:\n    view:\n      ¦", "yaml").labels).toEqual(["name", "action", "enabled", "message", "variants"]);
		expect(complete("menus:\n  A:\n    fixedItems:\n      - name: X\n        sl¦", "yaml").labels).toContain("slot");
		expect(complete("menus:\n  A:\n    items:\n      - variants:\n          - name: X\n            ¦", "yaml").labels).toEqual(["name", "when", "action"]);
		expect(complete("menus:\n  LIST_A:\n    filters:\n      - { when: X, ¦ }", "yaml").labels).toEqual(["when", "message"]);
		expect(complete("menus:\n  ¦", "yaml").labels).toEqual([]);
	});

	test("a key goes in with its colon", () => {
		const { items } = complete("menus:\n  A:\n    hideB¦", "yaml");
		expect(items.find(item => item.label == "hideBack")?.insertText).toBe("hideBack: ");
	});

	test("conditions registered in TypeScript and Pawn, and the built-in ones", () => {
		const { labels, items } = complete("menus:\n  A:\n    items:\n      - visible: IS_¦", "yaml");
		expect(labels).toContain("IS_ADMIN");
		expect(labels).toContain("IS_SPECTATOR");
		expect(labels).toContain("FLAG_");
		expect(labels).not.toContain("ADMIN");
		expect(items.find(item => item.label == "IS_ADMIN")?.detail).toBe("condition - plugins/admin.ts:7");
		expect(items.find(item => item.label == "IS_ADMIN")?.documentation).toContain("Whether the player has admin access.");
	});

	test("a name typed in plugin code is offered at once", () => {
		const live = new Registry();
		live.set("plugins/vip.ts", scanTypeScript("plugins/vip.ts", `import * as menus from "@amxts/menu-core";\nmenus.addCondition("MY_VIP", () => true);`));
		const { text, offset } = cursor("menus:\n  A:\n    activeOn: MY¦");
		const context = contextAt(text, offset, "yaml")!;
		expect(completions(context, live, [], where).map(item => item.label)).toContain("MY_VIP");
	});

	test("actions: registered, CLOSE_MENU, SHOW_ of the file's menus and code's", () => {
		const { labels } = complete("menus:\n  MAIN:\n    title: T\n    items:\n      - { name: X, action: ¦ }\n  OTHER:\n    title: O\n", "yaml");
		expect(labels).toContain("RESET_SCORE");
		expect(labels).toContain("TOGGLE_HIDE_KNIFE");
		expect(labels).toContain("CLOSE_MENU");
		expect(labels).toContain("SHOW_OTHER");
		expect(labels).toContain("SHOW_SHOP");
		expect(labels).toContain("SHOW_PAWN_MENU");
	});

	test("visible, enabled and when: restrictions, then conditions", () => {
		for (const marked of ["menus:\n  A:\n    items:\n      - enabled: ¦", "menus:\n  A:\n    items:\n      - { name: X, visible: [IS_ALIVE, ¦] }", "menus:\n  A:\n    items:\n      - variants:\n          - when: ¦", "menus:\n  LIST_A:\n    filters:\n      - when: ¦"]) {
			const { labels } = complete(marked, "yaml");
			expect(labels.slice(0, 2).sort()).toEqual(["VIP", "VIP_ONLY"]);
			expect(labels).toContain("IS_ADMIN");
			expect(labels).toContain("IS_ALIVE");
		}
	});

	test("a requirement of enabled: a line of names, or { when, message }", () => {
		const entry = complete("menus:\n  A:\n    items:\n      - name: X\n        enabled:\n          - IS_ALIVE\n          - ¦", "yaml");
		expect(entry.labels).toContain("VIP");
		expect(entry.labels).toContain("IS_ADMIN");
		expect(entry.labels.slice(0, 2)).toEqual(["when", "message"]);
		expect(entry.items.find(item => item.label == "when")?.insertText).toBe("when: ");
		const typed = complete("menus:\n  A:\n    items:\n      - name: X\n        enabled:\n          - IS_A¦", "yaml");
		expect(typed.context).toMatchObject({ type: "names", kind: "requirement" });

		expect(complete("menus:\n  A:\n    items:\n      - name: X\n        enabled:\n          - when: VI¦", "yaml").labels).toContain("VIP");
		expect(complete("menus:\n  A:\n    items:\n      - name: X\n        enabled:\n          - when: VIP\n            ¦", "yaml").labels).toEqual(["when", "message"]);
		expect(complete("menus:\n  A:\n    items:\n      - { name: X, enabled: [{ when: [IS_ALIVE, VI¦] }] }", "yaml").labels).toContain("VIP");
		expect(complete("menus:\n  A:\n    items:\n      - { name: X, enabled: [{ when: VIP, ¦ }] }", "yaml").labels).toEqual(["when", "message"]);
	});

	test("after ! in quotes; unquoted !NAME goes in quotes", () => {
		const quoted = complete(`menus:\n  A:\n    activeOn: "!IS_A¦"`, "yaml");
		expect(quoted.context).toMatchObject({ type: "names", negated: true, wrap: false });
		expect(quoted.items.find(item => item.label == "IS_ADMIN")?.insertText).toBe("IS_ADMIN");
		const bare = complete("menus:\n  A:\n    activeOn: !IS_A¦", "yaml");
		const item = bare.items.find(each => each.label == "IS_ADMIN")!;
		expect(item.insertText).toBe(`"!IS_ADMIN"`);
		expect(bare.text!.slice(item.start, item.end)).toBe("!IS_A");
	});

	test("the next of several: space-separated, a list", () => {
		expect(complete("menus:\n  A:\n    activeOn: IS_ADMIN IS_S¦", "yaml").labels).toContain("IS_SPECTATOR");
		expect(complete("menus:\n  A:\n    activeOn: [IS_ADMIN, IS_S¦]", "yaml").labels).toContain("IS_SPECTATOR");
		expect(complete("menus:\n  A:\n    activeOn:\n      - IS_ADMIN\n      - IS_S¦", "yaml").labels).toContain("IS_SPECTATOR");
	});

	test("placeholders after %, the menu's own among them", () => {
		const { labels, items } = complete(`menus:\n  SHOP:\n    title: "Price: %pr¦"`, "yaml");
		expect(labels).toContain("%price%");
		expect(labels).toContain("%dm_status%");
		expect(labels).toContain("%name%");
		expect(items.find(item => item.label == "%price%")?.insertText).toBe("price%");
		expect(complete(`menus:\n  OTHER:\n    title: "%pr¦"`, "yaml").labels).not.toContain("%price%");
		expect(complete(`menus:\n  A:\n    title: "%hp% and %pr¦"`, "yaml").labels).toContain("%dm_status%");
		expect(complete(`menus:\n  A:\n    title: "100%¦ sure"`, "yaml").labels.length).toBeGreaterThan(0);
		expect(complete(`menus:\n  A:\n    title: "%hp%¦"`, "yaml").labels).toEqual([]);
	});

	test("true and false for a flag", () => {
		expect(complete("menus:\n  A:\n    hideBack: ¦", "yaml").labels).toEqual(["true", "false"]);
	});
});

describe("completion: JSON", () => {
	test("keys, inside quotes or not", () => {
		expect(complete(`{ "menus": { "A": { "¦" } } }`, "json").labels).toContain("title");
		const bare = complete(`{ "menus": { "A": { "items": [{ ¦ }] } } }`, "json");
		expect(bare.items.find(item => item.label == "action")?.insertText).toBe(`"action": `);
	});

	test("names inside a string", () => {
		expect(complete(`{ "menus": { "A": { "items": [{ "visible": "!IS_¦" }] } } }`, "json").labels).toContain("IS_ADMIN");
		expect(complete(`{ "menus": { "A": { "items": [{ "enabled": ["IS_ALIVE", "VI¦"] }] } } }`, "json").labels).toContain("VIP");
		expect(complete(`{ "menus": { "A": { "items": [{ "enabled": [{ "when": "VI¦" }] }] } } }`, "json").labels).toContain("VIP");
		expect(complete(`{ "menus": { "A": { "items": [{ "enabled": [{ "when": ["IS_ALIVE", "VI¦"] }] }] } } }`, "json").labels).toContain("VIP");
		expect(complete(`{ "menus": { "A": { "items": [{ "enabled": [{ "¦" }] }] } } }`, "json").labels).toEqual(["when", "message"]);
		expect(complete(`{ "menus": { "A": { "activeOn": ["IS_ADMIN", "IS_S¦"] } } }`, "json").labels).toContain("IS_SPECTATOR");
		expect(complete(`{ "menus": { "A": { "onTimeout": "SHOW_¦" } } }`, "json").labels).toContain("SHOW_SHOP");
	});

	test("placeholders and flags", () => {
		expect(complete(`{ "menus": { "A": { "title": "%d¦" } } }`, "json").labels).toContain("%dm_status%");
		expect(complete(`{ "menus": { "A": { "locked": ¦ } } }`, "json").labels).toEqual(["true", "false"]);
	});
});

describe("completion: INI", () => {
	test("keys of a menu, of [MAIN], of KEY", () => {
		expect(complete("[A]\nTITLE = T\nHID¦", "ini").labels).toContain("HIDE_BACK");
		expect(complete("[MAIN]\n¦", "ini").labels).toEqual(["PREFIX", "KEY"]);
		expect(complete("[MAIN]\nKEY = {\n\t¦\n}", "ini").labels).toContain("EXIT");
		expect(complete("[A]\nTITLE = T\nON¦", "ini").items.find(item => item.label == "ON_TIMEOUT")?.insertText).toBe("ON_TIMEOUT = ");
	});

	test("values of a key: names, YES/NO, placeholders in TITLE", () => {
		expect(complete("[A]\nACTIVE_ON = IS_¦", "ini").labels).toContain("IS_SPECTATOR");
		expect(complete("[A]\nON_TIMEOUT = ¦", "ini").labels).toContain("CLOSE_MENU");
		expect(complete("[A]\nHIDE_EXIT = ¦", "ini").labels).toEqual(["YES", "NO"]);
		expect(complete(`[A]\nTITLE = "%d¦"`, "ini").labels).toContain("%dm_status%");
	});

	test("each column of a row", () => {
		const row = (before: string) => complete(`[A]\nTITLE = T\nITEMS = {\n\t${before}¦"\n}`, "ini");
		expect(row(`"%d`).labels).toContain("%dm_status%");
		expect(row(`"N" "" "!IS_`).labels).toContain("IS_ADMIN");
		expect(row(`"N" "" "" "SHOW_`).labels).toContain("SHOW_A");
		expect(row(`"N" "" "" "" "VI`).labels).toContain("VIP");
		expect(row(`"N" "" "" "" "" "`).labels).toEqual([]);
		expect(complete(`[A]\nTITLE = T\nFIXED_ITEMS = {\n\t"1" "N" "" "IS_¦"\n}`, "ini").labels).toContain("IS_ADMIN");
		expect(complete(`[LIST_A]\nTITLE = T\nFILTER = {\n\t"IS_¦"\n}`, "ini").labels).toContain("IS_SPECTATOR");
	});
});

describe("names nobody registers", () => {
	test("the fixture's menus: only what the workspace does not register", () => {
		for (const [file, format] of [["menu.ini", "ini"], ["menu.yaml", "yaml"], ["menu.json", "json"]] as const) {
			const analysis = analyze(fixture(`configs/playground/${file}`), format);
			const problems = checkNames(registry, analysis.uses, analysis.menus);
			expect(problems.map(problem => problem.message)).toEqual(["LIST_PLAYERS: the action \"PLAYER_ACTION\" is not registered. Nothing in the workspace registers it; a Pawn plugin on the server may."]);
		}
	});

	test("did you mean, the fix, and why it is only a warning", () => {
		const text = `menus:\n  MAIN:\n    title: T\n    activeOn: IS_SPECTATR\n    items:\n      - { name: A, action: SHOW_SHPO, enabled: VIPP }\n      - { name: "%dm_statsu%", action: RESET_SCORES }\n`;
		const analysis = analyze(text, "yaml");
		const problems = checkNames(registry, analysis.uses, analysis.menus);
		expect(problems.map(problem => problem.message)).toEqual([
			`MAIN: the condition "IS_SPECTATR" is not registered - did you mean "IS_SPECTATOR"? Nothing in the workspace registers it; a Pawn plugin on the server may.`,
			`MAIN: SHOW_SHPO opens the menu "SHPO", which is not there - did you mean "SHOP"? Nothing in the workspace makes it; a Pawn plugin on the server may.`,
			`MAIN: the condition "VIPP" is not registered - did you mean "VIP"? Nothing in the workspace registers it; a Pawn plugin on the server may.`,
			`MAIN: the placeholder %dm_statsu% is not registered - did you mean "dm_status"? Nothing in the workspace registers it; a Pawn plugin on the server may.`,
			`MAIN: the action "RESET_SCORES" is not registered - did you mean "RESET_SCORE"? Nothing in the workspace registers it; a Pawn plugin on the server may.`,
		]);
		expect(problems.every(problem => problem.severity == "warning")).toBe(true);
		expect(problems.map(problem => problem.fix?.text)).toEqual(["IS_SPECTATOR", "SHOW_SHOP", "VIP", "dm_status", "RESET_SCORE"]);
		expect(problems.map(problem => text.slice(problem.start, problem.end))).toEqual(["IS_SPECTATR", "SHOW_SHPO", "VIPP", "dm_statsu", "RESET_SCORES"]);
	});

	test("the names of visible, enabled and when: a restriction or a condition, NAME:param by its NAME", () => {
		const text = [
			"menus:",
			"  MAIN:",
			"    title: T",
			"    items:",
			"      - { name: a, action: CLOSE_MENU, visible: IS_SPECTATR, enabled: [VIP, IS_ADMIN, { when: \"VIPP:5 or more\", message: M }] }",
			"      - variants:",
			"          - { name: b, when: IS_ALIV, action: CLOSE_MENU }",
			"  LIST_P:",
			"    title: T",
			"    filters:",
			"      - { when: VIP_ONL }",
			"    view: { name: \"%name%\", action: CLOSE_MENU, enabled: FLAG_d }",
		].join("\n");
		const analysis = analyze(text, "yaml");
		expect(checkNames(registry, analysis.uses, analysis.menus).map(problem => problem.message.split(" Nothing")[0])).toEqual([
			`MAIN: the condition "IS_SPECTATR" is not registered - did you mean "IS_SPECTATOR"?`,
			`MAIN: the condition "VIPP" is not registered - did you mean "VIP"?`,
			`MAIN: the condition "IS_ALIV" is not registered - did you mean "IS_ALIVE"?`,
			`LIST_P: the condition "VIP_ONL" is not registered - did you mean "VIP_ONLY"?`,
		]);
	});

	test("built-ins: FLAG_*, CLOSE_MENU, SHOW_ of the file, %name% %target% %time%; conditions case aside", () => {
		const text = `menus:\n  A:\n    title: "%target% %time%"\n    activeOn: is_alive FLAG_abc is_admin\n    items:\n      - { name: "%name%", action: CLOSE_MENU SHOW_B, enabled: FLAG_z }\n  B:\n    title: B\n`;
		const analysis = analyze(text, "yaml");
		expect(checkNames(registry, analysis.uses, analysis.menus)).toEqual([]);
	});

	test("a restriction registered as * answers for every one", () => {
		const own = new Registry();
		own.set("a.ts", scanTypeScript("a.ts", `import * as menus from "@amxts/menu-core";\nmenus.addRestriction("*", () => true);`));
		const analysis = analyze(`menus:\n  A:\n    title: T\n    items:\n      - { name: A, visible: ANYTHING, enabled: [ELSE, { when: "MORE:5" }] }\n`, "yaml");
		expect(checkNames(own, analysis.uses, analysis.menus)).toEqual([]);
	});

	test("a menu's own placeholder is known in that menu only", () => {
		const analysis = analyze(`menus:\n  SHOP:\n    title: "%price%"\n  OTHER:\n    title: "%price%"\n`, "yaml");
		expect(checkNames(registry, analysis.uses, analysis.menus).map(problem => problem.message.split(" is not")[0])).toEqual(["OTHER: the placeholder %price%"]);
	});
});

describe("hover and go to definition", () => {
	const text = fixture("configs/playground/menu.yaml");
	const analysis = analyze(text, "yaml");
	const at = (word: string, nth = 0) => {
		let offset = -1;
		for (let i = 0; i <= nth; i++) offset = text.indexOf(word, offset + 1);
		return useAt(analysis, offset + 1)!;
	};

	test("where a name is registered, TypeScript or Pawn, with its doc", () => {
		expect(hoverOf(at("IS_ADMIN"), registry, analysis.menus, where)).toContain("TypeScript: `menus.addCondition(\"IS_ADMIN\")` in plugins/admin.ts:7\n\nWhether the player has admin access.");
		expect(hoverOf(at("IS_ADMIN"), registry, analysis.menus, where)).toContain("Filtered by:");
		expect(hoverOf(at("TOGGLE_HIDE_KNIFE"), registry, analysis.menus, where)).toContain("Pawn: `mc_register_action(\"TOGGLE_HIDE_KNIFE\")` in pawn/settings.sma:9\n\nHides the knife for the player.");
		expect(hoverOf(at("SHOW_ADMIN_MENU"), registry, analysis.menus, where)).toContain("The menu is in this file.");
		expect(hoverOf(at("FLAG_d"), registry, analysis.menus, where)).toContain("Built in");
		expect(hoverOf(at("PLAYER_ACTION"), registry, analysis.menus, where)).toContain("A Pawn plugin on the server");
	});

	test("a name of enabled: a restriction when one is registered, else a condition", () => {
		const text = `menus:\n  A:\n    title: T\n    items:\n      - { name: a, action: CLOSE_MENU, enabled: [VIP, { when: IS_SPECTATOR }] }\n`;
		const own = analyze(text, "yaml");
		const hover = (word: string) => hoverOf(useAt(own, text.indexOf(word) + 1)!, registry, own.menus, where);
		expect(hover("VIP")).toStartWith("**Restriction** `VIP`");
		expect(hover("IS_SPECTATOR")).toStartWith("**Condition** `IS_SPECTATOR`");
		expect(registrationsOf(useAt(own, text.indexOf("VIP") + 1)!, registry).map(each => each.kind)).toEqual(["restriction"]);
		expect(registrationsOf(useAt(own, text.indexOf("IS_SPECTATOR") + 1)!, registry).map(each => each.kind)).toEqual(["condition"]);
	});

	test("definition: the registrations", () => {
		expect(registrationsOf(at("JOIN_TEAM"), registry).map(where)).toEqual(["plugins/team.ts:7"]);
		expect(registrationsOf(at("SWAP"), registry).map(where)).toEqual(["node_modules/@amxts/extras/src/index.ts:4"]);
		expect(registrationsOf(at("solo_status"), registry).map(where)).toEqual(["pawn/settings.sma:13"]);
	});
});

describe("the built-in conditions", () => {
	const empty = new Registry();

	test("known without a registration, in any case, as conditions and restrictions; an unknown team is a slip", () => {
		const text = `menus:\n  A:\n    title: A\n    activeOn: IS_ALIVE !is_dead IS_BOT IS_ADMIN\n    items:\n      - { name: a, visible: TEAM_CT TEAM_TERRORIST TEAM_SPECTATOR TEAM_UNASSIGNED, action: CLOSE_MENU, enabled: IS_ADMIN }\n      - { name: b, enabled: TEAM_CTT, action: CLOSE_MENU }\n`;
		const analysis = analyze(text, "yaml");
		expect(checkNames(empty, analysis.uses, analysis.menus).map(problem => problem.message)).toEqual([
			`A: the condition "TEAM_CTT" is not registered - did you mean "TEAM_CT"? Nothing in the workspace registers it; a Pawn plugin on the server may.`,
		]);
	});

	test("offered, and hover says they are built into Menu Core - a plugin's own registration wins", () => {
		const { labels, items } = complete("menus:\n  A:\n    items:\n      - enabled: ¦", "yaml");
		for (const name of ["IS_ALIVE", "IS_DEAD", "IS_BOT", "TEAM_CT", "TEAM_TERRORIST", "TEAM_SPECTATOR", "TEAM_UNASSIGNED", "FLAG_"]) expect(labels).toContain(name);
		expect(items.find(item => item.label == "IS_BOT")?.documentation).toContain("Built into Menu Core");
		// The fixture workspace registers IS_ADMIN itself.
		expect(items.find(item => item.label == "IS_ADMIN")?.detail).toBe("condition - plugins/admin.ts:7");

		const text = `menus:\n  A:\n    title: A\n    activeOn: IS_ALIVE team_ct\n`;
		const analysis = analyze(text, "yaml");
		const hover = (word: string) => hoverOf(useAt(analysis, text.indexOf(word) + 1)!, empty, analysis.menus, where);
		expect(hover("IS_ALIVE")).toContain("Built into Menu Core: the player is alive.");
		expect(hover("team_ct")).toContain("Built into Menu Core: the player is in the CT team.");
	});
});

describe("a line of names that says less than it seems", () => {
	const empty = new Registry();

	test("a name twice, in any case, a name and its opposite - a line at a time, with a fix that removes the repeat", () => {
		const text = `{\n  "menus": {\n    "M": {\n      "title": "M",\n      "activeOn": "IS_ALIVE IS_ADMIN is_admin IS_ADMIN IS_ADMIN",\n      "items": [{ "name": "a", "action": "RUN RUN", "visible": "IS_ALIVE !IS_ALIVE", "enabled": ["VIP !vip", "VIP", { "when": ["IS_BOT", "IS_BOT"] }] }]\n    }\n  }\n}\n`;
		const analysis = analyze(text, "json");
		const problems = checkLines(analysis.uses);
		// Each requirement of enabled is a line of its own: VIP in two of them is not a repeat.
		expect(problems.map(problem => problem.message)).toEqual([
			"M: is_admin is listed more than once",
			"M: IS_ADMIN is listed more than once",
			"M: IS_ADMIN is listed more than once",
			"M: RUN is listed more than once",
			"M: IS_ALIVE and !IS_ALIVE together can never hold",
			"M: VIP and !vip together can never hold",
			"M: IS_BOT is listed more than once",
		]);
		expect(problems.map(problem => text.slice(problem.start, problem.end))).toEqual(["is_admin", "IS_ADMIN", "IS_ADMIN", "RUN", "!IS_ALIVE", "!vip", "IS_BOT"]);
		const fix = problems[1].fix!;
		expect(text.slice(0, fix.start) + fix.text + text.slice(fix.end)).toContain(`"activeOn": "IS_ALIVE IS_ADMIN is_admin IS_ADMIN",`);
		expect(problems[4].fix).toBeUndefined();
	});

	test("ADMIN and ACCESS_ADMIN are names like any other; INI rows and YAML lists are lines too", () => {
		const yaml = analyze(`menus:\n  M:\n    title: M\n    activeOn: [ADMIN, ACCESS_ADMIN, IS_BOT, "!IS_BOT"]\n`, "yaml");
		expect(checkLines(yaml.uses).map(problem => problem.message)).toEqual(["M: IS_BOT and !IS_BOT together can never hold"]);
		const ini = analyze(`[M]\nTITLE = M\nITEMS = {\n\t"a" "" "IS_BOT IS_BOT" "CLOSE_MENU"\n}\n`, "ini");
		expect(checkLines(ini.uses).map(problem => problem.message)).toEqual(["M: IS_BOT is listed more than once"]);
	});

	test("ADMIN and ACCESS_ADMIN are not built in: registered, they are known; not, IS_ADMIN is the one for ADMIN", () => {
		const text = `menus:\n  M:\n    title: M\n    activeOn: ADMIN ACCESS_ADMIN\n    items:\n      - { name: a, action: CLOSE_MENU, enabled: ADMIN }\n`;
		const analysis = analyze(text, "yaml");
		expect(checkNames(empty, analysis.uses, analysis.menus).map(problem => problem.message.split(" Nothing")[0])).toEqual([
			`M: the condition "ADMIN" is not registered - did you mean "IS_ADMIN"?`,
			`M: the condition "ACCESS_ADMIN" is not registered.`,
			`M: the condition "ADMIN" is not registered - did you mean "IS_ADMIN"?`,
		]);
		const ini = analyze(`[M]\nTITLE = M\nITEMS = {\n\t"a" "" "" "CLOSE_MENU" "ADMIN"\n}\n`, "ini");
		expect(checkNames(empty, ini.uses, ini.menus).map(problem => problem.message.split(" Nothing")[0])).toEqual([`M: the restriction "ADMIN" is not registered - did you mean "IS_ADMIN"?`]);
		const own = new Registry();
		own.set("a.ts", scanTypeScript("a.ts", `import * as menus from "@amxts/menu-core";\nmenus.addCondition("ADMIN", () => true);\nmenus.addCondition("ACCESS_ADMIN", () => true);`));
		expect(checkNames(own, analysis.uses, analysis.menus)).toEqual([]);
	});
});
