// Связка кластеров windows/ и tabs/ без циклов: они вызывают друг
// друга только через deps, здесь собираются оба набора.
// Выделено из index.ts: единое место wiring'а, register*Ipc и диагностика
// импортируют отсюда готовые createTab/createWindow вместо своих копий.
import { getStateBySender, findTab, windows, type WindowState } from './browserState'
import { partitionFor, bootWorkspaceId } from '../workspaces/registry'
import { clearWorkspaceWindows, planWorkspaceWindows } from '../workspaces/windowSnapshot'
import { beginWorkspaceSession } from '../workspaces/sessions'
import {
  createTab as createTabRaw,
  setActiveTab as setActiveTabRaw,
  closeTab as closeTabRaw,
  detachTabToNewWindow as detachTabRaw,
  pruneEmptyGroup,
  pushTabsState,
  type TabsDeps
} from '../tabs/tabsManager'
import {
  createWindow as createWindowRaw,
  applySnapshotTab,
  layoutView,
  layoutActiveView,
  persistSessionTabs,
  restoreWindowSnapshot,
  type WindowDeps
} from './windowsManager'
import { toggleFullscreenMode as toggleFullscreen } from './fullscreen'
import { closeOverlayOnTabChange, onOverlayEnded, showOverlay } from '../overlay'
import { tFor } from '../i18n'
import { inspectElementAt } from '../tabs/devtools'
import { handleTabChange, pumpPrompts } from '../permissions/permissionManager'
import type { PageMenuDeps } from '../tabs/pageMenu'
import type { SnapshotWindow } from '../workspaces/windowSnapshot'
import { latestClosed, takeClosed, type ClosedEntry } from '../store/closedStore'
import { START_URL } from '../pages/internalPages'
import { registerExtensionHost } from '../extensions/bridge'
import type { ChromeTabLike } from '../../shared/extensions-types'
import { BrowserWindow, session } from 'electron'

// wsOf: sender -> окно. Бросает, если окна нет: такое возможно только
// при гонке «ответ ушёл в уже закрытое окно», и молчаливый undefined
// превратил бы её в невыполненный handle без ошибки в логах.
export function wsOf(e: { sender: Electron.WebContents }): WindowState {
  const ws = getStateBySender(e.sender)
  if (!ws) throw new Error('No window for sender')
  return ws
}

// Оба набора deps собираются здесь: tabsManager получает layout-хелперы
// windowsManager, windowsManager — createTab tabsManager.
// Действия контекстного меню страницы (pageMenu.ts) — тот же случай: сам
// модуль меню окон не знает, поэтому openTab/openWindow/inspectAt приходят
// отсюда, а не импортом.
const pageMenuDeps: PageMenuDeps = {
  openTab: (ws, url) => {
    createTab(ws, url)
  },
  openWindow: (url) => {
    // Порядок как в cloneWindow: сначала окно, затем вкладка. Первую вкладку
    // createWindow создаёт только на did-finish-load шелла, поэтому грузить
    // URL «в активную вкладку» сразу после вызова нельзя — активной ещё нет.
    // Явный createTab кладёт вкладку раньше, и обработчик did-finish-load
    // уходит в ветку «вкладки уже есть», не подменяя её стартовой.
    const ws = createWindow({ restoreSession: false })
    createTab(ws, url)
  },
  inspectAt: (ws, tabId, x, y) => {
    inspectElementAt(ws, tabId, x, y)
  }
}

const tabsDeps: TabsDeps = {
  layoutView,
  layoutActiveView,
  // Обёртка: fullscreen.ts принимает layout явно, чтобы не было
  // цикла fullscreen <-> windowsManager.
  toggleFullscreenMode: (ws) => toggleFullscreen(ws, layoutActiveView),
  persistSessionTabs,
  createWindow: (opts) => createWindow(opts),
  pruneEmptyGroup,
  reopenClosed,
  pageMenu: pageMenuDeps
}

export function createTab(ws: WindowState, url = START_URL): number {
  return createTabRaw(ws, tabsDeps, url)
}

