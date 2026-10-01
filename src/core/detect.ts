/**
 * Which files are menu files:
 *
 * 1. the file amxts.config.ts names - `menus: { file, fallback }`, "menu" by
 *    default - under the server's configs/: any file whose path ends with
 *    `<file>.ini`, `.yaml`, `.yml`, `.json` or `.jsonc` (configs/menu.ini,
 *    a repository's own configs/myserver/menu.yaml, ...);
 * 2. the names in the `amxts.menus.files` setting, the same way;
 * 3. any other file whose content looks like one: an INI [SECTION] with TITLE
 *    and ITEMS, FIXED_ITEMS or VIEW; YAML or JSON with a top-level `menus`.
 */
import * as jsonc from "jsonc-parser";
import { Format, formatOf } from "./analyze";

/** The extensions a menu or config file has, in the order a name without one looks for them. */
export const EXTENSIONS = [".ini", ".yaml", ".yml", ".json", ".jsonc"];

/** A file's name as a path ends with it: lower case, with forward slashes. */
export function normalName(name: string) {
	return name.trim().replaceAll("\\", "/").replace(/^\/+/, "").toLowerCase();
}

/** Whether a name - "settings", "myplugin/settings", "settings.yaml" - is the file at `path`. */
export function readsFile(path: string, name: string) {
	const normal = `/${path.replaceAll("\\", "/").toLowerCase()}`;
	const wanted = normalName(name);
	if (wanted.length == 0) return false;
	if (EXTENSIONS.some(extension => wanted.endsWith(extension))) return normal.endsWith(`/${wanted}`);
	return EXTENSIONS.some(extension => normal.endsWith(`/${wanted}${extension}`));
}

/** Whether a path is one of the menu files named - "menu", "myserver/menu", "shop.yaml". */
export function matchesName(path: string, names: string[]) {
	return names.some(name => readsFile(path, name));
}

/** Whether a text reads like a menu file of its format. */
export function looksLikeMenuFile(text: string, format: Format) {
	if (format == "ini") {
		return /^\s*\[[^\]\r\n]+\]/m.test(text) && /^\s*TITLE\s*=/im.test(text) && /^\s*(?:ITEMS|FIXED_ITEMS|VIEW)\s*=\s*\{/im.test(text);
	}
	if (format == "yaml") return /^menus\s*:/m.test(text);
	const root = jsonc.parseTree(text, [], { allowTrailingComma: true });
	return root?.type == "object" && (root.children ?? []).some(property => property.children?.[0]?.value == "menus");
}

export interface Detection {
	/** The names of amxts.config.ts and the setting. */
	names: string[];
	detectByContent: boolean;
}

/** The format of a menu file, or null for a file that is not one. */
export function menuFileFormat(path: string, text: string, detection: Detection) {
	const format = formatOf(path);
	if (format == null) return null;
	if (matchesName(path, detection.names)) return format;
	if (detection.detectByContent && looksLikeMenuFile(text, format)) return format;
	return null;
}
