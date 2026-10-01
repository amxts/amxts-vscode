import { describe, expect, test } from "bun:test";
import { scanPawn } from "../src/core/scan-pawn";
import { menuFilesOfConfig, scanTypeScript } from "../src/core/scan-ts";
import { fixture, where, workspaceRegistry } from "./helpers";

describe("TypeScript registrations", () => {
	test("menus.* under the name the module is imported as", () => {
		const found = scanTypeScript("plugins/x.ts", `import * as mc from "@amxts/menu-core";\nmc.addCondition("IS_VIP", () => true);\nmc.addRestriction("VIP", () => true);\nmc.create("SHOP");`);
		expect(found.map(each => [each.kind, each.name, each.line, each.column])).toEqual([
			["condition", "IS_VIP", 1, 17],
			["restriction", "VIP", 2, 19],
			["menu", "SHOP", 3, 11],
		]);
	});

	test("menus.* auto-imported, without an import line", () => {
		const found = scanTypeScript("plugins/x.ts", `menus.addCondition("IS_VIP", () => true);
const shop = menus.create("SHOP");
shop.addPlaceholder("hp", () => "");`);
		expect(found.map(each => `${each.kind} ${each.name} ${each.menu ?? ""}`.trim())).toEqual(["condition IS_VIP", "menu SHOP", "placeholder hp SHOP"]);
	});

	test("named imports, with an alias too", () => {
		const found = scanTypeScript("t.ts", fixture("plugins/team.ts"));
		expect(found.map(each => `${each.kind} ${each.name}`)).toEqual(["condition IS_SPECTATOR", "action JOIN_SPECTATE", "action JOIN_TEAM"]);
	});

	test("a name that is not a string is left out; a template without substitutions is read", () => {
		const found = scanTypeScript("a.ts", fixture("plugins/admin.ts"));
		const names = found.map(each => each.name);
		expect(names).toContain("TOGGLE_SOLO");
		expect(names.some(name => name.startsWith("DYNAMIC"))).toBe(false);
	});

	test("the JSDoc of the call, or of the function it passes", () => {
		const found = scanTypeScript("a.ts", fixture("plugins/admin.ts"));
		expect(found.find(each => each.name == "IS_ADMIN" && each.kind == "condition")?.doc).toBe("Whether the player has admin access.");
		expect(found.find(each => each.name == "RESET_SCORE")?.doc).toBe("Resets the player's frags and deaths.");
		expect(found.find(each => each.name == "dm_status")?.doc).toBe("Shown in the admin menu: whether deathmatch is on.");
		expect(found.find(each => each.name == "JOIN_TEAM")?.doc).toBeUndefined();
	});

	test("a menu's own placeholder knows its menu", () => {
		const found = scanTypeScript("a.ts", fixture("plugins/admin.ts"));
		expect(found.find(each => each.name == "price")).toMatchObject({ kind: "placeholder", menu: "SHOP", via: "menu.addPlaceholder" });
		expect(found.find(each => each.name == "SHOP")).toMatchObject({ kind: "menu" });
		expect(found.find(each => each.name == "IS_ADMIN" && each.kind == "filter")).toBeDefined();
	});

	test("unrelated calls are not taken for registrations", () => {
		const found = scanTypeScript("x.ts", `const o = Object.create(null);\nconst m = new Map();\nm.set("A", 1);\nfoo.create("NOT_A_MENU");\naddAction("NOT_IMPORTED");`);
		expect(found).toEqual([]);
	});

	test("menu-core's own sources: its functions called by name", () => {
		const found = scanTypeScript("/x/menu-core/src/index.ts", `export function addAction(name: string) {}\naddAction("BUILT_IN");`);
		expect(found.map(each => each.name)).toEqual(["BUILT_IN"]);
	});

	test("the menu files amxts.config.ts names", () => {
		expect(menuFilesOfConfig(fixture("amxts.config.ts"))).toEqual(["playground/menu"]);
		expect(menuFilesOfConfig(`export default defineConfig({ modules: [] });`)).toEqual(["menu"]);
		expect(menuFilesOfConfig(`export default defineConfig({ menus: { file: "a/menu", fallback: "menu" } });`)).toEqual(["a/menu", "menu"]);
		expect(menuFilesOfConfig(`export default defineConfig({ menus: { fallback: "old" } });`)).toEqual(["menu", "old"]);
	});
});

describe("Pawn registrations", () => {
	test("the natives of menu_core.inc, comments and non-string names left out", () => {
		const found = scanPawn("settings.sma", fixture("pawn/settings.sma"));
		expect(found.map(each => `${each.kind} ${each.name}`)).toEqual(["action TOGGLE_HIDE_KNIFE", "action INPUT_FOV", "placeholder solo_status", "restriction VIP", "menu PAWN_MENU"]);
		expect(found[0]).toMatchObject({ line: 8, column: 21, endColumn: 38, language: "pawn", via: "mc_register_action", doc: "Hides the knife for the player." });
		expect(found[1].column).toBe(22);
	});
});

describe("the workspace", () => {
	test("plugins, Pawn sources and installed modules; not tests, not the core", async () => {
		const registry = await workspaceRegistry();
		const actions = registry.names("action");
		expect(actions).toContain("RESET_SCORE");
		expect(actions).toContain("TOGGLE_HIDE_KNIFE");
		expect(actions).toContain("SWAP");
		expect(actions).not.toContain("FROM_TEST");
		expect(actions).not.toContain("CORE_THING");
		expect(registry.names("menu").sort()).toEqual(["HELLO", "PAWN_MENU", "SHOP"]);
		expect(where(registry.find("action", "SWAP")[0])).toBe("node_modules/@amxts/extras/src/index.ts:4");
	});

	test("a file replaced as it changes; the version grows only on a change", async () => {
		const registry = await workspaceRegistry();
		const version = registry.version;
		expect(registry.set("plugins/new.ts", scanTypeScript("plugins/new.ts", `import * as menus from "@amxts/menu-core";\nmenus.addCondition("MY_VIP", () => true);`))).toBe(true);
		expect(registry.version).toBe(version + 1);
		expect(registry.set("plugins/new.ts", scanTypeScript("plugins/new.ts", `import * as menus from "@amxts/menu-core";\nmenus.addCondition("MY_VIP", () => true);`))).toBe(false);
		expect(registry.find("condition", "my_vip")).toHaveLength(1);
		registry.delete("plugins/new.ts");
		expect(registry.find("condition", "MY_VIP")).toHaveLength(0);
	});
});