export function setActiveTab(ws: WindowState, id: number): void {
  // Активный оверлей принадлежит ПРЕЖНЕЙ вкладке: его пункты (контекстное
  // меню вкладки, диалог иконки, панель поиска) рассчитаны на неё.
  // Раньше смена вкладки про оверлей ничего не знала, и меню висело уже
  // над другой страницей.
  //
  // Порядок: сначала закрыть, потом переключать. Обратный порядок отдавал
  // бы фокус не той вкладке: closeOverlay возвращает фокус ОКНУ (это его
  // работа после панели поиска и автофокуса поля), а setActiveTabRaw сразу
  // после этого отдаёт фокус VIEW новой вкладки — то есть последним
  // решением остаётся правильный. Наоборот, view не смог бы забрать
  // фокус: после closeOverlay он был бы перебит window.focus().
  // Промпт разрешения, показанный на прежней вкладке, скрывается, а не
  // отменяется: возврат на вкладку вернёт и промпт. Метка ставится ДО
  // переключения, пока ws.activeTabId ещё указывает на прежнюю вкладку.
  handleTabChange(ws)
  if (ws.window) closeOverlayOnTabChange(ws.window, id)
  setActiveTabRaw(ws, tabsDeps, id)
  // На новой активной вкладке может ждать свой промпт (он был скрыт
  // переключением ранее).
  pumpPrompts(ws)
}

export function closeTab(ws: WindowState, id: number): void {
  closeTabRaw(ws, tabsDeps, id)
}

export function detachTabToNewWindow(fromWs: WindowState, id: number, sx: number, sy: number): void {
  detachTabRaw(fromWs, tabsDeps, id, sx, sy)
}

// restoreSession пробрасывается в createWindow: «Open new window» открывает
// пустое окно и не должен подхватывать слепок вкладок. Слепок окна
// (`snapshot`) несёт вкладки, группы и порядок панели для восстановления.
// Зависимости окна для путей, где окно уже создано и к нему нужно
// применить слепок (восстановление после аварии). Тот же набор, что
// собирается в createWindow: иначе восстановление по кнопке диалога шло
// бы другим кодом, чем обычный старт.
const windowDeps: WindowDeps = {
  createTab,
  setActiveTab,
  pushTabsState,
  closeTab,
  reopenClosed: (ws, entryId) => reopenClosed(ws, entryId)
}

export function createWindow(
  opts: {
    x?: number
    y?: number
    restoreSession?: boolean
    workspaceId?: string
    key?: string
    snapshot?: SnapshotWindow
    deferTabs?: boolean
  } = {}
): WindowState {
  return createWindowRaw(opts, windowDeps)
}

/**
 * Открывает окна пространства по его слепку.
 *
 * Слепка нет (первый запуск, `rememberTabs: false`, все окна закрыты
 * пользователем) — одно окно со стартовой страницей. Слепок есть — по
 * окну на запись, с его геометрией и ключом: ключ важен для списка
 * недавно закрытых и для возврата вкладки «в исходное окно».
 *
 * Окно без сохранённой геометрии смещается от предыдущего, иначе два окна
 * легли бы друг на друга. При `rememberBounds: false` позиции не
 * применяются — план это уже учёл.
 *
 * Аварийное завершение предыдущего запуска меняет сценарий: вкладки не
 * открываются сразу, а предлагаются диалогом — до решения пользователя
 * страницы не грузятся вовсе.
 */
export function openWorkspaceWindows(wsId: string): WindowState[] {
  // Сессия начинается здесь, до окон: маркер на диске и отличает штатный
  // выход от аварийного. Оставшийся маркер прошлого запуска — та самая
  // авария, и его данные нужны диалогу.
  const { crash } = beginWorkspaceSession(wsId)
  const plan = planWorkspaceWindows(wsId)
  if (plan.length === 0) {
    console.log('[workspace] no snapshot to restore (or disabled), empty window:', wsId)
    return [createWindow({ workspaceId: wsId })]
  }
  // Строка в лог: по ней видно, восстановились ли окна и с какими ключами.
  // Без неё «браузер открыл одно окно вместо трёх» не отличить от «слепок
  // не прочитался».
  console.log(
    '[workspace] restoring windows:',
    wsId,
    plan.map((w) => `${w.key}(${w.tabs.length} tabs)`)
  )
  const tabs = plan.reduce((sum, w) => sum + w.tabs.length, 0)
  if (crash && tabs > 0) {
    console.log(
      '[workspace] previous session ended abnormally:',
      wsId,
      'started',
      new Date(crash.startedAt).toISOString(),
      `(${tabs} tabs in ${plan.length} windows)`
    )
    return [askToRestoreCrash(wsId, plan)]
  }
  return restoreWindowPlan(wsId, plan)
}

