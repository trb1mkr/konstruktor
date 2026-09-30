import { BrowserWindow, app, dialog, ipcMain, nativeTheme, screen } from 'electron'
import { join } from 'path'
import { getSettingsSync } from '../settingsStore'
import { verifyIconSource, verifyEmojiButton, fileToIconDataUrl } from '../iconVerify'
import { log, mark, perf, recordOpen, logError } from './logger'
import {
  createOverlay,
  ensureOverlayWindow as ensurePooledWindow,
  getPooledOverlay,
  hideContent,
  isContentUnmounted,
  logBoundsAfterHide,
  markContentShown,
  markContentUnmounted,
  parentOfPooledOverlay,
  setContentUnmounted
} from './pool'
import { pushPayload, waitPageReady, dropPendingPush, updatePayload } from './pool'
import type { PoolHooks } from './pool'
import type { OverlayModel, PushMessage } from '../../shared/overlay-types'

// Сервис оверлеев: единственная точка входа для показа, закрытия и
// разрешения команд поверхности.
//
// Заменяет системный Menu.popup, который на Windows всегда светлый и не
// стилизуется. Живёт в отдельном прозрачном frameless-окне поверх
// WebContentsView — поверх DOM сайта рисовать нельзя.
//
// Жизненный цикл: showOverlay создаёт сессию, resolveOverlay* её закрывают.
// Одновременно жив только один оверлей на родителя — новый вытесняет старый.
// Родитель moved/resized/minimized/blurred — оверлей закрывается сам.
//
// Миграция идёт шаг за шагом (см. docs/OVERLAY_PLAN.md). Шаг 4b вынес
// сюда логику из overlayManager.ts; тот остался фасадом, и все 14 вызовов
// работают через него. Шаг 10 переведёт их напрямую сюда, а
// overlayManager.ts будет удалён.


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
export { verifyIconSource } from '../iconVerify'

