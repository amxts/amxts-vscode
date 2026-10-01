import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Format } from "../src/core/analyze";
import { checkConfig, iniTree, loadsOf, namesakeMessage, namesakes } from "../src/core/config-check";
import { configCompletions, configContextAt, configDefinition, configHover } from "../src/core/config-features";
import { ConfigLoad, describe as describeShape, scanConfigLoads } from "../src/core/config-scan";
import { readsFile } from "../src/core/detect";
import { cursor, fixture, WORKSPACE } from "./helpers";

const PLUGIN = join(WORKSPACE, "plugins", "settings-plugin.ts");

function loadOf(code: string, file = "plugins/p.ts") {
	const [load] = scanConfigLoads(file, code);
	if (load == null) throw new Error("no load in the code");
	return load;
}

const header = `import * as configs from "@amxts/config-core";\n`;
const typed = loadOf(fixture("plugins/settings-plugin.ts"), PLUGIN);

function messages(text: string, format: Format, load: ConfigLoad = typed) {
	return checkConfig(text, format, load.shape).problems.map(problem => problem.message);
}

/** What completion offers at the ¦. */
function complete(marked: string, format: Format, load: ConfigLoad = typed) {
	const { text, offset } = cursor(marked);
	const context = configContextAt(text, offset, format);
	return context == null ? [] : configCompletions(context, load);
}

const labels = (marked: string, format: Format, load?: ConfigLoad) => complete(marked, format, load).map(item => item.label);

describe("the loads of a plugin", () => {
	test("the shape of a type argument, with its JSDoc and the defaults' places", () => {
		expect(typed.name).toBe("settings");
		expect(typed.call).toBe("configs.load<Settings>");
		expect(typed.place.line).toBe(16);
		expect(describeShape(typed.shape)).toBe(`{ chat: { prefix: string; enabled: boolean }; round: { time: number; mode: "normal" | "dm" | "knife" }; maps: string[]; prices: Map<string, number>; motd?: string }`);
		if (typed.shape.kind != "object") throw new Error("not an object");
		const chat = typed.shape.fields[0];
		expect(chat.doc).toBe("The text before every chat message.");
		expect(chat.places.map(place => place.line)).toEqual([7, 17]);
		if (chat.shape.kind != "object") throw new Error("not an object");
		expect(chat.shape.fields[0].value).toBe(`"[HNS]"`);
	});

	test("the shape of the defaults' literal", () => {
		const load = loadOf(`${header}const s = configs.load("myplugin/limits", { hp: 100, name: "x", on: false, list: [1, 2], nested: { deep: "a" } });`);
		expect(load.name).toBe("myplugin/limits");
		expect(describeShape(load.shape)).toBe("{ hp: number; name: string; on: boolean; list: number[]; nested: { deep: string } }");
	});

	test("a list of lists - rows of values - read and checked as Config Core reads it", () => {
		const load = loadOf(`${header}const s = configs.load("rows", { main: { cvars: [["mp_timelimit", "30"]], sides: [[1, 2]] } });`);
		expect(describeShape(load.shape)).toBe("{ main: { cvars: string[][]; sides: number[][] } }");
		const ini = `[main]\ncvars = {\n\t"a" "1"\n\t"b"\n}\nsides = {\n\t"1" "x"\n\tk = v\n}\n`;
		expect(messages(ini, "ini", load)).toEqual([
			`the item is text ("x"), not a number - it is left out`,
			`the item is an object, not a list - it is left out`,
		]);
		expect(messages(`[main]\ncvars = {\n}\nsides =\n`, "ini", load)).toEqual([]);
		expect(messages(`main:\n  cvars: text\n  sides: [[1, 2], 3]\n`, "yaml", load)).toEqual([`"cvars" is text, not a list - the default stays`]);
	});

	test("a named import of load, under another name, and a defaults variable with its type", () => {
		const code = `import { load as read } from "@amxts/config-core";\ninterface L { hp: number }\nconst defaults: L = { hp: 5 };\nconst s = read("limits", defaults);`;
		const load = loadOf(code);
		expect(load.call).toBe("read");
		expect(describeShape(load.shape)).toBe("{ hp: number }");
		if (load.shape.kind != "object") throw new Error("not an object");
		expect(load.shape.fields[0].places.map(place => place.line)).toEqual([1, 2]);
	});

	test("a type imported from another file", () => {
		const reader = (_from: string, spec: string) => (spec == "./types" ? { path: "plugins/types.ts", text: "export interface S {\n\t/** On or off. */\n\ton: boolean;\n}" } : null);
		const [load] = scanConfigLoads("plugins/p.ts", `${header}import { S } from "./types";\nconfigs.load<S>("s", { on: true });`, reader);
		expect(describeShape(load.shape)).toBe("{ on: boolean }");
		expect(load.dependencies).toEqual(["plugins/types.ts"]);
		if (load.shape.kind != "object") throw new Error("not an object");
		expect(load.shape.fields[0].doc).toBe("On or off.");
	});

	test("configs auto-imported, or imported under any name; a local configs is not Config Core", () => {
		expect(loadOf(`configs.load("x", { on: true });`).call).toBe("configs.load");
		expect(loadOf(`import * as cfg from "@amxts/config-core";
cfg.load("x", { on: true });`).call).toBe("cfg.load");
		expect(loadOf(`import { load as read } from "@amxts/config-core";
read("x", { on: true });`).call).toBe("read");
		expect(scanConfigLoads("p.ts", `import * as configs from "./mine";
configs.load("x", { on: true });`)).toEqual([]);
		expect(scanConfigLoads("p.ts", `const configs = mine();
configs.load("x", { on: true });`)).toEqual([]);
		expect(scanConfigLoads("p.ts", `function f(configs: Mine) {
	configs.load("x", { on: true });
}`)).toEqual([]);
	});

	test("what is not a typed load is left out; what the build refuses is unknown", () => {
		expect(scanConfigLoads("p.ts", `${header}configs.load("hello");`)).toEqual([]);
		expect(scanConfigLoads("p.ts", `${header}configs.load(name, { a: 1 });`)).toEqual([]);
		expect(scanConfigLoads("p.ts", `import * as other from "somewhere";\nother.load("x", { a: 1 });`)).toEqual([]);
		expect(loadOf(`${header}configs.load("x", { list: [] });`).shape.kind).toBe("object");
		expect(loadOf(`${header}configs.load("x", makeDefaults());`).shape.kind).toBe("unknown");
	});
});

