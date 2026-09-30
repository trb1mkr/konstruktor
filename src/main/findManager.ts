// Поиск по странице: состояние lastFind + обертка над findInPage/custom-поиском.
// Выделено из index.ts (п.3 рефакторинга): registerIpc дергает только
// queryFind/nextFind/prevFind/closeFind, вся DOM-логика — здесь и в findScripts.
import { BrowserWindow } from 'electron'
import {
  getState,
  getStateBySender,
  parentOfTab,
  type TabData,
  type WindowState
} from './browserState'
import {
  showOverlay,
  closeOverlay,
  getActiveOverlay,
  getParentOfOverlay,
  updateActiveOverlay
} from './overlayManager'
import {
  buildRunCustomFindScript,
  buildStepCustomFindScript,
  buildClearCustomFindScript,
  type CustomFindOptions
} from './findScripts'

// Панель поиска поверх страницы: один конструктор на все точки входа
// (before-input-event view, Ctrl+F shell, find:open). Повторный вызов
// при открытой панели — no-op, иначе моргание и потеря фокуса ввода.
export function openFindOverlay(ws: WindowState, query = ''): boolean {
  if (!ws.window || ws.window.isDestroyed()) return false
  const existing = getActiveOverlay(ws.window)
  if (existing && !existing.isDestroyed()) return true
  showOverlay(ws.window, {
    kind: 'find',
    anchor: { x: 0, y: ws.uiInsets.top },
    find: { query }
  })
  return true
}

// Активная view по sender оверлея поиска.
export function recOfOverlaySender(sender: Electron.WebContents): TabData | undefined {
  const overlay = BrowserWindow.fromWebContents(sender)
  const parent = overlay ? getParentOfOverlay(overlay) : undefined
  const ws = parent ? getState(parent) : undefined
  if (!ws || ws.activeTabId === null) return undefined
  return ws.tabs.get(ws.activeTabId)
}

export function parentOfOverlaySender(sender: Electron.WebContents): BrowserWindow | undefined {
  const overlay = BrowserWindow.fromWebContents(sender)
  return overlay ? getParentOfOverlay(overlay) : undefined
}

// Счётчик уходит через overlay:update, а не через executeJavaScript. Раньше
// он правил .find-count по селектору, и значение не жило в модели: приходило
// из main строкой и ложилось прямо в DOM. Теперь это поле find.counter,
// поэтому подсчёт не может разойтись с показанным, а renderer не получает
// исполняемый код от main.
function setFindCounter(parent: BrowserWindow | undefined, text: string): void {
  if (!parent) return
  updateActiveOverlay(parent, { find: { counter: text } })
}

// Собственный поиск для wholeWord/regex: findInPage их не умеет
// (только подстрока + matchCase). Разбиваем текст на слова границами
// Unicode-букв/цифр — пробелы и пунктуация считаются разделителями.
export async function runCustomFind(rec: TabData, opts: CustomFindOptions): Promise<void> {
  const parent = parentOfTab(rec)
  let res: { matches?: number; error?: string } = {}
  try {
    res = (await rec.view.webContents.executeJavaScript(
      buildRunCustomFindScript(opts)
    )) as { matches?: number; error?: string }
  } catch {
    res = { matches: 0 }
  }
  const n = res.matches ?? 0
  setFindCounter(
    parent,
    res.error === 'bad-regex' ? 'Invalid expression' : n === 0 ? 'No results' : `1 of ${n}`
  )
}

export async function stepCustomFind(rec: TabData, forward: boolean): Promise<void> {
  const parent = parentOfTab(rec)
  let res: { matches?: number; active?: number } = {}
  try {
    res = (await rec.view.webContents.executeJavaScript(
      buildStepCustomFindScript(forward)
    )) as { matches?: number; active?: number }
  } catch {
    return
  }
  const n = res.matches ?? 0
  setFindCounter(parent, n === 0 ? 'No results' : `${res.active ?? 0} of ${n}`)
}

export async function clearCustomFind(rec: TabData): Promise<void> {
  try {
    await rec.view.webContents.executeJavaScript(buildClearCustomFindScript())
  } catch {
    // Страница уже мертва — игнорим.
  }
}

// Последний текст поиска для findNext без повторного запроса.
let lastFindText = ''
let lastFindFlags = { matchCase: false }
// true = активен собственный поиск (wholeWord/regex), навигация через DOM.
let lastFindCustom = false

function activeViewOf(sender: Electron.WebContents): TabData | undefined {
  const overlay = BrowserWindow.fromWebContents(sender)
  const parent = overlay ? getParentOfOverlay(overlay) : undefined
  const ws = parent ? getState(parent) : getStateBySender(sender)
  if (!ws || ws.activeTabId === null) return undefined
  return ws.tabs.get(ws.activeTabId)
}

function runFind(
  sender: Electron.WebContents,
  opts: CustomFindOptions,
  forward: boolean
): boolean {
  const rec = activeViewOf(sender)
  if (!rec) return false
  const wc = rec.view.webContents
  if (!opts.query) {
    wc.stopFindInPage('clearSelection')
    void clearCustomFind(rec)
    lastFindCustom = false
    return true
  }
  // findInPage умеет только подстроку + matchCase. wholeWord и regex
  // идут через собственный поиск: разбиваем текст на слова и подсвечиваем.
  if (opts.wholeWord || opts.useRegex) {
    wc.stopFindInPage('clearSelection')
    lastFindText = opts.query
    lastFindFlags = { matchCase: opts.matchCase }
    lastFindCustom = true
    void runCustomFind(rec, opts)
    return true
  }
  void clearCustomFind(rec)
  lastFindText = opts.query
  lastFindFlags = { matchCase: opts.matchCase }
  lastFindCustom = false
  try {
    wc.findInPage(opts.query, {
      forward,
      matchCase: opts.matchCase,
      findNext: false
    })
  } catch {
    return false
  }
  return true
}

export function queryFind(sender: Electron.WebContents, opts: CustomFindOptions): boolean {
  return runFind(sender, opts, true)
}

export function nextFind(sender: Electron.WebContents): boolean {
  const rec = recOfOverlaySender(sender)
  if (!rec) return false
  if (lastFindCustom) {
    void stepCustomFind(rec, true)
    return true
  }
  if (!lastFindText) return false
  try {
    rec.view.webContents.findInPage(lastFindText, {
      forward: true,
      matchCase: lastFindFlags.matchCase,
      findNext: true
    })
  } catch {
    return false
  }
  return true
}

export function prevFind(sender: Electron.WebContents): boolean {
  const rec = recOfOverlaySender(sender)
  if (!rec) return false
  if (lastFindCustom) {
    void stepCustomFind(rec, false)
    return true
  }
  if (!lastFindText) return false
  try {
    rec.view.webContents.findInPage(lastFindText, {
      forward: false,
      matchCase: lastFindFlags.matchCase,
      findNext: true
    })
  } catch {
    return false
  }
  return true
}

export function closeFind(sender: Electron.WebContents): boolean {
  const overlay = BrowserWindow.fromWebContents(sender)
  const parent = overlay ? getParentOfOverlay(overlay) : undefined
  const ws = parent ? getState(parent) : undefined
  const rec = ws && ws.activeTabId !== null ? ws.tabs.get(ws.activeTabId) : undefined
  rec?.view.webContents.stopFindInPage('clearSelection')
  if (rec) void clearCustomFind(rec)
  lastFindCustom = false
  if (parent) closeOverlay(parent)
  return true
}
