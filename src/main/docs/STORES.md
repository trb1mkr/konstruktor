# 💾 Хранилища

Документ описывает JSON-хранилища main и Secure DNS: файлы, кэши, поведение инкогнито.

## 🧩 Файлы

Настройки лежат в `settings.json`, история в `history.json`, загрузки в `downloads.json`, плитки в `shortcuts.json`. Все файлы живут в userData. Каждый store держит кэш в памяти и пишет через debounce или по событию.

## ⚙️ Настройки

`settingsStore.ts` хранит поисковик, homepage, devtools, DNS, язык интерфейса (`locale`: `auto` | код из реестра LANGUAGES, дефолт `auto` — резолв и смена описаны в [I18N.md](../../shared/i18n/I18N.md)), анимации, тему, скругление, fullscreen, `rememberBounds`, `rememberTabs`, режим зума (`zoomMode`: origin/tab) и единый зум (`zoomSync`), геометрию и сессию вкладок. Чтение идет через `getSettings`, синхронное через `getSettingsSync`, запись через `saveSettings`.

```mermaid
flowchart LR
  UI[konstruktor://settings] -->|settings:save| Store[settingsStore]
  Store -->|settings:changed| Shell[shell]
  Store -->|applyThemeToViews| View[view]
  Cold[холодный старт] -->|readSettingsFileSync| Win[createWindow]
```

## 🕘 История и загрузки

`historyStore.ts` пишет визиты и метаданные, отдает ленту через `getTimeline`. `downloadsStore.ts` ведет прогресс через `will-download`. Инкогнито историю не пишет и не читает, загрузки читает общие.

## 🔒 Secure DNS

`dnsConfig.ts` маппит режим в DoH-сервер через `dnsServersFor` и ставит switches через `applySecureDns`. Применение идет при старте из сохраненных настроек, смена в UI требует рестарта.
