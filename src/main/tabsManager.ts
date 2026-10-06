// Вкладки: создание, переключение, закрытие, detach/attach, пуш состояния.
// Выделено из index.ts: здесь весь жизненный цикл WebContentsView.
// Окна (createWindow/layout/fullscreen) живут в windowsManager.ts,
// этот модуль принимает их через deps во избежание циклических импортов.
import { WebContentsView, shell } from 'electron'
import {
  allocTabId,
  NORMAL_PARTITION,
  INCOGNITO_PARTITION,
  type WindowState,
  type TabRecord
} from './browserState'
import { applyThemeToTab, viewBackgroundFor, type ThemeKeySetter } from './browserTheme'
import { ensureStripToken, removeStripToken, reorderStrip } from './stripOrder'
import { openFindOverlay } from './findManager'
import { closeDevToolsFor, toggleDevTools } from './devtools'
import {
  applyZoomToWs,
  percentOf,
  seedZoomPercent,
  setZoom,
  stepActiveZoom,
  syncZoomPopup,
  zoomModeFor,
  zoomShortcut
} from './zoomManager'
import { getActiveOverlay, closeOverlay, updateActiveOverlay } from './overlay'
import { getSettingsSync } from './settingsStore'
import { t } from './i18n'
import { recordVisit, updateMetadata } from './historyStore'
import { START_URL } from './startPage'

export interface TabsDeps {
  layoutView: (ws: WindowState, view: WebContentsView) => void
  layoutActiveView: (ws: WindowState) => void
  toggleFullscreenMode: (ws: WindowState) => boolean
  persistSessionTabs: (ws: WindowState) => void
  // restoreSession пробрасывается в createWindow: «Open new window» открывает
  // пустое окно и не должен подхватывать sessionTabs (общий слот на всё
  // приложение) — иначе «новое» окно оказывалось бы копией чужого.
  // Опции incognito больше нет: приватное окно не создаётся, режим
  // переключается на живом через switchIncognito.
  createWindow: (opts: { x?: number; y?: number; restoreSession?: boolean }) => WindowState
  pruneEmptyGroup: (ws: WindowState, instanceId: string) => void
}

export function pushTabsState(ws: WindowState): void {
  const list: TabRecord[] = ws.tabOrder
    .map((id) => {
      const t = ws.tabs.get(id)
      if (!t) return null
      // Опрос DevTools вместо чтения rec.devTools: пользователь может
      // закрыть панель крестиком в самом DevTools, и тогда запись в rec
      // устареет, а меню покажет «открыто». isDestroyed обязателен —
      // умирающий webContents бросает на любом обращении.
      const wc = t.view.webContents
      return {
        id,
        viewId: wc.id,
        url: t.url,
        title: t.customTitle ?? t.title,
        pinned: t.pinned,
        favicon: t.customFavicon ?? t.favicon,
        groupId: t.groupId,
        devToolsOpen: wc.isDestroyed() ? false : wc.isDevToolsOpened(),
        // Процент зума — опросом webContents, как у DevTools: Chromium
        // меняет его и сам (per-origin при навигации), а запись без
        // опроса протухала бы и badge показал бы чужое значение.
        zoom: percentOf(wc)
      }
    })
    .filter((t) => t !== null) as TabRecord[]
  ws.window?.webContents.send('tabs:state', {
    tabs: list,
    activeTabId: ws.activeTabId,
    incognito: ws.incognito,
    openGroups: ws.openGroups.map((g) => ({ ...g })),
    stripOrder: [...ws.stripOrder],
    pinnedStripOrder: [...ws.pinnedStripOrder]
  })
  // Открытый попап зума едет в той же точке: любое изменение зума
  // (клавиши, Ctrl+колесо, IPC, кнопки попапа) проходит через этот пуш,
  // и поле попапа показывает фактический процент страницы, а не stale.
  syncZoomPopup(ws)
}

