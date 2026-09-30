import { BrowserWindow, dialog, ipcMain, nativeTheme, screen } from 'electron'
import { join } from 'path'
import { getSettingsSync } from './settingsStore'
import { verifyIconSource, verifyEmojiButton, fileToIconDataUrl } from './iconVerify'
import { buildIconErrorScript } from './findScripts'
import { log, mark, perf, recordOpen, logError } from './overlay/logger'

// Менеджер оверлей-окон: прозрачные frameless-окна поверх основного,
// в них DOM-меню/тосты/попапы любой темы. Замена системному Menu.popup,
// который на Windows всегда светлый и не стилизуется.
//
// Жизненный цикл: showOverlay создает окно, select/dismiss закрывают.
// Одновременно жив только один оверлей на родителя — новый вытесняет старый.
// Родитель moved/resized/minimized/blurred — оверлей закрывается сам.

export interface OverlayMenuItem {
  id: string
  label: string
  icon: string
  // Цвет группы (для Add to group): точка-индикатор как на панели закладок.
  color?: string
  disabled?: boolean
}

export interface OverlayDialogButton {
  id: string
  label: string
}

// Общий диалог иконки: одно поле ввода + 4 кнопки (URL, файл, emoji, отмена).
// В поле вводится любой из трех источников, при нажатии тип верифицируется:
// URL (http/file/data/konstruktor), локальный путь к файлу (-> file://),
// одиночный emoji (-> emoji:). Пустой ввод = сброс иконки.
export interface IconDialogState {
  title: string
  placeholder?: string
  initial?: string
}

// Верификация источника иконки живет в iconVerify.ts (чистая функция,
// тестируется без Electron). Здесь — реэкспорт для старых импортов.
export { verifyIconSource } from './iconVerify'

interface OverlayRequest {
  kind: 'menu' | 'toast' | 'dialog' | 'find' | 'icon'
  anchor: { x: number; y: number }
  items?: OverlayMenuItem[]
  incognito?: boolean
  toast?: { title: string; body?: string; timeout?: number }
  dialog?: { title: string; buttons: OverlayDialogButton[] }
  icon?: IconDialogState
  find?: { query?: string }
  onSelect?: (id: string) => void
  // Контекст общего диалога иконки: apply вызывается после верификации.
  // Хранится и в request, и дублируется на overlay (__iconApply) —
  // хендлер overlay:submit-icon находит его по sender-окну.
  onIconApply?: (icon: string) => void
  // Выравнивание меню относительно якоря: 'end' — правый край меню
  // у якоря (кнопка ☰), 'start' — левый край у якоря (контекстное меню).
  align?: 'end' | 'start'
  // Повторный вызов того же вида при уже открытом оверлее закрывает его
  // вместо повторного показа. Нужно кнопкам-триггерам (☰ меню браузера):
  // второй клик по кнопке закрывает, как в обычных браузерах.
  // Идентификатор триггера для toggle. Повторный клик по ТОМ ЖЕ триггеру
  // закрывает открытое им меню; клик по другому триггеру (☰ браузера, когда
  // открыто меню вкладки) просто показывает своё меню. Ключ обязателен —
  // без него toggle закрывал бы чужое открытое меню.
  toggleKey?: string
}

// Активная сессия оверлея: parentId -> { overlay, request, sessionId }.
// sessionId — токен сессии, по нему проверяется, что активна именно та
// сессия, а не другая (см. resolveOverlaySelect).
// openedAt — момент открытия: по нему отсекается эхо открывающего
// клика (см. closeOverlayIfMenu).
interface ActiveOverlay {
  overlay: BrowserWindow
  request: OverlayRequest
  sessionId: number
  openedAt: number
}

const active = new Map<number, ActiveOverlay>()

// parentId -> { toggleKey, at } последнего ЗАКРЫТОГО меню. Нужно, чтобы
// отличить эхо открывающего клика от настоящего повторного клика по
// триггеру: и то и другое приходит в showOverlay с одинаковым toggleKey,
// но эхо — сразу после закрытия, а настоящий клик — спустя время.
const lastClosed = new Map<number, { toggleKey?: string; at: number }>()

// Сколько живёт запись о закрытии. Эхо приходит в том же тике, поэтому
// достаточно небольшого окна; 250 мс запас на медленный prod-перезапуск.
const TOGGLE_ECHO_MS = 250

// Флаг: открыт ли системный диалог (файл/сохранение) — чтобы игнорировать blur/move/resize
let isSystemDialogOpen = false

// Переиспользуемые оверлей-окна: parentId -> BrowserWindow (скрыто когда не используется)
const overlayPool = new Map<number, BrowserWindow>()

// Оверлейное окно живёт постоянно: мы НИКОГДА не вызываем show()/hide().
// Причина: DWM (Desktop Window Manager) на Windows анимирует появление и
// скрытие frameless-окна, длительность берёт из системной настройки
// «Анимированные элементы управления и элементы внутри окна» (~200 мс).
// Ни setOpacity, ни prefers-reduced-motion, ни прогрев на старте её не
// отключают — а прогрев не помогает потому, что DWM анимирует КАЖДЫЙ цикл
// show/hide, а не только первый.
//
// Поэтому «показ» и «скрытие» делаем без смены видимости окна:
//   показать  = setBounds(реальные координаты) + setOpacity(1)
//   скрыть    = parkOffscreen() + setOpacity(0)
// Окно всегда существует и всегда «видимо» для OS, но в парке оно за
// пределами экрана и прозрачно — пользователь его не видит и не может
// кликнуть. Ни одного вызова show/hide → ни одной системной анимации.

// Парковочная позиция. НЕЛЬЗЯ хардкодить отрицательные координаты:
// при мониторе СЛЕВА (x < 0) точка вроде (-32000, -32000) оказывается
// внутри его рабочей области — оверлей оказывался виден на втором
// мониторе вместо парковки, а клики по нему работали как по живому меню.
// Поэтому паркуем за пределы объединённой рабочей области всех
// дисплеев: x/y считаются от display.workArea и всегда за экраном.
/**
 * @deprecated Устарело. Парковка позицией выключена (PARK_MOVES_WINDOW).
 * Скрытие содержимого обеспечивают размонтирование, прозрачность и
 * отключение ввода. Оставлено для Linux и для отката одной строкой.
 */
