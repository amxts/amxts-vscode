import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { looksLikeMenuFile, matchesName, menuFileFormat } from "../src/core/detect";
import { menuSchema } from "../src/core/schema";
import { BUILT_IN_PLACEHOLDERS, iniKeysOf, INI_LABELS, INI_MAIN, INI_MENU, keysOf } from "../src/core/shape";
import { fixture } from "./helpers";

const MENU_CORE = join(import.meta.dir, "../../amxts-modules/menu-core/src");
const CONFIG_CORE = join(import.meta.dir, "../../amxts-modules/config-core/src");

/** `const NAME = ["a", "b"];` of a source file, as a list. */
function listIn(source: string, name: string) {
	const found = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(source);
	if (found == null) throw new Error(`${name} is not in the source`);
	return found[1].split(",").map(each => each.trim().replace(/^"|"$/g, ""));
}

describe.skipIf(!existsSync(MENU_CORE))("the key sets are Menu Core's", () => {
	const source = existsSync(MENU_CORE) ? readFileSync(join(MENU_CORE, "menu-file.ts"), "utf8") : "";

	test("YAML and JSON", () => {
		expect(keysOf("file")).toEqual(listIn(source, "FILE_KEYS"));
		expect(keysOf("labels")).toEqual(listIn(source, "LABEL_KEYS"));
		expect(keysOf("menu")).toEqual(listIn(source, "MENU_KEYS"));
		expect(keysOf("item")).toEqual(listIn(source, "ITEM_KEYS"));
		expect(keysOf("fixed")).toEqual(listIn(source, "FIXED_KEYS"));
		expect(keysOf("view")).toEqual(listIn(source, "VIEW_KEYS"));
		expect(keysOf("variant")).toEqual(listIn(source, "VARIANT_KEYS"));
		expect(keysOf("requirement")).toEqual(listIn(source, "REQUIREMENT_KEYS"));
		expect(keysOf("filter")).toEqual(listIn(source, "FILTER_KEYS"));
	});

	test("INI", () => {
		expect(iniKeysOf(INI_MAIN)).toEqual(listIn(source, "INI_MAIN_KEYS"));
		expect(iniKeysOf(INI_LABELS)).toEqual(listIn(source, "INI_LABEL_KEYS"));
		expect(iniKeysOf(INI_MENU)).toEqual(listIn(source, "INI_MENU_KEYS"));
	});

	test("built-in placeholders", () => {
		expect(BUILT_IN_PLACEHOLDERS).toEqual(listIn(readFileSync(join(MENU_CORE, "index.ts"), "utf8"), "BUILT_IN_PLACEHOLDERS"));
	});
});

describe.skipIf(!existsSync(CONFIG_CORE))("the vendored readers are Config Core's", () => {
	test("as they are in config-core (bun scripts/vendor.ts copies them again)", () => {
		for (const file of ["yaml.ts", "json.ts", "tree.ts", "internal.ts"]) {
			const vendored = readFileSync(join(import.meta.dir, "../src/vendor/config-core", file), "utf8").replaceAll("\r\n", "\n").split("\n").slice(2).join("\n");
			expect(vendored).toBe(readFileSync(join(CONFIG_CORE, file), "utf8").replaceAll("\r\n", "\n"));
		}
	});
});

describe("the JSON Schema", () => {
	test("schemas/menu.schema.json is made from the key sets (bun scripts/schema.ts)", () => {
		const written = JSON.parse(readFileSync(join(import.meta.dir, "../schemas/menu.schema.json"), "utf8"));
		expect(written).toEqual(menuSchema());
	});

	test("describes; only the names of visible, enabled and when, and a requirement, have their kinds", () => {
		const schema = menuSchema() as { definitions: Record<string, { properties: Record<string, Record<string, unknown>> }> };
		const names = { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] };
		const { definitions } = schema;
		for (const level of ["item", "fixed"]) expect(definitions[level].properties.visible).toMatchObject(names);
		for (const [level, key] of [["variant", "when"], ["requirement", "when"], ["filter", "when"]]) expect(definitions[level].properties[key]).toMatchObject(names);
		for (const level of ["item", "fixed", "view"]) {
			expect(definitions[level].properties.enabled).toMatchObject({ anyOf: [{ type: "string" }, { type: "array", items: { anyOf: [{ type: "string" }, { $ref: "#/definitions/requirement" }] } }] });
		}
		expect(definitions.requirement).toMatchObject({ type: "object", required: ["when"], additionalProperties: false, properties: { message: { type: "string" } } });

		// Anything else is said by the extension's own checks, in Menu Core's words.
		const rest = JSON.parse(JSON.stringify(schema));
		for (const level of ["item", "fixed"]) delete rest.definitions[level].properties.visible;
		for (const level of ["item", "fixed", "view"]) delete rest.definitions[level].properties.enabled;
		for (const level of ["variant", "filter"]) delete rest.definitions[level].properties.when;
		delete rest.definitions.requirement;
		const text = JSON.stringify(rest);
		expect(text).not.toContain("additionalProperties\":false");
		expect(text).not.toContain("\"type\"");
		expect(text).not.toContain("\"enum\"");
		expect(text).not.toContain("\"condition\"");
		expect(text).not.toContain("\"restriction\"");
	});
});

describe("which files are menu files", () => {
	test("by the name amxts.config.ts gives", () => {
		expect(matchesName("D:/srv/cstrike/addons/amxmodx/configs/playground/menu.yaml", ["playground/menu"])).toBe(true);
		expect(matchesName("D:\\proj\\configs\\playground\\menu.INI", ["playground/menu"])).toBe(true);
		expect(matchesName("D:/proj/configs/menu.yaml", ["playground/menu"])).toBe(false);
		expect(matchesName("D:/proj/configs/menu.jsonc", ["menu"])).toBe(true);
		expect(matchesName("D:/proj/configs/mymenu.yaml", ["menu"])).toBe(false);
		expect(matchesName("D:/proj/shop.yaml", ["shop.yaml"])).toBe(true);
		expect(matchesName("D:/proj/shop.yml", ["shop.yaml"])).toBe(false);
	});

	test("by what is in it", () => {
		expect(looksLikeMenuFile(fixture("configs/playground/menu.ini"), "ini")).toBe(true);
		expect(looksLikeMenuFile(fixture("configs/playground/menu.yaml"), "yaml")).toBe(true);
		expect(looksLikeMenuFile(fixture("configs/playground/menu.json"), "json")).toBe(true);
		expect(looksLikeMenuFile("[settings]\nvolume = 3\n", "ini")).toBe(false);
		expect(looksLikeMenuFile("name: x\nitems: []\n", "yaml")).toBe(false);
		expect(looksLikeMenuFile(`{ "a": { "menus": {} } }`, "json")).toBe(false);
	});

	test("the setting that turns content detection off", () => {
		const text = fixture("configs/playground/menu.yaml");
		expect(menuFileFormat("x/other.yaml", text, { names: ["menu"], detectByContent: true })).toBe("yaml");
		expect(menuFileFormat("x/other.yaml", text, { names: ["menu"], detectByContent: false })).toBeNull();
		expect(menuFileFormat("x/menu.yml", "", { names: ["menu"], detectByContent: false })).toBe("yaml");
		expect(menuFileFormat("x/menu.txt", text, { names: ["menu"], detectByContent: true })).toBeNull();
	});
});
