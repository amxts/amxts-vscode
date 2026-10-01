import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Registry } from "../src/core/registry";
import { findSources, scanSource } from "../src/core/workspace";

export const WORKSPACE = join(import.meta.dir, "fixtures", "workspace");
export const EXCLUDED = [".git", "node_modules", "dist", ".amxts", "test", "tests"];

export function fixture(path: string) {
	return readFileSync(join(WORKSPACE, path), "utf8");
}

/** The fixture workspace's registrations, read as the extension reads them. */
export async function workspaceRegistry() {
	const registry = new Registry();
	for (const path of await findSources(WORKSPACE, EXCLUDED)) registry.set(path, scanSource(path, readFileSync(path, "utf8")));
	return registry;
}

/** The text without its `|` marker, and where the marker was. */
export function cursor(marked: string) {
	const offset = marked.indexOf("¦");
	if (offset < 0) throw new Error("no ¦ in the text");
	return { text: marked.slice(0, offset) + marked.slice(offset + 1), offset };
}

/** "plugins/admin.ts:7" - a registration's place, as the tests name it. */
export function where(registration: { file: string; line: number }) {
	const normal = registration.file.replaceAll("\\", "/");
	return `${normal.slice(normal.indexOf("/workspace/") + "/workspace/".length)}:${registration.line + 1}`;
}
