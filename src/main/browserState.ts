// Состояние окон/вкладок: типы, пул WebContentsView, lookup-хелперы.
// Выделено из index.ts (п.3 рефакторинга): здесь нет логики создания окон,
// только хранилище + поиск. Остальные модули импортируют отсюда типы и map.
import { BrowserWindow, type WebContentsView } from 'electron'

export interface TabRecord {
  id: number
  viewId: number
  url: string
  title: string
  pinned: boolean
  favicon: string
  // Открытый экземпляр группы: ссылка на шаблон в groups.json.
  // undefined = вкладка вне групп.
  groupId?: string
}

export interface TabData {
  view: WebContentsView
  url: string
  title: string
  pinned: boolean
  favicon: string
  retriedWithChromeUA: boolean
  // Пользовательские переопределения из контекстного меню вкладки.
  // Хранятся отдельно от page title/favicon, чтобы обновления страницы
  // их не затирали. В UI уходит custom ?? page.
  customTitle?: string
  customFavicon?: string
  // Ключ последнего insertCSS темы (color-scheme) — для снятия при смене.
  themeKey?: string
  // Открытый экземпляр группы: ссылка на шаблон в groups.json.
  groupId?: string
}

// Состояние одного окна браузера. Вкладки живут внутри окна,
// detach переносит view целиком в новое WindowState.
// incognito: окно целиком приватное — in-memory партиция, без persist.
export interface OpenGroup {
  // id экземпляра: один шаблон можно открыть несколько раз,
  // поэтому у каждого открытия свой instanceId.
  instanceId: string
  // id шаблона в groups.json — для имени, цвета, иконки.
  savedId: string
  collapsed: boolean
  pinned: boolean
  // Вложенность открытых экземпляров: instanceId родителя.
  // undefined = группа верхнего уровня на панели вкладок.
  parentInstanceId?: string
}

export interface WindowState {
  window: BrowserWindow | null
  tabs: Map<number, TabData>
  tabOrder: number[]
  activeTabId: number | null
  // Единый порядок панели вкладок: токены корневых элементов.
  // 't:<id>' — вкладка без группы, 'g:<instanceId>' — корневая группа.
  // Группы того же ранга, что вкладки: таб и группа чередуются свободно.
  stripOrder: string[]
  // То же для закрепленной зоны слева (пины всегда слева, не смешиваются).
  pinnedStripOrder: string[]
  uiInsets: { top: number; bottom: number; left: number; right: number }
  incognito: boolean
  // Контентный fullscreen: view растянута на все окно, панели скрыты.
  contentFullscreen: boolean
  // Исконные bounds окна до контентного fullscreen — для возврата.
  savedBounds?: Electron.Rectangle
  // Открытые экземпляры групп этого окна (порядок = порядок на панели).
  openGroups: OpenGroup[]
}

// Партиции: обычная persistent, инкогнито in-memory (без persist:).
export const NORMAL_PARTITION = 'persist:konstruktor'
export const INCOGNITO_PARTITION = 'incognito-mem'

export const windows = new Map<number, WindowState>()

let nextTabId = 1

// Выдача id вкладки со сквозным счетчиком на все окна.
export function allocTabId(): number {
  return nextTabId++
}

export function getState(win: BrowserWindow | null): WindowState | undefined {
  if (!win) return undefined
  return windows.get(win.id)
}

export function getStateBySender(sender: Electron.WebContents): WindowState | undefined {
  return getState(BrowserWindow.fromWebContents(sender))
}

export function findTab(id: number): { ws: WindowState; rec: TabData } | undefined {
  for (const ws of windows.values()) {
    const rec = ws.tabs.get(id)
    if (rec) return { ws, rec }
  }
  return undefined
}

// Окно-родитель вкладки: поиск по ссылке на TabData (id могут совпадать
// между окнами после detach/attach, поэтому сравниваем по объекту).
export function parentOfTab(rec: TabData): BrowserWindow | undefined {
  for (const ws of windows.values()) {
    for (const [, r] of ws.tabs) {
      if (r === rec) return ws.window ?? undefined
    }
  }
  return undefined
}