export function createTab(ws: WindowState, deps: TabsDeps, url = START_URL): number {
  if (!ws.window) throw new Error('No window')
  const view = new WebContentsView({
    webPreferences: {
      // Сайты изолированы: nodeIntegration выключен по умолчанию.
      contextIsolation: true,
      // Инкогнито-окно: in-memory партиция, ничего не пишется на диск.
      partition: ws.incognito ? INCOGNITO_PARTITION : NORMAL_PARTITION
    }
  })
  // Нативный фон view под тему: дефолт #FFF вспыхивает белым
  // до первой отрисовки страницы. Красим сразу при создании.
  try {
    view.setBackgroundColor(viewBackgroundFor(getSettingsSync().theme ?? 'dark'))
  } catch {
    // Старый Electron без setBackgroundColor у View — игнорим.
  }
  // Pinch-zoom гасим: процентный зум — единственный источник масштаба,
  // и визуальный зум спорил бы с ним (своя шкала, своя история).
  // В Electron visual zoom выключен по умолчанию — вызов страховка,
  // а не включение.
  void view.webContents.setVisualZoomLevelLimits(1, 1)
  // Режим зума из настройки: 'tab' -> isolated (зум живёт в вкладке и
  // умирает с ней), 'origin' -> default (per-origin, как Chrome).
  view.webContents.setZoomMode(zoomModeFor(getSettingsSync()))
  // Единый зум: вкладка открывается с последнего процента и держит его на
  // каждой навигации. Зум до загрузки НЕ применяется (проверено замером:
  // setZoomFactor до did-finish-load отдаёт 1), поэтому подписка на
  // did-finish-load, а не вызов сразу. В isolated-режиме повтор того же
  // значения — no-op, в default перебивает origin-значение нового сайта.
  view.webContents.on('did-finish-load', () => {
    if (getSettingsSync().zoomSync) setZoom(view.webContents, seedZoomPercent())
  })
  const id = allocTabId()
  ws.tabs.set(id, { view, url, title: t('tabs.newTitle'), pinned: false, favicon: '', retriedWithChromeUA: false, customTitle: undefined, customFavicon: undefined })
  ws.tabOrder.push(id)
  // Новая вкладка без группы — в конец обычного ряда панели.
  ensureStripToken(ws, `t:${id}`, false)
  ws.window.contentView.addChildView(view)
  // Начальная геометрия сразу, иначе view с нулевыми bounds до первого layout:update.
  deps.layoutView(ws, view)
  // Тема новой вкладки — сразу текущая, без ожидания смены настроек.
  const setKey: ThemeKeySetter = (k) => {
    const live = ws.tabs.get(id)
    if (live) live.themeKey = k
  }
  applyThemeToTab(ws.tabs.get(id)!, getSettingsSync().theme ?? 'dark', setKey)

  view.webContents.on('did-navigate', (_e, navUrl) => {
    const rec = ws.tabs.get(id)
    if (!rec) return
    rec.url = navUrl
    rec.favicon = ''
    if (id === ws.activeTabId) ws.window?.webContents.send('tabs:navigated', { id, url: navUrl })
    pushTabsState(ws)
    deps.persistSessionTabs(ws)
    // История: только обычные окна, внутренние страницы пропускаем в store.
    if (!ws.incognito) {
      void recordVisit({ url: navUrl, title: rec.title, favicon: rec.favicon }).catch((err: unknown) =>
        console.error('[history] record failed:', err)
      )
    }
  })
  // did-navigate не стреляет для in-page и части редиректов — дублируем через did-navigate-in-page.
  view.webContents.on('did-navigate-in-page', (_e, navUrl) => {
    const rec = ws.tabs.get(id)
    if (!rec) return
    rec.url = navUrl
    if (id === ws.activeTabId) ws.window?.webContents.send('tabs:navigated', { id, url: navUrl })
    pushTabsState(ws)
    deps.persistSessionTabs(ws)
  })
  view.webContents.on('page-title-updated', (_e, title) => {
    const rec = ws.tabs.get(id)
    if (!rec) return
    rec.title = title
    pushTabsState(ws)
    // Только метаданные: заголовок прилетает после навигации,
    // новый визит не засчитываем.
    if (!ws.incognito) {
      void updateMetadata(rec.url, { title }).catch(() => undefined)
    }
  })
  // Иконка сайта для панели вкладок.
  view.webContents.on('page-favicon-updated', (_e, favicons) => {
    const rec = ws.tabs.get(id)
    if (!rec || favicons.length === 0) return
    rec.favicon = favicons[0]
    pushTabsState(ws)
    // Только метаданные: иконка прилетает после навигации,
    // новый визит не засчитываем (иначе один заход = ×2).
    if (!ws.incognito) {
      void updateMetadata(rec.url, { favicon: rec.favicon }).catch(() =>
        undefined
      )
    }
  })
  view.webContents.on('did-fail-load', (_e, code, desc, validatedUrl) => {
    ws.window?.webContents.send('tabs:load-failed', { id, code, desc, url: validatedUrl })
    // GitHub и часть CDN отдают ERR_CONNECTION_CLOSED на дефолтном UA:
    // повтор с Chrome-UA чинит handshake без участия пользователя.
    const rec = ws.tabs.get(id)
    if (
      rec &&
      !rec.retriedWithChromeUA &&
      (code === -100 || code === -101 || code === -104) &&
      !validatedUrl.startsWith('konstruktor://')
    ) {
      rec.retriedWithChromeUA = true
      const chromeUA =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      rec.view.webContents.setUserAgent(chromeUA)
      void rec.view.webContents.loadURL(validatedUrl).catch(() => undefined)
    }
  })
  // Внешние ссылки открываем в системном браузере.
  view.webContents.setWindowOpenHandler(({ url: popupUrl }) => {
    void shell.openExternal(popupUrl)
    return { action: 'deny' }
  })
  // Ctrl+F внутри страницы: перехватываем до сайта и открываем свою панель.
  // before-input-event не стреляет, если фокус в omnibox/devtools или
  // страница перехватила keydown — дублируем через menu-роль и Ctrl+F shell.
  // F11 внутри страницы: Chromium в WebContentsView перехватывает клавишу
  // сам и не отдает ее сайту — тогглим сценарий из настроек вручную.
  // F11 без модификаторов в любом фокусе view = toggle fullscreen.
  view.webContents.on('before-input-event', (e, input) => {
    if (
      input.key === 'F11' &&
      input.type === 'keyDown' &&
      !input.control &&
      !input.meta &&
      !input.shift &&
      !input.alt &&
      ws.window &&
      !ws.window.isDestroyed()
    ) {
      e.preventDefault()
      deps.toggleFullscreenMode(ws)
      return
    }
    // F12 — DevTools страницы (док справа/снизу, как в Chrome).
    //
    // Именно эта точка, а не обработчик окна: F12 приходит в webContents,
    // который сейчас в фокусе. Когда фокус в самом DevTools, Chromium
    // обрабатывает клавишу сам и event сюда не доходит — там F12 закрывает
    // панель штатно, дублировать нечего.
    if (
      input.key === 'F12' &&
      input.type === 'keyDown' &&
      !input.control &&
      !input.meta &&
      !input.shift &&
      !input.alt &&
      ws.window &&
      !ws.window.isDestroyed()
    ) {
      e.preventDefault()
      toggleDevTools(ws, id)
      pushTabsState(ws)
      return
    }
    // Масштаб страницы: Ctrl/Cmd + = / - / 0. Физический code, не key —
    // раскладка (см. TROUBLESHOOTING.md «Ctrl+F и раскладка»).
    const zoomAct = zoomShortcut(input)
    if (zoomAct !== null) {
      e.preventDefault()
      // Применение внутри helpers: они же пушат окно (и все окна при
      // едином зуме), отдельный pushTabsState здесь был бы дублем.
      if (zoomAct === 0) applyZoomToWs(ws, 100, pushTabsState)
      else stepActiveZoom(ws, zoomAct, pushTabsState)
      return
    }
    const key = (input.key ?? '').toLowerCase()
    // code KeyF — физическая клавиша, не зависит от раскладки (русская 'а' = KeyF).
    const isF = key === 'f' || input.code === 'KeyF'
    if ((input.control || input.meta) && !input.shift && !input.alt && isF && input.type === 'keyDown') {
      e.preventDefault()
      openFindOverlay(ws)
    }
    // Escape при открытой панели поиска: закрываем панель, чистим подсветку.
    if (input.key === 'Escape' && input.type === 'keyDown' && ws.window) {
      const overlay = getActiveOverlay(ws.window)
      if (overlay && !overlay.isDestroyed()) {
        view.webContents.stopFindInPage('clearSelection')
        closeOverlay(ws.window)
      }
    }
  })
  // Состояние DevTools в записи вкладки синхронизируем с Chromium: панель
  // закрывается не только через F12, но и крестиком в самом DevTools и по
  // F12 внутри DevTools. Без этих подписок запись протухала бы, и меню
  // показало бы «открыто» у закрытой панели. Пушим только при открытии:
  // закрытие не меняет раскладку меню, а лишний tabs:state гоняет всю панель.
  view.webContents.on('devtools-opened', () => {
    const live = ws.tabs.get(id)
    if (!live) return
    live.devTools = { open: true, mode: live.devTools?.mode ?? 'right' }
    if (id === ws.activeTabId) pushTabsState(ws)
  })
  view.webContents.on('devtools-closed', () => {
    const live = ws.tabs.get(id)
    if (!live) return
    live.devTools = undefined
    if (id === ws.activeTabId) pushTabsState(ws)
  })
  // Счётчик совпадений поиска: found-in-page активной view уходит в панель
  // поиска (оверлей kind 'find') точечным патчем overlay:update.
  //
  // Раньше это был executeJavaScript с querySelector по .find-count и
  // [data-find-status]. Счётчик не жил в модели, значение приходило из main
  // строкой, и разметка с данными могли разойтись при любом переименовании
  // класса. Теперь это поле find.counter, и оно меняется реактивно.
  view.webContents.on('found-in-page', (_e, result) => {
    if (id !== ws.activeTabId || !ws.window) return
    const text =
      result.matches === 0
        ? t('find.none')
        : t('find.counter', { active: result.activeMatchOrdinal, total: result.matches })
    updateActiveOverlay(ws.window, { find: { counter: text } })
  })

  // Ctrl+колесо: Electron зум НЕ применяет сам — content шлёт делегату
  // запрос (WebContentsDelegate::ContentsZoomChange), а Electron-реализация
  // только испускает zoom-changed и больше ничего не делает (в Chrome там
  // IDC_ZOOM_PLUS). Значит единственный вариант: применять лестницу здесь,
  // иначе Ctrl+колесо молча не работает.
  //
  // Свой лестничный шаг вместо того, что сделал бы Chromium: проценты
  // должны совпадать с badge и полем попапа, а не быть 1.2^N.
  view.webContents.on('zoom-changed', (_e, direction: string) => {
    const live = ws.tabs.get(id)
    if (!live) return
    stepActiveZoom(ws, direction === 'out' ? -1 : 1, pushTabsState)
  })

  if (url !== 'about:blank') {
    // loadURL для konstruktor://start резолвится через protocol.handle ниже.
    void view.webContents.loadURL(url).catch((err: unknown) => {
      console.error(`[tabs] loadURL failed for tab ${id}:`, err)
    })
  }
  setActiveTab(ws, deps, id)
  return id
}

