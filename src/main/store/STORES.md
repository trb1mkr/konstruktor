# 💾 Хранилища

Документ описывает JSON-хранилища main и Secure DNS: файлы, кэши, поведение инкогнито.

## 🧩 Файлы

Настройки лежат в `settings.json`, история в `history.json`, загрузки в `downloads.json`, плитки в `shortcuts.json`. Все файлы живут в userData. Каждый store держит кэш в памяти и пишет через debounce или по событию. Каналы `history:*` / `downloads:*` / `settings:*` / `shortcuts:*` сводит `ipc.ts`.

## ⚙️ Настройки

`settingsStore.ts` хранит поисковик, homepage, devtools, DNS, язык интерфейса (`locale`: `auto` | код из реестра LANGUAGES, дефолт `auto` — резолв и смена описаны в [I18N.md](../../shared/i18n/I18N.md)), анимации, тему, скругление, fullscreen, `rememberBounds`, `rememberTabs`, режим зума (`zoomMode`: origin/tab) и единый зум (`zoomSync`), видимость частей пункта меню (`menuShowIcons`, `menuShowText`, `menuShowHotkeys`, `menuHotkeysOnHover`), переопределения горячих клавиш (`hotkeys`: разреженная карта «действие -> акселератор», см. [TABS.md](../tabs/TABS.md) «Горячие клавиши»), геометрию и сессию вкладок.

Инвариант «включена хотя бы одна идентифицирующая часть — иконка или текст» держит `normalizeMenuParts` внутри `saveSettings`/`saveSettingsSync`: если иконка и текст выключены разом, возвращается текст. Хоткей в инвариант НЕ входит — он не идентифицирует пункт, а лишь подсказывает сочетание клавиш, поэтому его можно выключать в любом сочетании. Проверка в хранилище, а не только в форме, потому что значение меняют и другие входы (`settings:save`), и молча сохранённый безымянный пункт неотличим от разделителя.

Сочетания горячих клавиш отбирает `normalizeHotkeys` (там же, в `saveSettings`/`saveSettingsSync`): неизвестные действия, нераспознаваемые сочетания, одиночные печатные клавиши без модификатора и дубликаты отбрасываются — действие остаётся на значении по умолчанию. Пустая строка — не мусор, а состояние «сочетание снято» (Backspace в таблице настроек): ключ остаётся с пустым значением, и действие перестаёт перехватывать клавишу. Отсутствие ключа отличается от пустого значения: там действует дефолт. Доверять форме настроек нельзя: тот же `settings:save` доступен из любого окна.

Чтение идет через `getSettings`, синхронное через `getSettingsSync`; запись — `saveSettings`, синхронная запись — `saveSettingsSync` (её требует хук `close` окна: асинхронный `writeFile` не доживает до выхода процесса).

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

## 🛠️ Проблемы и решения

### 📜 История без дублей

`page-title-updated`/`page-favicon-updated` — только `updateMetadata`, новый визит не засчитывать, иначе один заход = ×2 в истории.

### 💾 Кэш настроек пуст на старте

`getSettingsSync()` до первого `load()` возвращает дефолты. Геометрия/сессия первого окна читаются синхронно с диска (`readSettingsFileSync`), иначе окно стартует не с тех bounds.
