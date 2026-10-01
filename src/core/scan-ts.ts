/**
 * The names a TypeScript file registers with Menu Core, read with the
 * TypeScript parser (no type checking - a file is read on every keystroke):
 *
 *     menus.addCondition("IS_VIP", ...)      a condition
 *     menus.addAction("KICK", ...)           an action
 *     menus.addRestriction("VIP", ...)       a restriction
 *     menus.addPlaceholder("hp", ...)        a placeholder
 *     menus.addConditionFilter("X", ...)     a filter over a condition
 *     menus.create("SHOP", ...)              a menu - SHOW_SHOP opens it
 *     shop.addPlaceholder("hp", ...)         a placeholder of the menu SHOP
 *
 * `menus` is Menu Core auto-imported (a plugin writes no import line), or
 * whatever name @amxts/menu-core is imported under; named imports
 * (`import { addCondition } from "@amxts/menu-core"`) count too. Only a name
 * written as a string is read: `addCondition(name, ...)` is left out.
 */
import ts from "typescript";
import { Registration, RegistrationKind } from "./registry";
import { commentBefore, isModule } from "./ts-source";

const REGISTERS: Record<string, RegistrationKind> = {
	addCondition: "condition",
	addAction: "action",
	addRestriction: "restriction",
	addPlaceholder: "placeholder",
	addConditionFilter: "filter",
	create: "menu",
};

/** Methods distinctive enough to be read on anything: a module may pass Menu Core around under another name. */
const ANY_RECEIVER = new Set(["addCondition", "addAction", "addRestriction", "addConditionFilter"]);

/** A string argument: "X" or `X` without substitutions. */
function literal(node: ts.Expression | undefined) {
	if (node == null) return null;
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node;
	return null;
}

/** The statement a call is part of: where its JSDoc is written. */
function statementOf(node: ts.Node) {
	let at: ts.Node = node;
	while (at.parent != null && !ts.isSourceFile(at.parent) && !ts.isBlock(at.parent) && !ts.isModuleBlock(at.parent)) at = at.parent;
	return at;
}

export function scanTypeScript(file: string, text: string): Registration[] {
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const namespaces = new Set<string>();
	/** Local name to Menu Core's function name. */
	const named = new Map<string, string>();
	/** Functions this file declares: their JSDoc, for a registration that passes one. */
	const functions = new Map<string, ts.Node>();
	/** A variable given a menu: `const shop = menus.create("SHOP")`. */
	const menuVariables = new Map<string, string>();
	const found: Registration[] = [];
	const ownFile = /[\\/]menu-core[\\/]src[\\/]/.test(file);

	for (const statement of source.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
		if (!isModule(statement.moduleSpecifier.text, "menu-core")) continue;
		const bindings = statement.importClause?.namedBindings;
		if (bindings != null && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
		if (bindings != null && ts.isNamedImports(bindings)) {
			for (const element of bindings.elements) named.set(element.name.text, (element.propertyName ?? element.name).text);
		}
		if (statement.importClause?.name != null) namespaces.add(statement.importClause.name.text);
	}

	const add = (kind: RegistrationKind, call: ts.CallExpression, name: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral, via: string, menu?: string) => {
		const start = source.getLineAndCharacterOfPosition(name.getStart(source) + 1);
		let doc = commentBefore(text, statementOf(call).getFullStart());
		const handler = call.arguments[1];
		if (doc == null && handler != null && ts.isIdentifier(handler)) {
			const declared = functions.get(handler.text);
			if (declared != null) doc = commentBefore(text, statementOf(declared).getFullStart());
		}
		const registration: Registration = { kind, name: name.text, file, line: start.line, column: start.character, endColumn: start.character + name.text.length, language: "ts", via, doc };
		if (menu != null) registration.menu = menu;
		found.push(registration);
	};

	const visitDeclarations = (node: ts.Node) => {
		if (ts.isFunctionDeclaration(node) && node.name != null) functions.set(node.name.text, node);
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer != null) {
			const init = node.initializer;
			if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) functions.set(node.name.text, node);
			const menu = createdMenu(init);
			if (menu != null) menuVariables.set(node.name.text, menu);
		}
		ts.forEachChild(node, visitDeclarations);
	};

	/** `menus.create("SHOP")` / `menus.find("SHOP")`: the menu's name. */
	const createdMenu = (node: ts.Expression): string | null => {
		if (!ts.isCallExpression(node)) return null;
		const callee = node.expression;
		const name = literal(node.arguments[0]);
		if (name == null) return null;
		if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && (namespaces.has(callee.expression.text) || callee.expression.text == "menus")) {
			if (callee.name.text == "create" || callee.name.text == "find" || callee.name.text == "register") return name.text;
		}
		if (ts.isIdentifier(callee) && ["create", "find", "register"].includes(named.get(callee.text) ?? "")) return name.text;
		return null;
	};

	const visit = (node: ts.Node) => {
		if (ts.isCallExpression(node)) inspect(node);
		ts.forEachChild(node, visit);
	};

	const inspect = (call: ts.CallExpression) => {
		const callee = call.expression;
		const name = literal(call.arguments[0]);
		if (name == null) return;

		if (ts.isIdentifier(callee)) {
			const imported = named.get(callee.text);
			const method = imported ?? (ownFile ? callee.text : undefined);
			const kind = method != null ? REGISTERS[method] : undefined;
			if (kind != null) add(kind, call, name, `menus.${method}`);
			return;
		}

		if (!ts.isPropertyAccessExpression(callee)) return;
		const method = callee.name.text;
		const kind = REGISTERS[method];
		if (kind == null) return;
		const receiver = callee.expression;
		const isNamespace = ts.isIdentifier(receiver) && namespaces.has(receiver.text);
		const receiverText = receiver.getText(source);

		if (method == "create") {
			if (isNamespace || receiverText == "menus") add("menu", call, name, `${receiverText}.create`);
			return;
		}

		if (method == "addPlaceholder" && !isNamespace && receiverText != "menus") {
			// A menu's own placeholder: `shop.addPlaceholder()`, `menus.create("SHOP").addPlaceholder()`.
			if (receiverText == "this") return;
			const menu = ts.isIdentifier(receiver) ? menuVariables.get(receiver.text) : createdMenu(receiver);
			add("placeholder", call, name, "menu.addPlaceholder", menu ?? "");
			return;
		}

		if (isNamespace || receiverText == "menus" || ANY_RECEIVER.has(method)) add(kind, call, name, `menus.${method}`);
	};

	visitDeclarations(source);
	visit(source);
	return found;
}

/** `menus: { file: "...", fallback: "..." }` of an amxts.config.ts: the menu files it names - "menu" when it names none, as Menu Core's default. */
export function menuFilesOfConfig(text: string) {
	const source = ts.createSourceFile("amxts.config.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	let file = "menu";
	let fallback = "";

	const visit = (node: ts.Node) => {
		if (ts.isPropertyAssignment(node) && node.name.getText(source).replace(/["']/g, "") == "menus" && ts.isObjectLiteralExpression(node.initializer)) {
			for (const property of node.initializer.properties) {
				if (!ts.isPropertyAssignment(property)) continue;
				const key = property.name.getText(source).replace(/["']/g, "");
				const value = literal(property.initializer)?.text.trim() ?? "";
				if (key == "file" && value.length > 0) file = value;
				if (key == "fallback") fallback = value;
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return fallback.length > 0 && fallback != file ? [file, fallback] : [file];
}
