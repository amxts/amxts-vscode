/**
 * The files of a workspace folder the extension reads: plugin sources (.ts,
 * .sma) for registrations, the sources of installed modules
 * (node_modules/@amxts/<module>/src), and files that may be menu files.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { EXTENSIONS } from "./detect";
import { Registration } from "./registry";
import { scanPawn } from "./scan-pawn";
import { scanTypeScript } from "./scan-ts";

/** JSON and YAML files that are never menu files, to not read them at all. */
const NEVER_MENUS = new Set(["package.json", "package-lock.json", "tsconfig.json", "jsconfig.json", "bun.lock", "pnpm-lock.yaml", ".eslintrc.json", "knip.json", "launch.json", "settings.json", "tasks.json", "extensions.json"]);
/** At most this many files of a kind are read from one folder: a workspace that big is not a plugin project. */
const LIMIT = 5000;

export function isSource(path: string) {
	const lower = path.toLowerCase();
	if (lower.endsWith(".sma")) return true;
	return lower.endsWith(".ts") && !lower.endsWith(".d.ts") && !lower.endsWith(".test.ts") && !lower.endsWith(".spec.ts");
}

export function isMenuCandidate(path: string) {
	const lower = path.toLowerCase().replaceAll("\\", "/");
	const name = lower.slice(lower.lastIndexOf("/") + 1);
	return EXTENSIONS.some(extension => lower.endsWith(extension)) && !NEVER_MENUS.has(name) && !name.startsWith("tsconfig");
}

/** The registrations of a source file, by its extension. */
export function scanSource(path: string, text: string): Registration[] {
	return path.toLowerCase().endsWith(".sma") ? scanPawn(path, text) : scanTypeScript(path, text);
}

async function walk(folder: string, exclude: Set<string>, accept: (path: string) => boolean, found: string[]) {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await fs.readdir(folder, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (found.length >= LIMIT) return;
		const path = join(folder, entry.name);
		if (entry.isDirectory()) {
			if (!exclude.has(entry.name) && entry.name != "node_modules") await walk(path, exclude, accept, found);
		} else if (entry.isFile() && accept(path)) {
			found.push(path);
		}
	}
}

/** node_modules/@amxts/<module>/src of a folder - a linked module too. */
async function moduleSources(root: string, found: string[]) {
	const scope = join(root, "node_modules", "@amxts");
	let modules: string[];
	try {
		modules = await fs.readdir(scope);
	} catch {
		return;
	}
	for (const module of modules) {
		// The core registers no menu names; its sources are many.
		if (module == "core") continue;
		await walk(join(scope, module, "src"), new Set(), isSource, found);
	}
}

/** The .ts and .sma files of a workspace folder, and of its installed modules. */
export async function findSources(root: string, excludeFolders: string[]) {
	const found: string[] = [];
	await walk(root, new Set(excludeFolders), isSource, found);
	await moduleSources(root, found);
	return found;
}

/** The files of a folder that may be menu files, by their extension. */
export async function findMenuCandidates(root: string, excludeFolders: string[]) {
	const found: string[] = [];
	await walk(root, new Set(excludeFolders), isMenuCandidate, found);
	return found;
}