function parkPosition(): { x: number; y: number } {
  // Верхний левый угол объединённой рабочей области всех дисплеев.
  // Паркуем выше и левее него: в эту точку физически нельзя попасть
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
function intersectsWorkArea(r: Electron.Rectangle): boolean {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea
    const overlapX = Math.min(r.x + r.width, a.x + a.width) - Math.max(r.x, a.x)
    const overlapY = Math.min(r.y + r.height, a.y + a.height) - Math.max(r.y, a.y)
    return overlapX > 0 && overlapY > 0
  })
}

// Уводит окно за пределы рабочей области, ПРОВЕРЯЯ результат.
//
// Почему проверка обязательна: `setBounds` с координатами за экраном —
// это просьба, а не команда. Оконный менеджер вправе её проигнорировать:
// на Linux X11/Wayland координаты клампятся в рабочую область ближайшего
// дисплея, и окно оказывается на соседнем мониторе. Отсюда редкие
// «выстрелы» — в 9 случаях из 10 парковка срабатывала, на десятый раз
// WM не успел и оверлей мелькнул на экране.
//
// Стратегия: пробуем увести с реальным размером, читаем фактические
// границы и, если окно всё ещё на экране, повторяем уже крохотным — 1x1
// в углу. Крохотное прозрачное окно без содержимого не занимает ничего
// и не перехватывает клики, даже если WM впихнёт его в угол.
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

// Парковочная позиция В ПРЕДЕЛАХ дисплея родителя.
//
// В отличие от parkPosition(), которая уводит окно за объединённую
// рабочую область (то есть на другой дисплей при их наличии), эта
// функция оставляет окно на том же дисплее, но выше его рабочей
// области. Дисплей не меняется, поэтому композитор не пересоздаёт
// поверхность — а именно это, по логам, стоило один кадр (16.6 мс)
// на первом открытии.
//
// Возвращает null, если такого положения не существует (например,
// над дисплеем нет места) — тогда вызывающий код откатится к обычной
// парковке.
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

