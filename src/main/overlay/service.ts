// ГРАНИЦА ФАЙЛА: показ оверлея — сессия, токены, present(),
// painted/unmounted. Файл — машина состояний ПОКАЗА; закрытие живёт
// в close.ts, команды renderer'а в resolve.ts, геометрия и сборка
// push — в push.ts. Потребители импортируют через ./index, а не
// отсюда: внутренние файлы папки не должны становиться контрактом.
//
// ЧТО ВЫНОСИТЬ ПРИ РОСТЕ:
// - новый kind оверлея -> ветка в overlayModel (push.ts) + панель
//   в renderer/overlay/, НЕ новый блок в showOverlay;
// - позиционирование -> geometry.ts, размер пула -> pool.ts;
// - каналы overlay:* -> ipc.ts, токены/сессии -> session.ts;
// - чистые builder-функции без BrowserWindow -> отдельный модуль
//   (так уже ушли iconVerify и findScripts).
// Сигнал к разделению: второй независимый сценарий закрытия или
// третий уровень стека, дублирующий restoreStackAfterPop (close.ts).
import { BrowserWindow, app, ipcMain, screen } from 'electron'
import { log, mark, perf, recordOpen, now, logError } from './logger'
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
import { pushPayload, waitPageReady, dropPendingPush } from './pool'
import type { PoolHooks } from './pool'
import { resolveBounds, resolveUnionBounds, surfaceFor } from './geometry'
import {
  clearSession,
  isTopSession,
  nextSessionId,
  sessionById,
  sessionOf,
  setSession,
  stackOf
} from './session'
import {
  closeOverlay,
  closeStack,
  closeIfFocusLeftApp,
  isDismissableMenuLike,
  isFocusHandoffActive,
  isSystemDialogOpen,
  lastClosed,
  noteFocusHandoff,
  restoreFocusToParent,
  TOGGLE_ECHO_MS,
  BLUR_SETTLE_MS
} from './close'
import { buildPushMessage, pendingGeometry, provisionalSize } from './push'
import type { LevelGeometry } from './push'

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
// Импортировать этот модуль следует из './overlay' — точки входа, а не
// отсюда: внутренние файлы папки не должны становиться контрактом для
// потребителей.


