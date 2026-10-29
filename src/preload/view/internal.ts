// Preload для WebContentsView вкладок. У view нет своего preload через
// webPreferences (один на все view), поэтому регистрируем скрипт на сессию:
// ses.registerPreloadScript({ type: 'frame', ... }) выполняется в КАЖДОМ
// фрейме до загрузки документа. contextBridge доступен, require('electron')
// не нужен — мост строится штатно через ipcRenderer + exposeInMainWorld.
import { contextBridge, ipcRenderer } from 'electron'
import { installPipHover } from './pip'
import type { ExtensionsState } from '../../shared/extensions-types'

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
  // Захват сочетаний на время редактирования горячих клавиш: пока поле в
  // фокусе, браузерные сочетания молчат (см. src/main/hotkeys.ts).
  setHotkeyCapture: (on: boolean) => ipcRenderer.invoke('hotkeys:capture', on),
  // Тема внутренней страницы, разрешенная в main (см. THEMES.md).
  // Не matchMedia: базовая тема веб-контента может перекрывать
  // nativeTheme.themeSource, и медиазапрос вернул бы схему сайтов.
  pageTheme: (): Promise<string> => ipcRenderer.invoke('theme:page'),
  saveSettings: (patch: {
    searchEngine?: string
    homepage?: string
    devtools?: boolean
    dnsMode?: string
    dnsCustom?: string
    locale?: string
    animations?: boolean
    theme?: string
    webContentTheme?: string
    roundedCorners?: boolean
    fullscreenMode?: string
    rememberBounds?: boolean
    rememberTabs?: boolean
    zoomMode?: string
    zoomSync?: boolean
    menuShowIcons?: boolean
    menuShowText?: boolean
    menuShowHotkeys?: boolean
    menuHotkeysOnHover?: boolean
    hotkeys?: Record<string, string>
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
  downloadsIcon: (id: string) => ipcRenderer.invoke('downloads:icon', id),
  // Расширения: страница konstruktor://extensions работает только через них.
  extensionsList: (): Promise<ExtensionsState> => ipcRenderer.invoke('extensions:list'),
  extensionsInstallFolder: () => ipcRenderer.invoke('extensions:install-folder'),
  extensionsInstallArchive: () => ipcRenderer.invoke('extensions:install-archive'),
  extensionsInstallPath: (path: string) => ipcRenderer.invoke('extensions:install-path', path),
  extensionsEnable: (id: string) => ipcRenderer.invoke('extensions:enable', id),
  extensionsDisable: (id: string) => ipcRenderer.invoke('extensions:disable', id),
  extensionsRemove: (id: string) => ipcRenderer.invoke('extensions:remove', id),
  extensionsReload: (id: string) => ipcRenderer.invoke('extensions:reload', id),
  extensionsOpenFolder: (id: string) => ipcRenderer.invoke('extensions:open-folder', id),
  extensionsSetEnabled: (on: boolean): Promise<ExtensionsState> =>
    ipcRenderer.invoke('extensions:set-enabled', on),
  extensionsSetDevMode: (on: boolean): Promise<ExtensionsState> =>
    ipcRenderer.invoke('extensions:set-dev-mode', on),
  extensionsCheckUpdates: () => ipcRenderer.invoke('extensions:check-updates'),
  onExtensionsChanged: (cb: (state: ExtensionsState) => void): (() => void) => {
    const listener = (_e: unknown, state: ExtensionsState): void => cb(state)
    ipcRenderer.on('extensions:state', listener as never)
    return () => ipcRenderer.removeListener('extensions:state', listener as never)
  },
  // Разрешения сайтов: страница konstruktor://settings читает решения и
  // сбрасывает их. Промпт разрешения открывает main — страницы его не
  // касаются.
  permissionsList: () => ipcRenderer.invoke('permissions:list'),
  permissionsClearOrigin: (origin: string) =>
    ipcRenderer.invoke('permissions:clear-origin', origin),
  // Снятие ОДНОЙ области: остальные решения сайта остаются, и промпт
  // вернётся только для снятой области.
  permissionsClearScope: (origin: string, scope: string) =>
    ipcRenderer.invoke('permissions:clear-scope', origin, scope),
  permissionsClearAll: () => ipcRenderer.invoke('permissions:clear-all'),
  // Рабочие пространства: страница konstruktor://workspaces управляет
  // всеми пространствами сразу, поэтому в вызовах — id, а не сессия.
  workspacesList: () => ipcRenderer.invoke('workspaces:list'),
  workspacesCreate: (input: {
    name?: string
    icon?: string
    color?: string
    copyFrom?: string
    sections?: string[]
  }) => ipcRenderer.invoke('workspaces:create', input),
  workspacesUpdate: (input: { id: string; name?: string; icon?: string; color?: string }) =>
    ipcRenderer.invoke('workspaces:update', input),
  workspacesDuplicate: (id: string, name?: string) =>
    ipcRenderer.invoke('workspaces:duplicate', { id, name }),
  workspacesDelete: (id: string) => ipcRenderer.invoke('workspaces:delete', id),
  workspacesOpen: (id: string) => ipcRenderer.invoke('workspaces:open', id)
})

// Отчёт страницы о захвате медиа.
//
// Обёртка на mediaDevices (её кладёт main в ГЛАВНЫЙ мир страницы, см.
// permissions/captureIndicator.ts) шлёт window.postMessage — из главного
// мира другого канала нет. DOM-событие видят все миры документа, поэтому
// изолированный мир прелоада его получает и пересылает в main.
//
// Проверяем метку и вид: без этого любое сообщение страницы становилось
// бы отчётом о захвате.
window.addEventListener('message', (e: MessageEvent) => {
  const data = e.data as { __konstruktorCapture?: boolean; kind?: string; active?: boolean } | null
  if (!data || data.__konstruktorCapture !== true) return
  if (data.kind !== 'audio' && data.kind !== 'video' && data.kind !== 'screen') return
  ipcRenderer.send('permissions:capture', data.kind, data.active === true)
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
