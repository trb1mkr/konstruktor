import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { log, mark, perf, logError, setPageLoadCount } from './logger'

// Пул оверлей-окон: создание, прогрев и скрытие.
//
// Окно оверлея живёт постоянно: мы НИКОГДА не вызываем show()/hide().
// Причина: DWM (Desktop Window Manager) на Windows анимирует появление и
// скрытие frameless-окна, длительность берётся из системной настройки
// «Анимированные элементы управления и элементы внутри окна» (~200 мс).
// Ни setOpacity, ни prefers-reduced-motion, ни прогрев на старте её не
// отключают — а прогрев не помогает потому, что DWM анимирует КАЖДЫЙ цикл
// show/hide, а не только первый.
//
// Поэтому «показ» и «скрытие» делаем без смены видимости окна:
//   показать  = setBounds(реальные координаты) + setOpacity(1)
//   скрыть    = размонтировать содержимое + setOpacity(0)
// Окно всегда существует, содержимое в нём живёт только пока оверлей
// показан. Ни одного вызова show/hide → ни одной системной анимации.

// Канал управления содержимым: main сообщает окну, нужно ли убрать
// содержимое из рендера. Главный механизм скрытия, парковка координатами
// — вспомогательная и отключённая (PARK_MOVES_WINDOW).
const CONTENT_CHANNEL = 'overlay:park'

// Канал доставки данных. Страница загружается один раз без payload,
// дальше main шлёт сюда каждую новую сессию.
const PUSH_CHANNEL = 'overlay:push'
const UPDATE_CHANNEL = 'overlay:update'

// ОСТАРОВШЕЕСЯ. Перемещение окна при парковке выключено: содержимое и так
// размонтировано через v-if, окно прозрачно, ввод отключён. Позиция
// больше не является механизмом скрытия.
//
// Проверено измерениями: именно переезд между дисплеями стоил один кадр
// композитора (+16.6 мс на первом открытии). Парковка в пределах дисплея
// родителя задержку убирала, но и убирать перемещение полностью даёт тот
// же результат.
//
// true — прежнее поведение: уводить окно за экран. Оставлено как
// запасной вариант для Linux и для отката одной строкой.
//
// ВНИМАНИЕ: возвращать парковку, не разобравшись, почему клик проходил
// сквозь меню. Без перемещения окно лежит под курсором, Windows
// активирует его, родитель теряет фокус, и меню закрывается не получив
// выбора. Сейчас это закрыто проверкой overlay.isFocused() в closeOnBlur.
const PARK_MOVES_WINDOW = false

// Пул: parentId -> BrowserWindow. Окно одно на родителя и живёт до его
// закрытия, поэтому на каждый сеанс память не тратится.
const overlayPool = new Map<number, BrowserWindow>()

// Сколько раз загружалась страница оверлея. Per-window: у каждого
// родителя своё окно, и пересоздание окна даёт честную единицу.
//
// Приёмка шага 4a: значение равно 1 за всю жизнь окна. Рост означает,
// что навигация вернулась и меню снова перезагружает страницу.
const pageLoadCount = new Map<number, number>()

/** Сколько раз грузилась страница оверлея у данного родителя. */
export function getPageLoadCount(parentId: number): number {
  return pageLoadCount.get(parentId) ?? 0
}

// Готовность страницы оверлея. Страница грузится ОДИН раз при создании
// окна, и данные приходят через overlay:push, а не через навигацию.
const pageReady = new Map<number, boolean>()

// Push, пришедшие до did-finish-load. Renderer ещё не смонтирован и
// подписки не слушает — сообщение потерялось бы, поэтому копим.
const pendingPush = new Map<number, unknown[]>()

/**
 * Ждёт готовности страницы оверлея. Разрешается сразу, если страница
 * уже загружалась: перезагрузок больше нет, и showOverlay вызывается
 * много раз за жизнь окна.
 *
 * Возвращает true, если страница реально готова, и false, если сработала
 * страховка. Различие принципиально: вызывающий код по false обязан
 * отменить показ, а не показывать окно вслепую.
 *
 * Страховка 2 с: если did-finish-load по какой-то причине не придёт
 * (страница не стартовала), НЕ показываем ничего. Раньше здесь стояло
 * «показываем всё равно», но это приводило к потере сообщений: push уходил
 * в webContents без документа и молча пропадал, renderer не отвечал на
 * painted, и пользователь получал пустое непрозрачное окно без единой
 * ошибки в логах.
 *
 * Ключевое: по таймауту pageReady НЕ выставляется. Иначе пришедшая
 * позже загрузка не найдёт сессию, а буфер pushPayload решит, что
 * страница готова, и отправит сообщение в пустоту. Флаг ставит только
 * обработчик did-finish-load.
 *
 * @returns true — страница готова; false — страховка сработала.
 */
