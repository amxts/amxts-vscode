// Copied from @amxts/config-core 0.1.0 (f9978d1) src/internal.ts by scripts/vendor.ts - do not edit.
// @ts-nocheck
/**
 * Config Core's own bookkeeping. Not part of the API.
 */
import { ConfigFormat, ConfigKind } from "./types";

/** A value of a config read as a tree: what a ConfigNode shows. */
export interface TreeNode {
	kind: ConfigKind;
	/** The key it has in its object; "" in an array and at the top. */
	key: string;
	/** A scalar as it was written: a string's text, a number as written, "true", "false", "null" or "" for an empty value. */
	text: string;
	/** A number's value; 0 for anything else. */
	value: number;
	/** An object's members or an array's items, in order. */
	items: TreeNode[];
	/** The comment and blank lines read before it; null for none. */
	comments: string[] | null;
	/** Where it was read, from 1; 0 for one made at run time or a column not known. */
	line: number;
	column: number;
	/** An object whose keys are found case-insensitively: an INI section's. */
	foldCase: boolean;
	/** A list that is an INI block of rows: written back as a block, even when each row is one value. */
	block: boolean;
}

/** A config file read as a tree. */
export interface TreeDocument {
	/** The file's path; "" for a text that came from no file. */
	file: string;
	format: ConfigFormat;
	root: TreeNode;
	/** One level of indentation, as the file has it. */
	indent: string;
	/** The comment and blank lines after the last value. */
	tail: string[] | null;
}

/** A place in a text: its line and column, from 1. */
export interface Place {
	line: number;
	column: number;
}