// Паркует окно на дисплее родителя. Возвращает true, если сработало.
/**
 * @deprecated Устарело. Вариант парковки, проверенный измерениями:
 * переезд между дисплеями стоил один кадр композитора, а парковка в
 * пределах дисплея родителя его устраняла. Неработающий путь — если
 * над дисплеем нет места. Оставлено для Linux и для отката.
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

// УСТАРЕЛО. Перемещение окна при парковке выключено: содержимое и так
// размонтировано через v-if, окно прозрачно, ввод отключён. Позиция
// больше не является механизмом скрытия.
//
// Проверено измерениями: именно переезд между дисплеями стоил один
// кадр композитора (+16.6 мс на первом открытии). Парковка в пределах
// дисплея родителя задержку убирала, но и убирать перемещение полностью
// даёт тот же результат.
//
// true — прежнее поведение: уводить окно за экран. Оставлено как
// запасной вариант для Linux и для отката одной строкой.
const PARK_MOVES_WINDOW = false

const CONTENT_CHANNEL = 'overlay:park'

// Renderer сообщает, что применил contentUnmounted=false и кадр отдан.
// Только после этого main возвращает прозрачность окну.
const PAINTED_CHANNEL = 'overlay:painted'

// Монотонный счетчик сессий оверлея. Каждое открытие получает новый
// токен: renderer подтверждает отрисовку именно этого токена, а main
// игнорирует подтверждения от устаревших сессий (защита от гонок).
let sessionCounter = 0

// parentId -> { token, resolve }. Пока Promise не разрешён, окно держится
// прозрачным: показывать старые пункты нового меню нельзя.
const pendingReady = new Map<number, { token: number; resolve: () => void }>()

// parentId -> true, пока окно парковано (невидимо). Нужно, чтобы
// слушатели move/resize/minimize не реагировали на собственную парковку
// и не закрывали активное меню в момент setBounds.
const contentUnmounted = new Set<number>()

// parentId -> время, до которого родительский blur не считается
// переключением на чужое окно. Заполняется noteFocusHandoff.
const focusHandoff = new Map<number, number>()

// Сколько живёт пометка передачи фокуса. Столько нужно, чтобы focus()
// оверлея дошёл до него на Linux: там он асинхронный, и в момент blur
// родителя overlay.isFocused() ещё вернул бы false.
const FOCUS_HANDOFF_MS = 400

// Оверлей намеренно забирает фокус (панель поиска, автофокус поля в
// диалоге) — родитель закономерно его теряет. Такой blur пропускаем.
function noteFocusHandoff(parentId: number): void {
  focusHandoff.set(parentId, Date.now() + FOCUS_HANDOFF_MS)
}

const MENU_W = 260
const MENU_ITEM_H = 40
const MENU_PAD = 20
const DIALOG_W = 320
const DIALOG_H = 190
// Общий диалог иконки: поле + 4 кнопки, выше обычного диалога.
const ICON_W = 340
const ICON_H = 250
// Панель поиска: ширина как у VS Code, высота под одну строку + отступ.
const FIND_W = 380
const FIND_H = 56

function menuHeight(items: OverlayMenuItem[], incognito: boolean): number {
  return MENU_PAD + items.length * MENU_ITEM_H + (incognito ? 26 : 0)
}

function overlayUrl(payload: object): string {
  const encoded = encodeURIComponent(JSON.stringify(payload))
  if (process.env['ELECTRON_RENDERER_URL']) {
    return `${process.env['ELECTRON_RENDERER_URL']}/menu.html#payload=${encoded}`
  }
  return `file://${join(__dirname, '../renderer/menu.html')}#payload=${encoded}`
}

// Создаёт оверлей-окно заранее и кладёт в пул, не показывая его.
// Вызывается при создании основного окна браузера, чтобы первый оверлей
// открывался мгновенно (без задержки на new BrowserWindow + load).
// Вешает слушатели, которые закрывают активный оверлей при потере
// родителя: движение, ресайз, сворачивание и ПЕРЕКЛЮЧЕНИЕ НА ДРУГОЕ ОКНО.
//
// Отдельный 'blur' обязателен: у minimize/move/resize есть события, а
// переключение на чужое окно их не стреляет — родитель остаётся на месте
// и не меняет размеры. Оверлей при этом `alwaysOnTop: true` и висит
// поверх чужого окна, показывая меню не того приложения. Своим 'blur'
// поймать нельзя: меню открывается через showInactive(), фокус у
// оверлея не было, значит и blur не придёт. Ловим по родителю.
function attachParentListeners(parent: BrowserWindow, overlay: BrowserWindow): void {
  const closeOnParent = () => {
    if (isSystemDialogOpen) return
    // Паркованное окно невидимо: парковка двигает его через setBounds,
    // и без этой проверки каждое движение родителя засоряло бы лог
    // и закрывало активное меню в момент установки bounds.
    if (contentUnmounted.has(parent.id)) return
    log('lifecycle', 'parent move/resize/minimize -> close', { parentId: parent.id })
    closeOverlay(parent)
  }
  const closeOnBlur = () => {
    if (isSystemDialogOpen) return
    if (contentUnmounted.has(parent.id)) return
    // Переключение на чужое окно не стреляет ни move, ни resize, ни
    // minimize — ловим только здесь. Иначе оверлей alwaysOnTop висит
    // поверх чужого окна с меню не того приложения.
    //
    // Исключение — намеренная передача фокуса оверлею: панель поиска
    // забирает фокус через focus(), диалоги — автофокусом поля ввода.
    // Родитель закономерно его теряет. Проверять надо по метке времени,
    // а НЕ по overlay.isFocused(): focus() на Linux асинхронный, и в
    // момент blur родителя оверлей ещё не успел получить фокус — панель
    // поиска закрылась бы сразу после открытия.
    const until = focusHandoff.get(parent.id) ?? 0
    if (Date.now() < until) return
    // Оверлей открыт через showInactive() и сам по себе фокуса не берёт.
    // Но если он лежит ПОД КУРСОРОМ (парковка больше не уводит окно за
    // экран), клик по родителю активирует наше окно, и blur родителя —
    // не переключение пользователя на другое приложение, а побочный
    // эффект нажатия. Раньше окно стояло за экраном и в hit-test не
    // попадало, поэтому этой ситуации не было.
    //
    // isFocused() на Windows синхронный, поэтому надёжно отличает "фокус
    // забрали мы" от "пользователь ушёл в другое приложение". На Linux
    // focus() асинхронный — там остаётся временная метка выше.
    if (process.platform === 'win32' && overlay.isFocused()) {
      log('lifecycle', 'parent blur by own overlay, ignored', { parentId: parent.id })
      return
    }
    log('lifecycle', 'parent blur -> close', { parentId: parent.id })
    closeOverlay(parent)
  }
  // Esc закрывает активный оверлей. Ловим на родителе, потому что сам
  // оверлей открыт через showInactive() и клавиши не получает — Esc уходит
  // в страницу, и renderer оверлея его не видит.
  //
  // Тосты исключены: они пассивны, живут по своему таймеру и гаситься
  // пользователем не должны. find/dialog/icon — наоборот, обязаны
  // закрываться, причём не теряя введённый текст.
  const onBeforeInput = (
    event: Electron.Event,
    input: Electron.Input
  ): void => {
    if (input.type !== 'keyDown' || input.key !== 'Escape') return
    const entry = active.get(parent.id)
    if (!entry) return
    if (entry.request.kind === 'toast') return
    event.preventDefault()
    log('session', 'esc closes overlay', {
      parentId: parent.id,
      kind: entry.request.kind
    })
    closeOverlay(parent)
  }
  parent.on('move', closeOnParent)
  parent.on('resize', closeOnParent)
  parent.on('minimize', closeOnParent)
  parent.on('blur', closeOnBlur)
  parent.webContents.on('before-input-event', onBeforeInput)
  overlay.on('closed', () => {
    parent.removeListener('move', closeOnParent)
    parent.removeListener('resize', closeOnParent)
    parent.removeListener('minimize', closeOnParent)
    parent.removeListener('blur', closeOnBlur)
    parent.webContents.removeListener('before-input-event', onBeforeInput)
  })
}

export function ensureOverlayWindow(parent: BrowserWindow): void {
  if (overlayPool.has(parent.id)) return
  const t0 = mark('overlay:prewarm')
  log('pool', 'prewarming window', { parentId: parent.id })
  const overlay = new BrowserWindow({
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    parent,
    show: false,
    frame: false,
    transparent: true,    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    focusable: true,
    webPreferences: {
      preload: join(__dirname, '../preload/overlay.cjs'),
      contextIsolation: true,
      sandbox: false
    }
  })
  overlayPool.set(parent.id, overlay)

  const cleanup = () => {
    if (active.get(parent.id)?.overlay === overlay) active.delete(parent.id)
  }
  overlay.on('closed', cleanup)
  overlay.on('blur', () => {
    if (isSystemDialogOpen) return
    log('lifecycle', 'blur -> close', { parentId: parent.id })
    closeOverlay(parent)
  })
  attachParentListeners(parent, overlay)
  // Прогрев завершён, когда страница оверлея загрузилась.
  overlay.once('ready-to-show', () => {
    perf('prewarm', 'overlay:prewarm', { parentId: parent.id })
    // Показываем ровно один раз за жизнь окна, чтобы оно получило
    // видимость у DWM, и сразу уводим в парк. Дальше show()/hide()
    // не вызываются НИКОГДА — это и убирает системную анимацию.
    overlay.showInactive()
    parkOverlay(overlay, parent.id)
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    void overlay.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/menu.html`)
  } else {
    void overlay.loadFile(join(__dirname, '../renderer/menu.html'))
  }
}

// Паркует оверлей при ЗАКРЫТИИ: гасит всё содержимое и уводит окно за
// экран. Перемещение здесь безобидно — пользователь ничего не ждёт, а
// припаркованное окно не торчит на соседнем мониторе.
//
// При ПЕРЕКЛЮЧЕНИИ сессии парковка тоже применяется, но обязательно
// ПОСЛЕ опустошения окна: иначе в промежутке между setBounds и прозрачностью
// WM успевает показать кадр со старым содержимым, и это видно как моргание.
function parkOverlay(overlay: BrowserWindow, parentId?: number): void {
  if (overlay.isDestroyed()) return
  try {
    // Порядок обязателен: опустошаем окно, и только потом уводим за
    // экран. Иначе в промежутке между setBounds и прозрачностью WM
    // успевает показать кадр со старым содержимым.
    setContentMounted(overlay, true)
    overlay.setOpacity(0)
    // Выключаем ввод: припаркованный кликабельный оверлей перехватывал
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
    logError('failed to park overlay', err)
  }
}

// Сообщаем окну, показывать ли содержимое.
//
// Отправляем всегда, даже если webContents грузится: сообщение в очереди
// дойдёт после перезагрузки страницы, а проверка isLoading() оставила бы
// окно с контентом на экране. В prod loadFile с hash = полный reload,
// renderer пересоздаётся и его состояние contentUnmounted сбрасывается.
function setContentMounted(overlay: BrowserWindow, value: boolean): void {
  try {
    overlay.webContents.send(CONTENT_CHANNEL, value)
  } catch (err) {
    logError('failed to send park state', err)
  }
}

// Renderer подтвердил, что сессия с токеном отрисована. Разрешаем показ.
// Токен сверяется: подтверждение от устаревшей сессии игнорируем.
function overlayPainted(overlay: BrowserWindow, token: number): Promise<void> {
  if (overlay.isDestroyed()) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      ipcMain.removeListener(PAINTED_CHANNEL, listener)
      clearTimeout(timer)
      resolve()
    }
    const listener = (_e: Electron.IpcMainEvent, t: number): void => {
      if (t === token) {
        perf('paint', 'ov:ready')
        finish()
      }
    }
    ipcMain.on(PAINTED_CHANNEL, listener)
    const timer = setTimeout(() => {
      log('lifecycle', 'paint timeout, showing anyway', { token })
      finish()
    }, 120)
  })
}

export function confirmOverlayReady(overlay: BrowserWindow, token: number): void {
  perf('ready', 'ov:nav')
  for (const [parentId, pending] of pendingReady) {
    if (pending.token !== token) continue
    const entry = active.get(parentId)
    if (!entry || entry.overlay !== overlay) {
      pending.resolve()
      pendingReady.delete(parentId)
      return
    }
    pending.resolve()
    pendingReady.delete(parentId)
    return
  }
  // Нет ожидания — либо протухшая сессия, либо renderer опередил main.
  log('lifecycle', 'ready for unknown session, ignored', { token })
}

export function closeOverlay(parent: BrowserWindow): void {
  const entry = active.get(parent.id)
  if (!entry) return
  log('session', 'closing', { parentId: parent.id, kind: entry.request.kind })
  // Запоминаем закрытое меню с его триггером: следующий вызов showOverlay
  // с тем же ключом в пределах TOGGLE_ECHO_MS — это эхо открывающего клика,
  // а не намерение открыть заново (см. ветку toggle в showOverlay).
  if (entry.request.kind === 'menu') {
    lastClosed.set(parent.id, {
      toggleKey: entry.request.toggleKey,
      at: Date.now()
    })
  }
  active.delete(parent.id)
  try {
    // hide(), а не close(): окно должно остаться в пул. close() уничтожил
    // бы BrowserWindow, и следующий showOverlay создавал бы новое окно
    // (потеря прогрева и лишние ~60 МБ на каждое открытие).
    if (!entry.overlay.isDestroyed()) {
      parkOverlay(entry.overlay, parent.id)
    }
  } catch {
    // Уже закрыто — игнорим.
  }
}

// Закрыть активный оверлей, но ТОЛЬКО если это меню. Клик по любому
// месту вне меню (вкладка, адресная строка, панель закладок) должен его
// гасить — как в обычных браузерах. Диалоги (icon/dialog) и панель
// поиска так не закрываются: у них своя логика (Esc, Cancel, toggle),
// и клик по shell не должен их сносить.
//
// Клик, ОТКРЫВШИЙ меню, прилетает сюда повторно: пока renderer грузит
// payload и ждёт подтверждения (~20-30 мс), исходный click успевает
// дойти до document и сообщить про гашение. Меню закрывается тем же
// кликом, которым его открыли. Ни mousedown, ни click от этого не
// спасают — отличать надо по времени, а не по типу события.
//
// Поэтому игнорируем гашения, пришедшие в первые OPEN_SETTLE_MS после
// открытия. 350 мс с запасом покрывает и медленный prod-перезапуск
// страницы оверлея.
const OPEN_SETTLE_MS = 350

export function closeOverlayIfMenu(parent: BrowserWindow): void {
  const entry = active.get(parent.id)
  if (!entry) return
  if (entry.request.kind !== 'menu') return
  const age = Date.now() - entry.openedAt
  if (age < OPEN_SETTLE_MS) {
    log('session', 'shell click during open, ignored', {
      parentId: parent.id,
      ageMs: age
    })
    return
  }
  log('session', 'closing on shell click', { parentId: parent.id, ageMs: age })
  closeOverlay(parent)
}

// Активный оверлей родителя (для проброса found-in-page в панель поиска).
export function getActiveOverlay(parent: BrowserWindow): BrowserWindow | undefined {
  const entry = active.get(parent.id)
  return entry && !entry.overlay.isDestroyed() ? entry.overlay : undefined
}

export function getActiveRequest(parent: BrowserWindow): OverlayRequest | undefined {
  return active.get(parent.id)?.request
}

// Родитель оверлея: sender find:query/next/prev/close — это webContents
// самого оверлея, по нему находим окно-родитель и активную view.
export function getParentOfOverlay(overlay: BrowserWindow): BrowserWindow | undefined {
  for (const [parentId, entry] of active) {
    if (entry.overlay === overlay) return BrowserWindow.fromId(parentId) ?? undefined
  }
  return undefined
}

export function showOverlay(parent: BrowserWindow, request: OverlayRequest): void {
  // Perf-метка входа: считаем всё от вызова showOverlay до показа окна.
  const t0 = mark('overlay:open')

  // Toggle: повторный клик по ТОМ ЖЕ триггеру закрывает его меню.
  // Ключ обязателен: без него закрылось бы чужое открытое меню — например,
  // открыто меню вкладки, клик по ☰ закрыл бы его вместо показа меню
  // браузера. Диалоги и поиск ключа не имеют и всегда просто показываются.
  if (request.toggleKey && request.kind === 'menu') {
    const cur = active.get(parent.id)
    const same = cur && !cur.overlay.isDestroyed() && cur.request.toggleKey === request.toggleKey
    if (same) {
      log('session', 'toggle: same trigger, closing', {
        parentId: parent.id,
        toggleKey: request.toggleKey
      })
      closeOverlay(parent)
      return
    }
    // Тот же триггер, но сессию уже сняли ПЕРЕД этим вызовом. Так бывает
    // при клике по кнопке: тот же клик сначала гасит меню через
    // menu:dismiss-on-shell-click, и только потом приходит popupMenu.
    // Без этой проверки toggle не срабатывал — вместо закрытия меню
    // открывалось заново, и пользователь видел моргание.
    //
    // Отличать надо по времени: настоящий повторный клик по ☰ приходит
    // спустя время, эхо же — в том же тике.
    const prev = lastClosed.get(parent.id)
    if (prev && prev.toggleKey === request.toggleKey && Date.now() - prev.at < TOGGLE_ECHO_MS) {
      log('session', 'toggle: echo after close, staying closed', {
        parentId: parent.id,
        toggleKey: request.toggleKey,
        ageMs: Date.now() - prev.at
      })
      lastClosed.delete(parent.id)
      return
    }
  }

  // Флаг анимаций из настроек: false = открыть моментально без fade-in.
  // Синхронно из кэша — без await, иначе меню открывается с задержкой.
  // Тему тоже из кэша: оверлей красится до монтирования.
  const settings = getSettingsSync()
  const animations = settings.animations !== false
  // Эффективная тема оверлея: system резолвится через nativeTheme,
  // остальные уходят как есть (slate красится своими переменными).
  const theme =
    settings.theme === 'system'
      ? nativeTheme.shouldUseDarkColors
        ? 'dark'
        : 'light'
      : settings.theme === 'slate' || settings.theme === 'light'
        ? settings.theme
        : 'dark'

  // Дисплей родителя — источник истины по координатам. При раскладке,
  // где окно на левом мониторе, его workArea.x отрицателен, и любая
  // арифметика в положительных координатах уводит окно на соседний
  // дисплей. Поэтому сверяем геометрию именно с дисплеем родителя, а не
  // с объединённой рабочей областью.
  const display = screen.getDisplayMatching(parent.getBounds())
  const parentBounds = parent.getContentBounds()
  log('geometry', 'parent display', {
    parentId: parent.id,
    displayId: display.id,
    workArea: display.workArea,
    contentBounds: parentBounds
  })
  const width =
    request.kind === 'menu'
      ? MENU_W
      : request.kind === 'dialog'
        ? DIALOG_W
      : request.kind === 'icon'
        ? ICON_W
      : request.kind === 'find'
        ? FIND_W
        : 360
  const height =
    request.kind === 'menu'
      ? menuHeight(request.items ?? [], request.incognito ?? false)
      : request.kind === 'dialog'
        ? DIALOG_H
      : request.kind === 'icon'
        ? ICON_H
      : request.kind === 'find'
        ? FIND_H
        : 120

  // Диалог и диалог иконки — по центру родителя. Поиск — правый верхний угол ОБЛАСТИ
  // СТРАНИЦЫ (ниже верхней панели UI): anchor несет uiInsets.top.
  // Меню — от якоря (align end/start). Клампим в границы родителя.
  const align = request.align ?? 'end'
  const centered = request.kind === 'dialog' || request.kind === 'icon'
  const isFind = request.kind === 'find'
  // Тост — правый нижний угол с отступом. Раньше он брал координаты
  // из anchor, и высота окна (120) отличалась от переданного отступа,
  // из-за чего карточка плавала выше низа. Положение считаем сами:
  // anchor тоста — устаревшее значение, на мигание оно не влияет.
  const isToast = request.kind === 'toast'
  const TOAST_GAP = 16
  const x = centered
    ? parentBounds.x + Math.max(0, Math.round((parentBounds.width - width) / 2))
    : isFind
      ? parentBounds.x + Math.max(0, parentBounds.width - width - 16)
      : isToast
        ? parentBounds.x + Math.max(0, parentBounds.width - width - TOAST_GAP)
        : Math.min(
            Math.max(
              parentBounds.x + request.anchor.x - (request.kind === 'menu' && align === 'end' ? width - 40 : 0),
              parentBounds.x
            ),
            parentBounds.x + parentBounds.width - width
          )
  const y = centered
    ? parentBounds.y + Math.max(0, Math.round((parentBounds.height - height) / 2))
    : isFind
      ? parentBounds.y + request.anchor.y + 12
      : isToast
        ? parentBounds.y + Math.max(0, parentBounds.height - height - TOAST_GAP)
        : Math.min(
            parentBounds.y + request.anchor.y,
            parentBounds.y + parentBounds.height - height
          )

  // Оверлей-окно уже создано заранее через ensureOverlayWindow.
  // Просто обновляем bounds и загружаем новый payload.
  let overlay = overlayPool.get(parent.id)
  const reused = !!overlay && !overlay.isDestroyed()
  log('pool', reused ? 'reusing pooled window' : 'no pooled window, creating', {
    parentId: parent.id,
    kind: request.kind
  })
  if (!overlay || overlay.isDestroyed()) {
    // Fallback: если окно не было создано заранее (на всякий случай)
    overlay = new BrowserWindow({
      x: Math.round(x),
      y: Math.round(y),
      width,
      height,
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
        preload: join(__dirname, '../preload/overlay.cjs'),
        contextIsolation: true,
        sandbox: false
      }
    })
    overlayPool.set(parent.id, overlay)

    const cleanup = () => {
      if (active.get(parent.id)?.overlay === overlay) active.delete(parent.id)
    }
    overlay.on('closed', cleanup)
    overlay.on('blur', () => {
      if (isSystemDialogOpen) return
      log('lifecycle', 'blur -> close', { parentId: parent.id })
      closeOverlay(parent)
    })
    attachParentListeners(parent, overlay)
    // Окно создано лениво (fallback): тот же единственный show() + парк,
    // что и в ensureOverlayWindow.
    const fresh = overlay
    fresh.once('ready-to-show', () => {
      fresh.showInactive()
      parkOverlay(fresh, parent.id)
    })
    if (process.env['ELECTRON_RENDERER_URL']) {
      void fresh.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/menu.html`)
    } else {
      void fresh.loadFile(join(__dirname, '../renderer/menu.html'))
    }
  } else {
    // Окно из пула, сейчас на экране. Порядок КРИТИЧЕН: сначала
    // опустошаем окно (содержимое, прозрачность, ввод), и только потом
    // перемещаем. Если перемещение не удастся и WM оставит окно на
    // экране, рисовать всё равно нечего — а значит вспышки не будет.
    //
    // Обратный порядок (сначала переместить, потом гасить) и давал
    // моргание: в промежутке между setBounds и прозрачностью WM успевал
    // показать кадр со старым содержимым.
    if (!overlay.isDestroyed()) {
      // 1. Содержимое убираем первым — главный слой защиты.
      setContentMounted(overlay, true)
      // 2. Гасим прозрачность: на Linux setOpacity(0) не гарантия, но
      //    дешевле и убирает most случаев.
      overlay.setOpacity(0)
      // 3. Выключаем ввод: припаркованный кликабельный оверлей перехватывал
      //    клики и слал dismiss в цикл.
      overlay.setIgnoreMouseEvents(true, { forward: false })
      // 4. И только теперь уводим за экран, с проверкой результата.
      if (PARK_MOVES_WINDOW) {
        if (!parkOnParentDisplay(overlay, parent, width, height)) {
          parkOffscreen(overlay, width, height)
        }
      }
      contentUnmounted.add(parent.id)
      // Диагностика: сразу после парковки снимаем ФАКТИЧЕСКИЕ границы.
      // setBounds — просьба, а не команда: WM может положить окно в
      // рабочую область соседнего дисплея, и это видно только здесь.
      const after = overlay.getBounds()
      log('geometry', 'after unmount', {
        parentId: parent.id,
        bounds: after,
        onScreen: intersectsWorkArea(after),
        displayId: screen.getDisplayMatching(after).id
      })
    }
    log('geometry', 'content unmounted while loading', { x: Math.round(x), y: Math.round(y), width, height })
  }

  log('geometry', 'resolved', { x: Math.round(x), y: Math.round(y), width, height })
  // Фиксируем окно в константе: ниже оно используется в замыканиях, где
  // narrowing по let-переменной уже не работает (TS18048).
  const win: BrowserWindow = overlay
  // Гасим окно до любых дальнейших действий: с этого момента до
  // подтверждения отрисовки оно не должно быть видимо.
  win.setOpacity(0)
  contentUnmounted.add(parent.id)
  // Токен сессии — до active.set: по нему resolveOverlaySelect отличает
  // свою сессию от новой, открытой из onSelect.
  const sessionToken = ++sessionCounter
  active.set(parent.id, { overlay, request, sessionId: sessionToken, openedAt: Date.now() })
  // Контекст диалога иконки дублируем на окно: хендлер overlay:submit-icon
  // находит apply по sender-окну, request при этом недоступен напрямую.
  if (request.kind === 'icon' && request.onIconApply) {
    ;(overlay as unknown as { __iconApply?: (icon: string) => void }).__iconApply = request.onIconApply
  }
  const payload =
    request.kind === 'menu'
      ? { kind: 'menu', items: request.items, incognito: request.incognito, animations, theme, align: request.align, token: sessionToken }
      : request.kind === 'dialog'
        ? { kind: 'dialog', dialog: request.dialog, animations, theme, token: sessionToken }
        : request.kind === 'icon'
          ? { kind: 'icon', icon: request.icon, animations, theme, token: sessionToken }
          : request.kind === 'find'
            ? { kind: 'find', find: request.find ?? {}, animations, theme, token: sessionToken }
            : { kind: 'toast', toast: request.toast, animations, theme, token: sessionToken }

  // Показ окна. Окно из пула уже загружено, нам нужно дождаться только
  // применения НОВОГО payload. Событие готовности зависит от типа навигации:
  //
  // - dev: loadURL на Vite-сервер меняет только hash. Это same-document
  //   переход — стреляет 'did-navigate-in-page'. Ни did-finish-load,
  //   ни ready-to-show, ни isLoading() здесь не помогают.
  // - prod: loadFile с новом hash = полная перезагрузка — стреляет
  //   'did-finish-load'.
  // - новое окно (из пула не взято): первый 'ready-to-show'.
  //
  // Плюс страховка по таймеру: если ни одно событие не пришло за 250 мс,
  // показываем всё равно — лучше меню с прошлым payload, чем неоткрытое меню.
  //
  // ВАЖНО: вешаем оба события, но ОБЯЗАТЕЛЬНО снимаем оба в show(). Иначе
  // не сработавший слушатель остаётся висеть до следующей навигации, и
  // каждое открытие добавляет ещё один — Electron ругается на
  // MaxListenersExceededWarning (лимит 10 на WebContents).
  //
  // Фокус: find забирает фокус ввода (нужно для поля поиска), остальное —
  // showInactive, чтобы оверлей не крал фокус у страницы.
  let shown = false
  let fallback: ReturnType<typeof setTimeout> | null = null
  const wc = win.webContents
  // Все три — function declaration: они ссылаются друг на друга, и только
  // function declaration хоистится (const-стрелки дали бы TDZ-ошибку).
  function onInPage(): void {
    show()
  }
  function onFinish(): void {
    show()
  }
  function show(): void {
    if (shown) return
    shown = true
    if (fallback) {
      clearTimeout(fallback)
      fallback = null
    }
    // Снимаем оба слушателя: сработало одно, второе нам уже не нужно.
    wc.removeListener('did-navigate-in-page', onInPage)
    wc.removeListener('did-finish-load', onFinish)
    if (win.isDestroyed()) return
    void present()
  }

  async function present(): Promise<void> {
    // Окно всегда «видимо» для OS — мы его не hide'ем, а паркуем.
    // Показ = вернуть прозрачность. Никакого show() → нет анимации.
    //
    // Но снимать прозрачность можно не сразу: renderer применяет payload
    // асинхронно (hashchange -> nextTick -> paint). Пока не подтвердил,
    // в окне лежат пункты ПРЕДЫДУЩЕГО меню — пользователь видит их как
    // вспышку. Поэтому ждём overlay:ready от renderer.
    if (win.isDestroyed()) return
    // Окно намеренно забирает фокус (find вызывает focus() ниже, диалоги
    // автофокусом поля ввода) — родитель потеряет его после setBounds.
    // Помечаем заранее, чтобы blur не закрыл только что показанное меню.
    if (request.kind === 'find' || request.kind === 'icon' || request.kind === 'dialog') {
      noteFocusHandoff(parent.id)
    }
    // Окно может быть ЖИВЫМ (переключение поверх открытого меню) или
    // припаркованным (открытие из пула). В обоих случаях сначала
    // опустошаем его, и только потом перемещаем — иначе в промежутке
    // между setBounds и прозрачностью WM успевает показать кадр со
    // старым содержимым, и это видно как моргание.
    setContentMounted(win, true)
    // Ставим позицию сразу, НЕ уводя за экран. Окно уже пустое (v-if
    // в renderer снял содержимое) и прозрачное, поэтому показывать ему
    // нечего и моргать нечему.
    //
    // Уводить за экран до подтверждения НЕЛЬЗЯ: припаркованное окно
    // композитор считает скрытым и душит requestAnimationFrame. Renderer
    // подтверждает отрисовку по цепочке hashchange -> nextTick -> rAF ->
    // rAF, и без кадрового цикла подтверждение не приходит вовсе:
    // срабатывал таймаут в 150 мс, и первое открытие из пула занимало
    // ~210 мс вместо ~20 мс на переключении типа меню.
    win.setBounds({ x: Math.round(x), y: Math.round(y), width, height })
    await new Promise<void>((resolve) => {
      pendingReady.set(parent.id, { token: sessionToken, resolve })
      // Страховка: если renderer не подтвердит (баг, падение), показываем
      // всё равно — зависшее прозрачное меню хуже, чем крохотная вспышка.
      setTimeout(() => {
        const p2 = pendingReady.get(parent.id)
        if (p2 && p2.token === sessionToken) {
          pendingReady.delete(parent.id)
          log('lifecycle', 'ready timeout, showing anyway', { parentId: parent.id })
          resolve()
        }
      }, 150)
    })
    if (win.isDestroyed()) return
    // Показ. Ключевой момент — прозрачность включается ПОСЛЕ того, как
    // renderer реально применил contentUnmounted=false.
    //
    // setContentMounted — асинхронный IPC: сообщение уходит в renderer, Vue
    // применяет v-if на следующем кадре. Если сразу после него включить
    // opacity, есть кадр, где окно уже на реальных координатах и уже
    // непрозрачное, но ещё со СТАРЫМ содержимым — это и есть вспышка.
    //
    // Поэтому ждём подтверждения от renderer и только после него
    // возвращаем прозрачность. Пока окно пустое, моргать нечему, даже
    // если WM его покажет.
    contentUnmounted.delete(parent.id)
    // Позиция уже выставлена до ожидания подтверждения — повторный
    // setBounds здесь был бы лишним вызовом WM без изменения результата.
    // Диагностика фактических границ после установки координат: если
    // окно оказалось не там, куда просили, причина в клампинге WM.
    const actualBounds = win.getBounds()
    log('geometry', 'after show bounds', {
      parentId: parent.id,
      want: { x: Math.round(x), y: Math.round(y) },
      got: { x: actualBounds.x, y: actualBounds.y },
      displayId: screen.getDisplayMatching(actualBounds).id
    })
    // Ввод включаем сразу: пустое окно клика не перехватит, а к моменту
    // показа содержимого кликабельность уже нужна.
    win.setIgnoreMouseEvents(false)
    // Содержимое показываем, прозрачность пока НЕ трогаем.
    mark('ov:ready')
    setContentMounted(win, false)
    // Ждём, пока renderer применит contentUnmounted=false и отдаст кадр.
    await overlayPainted(win, sessionToken)
    if (win.isDestroyed()) return
    win.setOpacity(1)
    if (request.kind === 'find') {
      try {
        win.focus()
      } catch (err) {
        logError('overlay focus failed', err)
      }
    }
    const ms = perf(`open(${request.kind}, ${reused ? 'reused' : 'new'})`, 'overlay:open')
    recordOpen(ms)
  }

  if (reused) {
    wc.on('did-navigate-in-page', onInPage)
    wc.on('did-finish-load', onFinish)
    fallback = setTimeout(() => {
      log('lifecycle', 'ready event timeout, showing anyway', { parentId: parent.id })
      show()
    }, 250)
  } else {
    win.once('ready-to-show', show)
  }

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(overlayUrl(payload))
  } else {
    void win.loadFile(join(__dirname, '../renderer/menu.html'), {
      hash: `payload=${encodeURIComponent(JSON.stringify(payload))}`
    })
  }
  mark('ov:nav')
  // Диагностика: показываем сразу, если навигации не будет вовсе (окно
  // скрыто и webContents не начал грузить — preload/кэш отдал синхронно).
  if (reused && !wc.isLoading() && !win.isVisible()) {
    log('lifecycle', 'no navigation started, showing immediately', { parentId: parent.id })
    show()
  }
}

export function resolveOverlaySelect(overlay: BrowserWindow, id: string): void {
  log('command', `select: ${id}`)
  for (const [parentId, entry] of active) {
    if (entry.overlay === overlay) {
      const parent = BrowserWindow.fromId(parentId)
      entry.request.onSelect?.(id)
      // onSelect умеет открыть новое оверлей-поверх (меню -> диалог иконки).
      // active уже указывает на новую сессию, и её закрывать нельзя —
      // иначе диалог живёт одну вспышку. Но парковать СТАРОЕ содержимое
      // тоже нельзя: если новая сессия ещё грузится, пользователь увидит
      // пункты предыдущего меню на новом месте. Поэтому проверяем, что
      // активна именно та же сессия — по её токену, а НЕ по окну: окно
      // из пула у всех сессий одно и то же, сравнение всегда истинно,
      // и проверка не срабатывала НИКОГДА. Из-за этого диалог иконки
      // открывался только со второго раза.
      const stillSame = active.get(parentId)?.sessionId === entry.sessionId
      if (!stillSame) {
        // onSelect открыл новую сессию поверх текущей (меню -> диалог
        // иконки). active уже указывает на неё, и её закрывать нельзя:
        // диалог жил бы ноль времени — открылся и тут же исчез, что и
        // выглядело как «Cancel не работает».
        //
        // Старое содержимое тоже не трогаем: размонтит его новая
        // сессия своим setContentMounted(true), а если она ещё грузится, то
        // размонтирование покажет пользователю пустое окно вместо
        // прежних пунктов. Поэтому просто выходим — showOverlay новой
        // сессии уже отправил все нужные сообщения.
        log('command', 'select opened new session, keeping it open', {
          parentId,
          closed: entry.sessionId,
          current: active.get(parentId)?.sessionId
        })
        return
      }
      if (parent) closeOverlay(parent)
      else {
        active.delete(parentId)
        try {
          // hide(), а не close(): родитель уже мёртв, но окно держим
          // в пуле, если оно переиспользуемо.
          parkOverlay(overlay)
        } catch {
          // Игнорим.
        }
      }
      return
    }
  }
}

export function resolveOverlayDismiss(overlay: BrowserWindow): void {
  log('command', 'dismiss')
  for (const [parentId, entry] of active) {
    if (entry.overlay === overlay) {
      const parent = BrowserWindow.fromId(parentId)
      if (parent) closeOverlay(parent)
      else {
        active.delete(parentId)
        try {
          parkOverlay(overlay)
        } catch {
          // Игнорим.
        }
      }
      return
    }
  }
}

// Диалог с полем ввода: значение "buttonId::text" резолвится
// через тот же onSelect — main разобрает префикс сам.
export function resolveOverlaySubmit(overlay: BrowserWindow, raw: string): void {
  log('command', `submit: ${raw.slice(0, 40)}`)
  for (const [parentId, entry] of active) {
    if (entry.overlay === overlay) {
      const parent = BrowserWindow.fromId(parentId)
      entry.request.onSelect?.(raw)
      if (parent) closeOverlay(parent)
      else {
        active.delete(parentId)
        try {
          parkOverlay(overlay)
        } catch {
          // Игнорим.
        }
      }
      return
    }
  }
}

// Общий диалог иконки: верификация источника перед применением.
// Возвращает true если применено (диалог закроется), false если
// источник отклонен (диалог остается, renderer показывает ошибку).
// Кнопка file открывает системный диалог выбора картинки и подставляет
// путь в поле через executeJavaScript — submit идет обычным путем.
export async function resolveOverlaySubmitIcon(
  overlay: BrowserWindow,
  buttonId: string,
  value: string,
  apply: (icon: string) => void
): Promise<boolean> {
  log('command', `submit-icon: ${buttonId} (${value.slice(0, 30)})`)
  for (const [parentId, entry] of active) {
    if (entry.overlay !== overlay) continue
    if (buttonId === 'file') {
      const parent = BrowserWindow.fromId(parentId)
      try {
        isSystemDialogOpen = true
        // Оверлей alwaysOnTop, и системный диалог открывается ПОД ним:
        // пользователь видит только рамку оверлея, сам диалог перекрыт.
        // На время выбора снимаем alwaysOnTop — состояние диалога не
        // теряется, в отличие от парковки окна.
        const wasAlwaysOnTop = overlay.isAlwaysOnTop()
        if (wasAlwaysOnTop) overlay.setAlwaysOnTop(false)
        let res: Electron.OpenDialogReturnValue
        try {
          res = await dialog.showOpenDialog(parent ?? (null as never), {
            title: 'Choose icon',
            properties: ['openFile'],
            filters: [
              { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp'] },
              { name: 'All files', extensions: ['*'] }
            ]
          })
        } finally {
          if (wasAlwaysOnTop && !overlay.isDestroyed()) overlay.setAlwaysOnTop(true)
        }
        isSystemDialogOpen = false
        if (res.canceled || !res.filePaths || res.filePaths.length === 0 || overlay.isDestroyed()) {
          return true
        }
        const conv = fileToIconDataUrl(res.filePaths[0])
        if (!conv.ok) {
          logError('icon file conversion failed', conv.error)
          const { buildIconErrorScript } = await import('./findScripts')
          await overlay.webContents.executeJavaScript(buildIconErrorScript(conv.error))
          return true
        }
        apply(conv.icon)
        const p = BrowserWindow.fromId(parentId)
        if (p) closeOverlay(p)
        return true
      } catch (err) {
        isSystemDialogOpen = false
        logError('file dialog failed', err)
        return true
      }
    }
    let check: { ok: true; icon: string } | { ok: false; error: string }
    if (buttonId === 'emoji') {
      check = verifyEmojiButton(value)
    } else {
      check = verifyIconSource(value)
      if (check.ok && check.icon.startsWith('emoji:')) {
        check = { ok: false, error: 'Use Emoji button for emoji' }
      }
    }
    if (!check.ok) return false
    apply(check.icon)
    const parent = BrowserWindow.fromId(parentId)
    if (parent) closeOverlay(parent)
    else {
      active.delete(parentId)
      try {
        parkOverlay(overlay)
      } catch {
        // Игнорим.
      }
    }
    return true
  }
  return false
}