/**
 * Ставит окна по плану.
 *
 * `reuse` — уже созданное окно (с геометрией первого слепка), в которое
 * нужно применить вкладки: так восстановление по кнопке диалога не
 * плодит лишнее окно и не мигает вторым.
 */
function restoreWindowPlan(
  wsId: string,
  plan: SnapshotWindow[],
  reuse?: WindowState
): WindowState[] {
  const out: WindowState[] = []
  let lastBounds = plan[0]?.bounds
  plan.forEach((snap, index) => {
    if (snap.bounds) lastBounds = snap.bounds
    const offset = snap.bounds
      ? {}
      : lastBounds
        ? { x: lastBounds.x + 32 * index, y: lastBounds.y + 32 * index }
        : {}
    if (index === 0 && reuse) {
      applySnapshotToWindow(reuse, snap)
      out.push(reuse)
      return
    }
    out.push(
      createWindow({
        ...offset,
        workspaceId: wsId,
        key: snap.key,
        snapshot: snap
      })
    )
  })
  return out
}

/** Слепок в готовое окно: вкладки, группы, ряд, активная вкладка. */
function applySnapshotToWindow(ws: WindowState, snap: SnapshotWindow): void {
  const restored = restoreWindowSnapshot(ws, windowDeps, snap)
  if (!restored) createTab(ws)
  layoutActiveView(ws)
  pushTabsState(ws)
}

/**
 * Диалог восстановления после аварии.
 *
 * Окно создаётся сразу и с геометрией первого слепка, но БЕЗ вкладок
 * (`deferTabs`): пока пользователь не ответил, ни одна страница не
 * загружается — в этом и смысл «безопасного» восстановления. Кнопки —
 * решения, а не подтверждение факта: восстановить или начать с чистого
 * листа.
 *
 * Снятие диалога без выбора (Esc, подложка, уход из приложения, вытеснение
 * другим оверлеем) считается восстановлением: потерять вкладки хуже, чем
 * открыть их без спроса. Поэтому в диалоге нет кнопки `__cancel__` — она
 * закрывала бы поверхность через dismiss и давала бы обратный смысл.
 */
function askToRestoreCrash(wsId: string, plan: SnapshotWindow[]): WindowState {
  const first = plan[0]
  const ws = createWindow({
    workspaceId: wsId,
    key: first.key,
    snapshot: first,
    deferTabs: true
  })
  const win = ws.window
  if (!win) return ws

  const tabs = plan.reduce((sum, w) => sum + w.tabs.length, 0)
  const t = tFor(wsId)
  let decided = false
  let unsubscribe: (() => void) | null = null
  const decide = (restore: boolean): void => {
    if (decided) return
    decided = true
    unsubscribe?.()
    unsubscribe = null
    if (win.isDestroyed()) return
    if (restore) {
      restoreWindowPlan(wsId, plan, ws)
      return
    }
    // «Начать с чистого листа»: слепок стирается, чтобы следующее
    // восстановление не вернуло те же вкладки снова.
    clearWorkspaceWindows(wsId)
    createTab(ws)
    layoutActiveView(ws)
    pushTabsState(ws)
  }

  // Диалог показывается, когда shell загружен И окно уже на экране: до
  // показа оверлей посчитал бы геометрию по ещё не применённым bounds.
  // Флаг `presented` обязателен: события приходят по отдельности, и второй
  // вызов создавал вторую сессию оверлея — первая снималась со всеми
  // последствиями («снятие = восстановить»), а диалог так и не появлялся.
  const ready = { loaded: false, shown: win.isVisible(), presented: false }
  const present = (): void => {
    if (decided || ready.presented || !ready.loaded || !ready.shown) return
    ready.presented = true
    unsubscribe = onOverlayEnded((parentId) => {
      if (parentId === win.id) decide(true)
    })
    showOverlay(win, {
      kind: 'dialog',
      anchor: { x: 0, y: 0 },
      dialog: {
        title: t('sessionRestore.title'),
        message: t('sessionRestore.message', { tabs, windows: plan.length }),
        input: false,
        buttons: [
          { id: 'restore', label: t('sessionRestore.restore') },
          { id: 'fresh', label: t('sessionRestore.fresh') }
        ]
      },
      onSelect: (raw) => {
        decide(raw.split('::')[0] === 'restore')
      }
    })
  }
  win.webContents.once('did-finish-load', () => {
    ready.loaded = true
    present()
  })
  win.once('show', () => {
    ready.shown = true
    present()
  })
  // Окно закрыли крестиком, не ответив: решать уже нечего.
  win.once('closed', () => {
    decided = true
    unsubscribe?.()
    unsubscribe = null
  })
  // Автоответ для проверки сценария без мыши (и для диагностики).
  // Ждёт появления диалога, а не выполняется сразу: решение обязано идти тем
  // же путём, что и настоящий ответ, — после показа и через `decide`.
  // Мгновенный ответ проходил мимо показа, и проверить, что диалог вообще
  // открывается, было нельзя.
  const autoAnswer = process.env['KONSTRUKTOR_RESTORE_ANSWER']
  if (autoAnswer === 'restore' || autoAnswer === 'fresh') {
    const timer = setInterval(() => {
      if (decided) {
        clearInterval(timer)
        return
      }
      if (!ready.presented) return
      clearInterval(timer)
      console.log('[workspace] crash restore: auto answer', autoAnswer)
      decide(autoAnswer === 'restore')
    }, 250)
  }
  return ws
}

