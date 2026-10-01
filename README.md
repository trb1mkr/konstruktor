# 🧩 Konstruktor

Браузер-конструктор. Является фреймворком + набором стандартных компонентов поверх Electron. Пользователь собирает браузер под себя. Окно вкладки (веб-страницы) — WebContentsView, весь окружающий интерфейс — кастомизируемые Vue SFC компоненты.  

## ℹ️ Общие сведения

**💻 Целевые платформы:** ПК (Windows, разработка и сборка через Electron).  
**🧰 Стек:** Electron 41, Vue 3, TypeScript, Vite, electron-vite.  
**📦 Ядро:** Пул WebContentsView с партициями `persist:konstruktor` и `incognito-mem`, прозрачные overlay-окна для меню и диалогов, локальные страницы `konstruktor://`.  
**💡 Идея:** Браузер для тех, кто устал адаптироваться под браузеры.  

## 🚀 Запуск

```sh
npm install
npm run dev
```

## 🧩 Кастомизация

Корневой layout — `src/renderer/App.vue`. Стандартные блоки лежат в `src/renderer/components/stdlib/` (`AddressBar`, `TabStrip`, `BookmarksBar`, `DropdownMenu`, `WindowControls`). Общее состояние вкладок хранится в `core/useTabs.ts`, отступы под WebContentsView считает `layoutEngine.ts`. Группы вкладок живут в `src/main/groupsStore.ts` и `src/main/groupsManager.ts`, рисуются через `TabGroupNode.vue`.  

## 📄 Документация

### 🗃️ Общая документация

- [📚 Правила документирования](./docs/DOCS.md)
- [🏗️ Архитектура](./docs/ARCHITECTURE.md)
- [🔀 Правила работы с git](./docs/GIT.md)
- [🔧 Troubleshooting](./docs/TROUBLESHOOTING.md)
- [🔄 План автообновления](./docs/UPDATE_PLAN.md)

### ✨ Документация по фичам и системам

Main:

- [🖥️ Окна и вкладки](./src/main/docs/WINDOWS_TABS.md)
- [💬 Оверлей-окна](./src/main/docs/OVERLAY.md)
- [ Поиск по странице](./src/main/docs/FIND.md)
- [🎨 Темы](./src/main/docs/THEMES.md)
- [💾 Хранилища](./src/main/docs/STORES.md)
- [🌐 Внутренние страницы](./src/main/docs/INTERNAL_PAGES.md)

Renderer:

- [🐚 Shell и layout](./src/renderer/docs/SHELL_LAYOUT.md)
- [🧠 Состояние shell](./src/renderer/docs/CORE_STATE.md)
- [🧩 Stdlib-компоненты](./src/renderer/docs/STDLIB.md)
- [💬 Overlay UI](./src/renderer/docs/OVERLAY_UI.md)

Мосты:

- [🔌 Мост shell](./src/preload/SHELL_BRIDGE.md)
- [🔌 Мост view](./src/view-preload/VIEW_BRIDGE.md)

