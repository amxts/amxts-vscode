/**
 * The typed configs a TypeScript file loads with Config Core, read with the
 * TypeScript parser (no type checking - a file is read on every keystroke):
 *
 *     configs.load("settings", { chat: { prefix: "[HNS]" } })
 *     configs.load<Settings>("myplugin/settings", defaults)
 *
 * `configs` is Config Core auto-imported (a plugin writes no import line), or
 * whatever name @amxts/config-core is imported under; a named import of
 * `load` counts too. Only a name written as a string is read. The
 * shape is worked out the way the build does it (typed-configs.ts of amxts):
 * from the type argument, the declared type of a defaults variable, or the
 * defaults' object literal. What the build would refuse is left unknown here,
 * and not checked - the build says what is wrong with it.
 */
import ts from "typescript";
import { commentBefore, isModule } from "./ts-source";

export type ConfigShape
	= | { kind: "text" | "number" | "boolean" | "unknown" }
		| { kind: "name"; names: string[] }
		| { kind: "list"; of: ConfigShape }
		| { kind: "object"; fields: ConfigField[] }
		| { kind: "map"; of: ConfigShape };

export type ObjectShape = Extract<ConfigShape, { kind: "object" }>;

/** A place in a source file, lines and columns from 0. */
export interface SourcePlace {
	file: string;
	line: number;
	column: number;
	endColumn: number;
}

export interface ConfigField {
	name: string;
	shape: ConfigShape;
	optional: boolean;
	/** The JSDoc of the interface member, or the comment above the defaults' property. */
	doc?: string;
	/** Where the field is written: the interface member first, then the defaults' property. */
	places: SourcePlace[];
	/** The default as the defaults' literal writes it. */
	value?: string;
}

export interface ConfigLoad {
	/** The name as written, trimmed: "settings", "myplugin/settings", "settings.yaml". */
	name: string;
	/** The name's string, quotes aside. */
	place: SourcePlace;
	/** `configs.load<Settings>` - how the call is written. */
	call: string;
	shape: ObjectShape | { kind: "unknown" };
	/** The other files the shape was read from, for a change there to read it again. */
	dependencies: string[];
}

/** An import resolved: the file `spec` means when imported from `from`, and its text; null when it is not found. */
export type ImportReader = (from: string, spec: string) => { path: string; text: string } | null;

const UNKNOWN: ConfigShape = { kind: "unknown" };

interface Context {
	path: string;
	file: ts.SourceFile;
}

function placeOf(node: ts.Node, at: Context): SourcePlace {
	const start = node.getStart(at.file);
	const position = at.file.getLineAndCharacterOfPosition(start);
	const end = at.file.getLineAndCharacterOfPosition(node.getEnd());
	return { file: at.path, line: position.line, column: position.character, endColumn: end.line == position.line ? end.character : position.character + node.getWidth(at.file) };
}

/** Reads shapes as the build does; what it would refuse is unknown. */
class Shapes {
	files = new Map<string, ts.SourceFile>();
	dependencies = new Set<string>();

	constructor(private imports: ImportReader | null) {}

	ofType(node: ts.TypeNode, at: Context, seen: string[] = []): ConfigShape {
		if (node.kind == ts.SyntaxKind.StringKeyword) return { kind: "text" };
		if (node.kind == ts.SyntaxKind.NumberKeyword) return { kind: "number" };
		if (node.kind == ts.SyntaxKind.BooleanKeyword) return { kind: "boolean" };
		if (ts.isParenthesizedTypeNode(node)) return this.ofType(node.type, at, seen);
		if (ts.isTypeOperatorNode(node) && node.operator == ts.SyntaxKind.ReadonlyKeyword) return this.ofType(node.type, at, seen);
		if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) return { kind: "name", names: [node.literal.text] };

		if (ts.isUnionTypeNode(node)) {
			const names: string[] = [];
			for (const each of node.types) {
				const shape = this.ofType(each, at, seen);
				if (shape.kind != "name") return UNKNOWN;
				names.push(...shape.names);
			}
			return { kind: "name", names };
		}

		if (ts.isArrayTypeNode(node)) return this.list(this.ofType(node.elementType, at, seen));
		if (ts.isTypeLiteralNode(node)) return this.members(node.members, at, seen);