export { pushTabsState, pruneEmptyGroup, tabsDeps }

/**
 * Возврат закрытой вкладки или окна из журнала «недавно закрытых».
 *
 * Вкладка возвращается В ИСХОДНОЕ ОКНО, если оно ещё живо: запись хранит
 * ключ окна (`w<N>`), который стабилен между запусками. Живого окна нет —
 * вкладка встаёт в текущее окно (то, откуда её вернули): так ведут себя
 * остальные браузеры, а плодить окно ради одной вкладки неожиданно.
 *
 * Окно восстанавливается ЦЕЛИКОМ из своего слепка — тем же путём, что при
 * старте (`createWindow` + `restoreWindowSnapshot`): группы, порядок и
 * активная вкладка возвращаются вместе со вкладками.
 *
 * `entryId` не передан — берётся самая свежая запись (хоткей Ctrl+Shift+T).
 * Запись можно восстановить только один раз: после возврата она уходит из
 * журнала, иначе хоткей открывал бы одну и ту же вкладку бесконечно.
 */
export function reopenClosed(from: WindowState, entryId?: string): boolean {
  const wsId = from.workspaceId
  // Инкогнито ничего не возвращает: его сессии нет ни в журнале, ни в
  // истории — это обещание режима, а не ограничение реализации.
  if (from.incognito) return false
  const entry: ClosedEntry | undefined = entryId
    ? takeClosed(wsId, entryId)
    : (() => {
        const last = latestClosed(wsId)
        return last ? takeClosed(wsId, last.id) : undefined
      })()
  if (!entry) return false
  return restoreClosedEntry(from, entry)
}

/** Применяет ЗАБРАННУЮ запись журнала. Отдельно — для диагностики и тестов. */
export function restoreClosedEntry(from: WindowState, entry: ClosedEntry): boolean {
  const wsId = from.workspaceId
  if (entry.kind === 'window') {
    console.log('[closed] restoring window:', entry.windowKey, `(${entry.snapshot.tabs.length} tabs)`)
    createWindow({ workspaceId: wsId, snapshot: entry.snapshot })
    return true
  }
  const tab = entry.snapshot.tabs[0]
  if (!tab) return false
  // Живое окно ищется по ключу в СВОЁМ пространстве: одинаковые ключи в
  // разных пространствах — норма (у каждого свой счётчик).
  const target = liveWindowByKey(wsId, entry.windowKey) ?? from
  try {
    const id = createTab(target, tab.url)
    applySnapshotTab(target, id, tab)
    setActiveTab(target, id)
    console.log(
      '[closed] restored tab:',
      tab.url,
      'into',
      target.key,
      target.key === entry.windowKey ? '(original)' : '(current)'
    )
    return true
  } catch (err) {
    console.log('[closed] restore failed:', String(err))
    return false
  }
}