export function waitPageReady(overlay: BrowserWindow): Promise<boolean> {
  const parentId = overlay.id
  if (pageReady.get(parentId)) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (loaded: boolean): void => {
      if (settled) return
      settled = true
      overlay.webContents.removeListener('did-finish-load', onLoad)
      clearTimeout(timer)
      if (loaded) pageReady.set(parentId, true)
      resolve(loaded)
    }
    const onLoad = (): void => finish(true)
    overlay.webContents.once('did-finish-load', onLoad)
    const timer = setTimeout(() => {
      log('lifecycle', 'page ready timeout, aborting overlay', { parentId })
      finish(false)
    }, 2000)
  })
}

/**
 * Отправляет сессию в renderer. Если страница ещё не готова, сообщение
 * копится и уйдёт при did-finish-load.
 */
export function pushPayload(overlay: BrowserWindow, payload: unknown): void {
  if (overlay.isDestroyed()) return
  if (!pageReady.get(overlay.id)) {
    const queue = pendingPush.get(overlay.id) ?? []
    queue.push(payload)
    pendingPush.set(overlay.id, queue)
    return
  }
  try {
    overlay.webContents.send(PUSH_CHANNEL, payload)
  } catch (err) {
    logError('failed to push overlay payload', err)
  }
}

/**
 * Точечное обновление живой сессии: счётчик поиска, ошибка валидации.
 *
 * Отличается от pushPayload тем, что несёт не целую сессию, а патч
 * модели, и отбрасывается, если сессия успела смениться. Без проверки
 * токена счётчик от прошлого поиска appeared бы в новом — окно одно и то
 * же, и отличить их нечем.
 *
 * Обновления НЕ буферизуются: в отличие от сессии, патч не имеет смысла
 * без сессии, к которой он относится. Если страница ещё грузится, патч
 * уйдёт в никуда — но и показывать ему нечего, до загрузки оверлей
 * закрыт.
 *
 * @param sessionId токен сессии, к которой относится патч.
 * @param currentId токен текущей сессии; при несовпадении патч отбрасывается.
 * @returns true, если патч отправлен.
 */
export function updatePayload(
  overlay: BrowserWindow,
  sessionId: number,
  currentId: number,
  patch: unknown
): boolean {
  if (overlay.isDestroyed()) return false
  if (sessionId !== currentId) return false
  try {
    overlay.webContents.send(UPDATE_CHANNEL, { sessionId, patch })
    return true
  } catch (err) {
    logError('failed to send overlay update', err)
    return false
  }
}

/** Сбрасывает готовность и буфер — окно пересоздано. */
export function markPageDirty(overlay: BrowserWindow): void {
  pageReady.set(overlay.id, false)
  pendingPush.delete(overlay.id)
}

/**
 * Выбрасывает из буфера отменённые сессии.
 *
 * Нужен, когда сессия снята до отправки: сообщение, уже лежащее в
 * очереди, иначе уйдёт при did-finish-load в renderer и применит
 * содержимое уже несуществующей сессии. Для пользователя это лишний
 * перелив содержимого в закрытом окне, для логов — выглядит как
 * открытие меню без запроса.
 *
 * Чистим ВЫБОРОЧНО по sessionId. Полная очистка была бы неверной: если
 * к моменту отмены в очереди уже лежит payload более новой сессии, мы
 * снесли бы живое сообщение вместе с мёртвым.
 *
 * payload намеренно хранится как unknown — пул не знает формы
 * сообщения. Поэтому сверяем структурно: у PushMessage поле sessionId
 * есть, и по нему отбор точный. Всё, что поля не содержит, считаем
 * чужим и не трогаем.
 *
 * @returns сколько сообщений выброшено.
 */