export function setActiveTab(ws: WindowState, deps: TabsDeps, id: number): void {
  const rec = ws.tabs.get(id)
  if (!rec || !ws.window) return
  // Прячем предыдущую view, показываем новую.
  if (ws.activeTabId !== null) {
    const prev = ws.tabs.get(ws.activeTabId)
    if (prev && prev.view !== rec.view) prev.view.setVisible(false)
  }
  ws.activeTabId = id
  rec.view.setVisible(true)
  // Клавиатурный фокус — view, а не окно.
  //
  // Замер: при запуске Ctrl+F не вызывал НИ ОДНОЙ подписки, и не
  // срабатывала ни одна клавиша вообще, при этом мышь работала (страница
  // прокручивалась), а у окна isFocused() был true. То есть клавиатурный
  // фокус не принадлежал НИ ОДНОМУ webContents: окно активно, но фокус
  // внутри него не задан. Мышь работает потому, что клик Chromium
  // трактует как команду «сфокусируй вид», а клавиатура уходит в
  // webContents, у которого фокуса нет, — поэтому before-input-event
  // молчит. Клик по странице чинил симптом, сам фокус ставя.
  //
  // setVisible(true) недостаточно: он показывает view, но не передаёт
  // ей клавиатуру. Нужен явный focus().
  rec.view.webContents.focus()
  deps.layoutActiveView(ws)
  pushTabsState(ws)
  deps.persistSessionTabs(ws)
}