/** Окно пространства по его стабильному ключу. */
function liveWindowByKey(wsId: string, key: string): WindowState | undefined {
  for (const ws of windows.values()) {
    if (ws.workspaceId !== wsId || ws.key !== key) continue
    if (ws.window && !ws.window.isDestroyed()) return ws
  }
  return undefined
}

// --- Возможности хоста для расширений ------------------------------------

// Расширения обращаются к вкладкам и окнам через loopback-мост, но сами
// кластеры не знают: возможности собираются здесь, где уже есть и createTab,
// и createWindow. Импорт в обратную сторону дал бы цикл (extensions -> deps).
function windowStateOf(id: number | undefined): WindowState | undefined {
  if (id === undefined) return undefined
  for (const ws of windows.values()) if (ws.window?.id === id) return ws
  return undefined
}

function activeWindowState(): WindowState | undefined {
  const focusedId = BrowserWindow.getFocusedWindow()?.id
  return windowStateOf(focusedId) ?? windows.values().next().value
}

function tabsOfWs(ws: WindowState): ChromeTabLike[] {
  const windowId = ws.window?.id ?? -1
  const out: ChromeTabLike[] = []
  ws.tabOrder.forEach((tabId, index) => {
    const rec = ws.tabs.get(tabId)
    if (!rec) return
    const wc = rec.view?.webContents
    out.push({
      id: tabId,
      index,
      windowId,
      url: rec.url,
      title: rec.customTitle ?? rec.title,
      active: tabId === ws.activeTabId,
      pinned: rec.pinned,
      incognito: ws.incognito,
      // Реальный признак звука: расширения используют его, чтобы понять,
      // есть ли вообще что слушать, и по нему же показывают индикатор.
      // Умирающий webContents бросает на любом обращении — проверяем.
      audible: wc && !wc.isDestroyed() ? wc.isCurrentlyAudible() : false
    })
  })
  return out
}

registerExtensionHost({
  listWindows: () =>
    [...windows.values()]
      .filter((ws) => ws.window)
      .map((ws) => ({
        id: ws.window?.id ?? -1,
        focused: ws.window?.isFocused() ?? false,
        incognito: ws.incognito
      })),
  listTabs: (windowId) =>
    [...windows.values()]
      .filter((ws) => windowId === undefined || ws.window?.id === windowId)
      .flatMap(tabsOfWs),
  activeWindowId: () => activeWindowState()?.window?.id ?? null,
  focusedWindowId: () => BrowserWindow.getFocusedWindow()?.id ?? null,
  openTab: (url, opts) => {
    const ws = windowStateOf(opts.windowId) ?? activeWindowState()
    if (!ws) return null
    const id = createTab(ws, url)
    if (opts.active) setActiveTab(ws, id)
    return id
  },
  closeTab: (id) => {
    const found = findTab(id)
    if (!found) return false
    closeTab(found.ws, id)
    return true
  },
  activateTab: (id) => {
    const found = findTab(id)
    if (!found) return false
    setActiveTab(found.ws, id)
    return true
  },
  navigateTab: (id, url) => {
    const found = findTab(id)
    if (!found || found.rec.view.webContents.isDestroyed()) return false
    void found.rec.view.webContents.loadURL(url)
    return true
  },
  reloadTab: (id) => {
    const found = findTab(id)
    if (!found || found.rec.view.webContents.isDestroyed()) return false
    found.rec.view.webContents.reload()
    return true
  },
  createWindow: (url) => {
    const ws = createWindow({ restoreSession: false })
    if (url) createTab(ws, url)
    return ws.window?.id ?? null
  },
  closeWindow: (id) => {
    const win = BrowserWindow.fromId(id)
    if (!win) return false
    win.close()
    return true
  },
  notify: (toast) => {
    const ws = activeWindowState()
    if (!ws?.window) return
    const bounds = ws.window.getContentBounds()
    showOverlay(ws.window, {
      kind: 'toast',
      anchor: { x: Math.max(0, bounds.width - 380), y: bounds.height - 160 },
      toast
    })
  },
  downloadUrl: (url, wsId) => {
    // Загрузка идёт в партицию пространства: cookies и сессия должны быть
    // те же, что у вкладки, иначе сайт отдаст чужой ответ или потребует вход.
    session.fromPartition(partitionFor(wsId ?? bootWorkspaceId())).downloadURL(url)
  }
})