interface OverlayRequest {
  kind: 'menu' | 'toast' | 'dialog' | 'find' | 'icon'
  anchor: { x: number; y: number }
  items?: OverlayMenuItem[]
  incognito?: boolean
  toast?: { title: string; body?: string; timeout?: number }
  dialog?: {
    title: string
    placeholder?: string
    initial?: string
    buttons: OverlayDialogButton[]
  }
  icon?: IconDialogState
  find?: { query?: string }
  onSelect?: (id: string) => void
  // Контекст общего диалога иконки: apply вызывается после верификации.
  // Лежит только здесь; хендлер overlay:submit-icon находит его через
  // request активной сессии, найденной по sender-окну.
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

// Обратная карта: id окна оверлея -> id его родителя. Нужна, потому что
// команды приходят от renderer оверлея, а сессия адресована по родителю.
// Раньше.parentId находился перебором active, и таких мест было пять —
// каждое O(n) и каждое с молчаливым «нашлось первое совпадение».
// Оверлеев мало, но перебор был неуместен и мешал убрать его вообще.
const parentOfOverlayId = new Map<number, number>()

/**
 * Родитель по id окна оверлея, либо undefined, если оверлей не активен.
 * Замена перебора active по entry.overlay.
 */
function findParentIdByOverlay(overlay: BrowserWindow): number | undefined {
  const parentId = parentOfOverlayId.get(overlay.id)
  if (parentId === undefined) return undefined
  // Пара может разъехаться: сессию сняли в обход (например, отмена по
  // таймауту раньше успела снять активную, а карту забыли). Сверяем, что
  // запись всё ещё указывает на это окно, иначе считаем оверлей чужим.
  const entry = active.get(parentId)
  if (!entry || entry.overlay !== overlay) {
    parentOfOverlayId.delete(overlay.id)
    return undefined
  }
  return parentId
}

/**
 * Регистрирует сессию и синхронно ведёт обратную карту.
 *
 * Обёртка существует, чтобы карту нельзя было забыть обновить: вся
 * беда линейного перебора как раз из-за того, что истина о родителе
 * жила в активной сессии. Держим обе структуры в одном месте.
 */
function setActiveSession(parentId: number, entry: ActiveOverlay): void {
  active.set(parentId, entry)
  parentOfOverlayId.set(entry.overlay.id, parentId)
}

/**
 * Снимает сессию и убирает обратную запись.
 *
 * Важно: снимается только сессия ИМЕННО этого родителя. Повторный
 * показ того же оверлея на другого родителя (окно переиспользуется
 * из пула) перезапишет карту, и старый вызов не должен был бы снести
 * новую запись.
 */
function clearActiveSession(parentId: number): void {
  const entry = active.get(parentId)
  if (entry && parentOfOverlayId.get(entry.overlay.id) === parentId) {
    parentOfOverlayId.delete(entry.overlay.id)
  }
  active.delete(parentId)
}

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


// Renderer сообщает, что применил contentUnmounted=false и кадр отдан.
// Только после этого main возвращает прозрачность окну.
const PAINTED_CHANNEL = 'overlay:painted'

// Вешает слушатели, закрывающие активный оверлей при потере родителя:
// движение, ресайз, сворачивание, ПЕРЕКЛЮЧЕНИЕ НА ДРУГОЕ ОКНО и Esc.
//
// В пул не выносится: нужны active, focusHandoff и closeOverlay, то есть
// всё состояние сессий. Пул получает готовую функцию через хук
// onParentEvent — иначе возник бы циклический импорт.
function attachParentListeners(parent: BrowserWindow, overlay: BrowserWindow): void {
  const closeOnParent = () => {
    if (isSystemDialogOpen) return
    // Паркованное окно невидимо: парковка двигает его через setBounds,
    // и без этой проверки каждое движение родителя засоряло бы лог
    // и закрывало активное меню в момент установки bounds.
    if (isContentUnmounted(parent.id)) return
    log('lifecycle', 'parent move/resize/minimize -> close', { parentId: parent.id })
    closeOverlay(parent)
  }
  const closeOnBlur = () => {
    if (isSystemDialogOpen) return
    if (isContentUnmounted(parent.id)) return
    // Переключение на чужое окно не стреляет ни move, ни resize, ни
    // minimize. Раньше ловили это здесь, по blur'у родителя, но поверх
    // работает только один guard: оверлей лежит под курсором (парковка
    // больше не уводит его за экран), клик по родителю активирует наше
    // окно, и blur родителя — не уход пользователя, а побочный эффект
    // нажатия. Отличить это от ухода можно было только по isFocused() оверлея.
    //
    // Проблема в том, что оверлей САМ забирает фокус (панель поиска через
    // focus(), диалоги — автофокусом поля ввода). Тогда родитель теряет
    // фокус при открытии, и при Alt+Tab теряет его уже оверлей — родитель
    // в этот момент не в фокусе и blur от него не приходит вовсе. Живой
    // Alt+Tab это подтвердил: событие на родителе не приходило, а оверлей
    // оставался висеть поверх чужого окна.
    //
    // Поэтому признак «ушли из приложения» проверяется отдельно и
    // одинаково для обоих окон — в closeIfFocusLeftApp. Здесь остаётся
    // только клик по родителю, который тоже приводит к blur'у.
    const until = focusHandoff.get(parent.id) ?? 0
    if (Date.now() < until) return
    if (process.platform === 'win32' && overlay.isFocused()) {
      log('lifecycle', 'parent blur by own overlay, ignored', { parentId: parent.id })
      return
    }
    // Фокус ушёл не в оверлей — значит приложение покинуто (Alt+Tab), и
    // оверлей обязан скрыться. Проверку делает closeIfFocusLeftApp.
    closeIfFocusLeftApp(parent, parent.id)
  }
  // Тот же признак, но со стороны оверлея. Нужен потому, что при
  // открытой панели поиска ФОКУС ДЕРЖИТ ОВЕРЛЕЙ: родитель потерял его
  // ещё при открытии, и blur родителя при Alt+Tab не приходит вовсе.
  // Без этого слушателя панель поиска и диалог иконки висели бы поверх
  // чужого окна (проверено: воспроизводилось на живом Alt+Tab).
  const onOverlayBlur = (): void => {
    if (isSystemDialogOpen) return
    if (isContentUnmounted(parent.id)) return
    if (!active.has(parent.id)) return
    // Родитель мог уже забрать фокус себе (например, по restoreFocusToParent
    // после закрытия) — тогда это не уход из приложения.
    if (!overlay.isDestroyed() && parent.isFocused()) return
    closeIfFocusLeftApp(overlay, parent.id)
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
  overlay.on('blur', onOverlayBlur)
  parent.webContents.on('before-input-event', onBeforeInput)
  overlay.on('closed', () => {
    parent.removeListener('move', closeOnParent)
    parent.removeListener('resize', closeOnParent)
    parent.removeListener('minimize', closeOnParent)
    parent.removeListener('blur', closeOnBlur)
    overlay.removeListener('blur', onOverlayBlur)
    parent.webContents.removeListener('before-input-event', onBeforeInput)
  })
}

// Хуки для пула. Замыкание создаётся на каждый вызов: пул знает только
// parentId, а closeOverlay и attachParentListeners требуют сам объект
// окна. Создавать один раз нельзя — родитель может быть пересоздан.
function poolHooks(): PoolHooks {
  return {
    onWindowClosed: (parentId: number) => {
      const parent = BrowserWindow.fromId(parentId)
      if (parent) closeOverlay(parent)
    },
    onParentEvent: (parent: BrowserWindow) => {
      const win = getPooledOverlay(parent.id)
      if (win) attachParentListeners(parent, win)
    }
  }
}

// Точка входа для внешнего кода (windowsManager). Внутренняя реализация
// живёт в пуле.
export function ensureOverlayWindow(parent: BrowserWindow): void {
  // Слушатель потери фокуса приложения ставится здесь, а не в attach:
  // он глобальный, и первое же окно браузера — правильное место, чтобы
  // он существовал до первого открытия оверлея.
  installAppBlurHook()
  ensurePooledWindow(parent, poolHooks())
}

// Монотонный счетчик сессий оверлея. Каждое открытие получает новый
// токен: renderer подтверждает отрисовку именно этого токена, а main
// игнорирует подтверждения от устаревших сессий (защита от гонок).
let sessionCounter = 0

// Фаза ready исчезла вместе с навигацией: раньше main ждал, пока
// renderer применит payload из URL, и держал окно прозрачным. Теперь
// данные приходят через overlay:push в уже готовый renderer, поэтому
// ждать нечего — достаточно подтверждения отрисовки (overlayPainted).


// parentId -> время, до которого родительский blur не считается
// переключением на чужое окно. Заполняется noteFocusHandoff.
const focusHandoff = new Map<number, number>()

// Сколько живёт пометка передачи фокуса. Столько нужно, чтобы focus()
// оверлея дошёл до него на Linux: там он асинхронный, и в момент blur
// родителя overlay.isFocused() ещё вернул бы false.
const FOCUS_HANDOFF_MS = 400


// Уже поднят ли слушатель потери фокуса приложения. Слушатель глобальный,
// а сессии заводятся и умирают, поэтому регистрируем один раз на весь
// процесс: иначе на каждое окно в пуле плодился бы свой, и они бы
// дублировали друг друга на общих parentId.
let appBlurHookInstalled = false

/**
 * Перенаправляет фокус, если он вернулся в приложение, но осел в СКРЫТЫЙ
 * оверлей.
 *
 * Оверлей создан с focusable: true — иначе панель поиска не смогла бы
 * забрать фокус на поле ввода. Но пока он в цепочке Alt+Tab, Windows при
 * возврате в приложение отдаёт фокус ЕМУ, а не родителю: оверлей
 * прозрачный и пустой, но живой. Клавиши уходят в его webContents, где
 * before-input-event не слушается, и Ctrl+F не срабатывает, пока
 * пользователь не кликнет по странице.
 *
 * Вернуть фокус из фона нельзя — пользователь сам ушёл, и украсть его
 * обратно значило бы выкинуть его из чужого приложения. Поэтому здесь не
 * возврат, а переадресация: момент «приложение снова на экране» известен
 * по browser-window-focus, и если фокус ушёл в скрытый оверлей, отдаём
 * его родителю, чей webContents клавиши и слушает.
 */
function installAppBlurHook(): void {
  if (appBlurHookInstalled) return
  appBlurHookInstalled = true
  app.on('browser-window-focus', (_event, focused) => {
    if (!focused || focused.isDestroyed()) return
    // Ищем родителя по карте ОКОН, а не по active: после Alt+Tab сессия
    // уже снята, и активная карта вернула бы undefined — переадресация
    // не сработала бы именно в том случае, ради которого написана.
    const parentId = parentOfPooledOverlay(focused.id)
    if (parentId === undefined) return
    // Содержимое живо — фокус в оверлее законный, переадресовывать нечего.
    if (!isContentUnmounted(parentId)) return
    const parent = BrowserWindow.fromId(parentId)
    if (!parent || parent.isDestroyed()) return
    log('lifecycle', 'focus landed on hidden overlay -> parent', {
      parentId,
      overlayId: focused.id
    })
    parent.focus()
  })
}

/**
 * Ловит уход приложения в фон по blur'у окна, которое ДЕРЖАЛО фокус.
 *
 * Почему не app.on('browser-window-blur'): он срабатывает и когда фокус
 * уходит СОБСТВЕННОМУ оверлею, а не только когда уходит из приложения.
 * Проверено на живом прогоне: панель поиска закрывалась сразу после
 * открытия, потому что родитель отдал фокус оверлею и событие пришло.
 * Отличить эти случаи по getFocusedWindow() не вышло — в момент
 * срабатывания фокус ещё числится нашим, и признак «ушли наружу»
 * срабатывал на каждом открытии.
 *
 * Поэтому сигнал берём с окна, которое фактически держало фокус:
 *
 *   blur родителя, фокус не в оверлее  -> ушли из приложения (Alt+Tab)
 *   blur оверлея, фокус не у оверлея   -> то же самое: терять было что
 *                                        кроме оверлея, значит ушли наружу
 *
 * В обоих случаях закрываем. Ложных срабатываний не будет: если фокус
 * перешёл между своими окнами, у нового владельца isFocused() истинно,
 * и мы выходим.
 *
 * @returns true, если оверлей закрыт.
 */
function closeIfFocusLeftApp(
  holder: BrowserWindow,
  parentId: number
): boolean {
  if (isSystemDialogOpen) return false
  const parent = BrowserWindow.fromId(parentId)
  if (!parent || parent.isDestroyed()) return false
  // Фокус ушёл в другое наше окно: это переключение внутри приложения.
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !focused.isDestroyed() && focused.id !== holder.id) {
    log('lifecycle', 'focus moved to own window', {
      parentId,
      holderId: holder.id,
      focusedId: focused.id
    })
    return false
  }
  log('lifecycle', 'app left focus -> close overlay', {
    parentId,
    holderId: holder.id
  })
  closeOverlay(parent)
  return true
}

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

// Переводит внутренний запрос в модель контракта для IPC-push.
//
// Раньше та же логика жила инлайн в showOverlay при сборке payload для
// URL. Теперь она оформлена отдельно: payload едет в renderer по
// контракту из shared/overlay-types.ts, и его форма задаётся там.
function overlayModel(request: OverlayRequest): OverlayModel {
  if (request.kind === 'menu') {
    return { view: 'menu', items: request.items ?? [], badge: request.incognito ? 'incognito' : undefined }
  }
  if (request.kind === 'dialog') {
    return {
      view: 'dialog',
      dialog: {
        title: request.dialog?.title ?? '',
        placeholder: request.dialog?.placeholder,
        initial: request.dialog?.initial,
        buttons: request.dialog?.buttons ?? []
      }
    }
  }
  if (request.kind === 'icon') {
    return {
      view: 'icon',
      icon: {
        title: request.icon?.title ?? '',
        placeholder: request.icon?.placeholder,
        initial: request.icon?.initial
      }
    }
  }
  if (request.kind === 'find') {
    return { view: 'find', find: { query: request.find?.query } }
  }
  return { view: 'toast', toast: request.toast ?? { title: '' } }
}






/**
 * Renderer подтвердил, что сессия с токеном отрисована. Разрешаем показ.
 * Токен сверяется: подтверждение от устаревшей сессии игнорируем.
 *
 * Возвращает true при подтверждении и false по таймауту. Различие
 * принципиально: раньше обе ветки сводились к показу, и окно становилось
 * непрозрачным без содержимого — тихо и без ошибок в логах. Теперь
 * вызывающий код по false отменяет показ.
 */
function overlayPainted(overlay: BrowserWindow, token: number): Promise<boolean> {
  if (overlay.isDestroyed()) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      ipcMain.removeListener(PAINTED_CHANNEL, listener)
      clearTimeout(timer)
      resolve(ok)
    }
    const listener = (_e: Electron.IpcMainEvent, t: number): void => {
      if (t === token) {
        perf('paint', 'ov:ready')
        finish(true)
      }
    }
    ipcMain.on(PAINTED_CHANNEL, listener)
    const timer = setTimeout(() => {
      log('lifecycle', 'paint timeout, aborting overlay', { token })
      finish(false)
    }, 120)
  })
}