export function dropPendingPush(overlay: BrowserWindow, sessionId: number): number {
  const queue = pendingPush.get(overlay.id)
  if (!queue?.length) return 0
  const kept = queue.filter((msg) => {
    if (typeof msg !== 'object' || msg === null) return true
    return (msg as { sessionId?: unknown }).sessionId !== sessionId
  })
  const dropped = queue.length - kept.length
  if (dropped === 0) return 0
  if (kept.length) pendingPush.set(overlay.id, kept)
  else pendingPush.delete(overlay.id)
  log('lifecycle', 'dropped pending overlay payloads', {
    parentId: overlay.id,
    sessionId,
    dropped
  })
  return dropped
}

// parentId -> true, пока содержимое размонтировано (окно «спрятано»).
// Нужно, чтобы слушатели move/resize/minimize/blur не реагировали на
// собственные действия и не закрывали активный оверлей.
const contentUnmounted = new Set<number>()

/**
 * @deprecated Устарело. Парковка позицией выключена (PARK_MOVES_WINDOW).
 * Скрытие содержимого обеспечивают размонтирование, прозрачность и
 * отключение ввода. Оставлено для Linux и для отката одной строкой.
 */
function parkPosition(): { x: number; y: number } {
  // Верхний левый угол объединённой рабочей области всех дисплеев.
  // Паркуем выше и левее него: в эту точка физически нельзя попасть
  // курсором, и она гарантированно вне любого монитора, включая
  // расположенные слева (с отрицательным x).
  let minX = 0
  let minY = 0
  for (const d of screen.getAllDisplays()) {
    minX = Math.min(minX, d.workArea.x)
    minY = Math.min(minY, d.workArea.y)
  }
  // Запас 2000px достаточен, чтобы не попасть в зону автопоказа, и не
  // выходит за пределы int-диапазона ОС.
  return { x: minX - 2000, y: minY - 2000 }
}

// Размеры парковочного окна. По умолчанию реальные (не 1x1), чтобы при
// возврате не было пересоздания/ресайза.
function parkBounds(width: number, height: number): Electron.Rectangle {
  const p = parkPosition()
  return { x: p.x, y: p.y, width, height }
}

// Окно внутри рабочей области какого-либо дисплея?
// Возвращает true, если хотя бы один прямоугольник пересекается.
export function intersectsWorkArea(r: Electron.Rectangle): boolean {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea
    const overlapX = Math.min(r.x + r.width, a.x + a.width) - Math.max(r.x, a.x)
    const overlapY = Math.min(r.y + r.height, a.y + a.height) - Math.max(r.y, a.y)
    return overlapX > 0 && overlapY > 0
  })
}

/**
 * @deprecated Устарело. См. PARK_MOVES_WINDOW. На Windows клик по
 * непрозрачной области проходил сквозь окно, лежащее под курсором, и
 * закрывал меню; возвращать парковку следует только вместе с проверкой
 * overlay.isFocused() в обработчике blur.
 */
function parkOffscreen(overlay: BrowserWindow, width: number, height: number): void {
  overlay.setBounds(parkBounds(width, height))
  let actual = overlay.getBounds()
  if (!intersectsWorkArea(actual)) return

  // Не сработало — сжимаем до 1x1 и уводим ещё дальше.
  const far = parkPosition()
  overlay.setBounds({ x: far.x - 4000, y: far.y - 4000, width: 1, height: 1 })
  actual = overlay.getBounds()
  if (intersectsWorkArea(actual)) {
    // Совсем крайний случай: WM упорно держит окно на экране. Сообщаем
    // в лог, чтобы это было видно, а не молча ловилось на глаз.
    logError('overlay could not be parked off-screen', { bounds: actual })
  }
}

/**
 * @deprecated Устарело. Парковочная позиция В ПРЕДЕЛАХ дисплея родителя.
 * Вариант, проверенный измерениями: переезд между дисплеями стоил один
 * кадр композитора, а парковка в пределах дисплея родителя его
 * устраняла. Неработающий путь — если над дисплеем нет места.
 */
function parkBoundsWithinDisplay(
  display: Electron.Display,
  width: number,
  height: number
): Electron.Rectangle | null {
  // Пробуем сначала над дисплеем, потом под ним. Оба варианта вне
  // workArea, поэтому intersectsWorkArea() обязан вернуть false.
  const candidates: Electron.Rectangle[] = [
    { x: display.bounds.x, y: display.bounds.y - height, width, height },
    {
      x: display.bounds.x,
      y: display.bounds.y + display.bounds.height,
      width,
      height
    }
  ]
  for (const c of candidates) {
    if (intersectsWorkArea(c)) continue
    return c
  }
  return null
}

