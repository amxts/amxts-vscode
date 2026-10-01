import { print, server } from "@amxts/core";
import * as configs from "@amxts/config-core";

type Mode = "normal" | "dm" | "knife";

interface Settings {
	/** The text before every chat message. */
	chat: { prefix: string; enabled: boolean };
	round: { time: number; mode: Mode };
	maps: string[];
	/** The price of each thing in the shop. */
	prices: Map<string, number>;
	/** Shown on join; left out, nothing is shown. */
	motd?: string;
}

const settings = configs.load<Settings>("settings", {
	chat: { prefix: "[HNS]", enabled: true },
	round: { time: 2.5, mode: "normal" },
	maps: [],
	prices: new Map<string, number>(),
});

server.addEventListener("putinserver", (event) => {
	if (settings.chat.enabled) print(event.player, `${settings.chat.prefix} ${settings.motd ?? ""}`);
});