/**
 * Отменяет показ, не дав окну стать видимым с пустым содержимым.
 *
 * Вызывается, когда renderer не подтвердил отрисовку: страница не
 * загрузилась или не ответила. Окно гасится и возвращается в пул как
 * обычно закрытое — пользователь не видит ничего, а в логах есть
 * причина. Активная сессия снимается, чтобы следующий showOverlay не
 * считал оверлей уже открытым.
 *
 * Заодно выбрасываем наш payload из буфера. Иначе он ушёл бы при
 * did-finish-load в уже закрытую сессию: renderer применил бы
 * содержимое в невидимое окно, и в логах это выглядело бы как
 * открытие меню без запроса. Чистка выборочная по sessionId, чтобы
 * не снести payload более новой сессии, если она успела встать в
 * очередь раньше.
 */
function abortPresent(win: BrowserWindow, parent: BrowserWindow, sessionToken: number): void {
  if (win.isDestroyed()) return
  try {
    dropPendingPush(win, sessionToken)
    win.setOpacity(0)
    hideContent(win, parent.id)
    // Оверлей мог забрать фокус до того, как мы сорвались по таймауту.
    // Отмена не должна оставлять фокус в пустом невидимом окне — иначе
    // следующий Ctrl+F не дойдёт до страницы.
    restoreFocusToParent(win, parent, sessionToken)
  } catch (err) {
    logError('failed to abort overlay', err)
  }
  // Снимаем сессию, только если она всё ещё наша: за время ожидания
  // мог открыться другой оверлей, и его трогать нельзя.
  const entry = active.get(parent.id)
  if (entry && entry.sessionId === sessionToken) clearActiveSession(parent.id)
  log('lifecycle', 'overlay aborted, nothing shown', { parentId: parent.id, sessionId: sessionToken })
}



