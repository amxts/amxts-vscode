/**
 * A JSON Schema of the menu file's shape, made from the key sets in
 * `shape.ts`: keys and their descriptions for the editor's own JSON and YAML
 * support. It mostly describes: an unknown key or a value of the wrong kind
 * is said by the extension's own checks, in Menu Core's words and with "did
 * you mean". Only the names of `visible`, `enabled` and `when` have their
 * kinds, and a requirement of `enabled` - `{ when, message }` - its keys, so
 * the editor can tell a line of names from a list of requirements.
 */
import { Field, Level, LEVELS } from "./shape";

type Schema = Record<string, unknown>;

/** A line of names: one or several space-separated, or a list of them. */
const NAMES: Schema = { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] };

function fieldSchema(field: Field): Schema {
	const described = { markdownDescription: field.description, description: field.description.replaceAll("`", "") };
	if (field.kind == "names" && field.names == "requirement") return { ...described, ...NAMES };
	if (field.kind == "requirements") return { ...described, anyOf: [{ type: "string" }, { type: "array", items: { anyOf: [{ type: "string" }, { $ref: `#/definitions/${field.level}` }] } }] };
	if (field.kind == "object") return { ...described, $ref: `#/definitions/${field.level}` };
	if (field.kind == "list") return { ...described, items: { $ref: `#/definitions/${field.level}` }, defaultSnippets: [{ body: [{}] }] };
	if (field.kind == "flag") return { ...described, examples: [true, false] };
	if (field.kind == "number") return { ...described, examples: field.key == "slot" ? [1, 2, 3, 4, 5, 6, 7] : [0, 1] };
	return described;
}

function levelSchema(level: Level): Schema {
	const properties: Schema = {};
	for (const field of LEVELS[level]) properties[field.key] = fieldSchema(field);
	if (level == "requirement") {
		(properties.message as Schema).type = "string";
		return { type: "object", properties, required: ["when"], additionalProperties: false };
	}
	return { properties };
}

export function menuSchema(): Schema {
	const definitions: Schema = {};
	for (const level of Object.keys(LEVELS) as Level[]) {
		if (level != "file" && level != "menus") definitions[level] = levelSchema(level);
	}
	definitions.menus = {
		markdownDescription: "The menus: `{ NAME: menu }`; a name starting with `LIST_` is a list menu.",
		additionalProperties: { $ref: "#/definitions/menu" },
	};
	const file = levelSchema("file");
	(file.properties as Schema).menus = { ...(file.properties as Schema).menus as Schema, $ref: "#/definitions/menus" };
	return {
		$schema: "http://json-schema.org/draft-07/schema#",
		$id: "https://amxts.github.io/schemas/menu.schema.json",
		title: "Menu Core menu file",
		description: "A menu file of @amxts/menu-core: chatPrefix, labels and menus.",
		...file,
		definitions,
	};
}
