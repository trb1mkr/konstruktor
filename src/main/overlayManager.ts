import { BrowserWindow, dialog, nativeTheme } from 'electron'
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

// parentId -> { overlay, request }
const active = new Map<number, { overlay: BrowserWindow; request: OverlayRequest }>()

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
//   скрыть    = setBounds(PARK) + setOpacity(0)
// Окно всегда существует и всегда «видимо» для OS, но в парке оно за
// пределами экрана и прозрачно — пользователь его не видит и не может
// кликнуть. Ни одного вызова show/hide → ни одной системной анимации.

// Парковочная позиция: далеко за левым верхним углом экрана. Размеры
// реальные (не 1x1), чтобы при возврате не было пересоздания/ресайза.
const PARK = { x: -32000, y: -32000 }

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
const parked = new Set<number>()

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
  const closeOnParent = () => {
    if (isSystemDialogOpen) return
    // Паркованное окно невидимо: парковка двигает его через setBounds,
    // и без этой проверки каждое движение родителя засоряло бы лог
    // и закрывало активное меню в момент установки bounds.
    if (parked.has(parent.id)) return
    log('lifecycle', 'parent move/resize/minimize -> close', { parentId: parent.id })
    closeOverlay(parent)
  }
  parent.on('move', closeOnParent)
  parent.on('resize', closeOnParent)
  parent.on('minimize', closeOnParent)
  overlay.on('closed', () => {
    parent.removeListener('move', closeOnParent)
    parent.removeListener('resize', closeOnParent)
    parent.removeListener('minimize', closeOnParent)
  })
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

// Паркует оверлей: прозрачный, за пределами экрана, но живой.
//
// Это единственный способ «скрыть» окно без вызова hide() — а именно
// вызовы show()/hide() вызывают системную анимацию DWM. В парке окно
// за экраном и полностью прозрачно: пользователь его не видит и не может
// кликнуть (попасть курсором за пределы экрана невозможно).
function parkOverlay(overlay: BrowserWindow, parentId?: number): void {
  if (overlay.isDestroyed()) return
  try {
    overlay.setOpacity(0)
    overlay.setBounds(PARK)
    if (parentId !== undefined) {
      parked.add(parentId)
      log('lifecycle', 'overlay parked', { parentId })
    }
  } catch (err) {
    logError('failed to park overlay', err)
  }
}

// Renderer подтвердил, что сессия с токеном отрисована. Разрешаем показ.
// Токен сверяется: подтверждение от устаревшей сессии игнорируем.
export function confirmOverlayReady(overlay: BrowserWindow, token: number): void {
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

  const parentBounds = parent.getContentBounds()
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
  const x = centered
    ? parentBounds.x + Math.max(0, Math.round((parentBounds.width - width) / 2))
    : isFind
      ? parentBounds.x + Math.max(0, parentBounds.width - width - 16)
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
    // Родитель двигается — оверлей протух, закрываем.
    const closeOnParent = () => {
      if (isSystemDialogOpen) return
      if (parked.has(parent.id)) return
      log('lifecycle', 'parent move/resize/minimize -> close', { parentId: parent.id })
      closeOverlay(parent)
    }
    parent.on('move', closeOnParent)
    parent.on('resize', closeOnParent)
    parent.on('minimize', closeOnParent)
    overlay.on('closed', () => {
      parent.removeListener('move', closeOnParent)
      parent.removeListener('resize', closeOnParent)
      parent.removeListener('minimize', closeOnParent)
    })
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
    // Окно из пула. Перед перестановкой гасим прозрачность: иначе
    // окно с УАРЫМ содержимым переедет на новую позицию, и пользователь
    // увидит вспышку старого меню до применения нового payload.
    if (!overlay.isDestroyed()) {
      overlay.setOpacity(0)
      parked.add(parent.id)
    }
    overlay.setBounds({ x: Math.round(x), y: Math.round(y), width, height })
    log('geometry', 'bounds updated', { x: Math.round(x), y: Math.round(y), width, height })
  }

  log('geometry', 'resolved', { x: Math.round(x), y: Math.round(y), width, height })
  // Фиксируем окно в константе: ниже оно используется в замыканиях, где
  // narrowing по let-переменной уже не работает (TS18048).
  const win: BrowserWindow = overlay
  // Гасим окно до любых дальнейших действий: с этого момента до
  // подтверждения отрисовки оно не должно быть видимо.
  win.setOpacity(0)
  parked.add(parent.id)
  active.set(parent.id, { overlay, request })
  // Контекст диалога иконки дублируем на окно: хендлер overlay:submit-icon
  // находит apply по sender-окну, request при этом недоступен напрямую.
  if (request.kind === 'icon' && request.onIconApply) {
    ;(overlay as unknown as { __iconApply?: (icon: string) => void }).__iconApply = request.onIconApply
  }
  const sessionToken = ++sessionCounter
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
    // Снимаем парковку до setBounds: дальше события родителя снова
    // должны закрывать меню при перемещении окна.
    parked.delete(parent.id)
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
    win.setOpacity(1)
    if (request.kind === 'find') win.focus()
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
      // onSelect может открыть новый оверлей поверх (например диалог
      // выбора иконки из контекстного меню). Тогда active уже указывает
      // на новое окно — его закрывать нельзя, только старый dismiss.
      if (active.get(parentId)?.overlay !== overlay) return
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
        const res = await dialog.showOpenDialog(parent ?? (null as never), {
          title: 'Choose icon',
          properties: ['openFile'],
          filters: [
            { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp'] },
            { name: 'All files', extensions: ['*'] }
          ]
        })
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