describe("which file a load reads", () => {
	test("a name, with or without its extension, under any folder", () => {
		expect(readsFile("D:\\srv\\configs\\settings.yaml", "settings")).toBe(true);
		expect(readsFile("/srv/configs/myplugin/settings.ini", "myplugin/settings")).toBe(true);
		expect(readsFile("/srv/configs/settings.ini", "myplugin/settings")).toBe(false);
		expect(readsFile("/srv/configs/settings.jsonc", "settings.json")).toBe(false);
		expect(readsFile("/srv/configs/settings.json", "settings.json")).toBe(true);
		expect(readsFile("/srv/configs/mysettings.yaml", "settings")).toBe(false);
		expect(loadsOf(join(WORKSPACE, "configs", "settings.yaml"), [typed])).toEqual([typed]);
	});

	test("of two files of one name, the first in Config Core's order is read", () => {
		const there = new Set(["/c/settings.ini", "/c/settings.yaml"]);
		const found = namesakes("/c/settings.yaml", "settings", path => there.has(path));
		expect(found).toEqual(["/c/settings.ini", "/c/settings.yaml"]);
		expect(namesakeMessage("/c/settings.yaml", found)).toBe("settings.ini, settings.yaml are all there - settings.ini is read; keep one of them");
		expect(namesakeMessage("/c/settings.ini", namesakes("/c/settings.ini", "settings", path => there.has(path)))).toBe("");
		expect(namesakes("/c/settings.yaml", "settings.yaml", () => true)).toEqual([]);
	});
});