		if (ts.isTypeReferenceNode(node)) {
			const name = node.typeName.getText(at.file);
			const args = node.typeArguments ?? [];
			if ((name == "Array" || name == "ReadonlyArray") && args.length == 1) return this.list(this.ofType(args[0], at, seen));
			if (name == "Map" && args.length == 2) return this.map(args[0], this.ofType(args[1], at, seen));
			if (args.length > 0) return UNKNOWN;
			return this.named(node.typeName, at, seen);
		}

		return UNKNOWN;
	}

	/** A list of text, numbers, booleans, names, objects - or of lists of values: rows. */
	list(of: ConfigShape): ConfigShape {
		const rows = of.kind == "list" && ["text", "number", "boolean", "name"].includes(of.of.kind);
		return (of.kind == "list" && !rows) || of.kind == "map" || of.kind == "unknown" ? UNKNOWN : { kind: "list", of };
	}

	map(key: ts.TypeNode, of: ConfigShape): ConfigShape {
		if (key.kind != ts.SyntaxKind.StringKeyword) return UNKNOWN;
		return of.kind == "list" || of.kind == "object" || of.kind == "map" || of.kind == "unknown" ? UNKNOWN : { kind: "map", of };
	}

	members(members: ts.NodeArray<ts.TypeElement>, at: Context, seen: string[]): ConfigShape {
		const fields: ConfigField[] = [];
		for (const member of members) {
			if (!ts.isPropertySignature(member) || member.type == null || !ts.isIdentifier(member.name)) return UNKNOWN;
			fields.push({
				name: member.name.text,
				shape: this.ofType(member.type, at, seen),
				optional: member.questionToken != null,
				doc: commentBefore(at.file.text, member.getFullStart()),
				places: [placeOf(member.name, at)],
			});
		}
		return { kind: "object", fields };
	}

	named(name: ts.EntityName, at: Context, seen: string[]): ConfigShape {
		const found = this.declaration(name, at);
		if (found == null) return UNKNOWN;
		const key = `${found.at.path}#${found.node.name.text}`;
		if (seen.includes(key)) return UNKNOWN;
		const inside = [...seen, key];
		if (ts.isTypeAliasDeclaration(found.node)) return found.node.typeParameters?.length ? UNKNOWN : this.ofType(found.node.type, found.at, inside);
		if (found.node.typeParameters?.length || found.node.heritageClauses?.length) return UNKNOWN;
		return this.members(found.node.members, found.at, inside);
	}

	declaration(name: ts.EntityName, at: Context): { node: ts.InterfaceDeclaration | ts.TypeAliasDeclaration; at: Context } | null {
		if (ts.isQualifiedName(name)) {
			if (!ts.isIdentifier(name.left)) return null;
			const namespace = this.importOf(name.left.text, at);
			if (namespace == null || namespace.kind != "namespace") return null;
			return this.exported(name.right.text, namespace.at, []);
		}
		const local = this.local(name.text, at);
		if (local != null) return local;
		const imported = this.importOf(name.text, at);
		if (imported == null || imported.kind != "named") return null;
		return this.exported(imported.name, imported.at, []);
	}

	local(name: string, at: Context) {
		for (const statement of at.file.statements) {
			if ((ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && statement.name.text == name) return { node: statement, at };
		}
		return null;
	}

	importOf(local: string, at: Context): { kind: "named"; name: string; at: Context } | { kind: "namespace"; at: Context } | null {
		for (const statement of at.file.statements) {
			if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
			const bindings = statement.importClause?.namedBindings;
			if (bindings == null) continue;
			const spec = statement.moduleSpecifier.text;
			if (ts.isNamespaceImport(bindings) && bindings.name.text == local) {
				const file = this.open(at, spec);
				return file != null ? { kind: "namespace", at: file } : null;
			}
			if (!ts.isNamedImports(bindings)) continue;
			const element = bindings.elements.find(each => each.name.text == local);
			if (element == null) continue;
			const file = this.open(at, spec);
			return file != null ? { kind: "named", name: (element.propertyName ?? element.name).text, at: file } : null;
		}
		return null;
	}

	exported(name: string, at: Context, visited: string[]): { node: ts.InterfaceDeclaration | ts.TypeAliasDeclaration; at: Context } | null {
		if (visited.includes(at.path)) return null;
		const local = this.local(name, at);
		if (local != null) return local;

		for (const statement of at.file.statements) {
			if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier == null || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
			const clause = statement.exportClause;
			let wanted = name;
			if (clause != null && ts.isNamedExports(clause)) {
				const element = clause.elements.find(each => each.name.text == name);
				if (element == null) continue;
				wanted = (element.propertyName ?? element.name).text;
			} else if (clause != null) {
				continue;
			}
			const file = this.open(at, statement.moduleSpecifier.text);
			const found = file != null ? this.exported(wanted, file, [...visited, at.path]) : null;
			if (found != null) return found;
		}

		const alias = this.importOf(name, at);
		return alias != null && alias.kind == "named" ? this.exported(alias.name, alias.at, [...visited, at.path]) : null;
	}

	open(at: Context, spec: string): Context | null {
		const found = this.imports?.(at.path, spec) ?? null;
		if (found == null) return null;
		this.dependencies.add(found.path);
		let file = this.files.get(found.path);
		if (file == null) {
			file = ts.createSourceFile(found.path, found.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
			this.files.set(found.path, file);
		}
		return { path: found.path, file };
	}

	/** The defaults' value, when no type is given: what it visibly is. */
	ofValue(node: ts.Expression, at: Context): ConfigShape {
		if (ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node)) return this.ofValue(node.expression, at);
		if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
			const shape = this.ofType(node.type, at);
			if (shape.kind == "object") attachDefaults(shape, node.expression, at);
			return shape;
		}
		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) return { kind: "text" };
		if (ts.isNumericLiteral(node)) return { kind: "number" };
		if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) return { kind: "number" };
		if (node.kind == ts.SyntaxKind.TrueKeyword || node.kind == ts.SyntaxKind.FalseKeyword) return { kind: "boolean" };

		if (ts.isObjectLiteralExpression(node)) {
			const fields: ConfigField[] = [];
			for (const property of node.properties) {
				if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) return UNKNOWN;
				fields.push({
					name: property.name.text,
					shape: this.ofValue(property.initializer, at),
					optional: false,
					doc: commentBefore(at.file.text, property.getFullStart()),
					places: [placeOf(property.name, at)],
					value: property.initializer.getText(at.file),
				});
			}
			return { kind: "object", fields };
		}

		if (ts.isArrayLiteralExpression(node)) {
			if (node.elements.length == 0) return UNKNOWN;
			const items = node.elements.map(each => this.ofValue(each, at));
			const first = describe(items[0]);
			if (items.some(each => describe(each) != first)) return UNKNOWN;
			return this.list(items[0]);
		}

		if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text == "Map" && node.typeArguments?.length == 2) {
			return this.map(node.typeArguments[0], this.ofType(node.typeArguments[1], at));
		}

		return UNKNOWN;
	}
}

