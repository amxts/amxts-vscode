import { Player, plugin } from "@amxts/core";
import * as menus from "@amxts/menu-core";

plugin({ name: "Admin", version: "1.0.0", author: "you", description: "Registrations for menu files" });

/** Whether the player has admin access. */
menus.addCondition("IS_ADMIN", player => player.access.includes("Admin"));

menus.addAction("RESET_SCORE", resetScore);
menus.addAction("TOGGLE_DM", () => {});
menus.addAction(`TOGGLE_SOLO`, () => {});

// Shown in the admin menu: whether deathmatch is on.
menus.addPlaceholder("dm_status", () => "on");

// A name made at run time is not read.
const dynamic = "DYNAMIC_" + "NAME";
menus.addAction(dynamic, () => {});

menus.addConditionFilter("IS_ADMIN", (_player, _viewer, _name, value) => value);

const shop = menus.create("SHOP", { title: "Shop" });
shop.addPlaceholder("price", () => "100$");

/** Resets the player's frags and deaths. */
function resetScore(player: Player) {
	player.frags = 0;
}
