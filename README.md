<div align="center">

# amxts for VS Code

**English** | [Русский](README.ru.md)

</div>

Editor support for [amxts](https://amxts.github.io/): live hints and checks in the files of the official modules — Menu Core menus and Config Core configs — from the names and shapes your plugins declare.

## Features

### Menu Core menus

Open `menu.ini`, `menu.yaml` or `menu.json` and get, as you type:

- **Completion** of keys, and of the conditions, actions, restrictions and placeholders your plugins register — TypeScript, Pawn and installed modules — besides Menu Core's built-in ones (`IS_ALIVE`, `TEAM_CT`, `IS_ADMIN`, `SHOW_<MENU>` …). A name added in a plugin is offered at once, before the plugin is saved.
- **Checks in Menu Core's own words**: an unknown key, a value of the wrong kind, a name nothing registers, a name listed twice or beside its opposite — with "did you mean" and a quick fix.
- **Hover** with where a name is registered and its doc comment; what a key or an INI column is.
- **Go to definition** from a name to its registration, from `SHOW_SHOP` to the menu; **Find all references** from a menu file or from the registration.

```ts
// plugins/vip.ts
menus.addCondition("MY_VIP", player => player.access.includes("LevelH"));
```

```yaml
# configs/menu.yaml
menus:
  MAIN_MENU:
    title: Main
    items:
      - name: VIP zone
        enabled: MY_|            # completion: MY_VIP - condition, plugins/vip.ts:2
        action: SHOW_VIP_MENUU   # warning: SHOW_VIP_MENUU opens the menu "VIP_MENUU", which is not there - did you mean "VIP_MENU"?
```

### Config Core configs

A file a plugin reads with `configs.load("settings", defaults)` — `settings.ini`, `.yaml`, `.yml`, `.json` or `.jsonc` — follows the defaults and the interface in the plugin:

- **Completion** of keys, `true`/`false`, and the members of a string union.
- **Checks in Config Core's own words**: an unknown key, a value of the wrong kind, a value outside a union.
- **Hover** with the field's type, doc comment and default; **go to definition** to the field in the code. Edit the interface and the file's hints follow.

```ts
// plugins/myplugin.ts
interface Settings {
	/** How the round is played. */
	mode: "normal" | "dm";
	rounds: number;
}
const settings = configs.load<Settings>("myplugin/settings", { mode: "normal", rounds: 10 });
```

```yaml
# configs/myplugin/settings.yaml
mode: dmm      # warning: "mode" is "dmm", not one of "normal", "dm" - did you mean "dm"? - the default stays
rounds: ten    # warning: "rounds" is text ("ten"), not a number - the default stays
```

## Requirements

- An amxts project: a folder with `amxts.config.ts`.
- [Menu Core](https://github.com/amxts/menu-core) or [Config Core](https://github.com/amxts/config-core) installed in it.
- For the schema of YAML menu files, the [YAML extension](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml) by Red Hat; the checks and completion work without it.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `amxts.menus.files` | `[]` | More menu files, besides the one `amxts.config.ts` names: `"shop"` or `"shop.yaml"`. |
| `amxts.menus.detectByContent` | `true` | Treat a file as a menu file when it looks like one. |
| `amxts.diagnostics.unknownNames` | `true` | Warn of names nothing in the workspace registers. |
| `amxts.index.excludeFolders` | `.git`, `node_modules`, `dist`, `.amxts`, `test`, `tests` | Folders not searched for registrations and `configs.load` calls. |

After `npm install`, run **amxts: Re-read the names the workspace registers**.

## Limitations

- Only names registered in the workspace are known. A Pawn plugin that is only on the server is not, so an unknown name is a warning, not an error; Menu Core checks the names again on the server.
- Only names and config names written as a string literal are read: `menus.addAction(name, …)`, `configs.load(file, …)` or a Pawn `#define` is not.
- A config's shape is read from the type argument or the defaults; a field of a type the build does not accept is not checked.

## License

[MIT](LICENSE)