/**
 * @deprecated Устарело. Паркует окно на дисплее родителя. Возвращает
 * true, если сработало.
 */
function parkOnParentDisplay(
  overlay: BrowserWindow,
  parent: BrowserWindow,
  width: number,
  height: number
): boolean {
  // getDisplayMatching, а не getDisplay: он есть в Electron, а
  // getDisplay(bounds) — нет. Совпадение с окном родителя даёт нужный
  // дисплей и заодно корректно для многомониторной раскладки.
  const display = screen.getDisplayMatching(parent.getBounds())
  const bounds = parkBoundsWithinDisplay(display, width, height)
  if (!bounds) {
    log('geometry', 'no off-screen slot on parent display', {
      parentId: parent.id,
      displayId: display.id,
      width,
      height
    })
    return false
  }
  overlay.setBounds(bounds)
  const actual = overlay.getBounds()
  const actualDisplay = screen.getDisplayMatching(actual)
  const ok = !intersectsWorkArea(actual) && actualDisplay.id === display.id
  log('geometry', 'content unmounted on parent display', {
    parentId: parent.id,
    want: bounds,
    got: actual,
    onScreen: intersectsWorkArea(actual),
    wantDisplayId: display.id,
    gotDisplayId: actualDisplay.id,
    ok
  })
  return ok
}

// Сообщаем окну, размонтировано ли содержимое.
//
// Флаг про РАЗМОНТИРОВАНИЕ: true = содержимое убрано из рендера.
//
// Отправляем всегда, даже если webContents грузится: сообщение в очереди
// дойдёт после перезагрузки страницы, а проверка isLoading() оставила бы
// окно с содержимым на экране. В prod loadFile с hash = полный reload,
// renderer пересоздаётся и его состояние contentUnmounted сбрасывается.
export function setContentUnmounted(overlay: BrowserWindow, unmounted: boolean): void {
  try {
    overlay.webContents.send(CONTENT_CHANNEL, unmounted)
  } catch (err) {
    logError('failed to send content state', err)
  }
}

// Скрывает окно (бывшая parkOverlay): размонтирует содержимое, гасит
// прозрачность и выключает ввод. Перемещение — только если PARK_MOVES_WINDOW.
//
// Порядок обязателен: сначала опустошаем окно, и только потом перемещаем.
// Иначе в промежутке между setBounds и прозрачностью WM успевает показать
// кадр со старым содержимым.
export function hideContent(overlay: BrowserWindow, parentId?: number): void {
  if (overlay.isDestroyed()) return
  try {
    setContentUnmounted(overlay, true)
    overlay.setOpacity(0)
    // Выключаем ввод: спрятанный кликабельный оверлей перехватывал
    // клики и слал dismiss в цикл.
    overlay.setIgnoreMouseEvents(true, { forward: false })
    // Перемещение окна — отдельный слой. Содержимое уже размонтировано,
    // прозрачно и некликабельно, поэтому парковка позицией не обязательна.
    if (PARK_MOVES_WINDOW) {
      const b = overlay.getBounds()
      if (parentId !== undefined) {
        const parent = BrowserWindow.fromId(parentId)
        if (parent && !parent.isDestroyed()) {
          if (!parkOnParentDisplay(overlay, parent, b.width, b.height)) {
            parkOffscreen(overlay, b.width, b.height)
          }
        } else {
          parkOffscreen(overlay, b.width, b.height)
        }
      } else {
        parkOffscreen(overlay, b.width, b.height)
      }
    }
    if (parentId !== undefined) {
      contentUnmounted.add(parentId)
      log('lifecycle', 'overlay content unmounted', { parentId })
    }
  } catch (err) {
    logError('failed to hide overlay content', err)
  }
}

// Содержимое окна размонтировано? Слушатели родителя проверяют это,
// чтобы не реагировать на собственные действия пула.
export function isContentUnmounted(parentId: number): boolean {
  return contentUnmounted.has(parentId)
}

// Пометить окно показанным: снимает флаг размонтирования после
// подтверждения отрисовки.
export function markContentShown(parentId: number): void {
  contentUnmounted.delete(parentId)
}