/**
 * Возвращает фокус родителю после закрытия оверлея.
 *
 * Зачем: окно оверлея переживает закрытие (оно в пуле), и если перед
 * закрытием забрало фокус — а это делает панель поиска через focus() и
 * автофокус поля ввода в диалогах — фокус остаётся в нём. Окно при этом
 * прозрачное и пустое, но живое, и клавиши уходят в его webContents.
 * before-input-event слушается только на родителе и на view вкладки,
 * поэтому Ctrl+F до повторного клика по странице не срабатывал: до
 * клика фокус ещё в оверлее, после — вернулся в страницу.
 *
 * Поэтому при закрытии оверлея фокус надо вернуть явно.
 *
 * НО только если фокус сейчас наш. Если пользователь ушёл в другое
 * приложение (Alt+Tab), а закрытие вызвано blur'ом родителя, красть
 * фокус обратно нельзя: это и есть тот самый случай, ради которого
 * blur-перехватчик закрывает оверлей.
 *
 * Проверка win.isFocused() надёжна только на Windows, где она
 * синхронна. На Linux focus() асинхронен, и в момент вызова фокус
 * мог ещё не дойти до оверлея — тогда проверка сказала бы «фокус не
 * наш» и мы бы НЕ вернули фокус, то есть баг остался бы. Поэтому там
 * опираемся на метку времени: если оверлей только что забрал фокус
 * (noteFocusHandoff), возврат нужен и делается безусловно.
 *
 * На Windows метка времени НЕ используется для решения: она
 * протухает через FOCUS_HANDOFF_MS, а focus() оверлея может
 * задержаться дольше, и тогда фокус уехал бы в оверлей навсегда.
 * Там решает isFocused().
 *
 * @returns true, если фокус возвращён.
 */