export function closeTab(ws: WindowState, deps: TabsDeps, id: number): void {
  const rec = ws.tabs.get(id)
  if (!rec || !ws.window) return
  const groupId = rec.groupId
  // DevTools закрываем ДО уничтожения webContents: умирающий view уносит
  // панель с собой, а closeDevTools на живом сбрасывает состояние явно.
  // При закрытии неактивной вкладки состояние всё равно уходит с записью.
  closeDevToolsFor(ws, id)
  ws.window.contentView.removeChildView(rec.view)
  rec.view.webContents.close()
  ws.tabs.delete(id)
  ws.tabOrder = ws.tabOrder.filter((t) => t !== id)
  // Вкладка без группы жила в едином ряду — убираем токен.
  if (!groupId) removeStripToken(ws, `t:${id}`)
  // Группа без вкладок исчезает с панели вкладок, шаблон остается в store.
  if (groupId) deps.pruneEmptyGroup(ws, groupId)
  if (ws.activeTabId === id) {
    ws.activeTabId = null
    if (ws.tabOrder.length > 0) setActiveTab(ws, deps, ws.tabOrder[ws.tabOrder.length - 1])
    else {
      pushTabsState(ws)
      deps.persistSessionTabs(ws)
    }
  } else {
    pushTabsState(ws)
    deps.persistSessionTabs(ws)
  }
}