/** The defaults' literal laid over a shape read from a type: where each field's default is, and what it is. */
function attachDefaults(shape: ObjectShape, node: ts.Expression, at: Context) {
	while (ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node) || ts.isAsExpression(node)) node = node.expression;
	if (!ts.isObjectLiteralExpression(node)) return;
	for (const property of node.properties) {
		if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
		const field = shape.fields.find(each => each.name == (property.name as ts.Identifier).text);
		if (field == null) continue;
		field.places.push(placeOf(property.name, at));
		field.value = property.initializer.getText(at.file);
		field.doc ??= commentBefore(at.file.text, property.getFullStart());
		if (field.shape.kind == "object") attachDefaults(field.shape, property.initializer, at);
	}
}

/** A shape as a type: `string`, `"a" | "b"`, `{ time: number }`. */
export function describe(shape: ConfigShape): string {
	switch (shape.kind) {
		case "name":
			return shape.names.map(each => JSON.stringify(each)).join(" | ");
		case "list":
			return shape.of.kind == "name" ? `(${describe(shape.of)})[]` : `${describe(shape.of)}[]`;
		case "map":
			return `Map<string, ${describe(shape.of)}>`;
		case "object":
			return `{ ${shape.fields.map(field => `${field.name}${field.optional ? "?" : ""}: ${describe(field.shape)}`).join("; ")} }`;
		case "text":
			return "string";
		default:
			return shape.kind;
	}
}

/** The declared type of the variable or parameter a name means where it is used, and its initializer. */
function declarationOf(use: ts.Identifier, file: ts.SourceFile): { type: ts.TypeNode | null; initializer: ts.Expression | null } | null {
	for (let scope: ts.Node | undefined = use.parent; scope != null; scope = scope.parent) {
		if (ts.isFunctionLike(scope)) {
			const parameter = scope.parameters.find(each => ts.isIdentifier(each.name) && each.name.text == use.text);
			if (parameter != null) return { type: parameter.type ?? null, initializer: parameter.initializer ?? null };
		}
		if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
		for (const statement of scope.statements) {
			if (!ts.isVariableStatement(statement) || statement.getStart(file) > use.getStart(file)) continue;
			const found = statement.declarationList.declarations.find(each => ts.isIdentifier(each.name) && each.name.text == use.text);
			if (found != null) return { type: found.type ?? null, initializer: found.initializer ?? null };
		}
	}
	return null;
}

