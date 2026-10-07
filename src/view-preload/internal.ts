// Preload для WebContentsView вкладок. У view нет своего preload через
// webPreferences (один на все view), поэтому регистрируем скрипт на сессию:
// ses.registerPreloadScript({ type: 'frame', ... }) выполняется в КАЖДОМ
// фрейме до загрузки документа. contextBridge доступен, require('electron')
// не нужен — мост строится штатно через ipcRenderer + exposeInMainWorld.
import { contextBridge, ipcRenderer } from 'electron'
import { installPipHover } from './pip'

// Кнопка PiP поверх HTML5-плееров: ставится в каждом фрейме, работает
// без бриджа — чистый DOM внутри изолированного мира прелоада.
installPipHover()

contextBridge.exposeInMainWorld('konstruktor', {
  historyList: (limit?: number) => ipcRenderer.invoke('history:list', limit),
  historySearch: (query?: string, limit?: number) =>
    ipcRenderer.invoke('history:search', query ?? '', limit),
  historyDelete: (url: string) => ipcRenderer.invoke('history:delete', url),
  historyClear: () => ipcRenderer.invoke('history:clear'),
  historyTimeline: (query?: string, limit?: number) =>
    ipcRenderer.invoke('history:timeline', query ?? '', limit),
  historyDeleteVisit: (url: string, at: number) =>
    ipcRenderer.invoke('history:delete-visit', url, at),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch: {
    searchEngine?: string
    homepage?: string
    devtools?: boolean
    dnsMode?: string
    dnsCustom?: string
    locale?: string
    animations?: boolean
    theme?: string
    roundedCorners?: boolean
    fullscreenMode?: string
    rememberBounds?: boolean
    rememberTabs?: boolean
    zoomMode?: string
    zoomSync?: boolean
  }) => ipcRenderer.invoke('settings:save', patch),
  getShortcuts: () => ipcRenderer.invoke('shortcuts:list'),
  addShortcut: (input: { name?: string; url: string }) =>
    ipcRenderer.invoke('shortcuts:add', input),
  removeShortcut: (url: string) => ipcRenderer.invoke('shortcuts:remove', url),
  downloadsList: (limit?: number) => ipcRenderer.invoke('downloads:list', limit),
  downloadsSearch: (query?: string, limit?: number) =>
    ipcRenderer.invoke('downloads:search', query ?? '', limit),
  downloadsRemove: (id: string) => ipcRenderer.invoke('downloads:remove', id),
  downloadsClear: () => ipcRenderer.invoke('downloads:clear'),
  downloadsOpen: (id: string) => ipcRenderer.invoke('downloads:open', id),
  downloadsIcon: (id: string) => ipcRenderer.invoke('downloads:icon', id)
})

// Клик по странице мимо открытого меню закрывает это меню: меню живёт
// в отдельном прозрачном окне поверх WebContentsView и клика по сайту
// не видит. Main закрывает ТОЛЬКО kind 'menu' — диалоги и панель поиска
// имеют свою логику закрытия и так не срабатывают.
//
// Ловим click, а не mousedown: mousedown, открывший меню, долетает до
// страницы уже после появления окна, и только что открытое меню
// закрывалось тем же кликом. К моменту click это другой момент времени.
//
// Только ЛКМ (button 0) — правый клик открывает меню, и его нельзя тут
// же гасить. Страница ничего не видит: preventDefault не вызываем,
// stopPropagation тоже. Метка источника уходит в лог main.
window.addEventListener(
  'click',
  (e: MouseEvent) => {
    if (e.button !== 0) return
    ipcRenderer.send('menu:dismiss-on-shell-click', 'view')
  },
  true
)