// Убрать пустые экземпляры групп: ни одной вкладки с таким instanceId.
export function pruneEmptyGroup(ws: WindowState, instanceId: string): void {
  const alive = [...ws.tabs.values()].some((t) => t.groupId === instanceId)
  if (!alive) {
    ws.openGroups = ws.openGroups.filter((g) => g.instanceId !== instanceId)
    removeStripToken(ws, `g:${instanceId}`)
  }
}

// Вынос вкладки в новое окно: view переезжает целиком, история сохраняется.
/**
 * Копия всех вкладок окна в новое окно (пункт «Clone window» меню окна).
 *
 * Отличие от detach: исходные вкладки остаются на месте. Переносить их
 * нельзя — это был бы detach всех вкладок разом, то есть исходное окно
 * осталось бы пустым и закрылось.
 *
 * Копируются ЗАПИСИ, а не WebContentsView (detach переносит view). Причина
 * в том, что перенос view не может быть копированием: одна view принадлежит
 * одному родителю, addChildView в второе окно её оттуда заберёт. Поэтому у
 * клона своя view на каждую вкладку — с той же партицией, то есть с той же
 * историей и кэшем.
 *
 * Порядок обязателен: сначала новое окно (renderer успевает прислать layout
 * до заезда), затем вкладки. Иначе did-finish-load нового окна создаст
 * лишнюю стартовую вкладку — она появилась бы первой и стала активной.
 *
 * Сдвиг от исходного окна: два окна в одной точке лежали бы друг на друге,
 * и верхнее закрыло бы нижнее целиком.
 */