describe("checks, in Config Core's words", () => {
	test("the fixture's file is clean", () => {
		expect(messages(fixture("configs/settings.yaml"), "yaml")).toEqual([]);
	});

	test("YAML: unknown keys, wrong kinds, a name outside the union", () => {
		const text = ["chat:", "  prefx: x", "  enabled: maybe", "round:", "  time: soon", "  mode: dmm", "maps: 5", "prices:", "  armor: cheap", "colour: red", ""].join("\n");
		expect(messages(text, "yaml")).toEqual([
			`unknown key "colour"`,
			`unknown key "prefx" in "chat" - did you mean "prefix"?`,
			`"enabled" is text ("maybe"), not true or false - the default stays`,
			`"time" is text ("soon"), not a number - the default stays`,
			`"mode" is "dmm", not one of "normal", "dm", "knife" - did you mean "dm"? - the default stays`,
			`"armor" is text ("cheap"), not a number - the default stays`,
		]);
	});

	test("a list, an object and an item of the wrong kind", () => {
		const text = `{ "chat": "x", "round": { "time": true }, "maps": ["a", { "b": 1 }], "prices": [1] }`;
		expect(messages(text, "json")).toEqual([
			`"chat" is text, not an object - the defaults stay`,
			`"time" is true or false ("true"), not a number - the default stays`,
			`the item is an object, not text - it is left out`,
			`"prices" is a list, not an object - the default stays`,
		]);
	});

	test("numbers and booleans written as text are read", () => {
		expect(messages(`chat:\n  enabled: "yes"\nround:\n  time: "2.5"\n`, "yaml")).toEqual([]);
		expect(messages(`chat:\n  enabled: 0\n`, "yaml")).toEqual([]);
	});

	test("the quick fix of a slip", () => {
		const text = `chat:\n  prefx: x\nround:\n  mode: dmm\n`;
		const fixes = checkConfig(text, "yaml", typed.shape).problems.map(problem => problem.fix);
		expect(fixes.map(fix => fix && text.slice(0, fix.start) + fix.text + text.slice(fix.end))).toEqual([`chat:\n  prefix: x\nround:\n  mode: dmm\n`, `chat:\n  prefx: x\nround:\n  mode: dm\n`]);
		const json = `{ "chat": { "prefx": "x" } }`;
		const [fix] = checkConfig(json, "json", typed.shape).problems.map(problem => problem.fix!);
		expect(json.slice(0, fix.start) + fix.text + json.slice(fix.end)).toBe(`{ "chat": { "prefix": "x" } }`);
	});

	test("a list of objects: the fields it needs, unknown keys in an item", () => {
		const load = loadOf(`${header}interface Item { name: string; price: number; note?: string }\nconfigs.load<{ shop: { items: Item[] } }>("shop", { shop: { items: [] } });`);
		const text = `shop:\n  items:\n    - name: armor\n      prise: 10\n    - 5\n`;
		expect(messages(text, "yaml", load)).toEqual([`unknown key "prise" - did you mean "price"?`, `"price" is missing - it is left empty`, `the item is a number, not an object - it is left out`]);
	});

	test("an optional object the defaults leave out: the fields it needs", () => {
		const load = loadOf(`${header}interface S { vip?: { tag: string; hp: number } }\nconfigs.load<S>("s", {});`);
		expect(messages(`vip:\n  tag: x\n`, "yaml", load)).toEqual([`"hp" is missing - it is left empty`]);
	});

	test("what does not parse, as Config Core says it", () => {
		const [message] = messages(`chat:\n  prefix: &a x\n`, "yaml");
		expect(message).toContain("Config Core stops here and the server reads the file as empty");
	});

	test("INI: sections are the objects at the top, their keys in any case", () => {
		const text = ["[chat]", "PREFIX = [HNS]", "enabled = yes", "", "[round]", "time = soon", "mode = dmm", "", "[CHAT]", "prefix = x", "", "[prices]", "armor = 10", ""].join("\n");
		expect(messages(text, "ini")).toEqual([
			`"maps" cannot be in an INI file, whose values are in [sections] - it stays the default; write the config in YAML or JSON`,
			`"motd" cannot be in an INI file, whose values are in [sections] - it stays the default; write the config in YAML or JSON`,
			`unknown key "CHAT" - did you mean "chat"?`,
			`"time" is text ("soon"), not a number - the default stays`,
			`"mode" is "dmm", not one of "normal", "dm", "knife" - did you mean "dm"? - the default stays`,
		]);
	});

	test("INI: a line of several values is a list, a block an object; a list of objects has no place", () => {
		const load = loadOf(`${header}interface S { round: { time: number; limits: { hp: number }; teams: { name: string }[] } }\nconfigs.load<S>("s", { round: { time: 1, limits: { hp: 1 }, teams: [] } });`);
		const text = ["[round]", "time = 2 3", "limits = {", "\tHP = 5", "\tarmor = 1", "}", ""].join("\n");
		expect(messages(text, "ini", load)).toEqual([
			`"round.teams" cannot be in an INI file, which has no lists of objects - it stays the default; write the config in YAML or JSON`,
			`"time" is a list, not a number - the default stays`,
			`unknown key "armor" in "limits"`,
		]);
		const root = iniTree(text);
		expect(root.items[0].items.map(item => item.kind)).toEqual(["array", "object"]);
	});
});

