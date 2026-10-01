import { Player, plugin, print, server } from "@amxts/core";
import * as ini from "@amxts/config-core";
import * as menus from "@amxts/menu-core";

plugin({ name: "Hello", version: "1.0.0", author: "Ernest Manukyan", description: "The first plugin of amxts-test" });

const greeting = readGreeting();

server.addCommand("/hp", sayHp);
server.addEventListener("putinserver", (event) => {
	print(0, `${greeting}, ${event.player.name}!`);
});

// A menu made in code: its title and items can be functions of the player.
const hello = menus.create("HELLO", { title: player => `Hello, ${player.name}` });
hello.addItem("Wave", { onSelect: wave });
hello.addItem(player => `Heal (${player.health} HP)`, {
	visible: player => player.health < 100,
	onSelect: heal,
});

server.addCommand("/menu", (player) => {
	hello.show(player);
});

function sayHp(player: Player) {
	print(player, `${player.name}, your HP: ${player.health}`);
}

// configs/hello.ini says what a player is greeted with:
//
//   [MAIN]
//   GREETING = Welcome
function readGreeting() {
	const main = ini.section(ini.load("hello"), "MAIN");
	if (!main) return "Welcome";

	return ini.getValue(main, "GREETING") ?? "Welcome";
}

function wave(player: Player) {
	print(0, `${player.name} waves`);
}

function heal(player: Player) {
	player.health = 100;
}