export function cloneWindow(
  fromWs: WindowState,
  deps: TabsDeps,
  offsetX = 32,
  offsetY = 32
): void {
  if (!fromWs.window || fromWs.tabs.size === 0) return
  const fromWin = fromWs.window
  // Группы копируются ДО вкладок: вкладки ссылаются на instanceId, и если
  // группа появится позже, ссылка окажется в пустоте при первом же рендере.
  const groups = fromWs.openGroups.map((g) => ({ ...g }))

  const ws = deps.createWindow({
    x: fromWin.getPosition()[0] + offsetX,
    y: fromWin.getPosition()[1] + offsetY
  })
  if (!ws.window) return
  // Режим клона повторяет режим исходного окна, и флаг ставится ДО
  // создания вкладок: createTab берёт партицию из ws.incognito, и
  // переключать окно через switchIncognito нельзя — оно переоткрывает
  // вкладки. Обычному окну попадать в приватную сессию тоже нельзя,
  // поэтому порядок именно такой: сначала флаг, потом вкладки.
  ws.incognito = fromWs.incognito
  for (const g of groups) {
    ws.openGroups.push(g)
    // Токен группы в ряду: только корневые. Вложенные рисуются внутри
    // родителя, как и в исходном окне.
    if (!g.parentInstanceId) ensureStripToken(ws, `g:${g.instanceId}`, g.pinned)
  }

  // Порядок копируем как есть: пользователь выстроил его вручную.
  //
  // Порядок вкладок (tabOrder) и порядок панели (stripOrder) — разные
  // вещи, и копируются по-разному. tabOrder задаётся циклом ниже, а
  // stripOrder здесь: группы к тому моменту уже в ряду, а createTab
  // докладывает вкладки в конец. Без явного reorderStrip группа,
  // добавленная первой, осталась бы в начале РЯДА, даже если в
  // исходном окне стояла последней.
  //
  // Соответствие токенов: id вкладок в клоне новые, поэтому порядок
  // исходного окна переносится через карту source->copy. Группы
  // сохраняют instanceId, и их токены переносятся как есть.
  const sourceTokenToCopyToken = new Map<string, string>()

  let activeId: number | null = null
  for (const id of fromWs.tabOrder) {
    const rec = fromWs.tabs.get(id)
    if (!rec) continue
    const copyId = createTab(ws, deps, rec.url)
    const copy = ws.tabs.get(copyId)
    if (!copy) continue
    copy.pinned = rec.pinned
    copy.customTitle = rec.customTitle
    copy.customFavicon = rec.customFavicon
    // instanceId сохраняется: ссылка вкладки должна вести в копию той же
    // группы, а не в отсутствующую.
    copy.groupId = rec.groupId
    // Вкладка с группой не получает токен в ряду — createTab уже положила
    // свой, и без removeStripToken она светилась бы и в группе, и в ряду.
    if (rec.groupId) removeStripToken(ws, `t:${copyId}`)
    sourceTokenToCopyToken.set(`t:${id}`, `t:${copyId}`)
    if (id === fromWs.activeTabId) activeId = copyId
  }

  // Порядок панели клона = порядок исходного окна с подменёнными
  // токенами вкладок. Зоны (pinned/normal) reorderStrip разнесёт сам по
  // флагам pinned, поэтому достаточно склеить зоны в том же порядке,
  // в каком их отдаёт renderer.
  const stripOrder = [...fromWs.pinnedStripOrder, ...fromWs.stripOrder]
    .map((tok) => sourceTokenToCopyToken.get(tok) ?? tok)
  reorderStrip(ws, stripOrder)

  ws.activeTabId =
    activeId ?? (ws.tabOrder.length > 0 ? ws.tabOrder[ws.tabOrder.length - 1] : null)
  if (ws.activeTabId !== null) setActiveTab(ws, deps, ws.activeTabId)

  pushTabsState(ws)
}

// Новое окно создается ПЕРВЫМ (renderer успечает прислать layout до переезда),
// затем view переносится. Иначе did-finish-load нового окна создаст лишнюю
// стартовую вкладку, а pushTabsState уйдет в пустоту.
/**
 * Переключить окно в приватный режим или обратно.
 *
 * Вкладки пересоздаются заново, а не переводятся: партиция задаётся на
 * WebContentsView в момент создания и сменить её у живой view нельзя.
 * Старые view закрываются, новые открываются по сохранённым URL.
 *
 * Что переносится: url, заголовок, иконка, закрепление, группа. Что НЕ
 * переносится: история вкладки, cookies, localStorage сайта — их нет в
 * приватной партиции в принципе. Поэтому переключение «туда» не
 * обратимо данными, а обратно вкладки просто откроются заново.
 *
 * Группы переносятся как есть: instanceId сохраняются, поэтому ссылки
 * вкладок на группы остаются валидными.
 *
 * Порядок обязателен: сначала снимаем все view, потом создаём новые.
 * Иначе панель на миг показала бы и старые, и новые вкладки, и при
 * большом числе вкладок activeTabId указывал бы на закрытую.
 */
