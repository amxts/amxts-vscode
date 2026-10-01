# Contributing

## Build and test

```bash
npm install
npm test                   # builds dist/extension.js, then bun test
npm run typecheck
npm run lint               # oxlint, and oxfmt --check on JSON and YAML
npm run lint:fix           # fixes what they can: formatting and the fixable rules
npm run package            # amxts-vscode-<version>.vsix
```

Press F5 in VS Code with this folder open to run the extension in a new window (`.vscode/launch.json`).

Install a build with `code --install-extension amxts-vscode-<version>.vsix`, or **Extensions** → `…` → **Install from VSIX…**.

## Layout

- `src/core/` knows menu files and registrations without VS Code: parsers, checks, completion, hover. Tested with `bun test` on the fixture workspace in `test/fixtures/`.
- `src/extension.ts` wires it to the editor; `test/smoke.test.ts` activates the bundled extension against a stand-in for the `vscode` module.

Kept in step with the modules:

- the key sets in `src/core/shape.ts` are Menu Core's - `test/shape.test.ts` compares them with `../amxts-modules/menu-core/src` when it is there;
- `src/vendor/config-core/` is Config Core's YAML and JSON reader, copied by `bun scripts/vendor.ts` - the tests compare it with `../amxts-modules/config-core/src`;
- `schemas/menu.schema.json` is made from the key sets by `bun scripts/schema.ts`; a test fails when it is behind.

## Where names come from

- **TypeScript**, read with the TypeScript parser on every keystroke of an open file, and from disk for the others: `addCondition`, `addAction`, `addRestriction`, `addPlaceholder`, `addConditionFilter` and `create` of `@amxts/menu-core` - on `menus`, the name a plugin uses it by without an import, or under whatever name it is imported; a menu object's `addPlaceholder` (followed within the file).
- **Installed modules**: `node_modules/@amxts/*/src`.
- **Pawn** (`*.sma`): `mc_register_condition`, `mc_register_action`, `mc_register_restriction`, `mc_register_placeholder`, `mc_register_condition_filter`, `mc_create_menu`.
- **Built in**, as Menu Core has them.

## Which files are menu files

1. The file `amxts.config.ts` names - `menus: { file, fallback }`, `"menu"` by default: any `.ini`, `.yaml`, `.yml`, `.json` or `.jsonc` whose path ends with that name.
2. The names in `amxts.menus.files`, the same way.
3. With `amxts.menus.detectByContent`, a file that looks like one: an INI `[SECTION]` with `TITLE` and `ITEMS`, `FIXED_ITEMS` or `VIEW`; YAML or JSON with a top-level `menus` key.

At most 5000 files of a kind are read per workspace folder. YAML completion follows indentation: a flow mapping or list spread over several lines is not followed.

## Config files

`src/core/config-scan.ts` finds `configs.load(name, defaults)` of `@amxts/config-core` (a namespace import, or `load` under any alias) and reads the shape the way the build's typed-configs transform does: the type argument, else the defaults' declared type, else the defaults literal. `src/core/config-check.ts` matches a file by the end of its path (`myplugin/settings` → `…/myplugin/settings.yaml`; with an extension, only that file), maps INI as Config Core does (a `[section]` is a top-level key) and checks it in Config Core's words; `src/core/config-features.ts` gives completion, hover and definition. Tests: `test/config.test.ts`.

## Dependencies

Bundled into one file by esbuild; nothing else ships.

| Package | Why |
| --- | --- |
| `typescript` | Reads plugins with the TypeScript parser (`createSourceFile`, no type checking). VS Code's own copy is not available to extensions. Pinned to 6.0, the last version with the JavaScript compiler API. |
| `yaml` | A tolerant YAML parser with offsets: a half-written file still has its keys and values. Config Core's reader stops at the first error and keeps no end positions. |
| `jsonc-parser` | The same for JSON with comments - the parser VS Code itself uses - plus `getLocation` for completion. |

Development only: `esbuild`, `@vscode/vsce`, `@types/vscode`, `@types/node`, `@types/bun`; `oxlint` and `oxfmt` with the ESLint plugins `.oxlintrc.json` runs (`@stylistic/eslint-plugin` and the rest of `@antfu/eslint-config`'s).
