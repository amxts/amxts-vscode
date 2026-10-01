// Copied from @amxts/config-core 0.1.0 (f9978d1) src/types.ts by scripts/vendor.ts - do not edit.
// @ts-nocheck
/**
 * The types of Config Core's API: a config file's format, a value's kind and
 * the module's options.
 */

/** A config file's format, one of `"ini"`, `"yaml"` (`.yaml`, `.yml`) or `"json"` (`.json`, `.jsonc`). */
export type ConfigFormat = "ini" | "yaml" | "json";

/** A config value's kind, one of `"object"`, `"array"`, `"string"`, `"number"`, `"boolean"` or `"null"` - the kinds of JSON. */
export type ConfigKind = "object" | "array" | "string" | "number" | "boolean" | "null";

/** Config Core's options: `configs` in `amxts.config.ts`. */
export interface ConfigCoreOptions {
	/** The folder under `configs/` that names are loaded from, e.g. `"myserver"`; `""` is `configs/` itself. */
	baseDir: string;
}

