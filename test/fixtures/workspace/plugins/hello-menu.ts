import { plugin, print, server } from "@amxts/core";
import * as menus from "@amxts/menu-core";

plugin({ name: "Hello menu", version: "1.0.0", author: "you", description: "Opens a menu from a registered module" });

// A menu of menu.ini, by its name.
server.addCommand("/menu", player => menus.show(player, "MAIN_MENU"));

// A menu made in code: an object, with what its items do right on them.
const hello = menus.create("HELLO", { title: player => `Hello, ${player.name}` });
hello.addItem("Wave", {
	onSelect: (player) => {
		print(player, "You wave");
	},
});
hello.addItem(player => `Heal (${player.health} HP)`, {
	visible: player => player.health < 100,
	onSelect: (player) => {
		player.health = 100;
	},
});

server.addCommand("/hello", (player) => {
	hello.show(player);
});