function restoreFocusToParent(
  win: BrowserWindow,
  parent: BrowserWindow,
  sessionToken: number
): boolean {
  if (parent.isDestroyed()) return false
  if (process.platform === 'win32') {
    if (!win.isFocused()) {
      // Фокус не наш: пользователь ушёл в другое приложение, либо окно
      // фокус так и не забирало (тогда возвращать нечего).
      log('lifecycle', 'focus not on overlay, skipping restore', {
        parentId: parent.id
      })
      return false
    }
  } else if (Date.now() >= (focusHandoff.get(parent.id) ?? 0)) {
    // Linux: оверлей уже не в фёнове фокуса, возврат не наш.
    log('lifecycle', 'focus handoff expired, skipping restore', { parentId: parent.id })
    return false
  }
  try {
    parent.focus()
    log('lifecycle', 'focus returned to parent', {
      parentId: parent.id,
      sessionId: sessionToken
    })
    return true
  } catch (err) {
    logError('failed to restore focus to parent', err)
    return false
  }
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
  clearActiveSession(parent.id)
  try {
    // Тот же случай, что и в abortPresent: сессию закрыли, пока страница
    // ещё грузилась, и payload лежит в буфере. Без сброса он применится
    // позже в закрытом окне.
    dropPendingPush(entry.overlay, entry.sessionId)
    // hide(), а не close(): окно должно остаться в пул. close() уничтожил
    // бы BrowserWindow, и следующий showOverlay создавал бы новое окно
    // (потеря прогрева и лишние ~60 МБ на каждое открытие).
    if (!entry.overlay.isDestroyed()) {
      hideContent(entry.overlay, parent.id)
      // Фокус возвращаем после hideContent, но не потому что тот его
      // меняет (setOpacity/setIgnoreMouseEvents фокуса не трогают), а
      // чтобы окно уже было пустым на момент возврата: если между
      // hideContent и focus() что-то пойдёт не так, пользователь увидит
      // уже пустое окно в фокусе, а не пустое содержимое.
      restoreFocusToParent(entry.overlay, parent, entry.sessionId)
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

/**
 * Точечно обновляет модель живой сессии.
 *
 * Единственная точка, через которую патчи уходят в renderer: и счётчик
 * поиска, и ошибка валидации иконки. Раньше обе шли через
 * `executeJavaScript(buildScript(...))` — то есть через генерацию строк JS
 * и `querySelector` по селекторам, которые пришлось бы синхронизировать с
 * разметкой вручную. Теперь модель меняется реактивно, и данные с разметкой
 * разойтись не могут: счётчик это поле модели, а не элемент с классом.
 *
 * Патч уходит только в свою сессию: окно из пула у всех сессий одно, и без
 * сверки токена счётчик от прошлого поиска появился бы в следующем.
 */
export function updateActiveOverlay(parent: BrowserWindow, patch: unknown): boolean {
  const entry = active.get(parent.id)
  if (!entry) return false
  if (entry.overlay.isDestroyed()) return false
  return updatePayload(entry.overlay, entry.sessionId, entry.sessionId, patch)
}

/**
 * Точечное обновление по sender'у renderer'а оверлея.
 *
 * Отдельный вход нужен `findManager`: счётчик приходит по вводу, и активная
 * сессия к тому моменту могла смениться. Родителя находим по карте окон, а
 * не по `active`.
 */
export function updateOverlayBySender(sender: Electron.WebContents, patch: unknown): boolean {
  const overlay = BrowserWindow.fromWebContents(sender)
  if (!overlay) return false
  const parentId = parentOfPooledOverlay(overlay.id)
  if (parentId === undefined) return false
  const parent = BrowserWindow.fromId(parentId)
  if (!parent) return false
  return updateActiveOverlay(parent, patch)
}

// Родитель оверлея: sender find:query/next/prev/close — это webContents
// самого оверлея, по нему находим окно-родитель и активную view.
export function getParentOfOverlay(overlay: BrowserWindow): BrowserWindow | undefined {
  const parentId = findParentIdByOverlay(overlay)
  if (parentId === undefined) return undefined
  return BrowserWindow.fromId(parentId) ?? undefined
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
  let overlay = getPooledOverlay(parent.id)
  const reused = !!overlay && !overlay.isDestroyed()
  log('pool', reused ? 'reusing pooled window' : 'no pooled window, creating', {
    parentId: parent.id,
    kind: request.kind
  })
if (!overlay || overlay.isDestroyed()) {
    // Fallback: окно не было создано заранее (или уничтожено). Создаём
    // через пул — опции, слушатели и загрузка страницы те же, что при
    // прогреве. Дублировать их здесь было ошибкой: копии разошлись.
    overlay = createOverlay(parent, poolHooks())
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
      // Порядок обязателен: опустошить окно, и только потом перемещать.
      // Иначе в промежутке между setBounds и прозрачностью WM успевает
      // показать кадр со старым содержимым.
      //
      // Логика живёт в pool.hideContent. Дубль был второй копией и уже
      // разошёлся с пулом: флаг размонтирования ставился вручную, минуя
      // API, из-за чего правки пула не действовали на этот путь.
      hideContent(overlay, parent.id)
      // Диагностика: снимаем ФАКТИЧЕСКИЕ границы после скрытия.
      // setBounds — просьба, а не команда: WM может положить окно в
      // рабочую область соседнего дисплея, и это видно только здесь.
      logBoundsAfterHide(overlay, parent.id)
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
  markContentUnmounted(parent.id)
  // Токен сессии — до active.set: по нему resolveOverlaySelect отличает
  // свою сессию от новой, открытой из onSelect.
  const sessionToken = ++sessionCounter
  setActiveSession(parent.id, { overlay, request, sessionId: sessionToken, openedAt: Date.now() })
  // Показ окна. Страница уже загружена (пул сделал это при создании
  // окна), навигации нет — ждать остаётся только отрисовку.
  async function present(): Promise<void> {
    // Окно всегда «видимо» для OS — мы его не hide'ем, а паркуем.
    // Показ = вернуть прозрачность. Никакого show() → нет анимации.
    //
    // Но снимать прозрачность можно не сразу: renderer применяет
    // полученный push асинхронно (событие -> nextTick -> paint). Пока не
    // подтвердил, в окне лежат пункты ПРЕДЫДУЩЕГО меню — пользователь
    // видит их как вспышку. Поэтому ждём overlay:painted.
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
    setContentUnmounted(win, true)
    // Ставим позицию сразу, НЕ уводя за экран. Окно уже пустое (v-if
    // в renderer снял содержимое) и прозрачное, поэтому показывать ему
    // нечего и моргать нечему.
    //
    // Уводить за экран до подтверждения НЕЛЬЗЯ: припаркованное окно
    // композитор считает скрытым и душит requestAnimationFrame. Renderer
    // подтверждает отрисовку по цепочке событие -> nextTick -> rAF, и
    // без кадрового цикла подтверждение не приходит вовсе:
    // срабатывал таймаут в 150 мс, и первое открытие из пула занимало
    // ~210 мс вместо ~20 мс на переключении типа меню.
    win.setBounds({ x: Math.round(x), y: Math.round(y), width, height })
    // Данные уходят через overlay:push, а не через URL. Навигации больше
    // нет, поэтому и фазы ready (ожидание применения payload) не нужно:
    // push приходит в уже смонтированный renderer.
    //
    // Всё, что раньше ехало в hash, теперь идёт сообщением: view, items,
    // тема, флаг анимаций, выравнивание и токен сессии.
    //
    // ВАЖНО: pushPayload идёт ДО await waitPageReady не из оптимизации,
    // а ради буфера: если страница ещё не загрузилась, сообщение встаёт
    // в очередь pendingPush и уйдёт при did-finish-load. Обратный порядок
    // был бессмысленным: waitPageReady выставляет pageReady = true, и
    // буферизация становилась недостижимой.
    const message: PushMessage = {
      sessionId: sessionToken,
      model: overlayModel(request),
      theme,
      animations,
      // Контракт называет это anchorLeft: 'start' -> прижать к левому
      // краю якоря. Раньше поле называлось align и ехало в payload URL,
      // теперь форма задана контрактом.
      anchorLeft: request.align === 'start'
    }
    pushPayload(win, message)
    mark('ov:nav')
    // Ожидаем, что сообщение применится и renderer подтвердит отрисовку.
    // Страховка waitPageReady чисто информационная: сообщение уже в очереди
    // и уйдёт при загрузке, ждать здесь нечего — дальше нас спасёт
    // overlayPainted, у которого своя выдержка.
    const pageLoaded = await waitPageReady(win)
    if (win.isDestroyed()) return
    // Страница не загрузилась. Показывать нечего: push ушёл в очередь и
    // уйдёт позже сам, а содержимое всё равно не отрисуется в этот сеанс.
    // Гасим окно и снимаем сессию — раньше здесь стоял показ, и он
    // приводил к пустому непрозрачному окну без единой ошибки в логах.
    if (!pageLoaded) {
      abortPresent(win, parent, sessionToken)
      return
    }
    // Показ. Ключевой момент — прозрачность включается ПОСЛЕ того, как
    // renderer реально применил contentUnmounted=false.
    //
    // setContentUnmounted — асинхронный IPC: сообщение уходит в renderer,
    // Vue применяет v-if на следующем кадре. Если сразу после него
    // включить opacity, есть кадр, где окно уже на реальных координатах и
    // уже непрозрачное, но ещё со СТАРЫМ содержимым — это и есть вспышка.
    //
    // Поэтому ждём подтверждения от renderer и только после него
    // возвращаем прозрачность. Пока окно пустое, моргать нечему, даже
    // если WM его покажет.
    markContentShown(parent.id)
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
    setContentUnmounted(win, false)
    // Ждём, пока renderer применит contentUnmounted=false и отдаст кадр.
    const painted = await overlayPainted(win, sessionToken)
    if (win.isDestroyed()) return
    // Подтверждения нет: renderer не смог применить содержимое. Прозрачность
    // не возвращаем — иначе пользователь увидит пустое окно, и в логах
    // не будет ни ошибки, ни внятной причины.
    if (!painted) {
      abortPresent(win, parent, sessionToken)
      return
    }
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

  // Навигации больше нет: страница оверлея загружается один раз при
  // создании окна (в пуле) и дальше не перезагружается. Данные приходят
  // через overlay:push, поэтому did-navigate-in-page, did-finish-load,
  // таймаут 250 мс и overlayUrl() больше не нужны.
  //
  // Остаётся показать окно: дождаться готовности страницы, отправить
  // push, дождаться подтверждения отрисовки. Всё это делает present().
  void present()
}

export function resolveOverlaySelect(overlay: BrowserWindow, id: string): void {
  log('command', `select: ${id}`)
  const parentId = findParentIdByOverlay(overlay)
  if (parentId === undefined) return
  const entry = active.get(parentId)
  if (!entry) return
  {
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
        // сессия своим setContentUnmounted(true), а если она ещё грузится, то
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
      clearActiveSession(parentId)
      try {
        // hide(), а не close(): родитель уже мёртв, но окно держим
        // в пуле, если оно переиспользуемо.
        hideContent(overlay)
      } catch {
        // Игнорим.
      }
    }
  }
}

export function resolveOverlayDismiss(overlay: BrowserWindow): void {
  log('command', 'dismiss')
  const parentId = findParentIdByOverlay(overlay)
  if (parentId === undefined) return
  const parent = BrowserWindow.fromId(parentId)
  if (parent) closeOverlay(parent)
  else {
    clearActiveSession(parentId)
    try {
      hideContent(overlay)
    } catch {
      // Игнорим.
    }
  }
}

// Диалог с полем ввода: значение "buttonId::text" резолвится
// через тот же onSelect — main разобрает префикс сам.
export function resolveOverlaySubmit(overlay: BrowserWindow, raw: string): void {
  log('command', `submit: ${raw.slice(0, 40)}`)
  const parentId = findParentIdByOverlay(overlay)
  if (parentId === undefined) return
  const entry = active.get(parentId)
  if (!entry) return
  const parent = BrowserWindow.fromId(parentId)
  entry.request.onSelect?.(raw)
  if (parent) closeOverlay(parent)
  else {
    clearActiveSession(parentId)
    try {
      hideContent(overlay)
    } catch {
      // Игнорим.
    }
  }
}

// Общий диалог иконки: верификация источника перед применением.
// Возвращает true если применено (диалог закроется), false если
// источник отклонен (диалог остается, renderer показывает ошибку).
// Кнопка file открывает системный диалог выбора картинки и подставляет
// путь в поле через executeJavaScript — submit идет обычным путем.
//
// apply больше НЕ передаётся снаружи и не дублируется на окне в
// __iconApply: он лежит в request активной сессии, а сессия находится
// через обратную карту. Раньше контекст хранился в двух местах сразу, и
// apply на окне мог устареть раньше сессии.
export async function resolveOverlaySubmitIcon(
  overlay: BrowserWindow,
  buttonId: string,
  value: string
): Promise<boolean> {
  log('command', `submit-icon: ${buttonId} (${value.slice(0, 30)})`)
  const parentId = findParentIdByOverlay(overlay)
  if (parentId === undefined) return false
  const entry = active.get(parentId)
  if (!entry) return false
  const apply = entry.request.onIconApply
  if (!apply) return false
  {
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
          // Ошибка уходит через overlay:update, а не executeJavaScript:
          // раньше скрипт правил .dialog-error по селектору, и разметка с
          // данными расходились при любом переименовании класса.
          const errParent = BrowserWindow.fromId(parentId)
          if (errParent) {
            updateActiveOverlay(errParent, { icon: { error: conv.error } })
          }
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
      clearActiveSession(parentId)
      try {
        hideContent(overlay)
      } catch {
        // Игнорим.
      }
    }
    return true
  }
  return false
}
