# 🔧 Troubleshooting

Документ собирает выясненные нюансы для разработчиков: при повторном столкновении смотреть сюда, а не дебажить заново.

## 🪟 WebContentsView вне DOM

View — нативный слой вне DOM: поверх сайта ничего не нарисовать из renderer. Меню, диалоги, поиск — только отдельными прозрачными окнами (`overlayManager.ts`). `z-index` и CSS поверх view не работают никогда.

## 🖱️ Правый клик на drag-области

На `-webkit-app-region: drag` Windows отдает ПКМ системному меню окна, renderer его не видит. `strip-filler` теперь `drag` (тащит окно), но `@contextmenu.prevent` на нём работает — меню панели открывается на всей пустой области.

## 🖼️ Рамка через inset-тень

`border` растит высоту узла на 2px: каждая вложенная группа сдвигала адресную строку вниз. Обводка групп и вкладок — только `box-shadow: inset`, она не влияет на layout.

## 🧲 Липкий токен DnD

Цель при dragover сдвигается вправо на ширину перетаскиваемого — курсор оказывается над зазором/соседом. Переключать токен в этот момент нельзя: начинается цикл прыгания. Dragover над самим перетаскиваемым токен не меняет, дроп идет по липкому токену (`useStripDrag.ts`). Плейсхолдер `.drop-gap` — отдельный прозрачный элемент перед целью, держит место в layout.

## 🧩 Единый ряд stripOrder

Инвариант: корневой элемент = ровно один токен `t:<id>`/`g:<instanceId>` в ровно одной зоне. `createTab` кладет токен вкладки, уход в группу его убирает. Забытый токен = невидимая группа (баг `New Group` со stray `t:`). Проверка — `checkStripInvariant` в `stripOrder.ts`.

## 🎭 Scoped-стили не пробиваются

`.tab` из `TabStrip.vue` не виден в `TabGroupNode.vue`: дублировать через `tabShared.ts`/`tabShared.css`, иначе чинить hover/shrink в двух местах.

## 😀 Emoji с префиксом

Голый emoji в `icon`/`favicon` ломает `<img>`: хранить как `emoji:...`, рисовать текстом (`faviconIsEmoji`/`groupIconText`). Кнопка URL голый emoji отклоняет (`verifyEmojiButton`).

## ⚪ Белый флеш view

Дефолтный фон view `#FFF` вспыхивает до первой отрисовки. Красить сразу через `viewBackgroundFor` + `setBackgroundColor` при создании и при смене темы.

## ⌨️ Ctrl+F и раскладка

`input.key` зависит от раскладки (русская `а` = `KeyF`): проверять `input.code === 'KeyF'`. `before-input-event` не стреляет при фокусе в omnibox/devtools — дублировать через `win.webContents.on('before-input-event')`.

## 📦 ESM-прелоад и sandbox

При `"type": "module"` прелоад собирается в `.mjs`/`.cjs`: нужен `sandbox: false`, иначе `window.browserAPI` молча `undefined`. CJS-билд лежит рядом (`index.cjs`).

## 🌐 Кастомная схема до ready

`protocol.registerSchemesAsPrivileged` для `konstruktor://` — строго до `app.ready`, иначе view схему не рендерит. Хендл регистрировать на всех трех сессиях (default + обе партиции).

## 🕵️ Detach до did-finish-load

Новое окно при detach создавать первым и класть вкладку в `tabOrder` сразу: иначе `did-finish-load` создаст лишнюю стартовую, а `pushTabsState` уйдет в пустоту.

## 💾 Кэш настроек пуст на старте

`getSettingsSync()` до первого `load()` возвращает дефолты. Геометрия/сессия первого окна читаются синхронно с диска (`readSettingsFileSync`), иначе окно стартует не с тех bounds.

## 🐞 GitHub и дефолтный UA

Часть CDN отдает `ERR_CONNECTION_CLOSED` на дефолтном UA Electron: повтор с Chrome-UA чинит handshake (`did-fail-load` в `tabsManager.ts`).

## 📜 История без дублей

`page-title-updated`/`page-favicon-updated` — только `updateMetadata`, новый визит не засчитывать, иначе один заход = ×2 в истории.