// Пометить окно размонтированным. Вызывается в начале показа, до
// подтверждения отрисовки: с этого момента и до концаpresent() окно
// не должно считаться показанным, иначе слушатели родителя среагируют
// на собственные setBounds и закроют только что открытое меню.
export function markContentUnmounted(parentId: number): void {
  contentUnmounted.add(parentId)
}

// Окно из пула, если оно живо.
export function getPooledOverlay(parentId: number): BrowserWindow | undefined {
  const win = overlayPool.get(parentId)
  return win && !win.isDestroyed() ? win : undefined
}

/**
 * Родитель по id окна оверлея — по карте ОКОН, а не по сессиям.
 *
 * Нужна именно карта окон: сессия оверлея живёт секунды, а окно — всю
 * жизнь. Случай, где это различие критично: приложение ушло в фон по
 * Alt+Tab, оверлей закрылся, сессия снята — но Windows при возврате
 * отдаёт фокус окну оверлея (оно focusable, см. createOverlayWindow).
 * Определять родителя по active в этот момент уже нечем, а оверлей
 * прозрачный и пустой: клавиши уходят в его webContents, и Ctrl+F не
 * работает, пока пользователь не кликнет по странице.
 *
 * @returns id родителя или undefined, если это не окно оверлея.
 */
export function parentOfPooledOverlay(overlayId: number): number | undefined {
  for (const [parentId, win] of overlayPool) {
    if (!win.isDestroyed() && win.id === overlayId) return parentId
  }
  return undefined
}

// Путь к preload оверлея. Вынесен, потому что нужен и пулу, и manager.
function overlayPreload(): string {
  return join(__dirname, '../preload/overlay.cjs')
}

// Путь к странице оверлея без payload.
function overlayPage(): string {
  return join(__dirname, '../renderer/menu.html')
}

// Создаёт оверлей-окно. Опции одинаковы для прогрева и для ленивого
// fallback в showOverlay — расхождение между ними давало окна, которые
// вели себя по-разному.
function createOverlayWindow(parent: BrowserWindow): BrowserWindow {
  return new BrowserWindow({
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    parent,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    focusable: true,
    webPreferences: {
      preload: overlayPreload(),
      contextIsolation: true,
      sandbox: false
    }
  })
}