/** The name Config Core gives a plugin without an import (its `defineModule({ imports })`). */
const AUTO_IMPORTED = "configs";

/**
 * The typed `load` calls of a file: of Config Core imported under any name,
 * or auto-imported as `configs` - unless the file binds that name itself.
 * `imports` finds a type imported from another file; without it such a type is unknown.
 */
export function scanConfigLoads(path: string, text: string, imports: ImportReader | null = null): ConfigLoad[] {
	if (!text.includes("config-core") && !text.includes(`${AUTO_IMPORTED}.`)) return [];
	const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const namespaces = new Set<string>();
	const loads = new Set<string>();
	/** Names the file's imports bind: an import of `configs` from elsewhere is not Config Core. */
	const bound = new Set<string>();

	for (const statement of file.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
		const fromConfigCore = isModule(statement.moduleSpecifier.text, "config-core");
		const clause = statement.importClause;
		const bindings = clause?.namedBindings;
		if (clause?.name != null) bound.add(clause.name.text);
		if (bindings != null && ts.isNamespaceImport(bindings)) {
			bound.add(bindings.name.text);
			if (fromConfigCore) namespaces.add(bindings.name.text);
		}
		if (bindings == null || !ts.isNamedImports(bindings)) continue;
		for (const element of bindings.elements) {
			bound.add(element.name.text);
			if (fromConfigCore && (element.propertyName ?? element.name).text == "load") loads.add(element.name.text);
		}
	}

	const at: Context = { path, file };
	const found: ConfigLoad[] = [];

	const isConfigCore = (receiver: ts.Identifier) =>
		namespaces.has(receiver.text) || (receiver.text == AUTO_IMPORTED && !bound.has(AUTO_IMPORTED) && declarationOf(receiver, file) == null);
	const isLoad = (callee: ts.Expression) =>
		(ts.isIdentifier(callee) && loads.has(callee.text))
		|| (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.name.text == "load" && isConfigCore(callee.expression));

	const visit = (node: ts.Node) => {
		ts.forEachChild(node, visit);
		if (!ts.isCallExpression(node) || !isLoad(node.expression)) return;
		if (!node.typeArguments?.length && node.arguments.length < 2) return;
		const name = node.arguments[0];
		if (name == null || !(ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name))) return;

		const shapes = new Shapes(imports);
		const shape = shapeOfCall(node, shapes, at);
		const start = file.getLineAndCharacterOfPosition(name.getStart(file) + 1);
		const call = text.slice(node.expression.getStart(file), node.arguments.pos - 1);
		found.push({
			name: name.text.trim(),
			place: { file: path, line: start.line, column: start.character, endColumn: start.character + name.text.length },
			call,
			shape: shape.kind == "object" ? shape : { kind: "unknown" },
			dependencies: [...shapes.dependencies],
		});
	};
	visit(file);
	return found;
}

/** A load's shape: the type argument, the defaults' declared type, or the defaults' literal. */
function shapeOfCall(call: ts.CallExpression, shapes: Shapes, at: Context): ConfigShape {
	const defaults = call.arguments[1];
	const typeArgument = call.typeArguments?.[0];
	if (typeArgument != null) {
		const shape = shapes.ofType(typeArgument, at);
		if (shape.kind == "object" && defaults != null) attachDefaults(shape, literalOf(defaults, at) ?? defaults, at);
		return shape;
	}
	if (defaults == null) return UNKNOWN;

	if (ts.isIdentifier(defaults)) {
		const declared = declarationOf(defaults, at.file);
		if (declared?.type == null) return UNKNOWN;
		const shape = shapes.ofType(declared.type, at);
		if (shape.kind == "object" && declared.initializer != null) attachDefaults(shape, declared.initializer, at);
		return shape;
	}

	return shapes.ofValue(defaults, at);
}

/** The literal a defaults variable is set to, for where its fields are. */
function literalOf(node: ts.Expression, at: Context) {
	if (!ts.isIdentifier(node)) return null;
	return declarationOf(node, at.file)?.initializer ?? null;
}
