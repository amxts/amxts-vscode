<div align="center">

# amxts для VS Code

[English](README.md) | **Русский**

</div>

Поддержка [amxts](https://amxts.github.io/) в редакторе: подсказки и проверки прямо при наборе в файлах официальных модулей — меню Menu Core и конфигах Config Core — по именам и формам, которые объявляют ваши плагины.

## Возможности

### Меню Menu Core

Откройте `menu.ini`, `menu.yaml` или `menu.json` — и при наборе получите:

- **Автодополнение** ключей, а также условий, действий, ограничений и подстановок, которые регистрируют ваши плагины, — TypeScript, Pawn и установленные модули, — и встроенных в Menu Core (`IS_ALIVE`, `TEAM_CT`, `IS_ADMIN`, `SHOW_<MENU>` …). Имя, добавленное в плагине, предлагается сразу, ещё до сохранения плагина.
- **Проверки словами самого Menu Core**: незнакомый ключ, значение не того вида, имя, которое никто не регистрирует, имя дважды или рядом с противоположным, — с «did you mean» и быстрым исправлением.
- **Подсказку при наведении**: где имя зарегистрировано и его комментарий; что это за ключ или столбец INI.
- **Переход к определению** с имени к его регистрации, с `SHOW_SHOP` к меню; **поиск всех ссылок** из файла меню или от регистрации.

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
        enabled: MY_|            # подсказка: MY_VIP - condition, plugins/vip.ts:2
        action: SHOW_VIP_MENUU   # предупреждение: SHOW_VIP_MENUU opens the menu "VIP_MENUU", which is not there - did you mean "VIP_MENU"?
```

### Конфиги Config Core

Файл, который плагин читает через `configs.load("settings", defaults)`, — `settings.ini`, `.yaml`, `.yml`, `.json` или `.jsonc` — следует умолчаниям и интерфейсу в плагине:

- **Автодополнение** ключей, `true`/`false` и членов строкового объединения.
- **Проверки словами самого Config Core**: незнакомый ключ, значение не того вида, значение вне объединения.
- **Подсказку при наведении** с типом поля, его комментарием и умолчанием; **переход к определению** — к полю в коде. Поменяйте интерфейс — подсказки файла последуют за ним.

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
mode: dmm      # предупреждение: "mode" is "dmm", not one of "normal", "dm" - did you mean "dm"? - the default stays
rounds: ten    # предупреждение: "rounds" is text ("ten"), not a number - the default stays
```

## Требования

- Проект amxts: папка с `amxts.config.ts`.
- Установленный в нём [Menu Core](https://github.com/amxts/menu-core) или [Config Core](https://github.com/amxts/config-core).
- Для схемы в файлах меню YAML — [YAML-расширение](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml) Red Hat; проверки и автодополнение работают и без него.

## Настройки

| Настройка | По умолчанию | Что делает |
| --- | --- | --- |
| `amxts.menus.files` | `[]` | Ещё файлы меню, кроме того, что называет `amxts.config.ts`: `"shop"` или `"shop.yaml"`. |
| `amxts.menus.detectByContent` | `true` | Считать файл файлом меню, если он похож на него. |
| `amxts.diagnostics.unknownNames` | `true` | Предупреждать об именах, которые никто в рабочей области не регистрирует. |
| `amxts.index.excludeFolders` | `.git`, `node_modules`, `dist`, `.amxts`, `test`, `tests` | Папки, где не ищутся регистрации и вызовы `configs.load`. |

После `npm install` выполните **amxts: Re-read the names the workspace registers**.

## Ограничения

- Известны только имена, зарегистрированные в рабочей области. Pawn-плагина, который есть только на сервере, расширение не видит, поэтому незнакомое имя — предупреждение, а не ошибка; Menu Core проверяет имена ещё раз на сервере.
- Читаются только имена и имена конфигов, записанные строкой: `menus.addAction(name, …)`, `configs.load(file, …)` или `#define` в Pawn — нет.
- Форма конфига читается из аргумента типа или умолчаний; поле типа, который сборка не принимает, не проверяется.

## Лицензия

[MIT](LICENSE)