export function switchIncognito(
  ws: WindowState,
  deps: TabsDeps,
  toIncognito: boolean
): void {
  if (!ws.window || ws.window.isDestroyed()) return
  if (ws.incognito === toIncognito) return

  // Слепок до разрушения: после закрытия view данных не будет.
  const saved = ws.tabOrder
    .map((id) => {
      const rec = ws.tabs.get(id)
      if (!rec) return null
      return {
        url: rec.url,
        title: rec.title,
        favicon: rec.favicon,
        customTitle: rec.customTitle,
        customFavicon: rec.customFavicon,
        pinned: rec.pinned,
        groupId: rec.groupId,
        active: id === ws.activeTabId
      }
    })
    .filter((t): t is NonNullable<typeof t> => t !== null)
  const groups = ws.openGroups.map((g) => ({ ...g }))

  // Старые view закрываем все до создания новых.
  for (const [tabId, rec] of ws.tabs) {
    try {
      // DevTools закрываем явно, до уничтожения view: панель принадлежит
      // view, и без closeDevTools Chromium сносит её вместе с webContents
      // молча. Само состояние обнуляем здесь же — карта вкладок очищается
      // строкой ниже, но closeDevToolsFor читает запись по id.
      closeDevToolsFor(ws, tabId)
      ws.window.contentView.removeChildView(rec.view)
      rec.view.webContents.close()
    } catch {
      // view уже мертва — игнорим.
    }
  }
  ws.tabs.clear()
  ws.tabOrder = []
  ws.stripOrder = []
  ws.pinnedStripOrder = []
  ws.openGroups = groups
  ws.activeTabId = null
  ws.incognito = toIncognito

  if (saved.length === 0) {
    createTab(ws, deps, START_URL)
    pushTabsState(ws)
    return
  }

  let activeId: number | null = null
  for (const t of saved) {
    const id = createTab(ws, deps, t.url)
    const rec = ws.tabs.get(id)
    if (!rec) continue
    rec.title = t.title
    rec.favicon = t.favicon
    rec.customTitle = t.customTitle
    rec.customFavicon = t.customFavicon
    rec.pinned = t.pinned
    rec.groupId = t.groupId
    if (t.groupId) removeStripToken(ws, `t:${id}`)
    if (t.active) activeId = id
  }
  // Активной делаем ту же вкладку, что была активной: переключение
  // режима не должно сбрасывать пользователя на первую вкладку.
  ws.activeTabId =
    activeId ?? (ws.tabOrder.length > 0 ? ws.tabOrder[ws.tabOrder.length - 1] : null)
  if (ws.activeTabId !== null) setActiveTab(ws, deps, ws.activeTabId)
  pushTabsState(ws)
}

// Новое окно создается ПЕРВЫМ (renderer успевает прислать layout до переезда),
// затем view переносится. Иначе did-finish-load нового окна создаст лишнюю
// стартовую вкладку, а pushTabsState уйдет в пустоту.
export function detachTabToNewWindow(
  fromWs: WindowState,
  deps: TabsDeps,
  id: number,
  sx: number,
  sy: number
): void {
  const rec = fromWs.tabs.get(id)
  if (!rec || !fromWs.window) return
  // Флаг приватности ставится ДО переноса view: у detached-вкладки партиция
  // уже задана при создании, и обычное окно принять приватную view не должно.
  const ws = deps.createWindow({
    x: Math.round(sx - 80),
    y: Math.round(sy - 40)
  })
  if (!ws.window) return
  ws.incognito = fromWs.incognito
  // Переносим view сразу: новое окно еще грузит renderer, вкладка уже в tabOrder.
  // did-finish-load увидит непустой tabs и не создаст стартовую.
  ws.tabs.set(id, rec)
  ws.tabOrder.push(id)
  ws.activeTabId = id
  // Detach уносит вкладку без группы — токен в ряд нового окна.
  if (!rec.groupId) ensureStripToken(ws, `t:${id}`, rec.pinned)

  fromWs.window.contentView.removeChildView(rec.view)
  fromWs.tabs.delete(id)
  fromWs.tabOrder = fromWs.tabOrder.filter((t) => t !== id)
  if (!rec.groupId) removeStripToken(fromWs, `t:${id}`)
  if (fromWs.activeTabId === id) {
    fromWs.activeTabId = null
    if (fromWs.tabOrder.length > 0) {
      setActiveTab(fromWs, deps, fromWs.tabOrder[fromWs.tabOrder.length - 1])
    } else {
      pushTabsState(fromWs)
    }
  } else {
    pushTabsState(fromWs)
  }
  // Пустое окно без вкладок закрываем, как в Chrome.
  if (fromWs.tabs.size === 0) fromWs.window.close()

  ws.window.contentView.addChildView(rec.view)
  rec.view.setVisible(true)
  deps.layoutView(ws, rec.view)
  pushTabsState(ws)
}
