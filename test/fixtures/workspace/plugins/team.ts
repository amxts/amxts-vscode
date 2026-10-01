import { addAction, addCondition as condition } from "@amxts/menu-core";

condition("IS_SPECTATOR", player => player.team == "Spectator");
addAction("JOIN_SPECTATE", (player) => {
	player.team = "Spectator";
});
addAction("JOIN_TEAM", () => {});