export interface OverlayMenuItem {
  id: string
  label: string
  icon: string
  // Цвет группы (для Add to group): точка-индикатор как на панели закладок.
  color?: string
  disabled?: boolean
  // Разделительная линия. Только у меню окна: в системном их три, и без
  // них меню читается как сплошной список. Пустые label/icon игнорируются
  // renderer-ом, пункт не нажимается и не получает фокус.
  separator?: boolean
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

export interface OverlayRequest {
  kind: 'menu' | 'toast' | 'dialog' | 'find' | 'icon' | 'window-menu' | 'zoom'
  anchor: { x: number; y: number }
  items?: OverlayMenuItem[]
  toast?: { title: string; body?: string; timeout?: number }
  dialog?: {
    title: string
    placeholder?: string
    initial?: string
    buttons: OverlayDialogButton[]
  }
  icon?: IconDialogState
  find?: { query?: string }
  // Текущий процент зума попапа. Общий объект с моделью из openZoomPopup:
  // onSelect мутирует его, и пересборка push (измерение, возврат по Esc)
  // показывает уже применённый процент, а не тот, что был на открытии.
  zoom?: { percent: number }
  onSelect?: (id: string) => void
  // Не закрывать сессию после select. Нужно попапу зума: `+`/`−`/`Reset`
  // обновляют процент через overlay:update и держат попап открытым,
  // тогда как пункт меню закрывает его всегда.
  holdOnSelect?: (id: string) => boolean
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

// Состояние закрытия (toggle-эхо lastClosed, заслон системного
// диалога isSystemDialogOpen) и фокуса (focusHandoff) живёт в close.ts:
// им пользуются все сценарии закрытия, а показ только читает флаги.

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

// Бюджет «быстрой» отрисовки: пока он не превышен, молчим, потому что
// такое время — норма. Превышение — уже интересно, но НЕ повод
// отменять показ (см. PAINT_TIMEOUT_MS).
const PAINT_BUDGET_MS = 60

// Сколько ждем painted, прежде чем считать renderer не отвечающим.
//
// Это НЕ бюджет латентности, а страховка безопасности, и это различие
// решающее. Пока ждём, окно прозрачно и пусто — пользователь не видит
// ничего. Значит ожидание не ощущается: ни миллисекунда этого таймаута
// не попадает во «время открытия» в восприятии, всё оно уходит на паузу
// ДО появления меню. А вот короткий таймаут вредит: он ловит не поломку,
// а медленный кадр, и отменяет показ, который вот-вот был бы показан.
//
// На шаге 9 измерено на dev: первый paint занимает 67.7 мс, потому что
// шаблоны Vue компилируются в браузере при первом монтировании. При
// старом таймауте 120 мс первые два открытия в dev не укладывались и
// отменялись — меню просто не появлялось, при том что renderer был жив
// и через несколько кадров присылал painted. В prod тот же путь —
// 6.7..30.6 мс, отмен не было вовсе.
//
// Поэтому таймаут намеренно щедрый: он должен ловить только «renderer
// не ответит никогда» (упавший preload, разрушенное окно), а не
// «renderer ответил чуть позже».
const PAINT_TIMEOUT_MS = 1000

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
    // Весь стек, а не верхний уровень: после перемещения окна невалидна
    // и вложенная сессия, а оставить её значило бы оставить диалог
    // висящим над пустым местом.
    closeStack(parent)
  }
  const closeOnBlur = (): void => {
    if (isSystemDialogOpen) return
    if (isContentUnmounted(parent.id)) return
    const entry = sessionOf<OverlayRequest>(parent.id)
    if (!entry) return
    // Токен сессии: пока ждём проверки ниже, сессия могла закрыться или
    // смениться. Тогда blur относится к другой поверхности, и гасить
    // текущую нельзя.
    const token = entry.sessionId
    // Переключение на чужое окно не стреляет ни move, ни resize, ни
    // minimize. Ловим это здесь, по blur'у родителя, но поверх
    // работает только один guard: оверлей лежит под курсором (парковка
    // больше не уводит его за экран), клик по нему активирует наше окно,
    // и blur родителя — не уход пользователя, а побочный эффект
    // нажатия. Отличить это от ухода можно только по фокусу оверлея.
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
    const until = isFocusHandoffActive(parent.id)
    if (until) return
    // Проверка отложенная на всех платформах, и это не оптимизация.
    //
    // На Windows isFocused() синхронен, и ответ приходит сразу. На Linux
    // активация окна АСИНХРОННА: в момент blur родителя WM ещё не
    // успел перевести фокус на оверлей, и getFocusedWindow() возвращает
    // null. Проверка на этом кадре говорила бы «ушли из приложения» —
    // и меню закрывалось бы тем самым кликом, которым выбирают пункт.
    // Живой прогон это подтвердил: в логах шло
    //   app left focus -> close overlay { holderId: 1 }
    //   closing
    //   focus landed on hidden overlay -> parent { overlayId: 2 }
    // то есть blur пришёл первым, а фокус оверлею передан уже после
    // закрытия, и клик по пункту ушёл в размонтированное содержимое.
    //
    // Через BLUR_SETTLE_MS активация успевает завершиться, и оверлей
    // виден как держащий фокус. Задержка незаметна: на Alt+Tab оверлей
    // гаснет на 60 мс позже, что в кадре не воспринимается.
    setTimeout(() => {
      if (isSystemDialogOpen) return
      // Сессия могла закрыться или уйти вниз стека, пока ждали: blur мог
      // прийти от другой поверхности, и гасить текущую нельзя.
      // Именно ВЕРХНЯ: isCurrentSession в стеке отвечает на вопрос «есть
      // ли она вообще», и пропустил бы проверку, когда поверх меню лежит
      // диалог — тогда blur меню закрыл бы диалог вместо того, чтобы его
      // игнорировать.
      if (!isTopSession(parent.id, token)) return
      if (isContentUnmounted(parent.id)) return
      if (overlay.isDestroyed()) return
      // Фокус у нашего окна — значит это не уход из приложения, а
      // активация оверлея кликом по нему же.
      if (overlay.isFocused() || parent.isFocused()) {
        log('lifecycle', 'parent blur by own overlay, ignored', {
          parentId: parent.id,
          sessionId: token,
          overlayFocused: overlay.isFocused(),
          parentFocused: parent.isFocused()
        })
        return
      }
      // Фокус ушёл не в оверлей — значит приложение покинуто (Alt+Tab),
      // и оверлей обязан скрыться.
      closeIfFocusLeftApp(parent, parent.id)
    }, BLUR_SETTLE_MS)
  }
  // Тот же признак, но со стороны оверлея. Нужен потому, что при
  // открытой панели поиска ФОКУС ДЕРЖИТ ОВЕРЛЕЙ: родитель потерял его
  // ещё при открытии, и blur родителя при Alt+Tab не приходит вовсе.
  // Без этого слушателя панель поиска и диалог иконки висели бы поверх
  // чужого окна (проверено: воспроизводилось на живом Alt+Tab).
  // Проверка отложенная по той же причине, что в closeOnBlur: активация
  // окна на Linux асинхронна, и мгновенная проверка isFocused() сказала бы
  // «ушли из приложения» в тот самый кадр, когда фокус как раз ПЕРЕХОДИТ
  // оверлею.
  const onOverlayBlur = (): void => {
    if (isSystemDialogOpen) return
    if (isContentUnmounted(parent.id)) return
    const entry = sessionOf<OverlayRequest>(parent.id)
    if (!entry) return
    const token = entry.sessionId
    setTimeout(() => {
      if (isSystemDialogOpen) return
      // Верхняя, а не «где угодно в стеке»: см. замечание в closeOnBlur.
      if (!isTopSession(parent.id, token)) return
      if (isContentUnmounted(parent.id)) return
      if (overlay.isDestroyed()) return
      // Родитель мог уже забрать фокус себе (например, по
      // restoreFocusToParent после закрытия) — тогда это не уход из
      // приложения.
      if (parent.isFocused()) return
      closeIfFocusLeftApp(overlay, parent.id)
    }, BLUR_SETTLE_MS)
  }
  // Esc закрывает активный оверлей.
  //
  // Слушатель висит на ДВУХ webContents — родителя и самого оверлея, и это
  // не дублирование, а следствие шага 7. Изначально обработчик был только
  // на родителе: оверлей открывался через showInactive(), фокуса не
  // получал, и Esc уходил в страницу браузера, а renderer оверлея его не
  // видел. Теперь меню получает фокус (это нужно клавиатурной навигации),
  // и Esc уходит уже в оверлей — слушатель на родителе молча перестал
  // срабатывать, а в renderer Esc намеренно не ловится.
  //
  // Нажатие приходит ровно в тот webContents, у которого фокус, поэтому
  // двойного закрытия не будет. Родитель оставлен на случай, когда фокус
  // ещё не переехал (окно показано, фокусировка не успела).
  //
  // Тосты исключены: они пассивны, живут по своему таймеру и гаситься
  // пользователем не должны. find/dialog/icon/menu — наоборот, обязаны
  // закрываться, причём не теряя введённый текст.
  const onBeforeInput = (
    event: Electron.Event,
    input: Electron.Input
  ): void => {
    if (input.type !== 'keyDown' || input.key !== 'Escape') return
    const entry = sessionOf<OverlayRequest>(parent.id)
    if (!entry) return
    if (entry.request.kind === 'toast') return
    event.preventDefault()
    log('session', 'esc closes overlay', {
      parentId: parent.id,
      kind: entry.request.kind
    })
    closeOverlay(parent)
  }
  parent.webContents.on('before-input-event', onBeforeInput)
  overlay.webContents.on('before-input-event', onBeforeInput)
  parent.on('move', closeOnParent)
  parent.on('resize', closeOnParent)
  parent.on('minimize', closeOnParent)
  parent.on('blur', closeOnBlur)
  overlay.on('blur', onOverlayBlur)
  overlay.on('closed', () => {
    parent.removeListener('move', closeOnParent)
    parent.removeListener('resize', closeOnParent)
    parent.removeListener('minimize', closeOnParent)
    parent.removeListener('blur', closeOnBlur)
    overlay.removeListener('blur', onOverlayBlur)
    // Проверка уничтожения обязательна для ОБЕИХ сторон.
    //
    // Слушатель висит на дочернем оверлее, и при закрытии приложения он
    // срабатывает в момент, когда одно из окон уже разрушено: родитель
    // закрылся раньше оверлея, либо оверлей раньше родителя. Обращение к
    // webContents уничтоженного окна бросает
    // «Object has been destroyed» — и оно всплывает как необработанное
    // исключение в главном процессе, с диалогом поверх приложения.
    //
    // Раньше здесь стоял только parent.webContents.removeListener, и окно
    // не разрушалось при закрытии, поэтому наткнуться на это было нельзя.
    // Оверлей из пула уничтожается при выходе, и тогда первым падал
    // именно оверлейный webContents.
    if (!parent.isDestroyed()) {
      parent.webContents.removeListener('before-input-event', onBeforeInput)
    }
    if (!overlay.isDestroyed()) {
      overlay.webContents.removeListener('before-input-event', onBeforeInput)
    }
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

// Счётчик сессий и реестр активных сессий живут в session.ts: ими
// пользуются и сервис, и стек вложенности, поэтому
// держать их здесь означало бы копить импорт в сторону шага 8.

// Фаза ready исчезла вместе с навигацией: раньше main ждал, пока
// renderer применит payload из URL, и держал окно прозрачным. Теперь
// данные приходят через overlay:push в уже готовый renderer, поэтому
// ждать нечего — достаточно подтверждения отрисовки (overlayPainted).

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

// Геометрия показа (provisionalSize, LevelGeometry/PendingGeometry,
// pendingGeometry, buildPushMessage, pushStackGeometry, applyMeasured,
// overlayModel) вынесена в push.ts: её делят showOverlay, возврат по
// Esc (close.ts) и overlay:measured.

// Сборка push-сообщения (buildPushMessage, pushStackGeometry,
// overlayModel) и применение измерения (applyMeasured) — в push.ts.

/**
 * Renderer подтвердил, что сессия с токеном отрисована. Разрешаем показ.
 * Токен сверяется: подтверждение от устаревшей сессии игнорируем.
 *
 * Возвращает true при подтверждении и false по таймауту. Различие
 * принципиально: раньше обе ветки сводились к показу, и окно становилось
 * непрозрачным без содержимого — тихо и без ошибок в логах. Теперь
 * вызывающий код по false отменяет показ.
 */
// Постоянный учёт подтверждений отрисовки.
//
// overlayPainted подписывается на painted ПОСЛЕ того, как push уже ушёл в
// renderer. Между отправкой и подпиской подтверждение может прийти — и
// улететь в пустоту, после чего main ждёт до таймаута и аварийно гасит
// окно. На прогоне это дало 15 абортов подряд.
//
// Слушатель стоит всегда и просто запоминает токены. Ожидание по
// конкретному токену по-прежнему ведёт overlayPainted.
export function watchPaintedOnce(): void {
  if (watchPaintedOnce.done) return
  watchPaintedOnce.done = true
  ipcMain.on(PAINTED_CHANNEL, (_e: Electron.IpcMainEvent, t: number): void => {
    paintedSeen.add(t)
  })
}
watchPaintedOnce.done = false

// id окон, для которых подтверждение размонтирования уже пришло, но ещё
// не востребовано. Renderer отвечает на каждое park-сообщение, в том
// числе на те, что main шлёт мимо awaitUnmounted, — иначе подтверждение
// опережало бы подписку и терялось.
const unmountedSeen = new Set<number>()

// Ожидающие подтверждения: id окна оверлея -> резолвер.
const unmountWaiters = new Map<number, () => void>()

// Сколько ждём подтверждения, прежде чем показать окно в любом случае.
// Пока ждём, пользователь видит прежнее содержимое на прежнем месте:
// картинка не портится, показ просто начинается чуть позже.
const UNMOUNT_TIMEOUT_MS = 250

/** Подтверждение размонтирования пришло от renderer. */
export function confirmUnmounted(overlay: BrowserWindow): void {
  unmountedSeen.add(overlay.id)
  unmountWaiters.get(overlay.id)?.()
}

/**
 * Ждёт, пока renderer подтвердит, что содержимое убрано из DOM.
 *
 * Вызывается перед setBounds при смене содержимого поверх ЖИВОГО окна.
 * На Linux setOpacity — no-op, поэтому единственная защита от кадра со
 * старым содержимым — размонтирование, и без ожидания окно успевало
 * переехать на новые координаты, пока прежнее меню ещё было на экране:
 * пользователь видел на месте диалога иконки пункт меню вкладок.
 *
 * На типичном показе ожидания нет: окно и так пустое, renderer молчит,
 * потому что подтверждать нечего. Ожидание включается только когда
 * показать реально есть что стирать — то есть вызывается лишь из ветки
 * «живое окно», а не из пула.
 *
 * @returns сколько ждали, мс. Для лога.
 */
export function awaitUnmounted(overlay: BrowserWindow): Promise<number> {
  const id = overlay.id
  // Подтверждение могло прийти ДО подписки — renderer отвечает на каждое
  // park-сообщение, а не только на те, что main ждёт.
  if (unmountedSeen.delete(id)) return Promise.resolve(0)
  const started = now()
  return new Promise<number>((resolve) => {
    const done = (): void => {
      if (unmountWaiters.get(id) !== done) return
      unmountWaiters.delete(id)
      clearTimeout(timer)
      resolve(now() - started)
    }
    unmountWaiters.set(id, done)
    const timer = setTimeout(() => {
      // Renderer не ответил. Показываем всё равно: отсутствие ответа
      // означает риск одного кадра, а не поломку.
      log('lifecycle', 'unmount confirm timeout, showing anyway', { overlayId: id })
      done()
    }, UNMOUNT_TIMEOUT_MS)
  })
}

// Токены, для которых painted уже пришёл ДО подписки.
const paintedSeen = new Set<number>()

function overlayPainted(overlay: BrowserWindow, token: number): Promise<boolean> {
  if (overlay.isDestroyed()) return Promise.resolve(false)
  // Подтверждение могло прийти раньше: до этой функции слушателя не
  // было, и painted улетал в пустоту. Смотрим на факт получения.
  if (paintedSeen.delete(token)) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    let settled = false
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined
    const startedAt = now()
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      ipcMain.removeListener(PAINTED_CHANNEL, listener)
      clearTimeout(budgetTimer)
      clearTimeout(fallbackTimer)
      resolve(ok)
    }
    const listener = (_e: Electron.IpcMainEvent, t: number): void => {
      if (t === token) {
        perf('paint', 'ov:ready')
        finish(true)
      }
    }
    ipcMain.on(PAINTED_CHANNEL, listener)
    // Медленный кадр — не поломка. Пока бюджет не превышен, молчим:
    // отличить одно от другого можно только по времени, и отменять
    // показ по медленному кадру — ложное срабатывание (см. PAINT_TIMEOUT_MS).
    const budgetTimer = setTimeout(() => {
      log('lifecycle', 'paint budget exceeded, waiting longer', {
        token,
        waitedMs: Number((now() - startedAt).toFixed(1))
      })
      // Страховка по-прежнему нужна: если renderer не ответит никогда,
      // показ обязан отмениться, а не висеть вечно.
      fallbackTimer = setTimeout(() => {
        log('lifecycle', 'paint timeout, aborting overlay', { token })
        finish(false)
      }, PAINT_TIMEOUT_MS)
    }, PAINT_BUDGET_MS)
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
  // Снимаем ТОЛЬКО свою сессию, по её токену. clearSession без токена
  // снимает весь стек: если пока ждали подтверждения поверх открылся
  // вложенный уровень, он был бы снесён вместе с нашим. Раньше стека не
  // было и полное снятие было единственным вариантом.
  const entry = sessionById<OverlayRequest>(parent.id, sessionToken)
  if (entry) clearSession(parent.id, sessionToken)
  log('lifecycle', 'overlay aborted, nothing shown', { parentId: parent.id, sessionId: sessionToken })
}

// Закрытие сессий (closeOverlay, closeStack, closeOverlayIfMenu,
// closeOverlayOnTabChange), доступ к активной сессии (getActiveOverlay,
// getActiveRequest, updateActiveOverlay, updateOverlayBySender,
// getParentOfOverlay) и возврат фокуса — в close.ts: ими делят
// blur-слушатели, abortPresent и IPC.

export function showOverlay(parent: BrowserWindow, request: OverlayRequest): void {
  // Toggle: повторный клик по ТОМ ЖЕ триггеру закрывает его меню.
  // Ключ обязателен: без него закрылось бы чужое открытое меню — например,
  // открыто меню вкладки, клик по ☰ закрыл бы его вместо показа меню
  // браузера. Диалоги и поиск ключа не имеют и всегда просто показываются.
  // zoom-badge в списке обязателен: повторный клик по бейджу зума закрывает
  // его попап (контракт тот же, что у ☰).
  if (request.toggleKey && isDismissableMenuLike(request.kind)) {
    const cur = sessionOf<OverlayRequest>(parent.id)
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
  // Описание поверхности: размеры и выравнивание одним объектом.
  // Хардкод вида MENU_PAD + N * MENU_ITEM_H удалён на шаге 6: число 40
  // не имело отношения к CSS, и каждый пункт меню съедал 6 px.
  //
  // До измерения берётся размер из описания поверхности — этого хватает
  // для первого кадра. Настоящий размер приходит из renderer через
  // overlay:measured и корректирует bounds, см. applyMeasured.
  const spec = surfaceFor(request.kind, request.align)
  const provisional = provisionalSize(request)

  // Рабочая область дисплея РОДИТЕЛЯ, а не объединённая. При раскладке
  // с окном на левом мониторе workArea.x отрицателен, и арифметика в
  // положительных координатах уводит окно на соседний дисплей.
  const workArea = display.workArea
  log('geometry', 'parent display', {
    parentId: parent.id,
    displayId: display.id,
    workArea,
    contentBounds: parentBounds
  })

  //
  // ВЛОЖЕННОСТЬ ОТКЛЮЧЕНА ПО РЕШЕНИЮ ПОЛЬЗОВАТЕЛЯ.
  //
  // Признано: стек уровней строит «Change icon» из меню вкладки, открывая
  // диалог ПОВЕРХ меню, оставляя меню видимым под ним. Проверка на
  // живом прогоне показала, что это не целевое поведение: у пользователя
  // это выглядит как два наложенных окна, а не как переход «меню ->
  // диалог».
  //
  // Механика стека оставлена в коде целиком: session.ts, union,
  // LevelGeometry, frozen, реестр уровней в renderer. Она стоит
  // включённой одной строкой (isNested), и включение её обратно — одна
  // правка, а не восстановление с нуля.
  //
  // Что при этом работает:
  //   - меню иконки ВЫТЕСНЯЕТ меню вкладки, как до шага 8;
  //   - стек глубиной 1 — это ровно прежнее поведение, а все проверки
  //     по токену, геометрии уровней и фокусу работают как надо.
  //
  // Что пришлось чинить, пока механику включали, и что нужно помнить при
  // возврате к вложенности:
  //   - обратная карта «окно оверлея -> родитель» общая для всех уровней,
  //     и снимать её можно только при пустом стеке (session.ts);
  //   - isTopSession, а не isCurrentSession, в resolveOverlaySelect и в
  //     blur-обработчиках;
  //   - spec и anchor лежат на КАЖДОМ уровне, а не на показе;
  //   - сверка устаревших push сравнивает стеки, а не верхние токены.
  const existing = stackOf<OverlayRequest>(parent.id)
  //
  // Рубрильник вложенности. Возвращается к true вместе с описанием
  // уровня в requests: условие восстанавливает стек ровно в том виде, в
  // каком он был до отката.
  const NESTED_DIALOGS = false
  const isNested =
    NESTED_DIALOGS &&
    existing.length > 0 &&
    existing[existing.length - 1].request.kind === 'menu' &&
    (request.kind === 'icon' || request.kind === 'dialog')
  if (!isNested) {
    // Новый корень: старый стек снимаем целиком. closeOverlay здесь не
    // годится — он гасит окно, а нам нужно показать новое содержимое
    // поверх старого, иначе между setContentUnmounted и отрисовкой
    // пользователь увидит пустое окно.
    for (const old of existing) dropPendingPush(old.overlay, old.sessionId)
    clearSession(parent.id)
  }

  const resolved = resolveBounds(
    parentBounds,
    workArea,
    request.anchor,
    spec,
    provisional,
    false
  )
  //
  // Прямоугольник этого уровня в экранных координатах.
  const level: Electron.Rectangle = {
    x: resolved.x,
    y: resolved.y,
    width: resolved.width,
    height: resolved.height
  }
  //
  // Уровни, уже лежащие в стеке, и новый — окно должно покрывать их все
  // (вариант B шага 8). Прямоугольники нижних уровней берём из прошлой
  // геометрии: pendingGeometry хранит их именно для этого.
  const carried: LevelGeometry[] = []
  if (isNested) {
    const prev = pendingGeometry.get(parent.id)
    if (prev) carried.push(...prev.levels)
  }
  const { x, y, width, height } = resolveUnionBounds(
    [...carried.map((l) => l.rect), level],
    workArea
  )

  // Геометрия запоминается для последующей коррекции по измерению.
  // Описание поверхности и якорь лежат на КАЖДОМ уровне, а не на показе:
  // после возврата по Esc замер приходит от нижнего уровня, и общий spec
  // пересчитывал меню по ширине диалога.
  pendingGeometry.set(parent.id, {
    parentBounds,
    workArea,
    // Union последнего показа. При возврате уровня он НЕ пересчитывается
    // (см. restoreStackAfterPop), и offset'ы остаются в тех же границах.
    union: { x, y, width, height },
    // Полный показ: окно снова считается по всем уровням.
    frozen: false,
    levels: [
      ...carried,
      // Токен проставляется сразу после nextSessionId() ниже: на этом
      // месте сессия ещё не создана. Пока он 0, уровень не найдётся по
      // токену — но и не должен: возврата до конца показа не бывает.
      { sessionId: 0, rect: level, spec, anchor: request.anchor, flipped: resolved.flipped }
    ]
  })


  // Оверлей-окно уже создано заранее через ensureOverlayWindow.
  // Просто обновляем bounds и загружаем новый payload.
  let overlay = getPooledOverlay(parent.id)
  const reused = !!overlay && !overlay.isDestroyed()
  // Окно было ЖИВЫМ — на экране, с видимым содержимым. Определяем ДО
  // hideContent: тот снимает флаг размонтирования, и после него признак
  // уже не различить.
  //
  // Признак нужен в present(): у живого окна есть что стирать, и перед
  // setBounds надо дождаться подтверждения от renderer. У припаркованного
  // содержимое уже убрано, ждать нечего.
  const wasLive = !isContentUnmounted(parent.id)
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
  const sessionToken = nextSessionId()
  // Токен последнего уровня проставляется здесь: в pendingGeometry он
  // был записан с заглушкой, потому что на том месте сессии ещё не было.
  // Без этого возврат по Esc не нашёл бы снятый уровень по токену.
  {
    const geo = pendingGeometry.get(parent.id)
    if (geo && geo.levels.length > 0) {
      const last = geo.levels[geo.levels.length - 1]
      if (last.sessionId === 0) {
        geo.levels[geo.levels.length - 1] = { ...last, sessionId: sessionToken }
      }
    }
  }
  // Подтверждения отрисовки для прошлых показов больше не нужны: к этому
  // моменту они либо приняты, либо сессии давно нет. Без чистки множество
  // росло всю жизнь процесса.
  for (const seen of paintedSeen) {
    if (seen < sessionToken) paintedSeen.delete(seen)
  }
  setSession(parent.id, { overlay, request, sessionId: sessionToken, openedAt: Date.now() })
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
    // Окно намеренно забирает фокус (find вызывает focus() ниже, меню
    // тоже, диалоги — автофокусом поля ввода) — родитель потеряет его
    // после setBounds. Помечаем заранее, чтобы blur не закрыл только
    // что показанную поверхность.
    //
    // 'menu' в списке обязателен: он в фокусе с момента открытия, а
    // родитель, теряя фокус, посчитал бы это уходом из приложения и
    // закрыл меню тем самым фокусированием.
    if (
      request.kind === 'find' ||
      request.kind === 'icon' ||
      request.kind === 'dialog' ||
      request.kind === 'menu' ||
      request.kind === 'window-menu' ||
      request.kind === 'zoom'
    ) {
      noteFocusHandoff(parent.id)
    }
    // Окно может быть ЖИВЫМ (переключение поверх открытого меню) или
    // припаркованным (открытие из пула). В обоих случаях сначала
    // опустошаем его, и только потом перемещаем — иначе в промежутке
    // между setBounds и прозрачностью WM успевает показать кадр со
    // старым содержимым, и это видно как моргание.
    setContentUnmounted(win, true)
    // Ждём подтверждения размонтирования, но только если стирать есть
    // что: у припаркованного окна содержимое уже убрано (renderer молчит,
    // потому что подтверждать нечего), и ожидание лишь задержало бы
    // открытие. У ЖИВОГО окна на экране прежнее содержимое — его надо
    // сначала убрать из DOM, иначе окно переезжает на новые координаты,
    // а прежнее меню ещё на экране: на месте диалога иконки пользователь
    // видел пункт меню вкладок.
    //
    // На Linux setOpacity — no-op, поэтому размонтирование здесь не
    // «дополнительная» защита, а единственная.
    if (wasLive) {
      const waited = await awaitUnmounted(win)
      if (win.isDestroyed()) return
      if (waited > 0) {
        log('lifecycle', 'waited for unmount confirm', {
          parentId: parent.id,
          waitedMs: Number(waited.toFixed(1))
        })
      }
    }
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
    // Шлём весь стек, а не только верхний уровень. При одном
    // уровне его offset равен нулю — поведение не отличается от прежнего.
    const message = buildPushMessage(
      parent,
      pendingGeometry.get(parent.id)?.levels ?? [],
      { x, y, width, height }
    )
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
    // Клавиатура в меню. Оверлей открыт через showInactive() и сам фокуса
    // не получает: без focus() стрелки не доходят до renderer, и навигация
    // «оживала» только после клика по самому меню. Клик работал потому,
    // что он активировал окно — то есть фокус давал первый клик, а не
    // открытие.
    //
    // Меню и панель поиска забирают фокус; диалоги — через автофокус поля
    // ввода, тост фокуса не берёт вовсе (он пассивен). Попап зума — как
    // меню: без focus() стрелки/Enter в поле процента не доходили бы.
    if (
      request.kind === 'find' ||
      request.kind === 'menu' ||
      request.kind === 'window-menu' ||
      request.kind === 'zoom'
    ) {
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

// Команды renderer'а (resolveOverlaySelect/Dismiss/Submit/SubmitIcon)
// живут в resolve.ts: ими пользуется только overlay/ipc.ts.