// Загружает страницу оверлея. В dev — на Vite-сервер, в prod — с диска.
//
// Страница грузится ОДИН раз за жизнь окна, без payload. Данные приходят
// через overlay:push — навигации больше нет, поэтому и перезагрузки в
// prod нет (раньше loadFile с hash давал полный reload на каждое меню).
function loadOverlayPage(overlay: BrowserWindow): void {
  pageReady.set(overlay.id, false)
  pendingPush.delete(overlay.id)
  // Считаем загрузку: 1 = страница загружена один раз, как и задумано.
  // Всё, что больше, — возврат навигации.
  const loadCount = (pageLoadCount.get(overlay.id) ?? 0) + 1
  pageLoadCount.set(overlay.id, loadCount)
  log('lifecycle', 'overlay page loading', {
    parentId: overlay.id,
    loadCount
  })
  // Сводка печатается в логгере раз в 5 минут, а счётчик живёт здесь.
  // Связь односторонняя: пул -> логгер. Обратной не будет, иначе
  // возникнет циклический импорт.
  //
  // Суммируем по всем окнам: у нескольких родителей на каждый своё
  // окно, и в сводке нужно общее число загрузок.
  let total = 0
  for (const count of pageLoadCount.values()) total += count
  setPageLoadCount(total)
  // Подписка на слитие очереди должна висеть ДО load: на быстром кэше
  // did-finish-load приходит раньше, чем сработает подписка из showOverlay.
  overlay.webContents.on('did-finish-load', () => {
    pageReady.set(overlay.id, true)
    const queue = pendingPush.get(overlay.id)
    if (!queue?.length) return
    pendingPush.delete(overlay.id)
    for (const msg of queue) {
      try {
        overlay.webContents.send(PUSH_CHANNEL, msg)
      } catch (err) {
        logError('failed to flush overlay payload', err)
      }
    }
    log('lifecycle', 'flushed buffered overlay payloads', {
      parentId: overlay.id,
      count: queue.length
    })
  })
  // ДИАГНОСТИКА: искусственная задержка загрузки страницы. Нужна, чтобы
  // проверить, что происходит, когда push приходит ДО готовности
  // страницы: ждёт ли waitPageReady, срабатывает ли буфер pendingPush,
  // и что делает страховка в 2 с.
  //
  // Задерживаем сам вызов load, а не функцию: loadOverlayPage синхронная
  // и вызывается из ensureOverlayWindow, где блокировка означала бы
  // блокировку прогорева. did-finish-load придёт позже сам по себе, и
  // pageReady останется false до этого момента — ровно то поведение,
  // которое мы хотим воспроизвести.
  const delay = Number(process.env['OVERLAY_PAGE_LOAD_DELAY_MS'] ?? '0') || 0
  const startLoad = (): void => {
    if (overlay.isDestroyed()) return
    if (process.env['ELECTRON_RENDERER_URL']) {
      void overlay.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/menu.html`)
    } else {
      void overlay.loadFile(overlayPage())
    }
  }
  if (delay > 0) {
    log('lifecycle', 'overlay page load artificially delayed', {
      parentId: overlay.id,
      delayMs: delay
    })
    setTimeout(startLoad, delay)
  } else {
    startLoad()
  }
}

// Хуки, которые снаружи нужны менеджеру сессий. Передаются явно, чтобы
// пул не зависел от модуля сессий и не было циклического импорта.
export interface PoolHooks {
  // Окно уничтожено: снять запись об активной сессии.
  onWindowClosed: (parentId: number) => void
  // Родитель потерял фокус или переместился: закрыть активный оверлей.
  onParentEvent: (parent: BrowserWindow) => void
}

// Создаёт оверлей-окно заранее и кладёт в пул, не показывая его.
// Вызывается при создании основного окна браузера, чтобы первый оверлей
// открывался мгновенно (без задержки на new BrowserWindow + load).
export function ensureOverlayWindow(parent: BrowserWindow, hooks: PoolHooks): void {
  if (overlayPool.has(parent.id)) return
  mark('overlay:prewarm')
  log('pool', 'prewarming window', { parentId: parent.id })
  const overlay = createOverlayWindow(parent)
  overlayPool.set(parent.id, overlay)

  overlay.on('closed', () => {
    overlayPool.delete(parent.id)
    pageReady.delete(overlay.id)
    pendingPush.delete(overlay.id)
    pageLoadCount.delete(overlay.id)
    hooks.onWindowClosed(parent.id)
  })
  hooks.onParentEvent(parent)
  // Прогрев завершён, когда страница оверлея загрузилась.
  overlay.once('ready-to-show', () => {
    perf('prewarm', 'overlay:prewarm', { parentId: parent.id })
    // Показываем ровно один раз за жизнь окна, чтобы оно получило
    // видимость у DWM, и сразу прячем содержимое. Дальше show()/hide()
    // не вызываются НИКОГДА — это и убирает системную анимацию.
    overlay.showInactive()
    hideContent(overlay, parent.id)
  })
  loadOverlayPage(overlay)
}

// Ленивый fallback: если прогрев не успел или окно было уничтожено.
// Создаёт окно, вешает те же слушатели и сразу прячет содержимое.
export function createOverlay(parent: BrowserWindow, hooks: PoolHooks): BrowserWindow {
  const overlay = createOverlayWindow(parent)
  overlayPool.set(parent.id, overlay)

  overlay.on('closed', () => {
    overlayPool.delete(parent.id)
    pageReady.delete(overlay.id)
    pendingPush.delete(overlay.id)
    pageLoadCount.delete(overlay.id)
    hooks.onWindowClosed(parent.id)
  })
  hooks.onParentEvent(parent)
  overlay.once('ready-to-show', () => {
    overlay.showInactive()
    hideContent(overlay, parent.id)
  })
  loadOverlayPage(overlay)
  return overlay
}

// Диагностика: снять фактические границы после скрытия. setBounds —
// просьба, а не команда: WM может положить окно в рабочую область
// соседнего дисплея, и это видно только здесь.
export function logBoundsAfterHide(overlay: BrowserWindow, parentId: number): void {
  const after = overlay.getBounds()
  log('geometry', 'after unmount', {
    parentId,
    bounds: after,
    onScreen: intersectsWorkArea(after),
    displayId: screen.getDisplayMatching(after).id
  })
}
