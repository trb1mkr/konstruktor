import { contextBridge, ipcRenderer } from 'electron'

// Типы публичного API браузера для renderer (Vue SFC).
export interface TabInfo {
  id: number
  url: string
  title: string
  pinned: boolean
  favicon: string
  groupId?: string
}

export interface OpenGroupInfo {
  instanceId: string
  savedId: string
  collapsed: boolean
  pinned: boolean
  parentInstanceId?: string
}

export interface SavedGroupInfo {
  id: string
  name: string
  icon: string
  color: string
  urls: string[]
  children: string[]
  pinned: boolean
}

export interface TabsState {
  tabs: TabInfo[]
  activeTabId: number | null
  incognito: boolean
  openGroups: OpenGroupInfo[]
  // Единый порядок панели: 't:<id>' вкладка, 'g:<instanceId>' группа.
  stripOrder: string[]
  pinnedStripOrder: string[]
}

export interface UiInsets {
  top: number
  bottom: number
  left: number
  right: number
}

const browserAPI = {
  createTab: (url?: string): Promise<number> => ipcRenderer.invoke('tabs:create', url),
  closeTab: (id: number): Promise<boolean> => ipcRenderer.invoke('tabs:close', id),
  activateTab: (id: number): Promise<boolean> => ipcRenderer.invoke('tabs:activate', id),
  listTabs: (): Promise<TabsState> => ipcRenderer.invoke('tabs:list'),
  navigate: (id: number, url: string): Promise<boolean> =>
    ipcRenderer.invoke('tabs:navigate', id, url),
  goBack: (): Promise<boolean> => ipcRenderer.invoke('tabs:back'),
  goForward: (): Promise<boolean> => ipcRenderer.invoke('tabs:forward'),
  reload: (): Promise<boolean> => ipcRenderer.invoke('tabs:reload'),
  // Новый порядок после DnD в панели.
  reorderTabs: (order: number[]): Promise<boolean> => ipcRenderer.invoke('tabs:reorder', order),
  // Единый ряд: токены 't:<id>'/'g:<instanceId>' — вкладки и группы одного ранга.
  reorderStrip: (order: string[]): Promise<boolean> => ipcRenderer.invoke('tabs:reorder', order),
  pinTab: (id: number, pinned: boolean): Promise<boolean> =>
    ipcRenderer.invoke('tabs:pin', id, pinned),
  duplicateTab: (id: number): Promise<number> => ipcRenderer.invoke('tabs:duplicate', id),
  renameTab: (id: number, title: string): Promise<boolean> =>
    ipcRenderer.invoke('tabs:rename', id, title),
  setTabIcon: (id: number, icon: string): Promise<boolean> =>
    ipcRenderer.invoke('tabs:set-icon', id, icon),
  // Контекстное меню вкладки: точка клика относительно content-области окна.
  // rename/set-icon выбираются в меню, а значения спрашивает renderer-диалог.
  tabContextMenu: (id: number, pos: { x: number; y: number }): void =>
    ipcRenderer.send('tabs:context-menu', { id, ...pos }),
  // Контекстное меню самой панели вкладок (мимо вкладок):
  // создать вкладку, закрыть все.
  tabStripContextMenu: (pos: { x: number; y: number }): void =>
    ipcRenderer.send('tabs:strip-context-menu', pos),
  // Группы вкладок: шаблоны в groups.json + открытые экземпляры.
  listGroups: (): Promise<SavedGroupInfo[]> => ipcRenderer.invoke('groups:list'),
  createGroup: (input?: { name?: string; icon?: string; color?: string; pinned?: boolean }): Promise<{ saved: SavedGroupInfo; instanceId: string }> =>
    ipcRenderer.invoke('groups:create', input ?? {}),
  openGroup: (savedId: string): Promise<string> => ipcRenderer.invoke('groups:open', savedId),
  renameGroup: (savedId: string, name: string): Promise<SavedGroupInfo | null> =>
    ipcRenderer.invoke('groups:rename', savedId, name),
  setGroupColor: (savedId: string, color: string): Promise<SavedGroupInfo | null> =>
    ipcRenderer.invoke('groups:set-color', savedId, color),
  setGroupIcon: (savedId: string, icon: string): Promise<SavedGroupInfo | null> =>
    ipcRenderer.invoke('groups:set-icon', savedId, icon),
  deleteGroup: (savedId: string): Promise<boolean> => ipcRenderer.invoke('groups:delete', savedId),
  toggleGroupCollapse: (instanceId: string): Promise<boolean> =>
    ipcRenderer.invoke('groups:toggle-collapse', instanceId),
  toggleGroupPin: (instanceId: string): Promise<boolean> =>
    ipcRenderer.invoke('groups:toggle-pin', instanceId),
  toggleGroupBookmarkPin: (savedId: string): Promise<SavedGroupInfo | null> =>
    ipcRenderer.invoke('groups:toggle-bookmark-pin', savedId),
  nestGroup: (childSavedId: string, parentSavedId: string): Promise<SavedGroupInfo | null> =>
    ipcRenderer.invoke('groups:nest', childSavedId, parentSavedId),
  unnestGroup: (childSavedId: string, parentSavedId: string): Promise<SavedGroupInfo | null> =>
    ipcRenderer.invoke('groups:unnest', childSavedId, parentSavedId),
  addTabToGroup: (tabId: number, instanceId: string): Promise<boolean> =>
    ipcRenderer.invoke('groups:add-tab', tabId, instanceId),
  removeTabFromGroup: (tabId: number): Promise<boolean> =>
    ipcRenderer.invoke('groups:remove-tab', tabId),
  ungroup: (instanceId: string): Promise<boolean> => ipcRenderer.invoke('groups:ungroup', instanceId),
  closeGroupTabs: (instanceId: string): Promise<boolean> =>
    ipcRenderer.invoke('groups:close-tabs', instanceId),
  moveGroupTabs: (fromInstance: string, toInstance: string): Promise<boolean> =>
    ipcRenderer.invoke('groups:move-tabs', fromInstance, toInstance),
  groupContextMenu: (instanceId: string, pos: { x: number; y: number }): void =>
    ipcRenderer.send('groups:context-menu', { instanceId, ...pos }),
  // Вынос вкладки за окно — новое окно браузера с этой вкладкой.
  detachTab: (id: number, pos: { x: number; y: number }): Promise<boolean> =>
    ipcRenderer.invoke('tabs:detach', id, pos),
  // Втягивание чужой вкладки в это окно (слияние окон).
  attachTab: (id: number): Promise<boolean> => ipcRenderer.invoke('tabs:attach', id),
  // Новое инкогнито-окно (in-memory партиция).
  openIncognito: (): Promise<number | null> => ipcRenderer.invoke('window:incognito'),
  // Кнопки кастомного заголовка окна.
  minimizeWindow: (): Promise<boolean> => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke('window:toggle-maximize'),
  closeWindow: (): Promise<boolean> => ipcRenderer.invoke('window:close'),
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:is-maximized'),
  // F11 из фокуса shell: тоггл fullscreen через main.
  toggleFullscreen: (): Promise<boolean> => ipcRenderer.invoke('window:toggle-fullscreen'),
  // Ручное перетаскивание окна (вместо -webkit-app-region: drag).
  //
  // Координаты курсора — экранные (screenX/screenY), потому что окно
  // двигается по экрану. clientX/Y не годятся: они отсчитываются от
  // области содержимого, а при перетаскивании это разные координаты.
  startWindowDrag: (pos: { x: number; y: number }): boolean =>
    ipcRenderer.sendSync('window:drag-start', pos.x, pos.y),
  moveWindowDrag: (pos: { x: number; y: number }): void =>
    ipcRenderer.send('window:drag-move', pos.x, pos.y),
  endWindowDrag: (): void => ipcRenderer.send('window:drag-end'),
  // Своё меню окна: ПКМ по кнопкам навигации (свернуть/развернуть/закрыть).
  windowContextMenu: (pos: { x: number; y: number }): void =>
    ipcRenderer.send('window:context-menu', pos),
  // Внутренние страницы.
  openHistory: (): Promise<boolean> => ipcRenderer.invoke('tabs:open-history'),
  openSettings: (): Promise<boolean> => ipcRenderer.invoke('tabs:open-settings'),
  openDownloads: (): Promise<boolean> => ipcRenderer.invoke('tabs:open-downloads'),
  // Сообщить main отступы UI, чтобы WebContentsView занял остаток окна.
  updateLayout: (insets: Partial<UiInsets>): void =>
    ipcRenderer.send('layout:update', insets),
  // Нативное меню поверх всего (WebContentsView перекрывает DOM-оверлеи).
  // anchor: координаты правого нижнего угла кнопки относительно
  // content-области окна — меню открывается вниз из одной точки.
  popupMenu: (anchor: { x: number; y: number }): void =>
    ipcRenderer.send('menu:popup', anchor),
  // Клик по shell в стороне от открытого меню. Меню живёт в отдельном
  // окне, поэтому клик по вкладке/адресной строке/панели его не гасит.
  // Renderer ловит click на document и сообщает сюда; main закрывает
  // активный оверлей ТОЛЬКО если он меню — диалоги и панель поиска
  // так закрывать нельзя, они живут своей логикой.
  // Метка источника уходит в лог main: по ней видно, эхо это или нет.
  dismissMenuOnShellClick: (): void =>
    ipcRenderer.send('menu:dismiss-on-shell-click', 'shell'),
  // Тосты поверх сайта (оверлей-окно, темная тема).
  notify: (toast: { title: string; body?: string; timeout?: number }): Promise<boolean> =>
    ipcRenderer.invoke('overlay:notify', toast),
  // Поиск по странице: открыть панель (Ctrl+F из shell тоже сюда).
  openFind: (query?: string): Promise<boolean> => ipcRenderer.invoke('find:open', query),
  // Настройки shell: тема и прочее без перезагрузки внутренних страниц.
  getSettings: () => ipcRenderer.invoke('settings:get'),
  onSettingsChanged: (cb: () => void): (() => void) => {
    const listener = () => cb()
    ipcRenderer.on('settings:changed', listener as never)
    return () => ipcRenderer.removeListener('settings:changed', listener as never)
  },
  onTabsState: (cb: (state: TabsState) => void): (() => void) => {
    const listener = (_e: unknown, state: TabsState) => cb(state)
    ipcRenderer.on('tabs:state', listener as never)
    return () => ipcRenderer.removeListener('tabs:state', listener as never)
  },
  // Моментальная синхронизация шаблонов групп: main шлет свежий
  // список после каждой мутации store, shell не ждет tabs:state.
  onGroupsChanged: (cb: (groups: SavedGroupInfo[]) => void): (() => void) => {
    const listener = (_e: unknown, groups: SavedGroupInfo[]) => cb(groups)
    ipcRenderer.on('groups:changed', listener as never)
    return () => ipcRenderer.removeListener('groups:changed', listener as never)
  },
  onNavigated: (cb: (info: { id: number; url: string }) => void): (() => void) => {
    const listener = (_e: unknown, info: { id: number; url: string }) => cb(info)
    ipcRenderer.on('tabs:navigated', listener as never)
    return () => ipcRenderer.removeListener('tabs:navigated', listener as never)
  },
  // Действие из контекстного меню вкладки, требующее ввода (rename/set-icon).
  onTabAction: (cb: (info: { id: number; action: string }) => void): (() => void) => {
    const listener = (_e: unknown, info: { id: number; action: string }) => cb(info)
    ipcRenderer.on('tabs:tab-action', listener as never)
    return () => ipcRenderer.removeListener('tabs:tab-action', listener as never)
  },
  // Состояние maximize/fullscreen окна: пуш из main, без опроса таймером.
  onMaximizedChanged: (cb: (maximized: boolean) => void): (() => void) => {
    const listener = (_e: unknown, maximized: boolean) => cb(maximized)
    ipcRenderer.on('window:maximized', listener as never)
    return () => ipcRenderer.removeListener('window:maximized', listener as never)
  },
  onFullscreenChanged: (cb: (fullscreen: boolean) => void): (() => void) => {
    const listener = (_e: unknown, fullscreen: boolean) => cb(fullscreen)
    ipcRenderer.on('window:fullscreen', listener as never)
    return () => ipcRenderer.removeListener('window:fullscreen', listener as never)
  },
  // Контентный fullscreen: панели shell прячутся, view на все окно.
  onContentFullscreenChanged: (cb: (on: boolean) => void): (() => void) => {
    const listener = (_e: unknown, on: boolean) => cb(on)
    ipcRenderer.on('window:content-fullscreen', listener as never)
    return () => ipcRenderer.removeListener('window:content-fullscreen', listener as never)
  }
}

export type BrowserAPI = typeof browserAPI

contextBridge.exposeInMainWorld('browserAPI', browserAPI)

declare global {
  interface Window {
    browserAPI: BrowserAPI
  }
}
