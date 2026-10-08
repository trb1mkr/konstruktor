// Внутренние страницы конструктора. Отдаются через konstruktor://start,
// history, settings и downloads без внешних ресурсов — работают офлайн.
// Рендерятся внутри WebContentsView как обычные вкладки.
//
// Каждая страница собирается функцией от языка: HTML запекается на
// запрос (а не при импорте модуля), статические строки переводятся t(),
// динамические внутри <script> — встроенным tr() из shared/i18n/pageRuntime.
//
// Состав: общий каркас — shell.ts, по одному файлу на страницу
// (startPage/historyPage/settingsPage/downloadsPage), хост — protocol.ts.
//
// ГРАНИЦА ФАЙЛА: только URL-константы и реэкспорт builder'ов —
// единственный вход для protocol.ts, tabsIpc, browserMenu и всех,
// кому нужен START_URL из windows/ и groups/. НОВАЯ внутренняя страница =
// новый build*Page в своём файле + хост в protocol.ts + URL здесь,
// и больше нигде. Сигнал к разделению: build*Page превышает ~150 строк
// — тогда её <script> уходит в отдельный модуль строкой в builder.
export const HISTORY_URL = 'konstruktor://history'
export const SETTINGS_URL = 'konstruktor://settings'
export const DOWNLOADS_URL = 'konstruktor://downloads'

export { START_URL, buildStartPage } from './startPage'
export { buildHistoryPage } from './historyPage'
export { buildSettingsPage } from './settingsPage'
export { buildDownloadsPage } from './downloadsPage'