describe("completion", () => {
	test("YAML: the keys of the object at the cursor", () => {
		expect(labels("ch¦", "yaml")).toEqual(["chat", "round", "maps", "prices", "motd"]);
		expect(labels("chat:\n  ¦", "yaml")).toEqual(["prefix", "enabled"]);
		expect(labels("round:\n  time: 3\n  m¦", "yaml")).toEqual(["time", "mode"]);
		const [prefix] = complete("chat:\n  pre¦", "yaml");
		expect(prefix.insertText).toBe("prefix: ");
		expect(prefix.documentation).toContain("Default: `\"[HNS]\"`");
	});

	test("YAML: true and false, the names of a union", () => {
		expect(labels("chat:\n  enabled: ¦", "yaml")).toEqual(["true", "false"]);
		expect(labels("round:\n  mode: k¦", "yaml")).toEqual(["normal", "dm", "knife"]);
		expect(labels("round:\n  time: ¦", "yaml")).toEqual([]);
	});

	test("YAML: a list of names, and the keys of an item of a list of objects", () => {
		const load = loadOf(`${header}interface S { modes: ("a" | "b")[]; teams: { name: string; size: number }[] }\nconfigs.load<S>("s", { modes: [], teams: [] });`);
		expect(labels("modes:\n  - ¦", "yaml", load)).toEqual(["a", "b"]);
		expect(labels("modes: [a, ¦", "yaml", load)).toEqual(["a", "b"]);
		expect(labels("teams:\n  - n¦", "yaml", load)).toEqual(["name", "size"]);
		expect(labels("teams:\n  - name: x\n    s¦", "yaml", load)).toEqual(["name", "size"]);
	});

	test("JSON: keys and values, in their quotes", () => {
		expect(labels(`{ "chat": { "¦" } }`, "json")).toEqual(["prefix", "enabled"]);
		const [key] = complete(`{ "chat": { ¦ } }`, "json");
		expect(key.insertText).toBe(`"prefix": `);
		const mode = complete(`{ "round": { "mode": ¦ } }`, "json");
		expect(mode.map(item => item.insertText)).toEqual([`"normal"`, `"dm"`, `"knife"`]);
		expect(complete(`{ "round": { "mode": "¦" } }`, "json").map(item => item.insertText)).toEqual(["normal", "dm", "knife"]);
	});

	test("INI: the sections, their keys, their values", () => {
		expect(labels("[¦", "ini")).toEqual(["chat", "round", "prices"]);
		expect(labels("[chat]\n¦", "ini")).toEqual(["prefix", "enabled"]);
		expect(labels("[round]\nmode = ¦", "ini")).toEqual(["normal", "dm", "knife"]);
		expect(complete("[chat]\nena¦", "ini")[1].insertText).toBe("enabled = ");
	});
});

describe("hover and go to definition", () => {
	const text = fixture("configs/settings.yaml");
	const analysis = checkConfig(text, "yaml", typed.shape);
	const at = (marker: string) => text.indexOf(marker) + 2;
	const place = (each: { file: string; line: number }) => `${each.file.replaceAll("\\", "/").split("/").pop()}:${each.line + 1}`;

	test("a key's type, JSDoc, default and the load that reads it", () => {
		const hover = configHover(analysis, at("chat:"), typed, place)!;
		expect(hover.markdown).toContain("**chat** - `chat: { prefix: string; enabled: boolean }`");
		expect(hover.markdown).toContain("The text before every chat message.");
		expect(hover.markdown).toContain(`Read by \`configs.load<Settings>("settings")\` in settings-plugin.ts:17`);
		expect(configHover(analysis, at("prefix:"), typed, place)!.markdown).toContain("**chat.prefix**");
	});

	test("the interface member, then the defaults' property", () => {
		expect(configDefinition(analysis, at("mode:")).map(place)).toEqual(["settings-plugin.ts:9", "settings-plugin.ts:19"]);
		expect(configDefinition(analysis, at("motd:")).map(place)).toEqual(["settings-plugin.ts:14"]);
		expect(configDefinition(analysis, 0)).toEqual([]);
	});
});
