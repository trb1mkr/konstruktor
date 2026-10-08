// Закрытие оверлея: снятие сессий, возврат к нижнему уровню стека,
// возврат фокуса и гашение по событиям (blur, смена вкладки, клик мимо).
// Выделено из service.ts: показ живёт в service.ts, команды renderer'а —
// в resolve.ts, здесь — всё, что ЗАКРЫВАЕТ.
//
// Общее состояние, разделяемое с service.ts: lastClosed (toggle-эхо),
// isSystemDialogOpen (заслон системного диалога) и focusHandoff
// (метка передачи фокуса). Оно нужно здесь, потому что каждый сценарий
// закрытия сверяется с этими флагами.
import { BrowserWindow } from 'electron'
import { log, logError } from './logger'
import {
  dropPendingPush,
  getPooledOverlay,
  hideContent,
  parentOfPooledOverlay,
  pushPayload,
  updatePayload
} from './pool'
import {
  clearSession,
  parentIdOfOverlay,
  sessionOf,
  stackDepth,
  stackOf
} from './session'
import { buildPushMessage, pendingGeometry } from './push'
import type { OverlayRequest } from './service'

/**
 * Виды, которые гасятся внешним кликом и тогглом по своему триггеру.
 *
 * Меню (контекстное и окна) и попап зума: у всех один UX-контракт —
 * открытое закрывается кликом мимо и повторным кликом по триггеру,
 * диалоги/поиск/тосты так не закрываются (у них своя логика).
 *
 * Раньше условие было продублировано в шести местах сервиса, и каждое
 * новое «менюподобное» видело только часть из них: попап зума либо
 * не закрывался кликом по странице, либо закрывался при каждом `+`.
 */
export function isDismissableMenuLike(kind: OverlayRequest['kind']): boolean {
  return kind === 'menu' || kind === 'window-menu' || kind === 'zoom'
}

// parentId -> { toggleKey, at } последнего ЗАКРЫТОГО меню. Нужно, чтобы
// отличить эхо открывающего клика от настоящего повторного клика по
// триггеру: и то и другое приходит в showOverlay с одинаковым toggleKey,
// но эхо — сразу после закрытия, а настоящий клик — спустя время.
export const lastClosed = new Map<number, { toggleKey?: string; at: number }>()

// Сколько живёт запись о закрытии. Эхо приходит в том же тике, поэтому
// достаточно небольшого окна; 250 мс запас на медленный prod-перезапуск.
export const TOGGLE_ECHO_MS = 250

// Флаг: открыт ли системный диалог (файл/сохранение) — чтобы игнорировать blur/move/resize
export let isSystemDialogOpen = false

/** Открывает/закрывает заслон системного диалога (выбор файла иконки). */
export function setSystemDialogOpen(open: boolean): void {
  isSystemDialogOpen = open
}

// parentId -> время, до которого родительский blur не считается
// переключением на чужое окно. Заполняется noteFocusHandoff.
const focusHandoff = new Map<number, number>()

// Сколько живёт пометка передачи фокуса. Столько нужно, чтобы focus()
// оверлея дошёл до него на Linux: там он асинхронный, и в момент blur
// родителя overlay.isFocused() ещё вернул бы false.
const FOCUS_HANDOFF_MS = 400

// Сколько ждать, прежде чем признавать blur родителя уходом из
// приложения. Нужно, чтобы на Linux успела завершиться асинхронная
// активация окна оверлея: в момент blur она ещё не началась, и
// isFocused() вернул бы false на клике по самому меню.
//
// 60 мс — с запасом больше типичного времени активации окна в WM,
// но меньше времени, за которое человек успевает переключиться на
// другое приложение и заметить оставшийся оверлей.
export const BLUR_SETTLE_MS = 60

// Оверлей намеренно забирает фокус (панель поиска, автофокус поля в
// диалоге) — родитель закономерно его теряет. Такой blur пропускаем.
export function noteFocusHandoff(parentId: number): void {
  focusHandoff.set(parentId, Date.now() + FOCUS_HANDOFF_MS)
}

/** Жива ли ещё метка передачи фокуса (для решений по blur). */
export function isFocusHandoffActive(parentId: number): boolean {
  return Date.now() < (focusHandoff.get(parentId) ?? 0)
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
export function closeIfFocusLeftApp(
  holder: BrowserWindow,
  parentId: number
): boolean {
  if (isSystemDialogOpen) return false
  const parent = BrowserWindow.fromId(parentId)
  if (!parent || parent.isDestroyed()) return false
  // Фокус ушёл в ЧУЖОЕ окно — оверлей обязан скрыться, иначе он останется
  // висеть поверх окна, которое пользователь открыл вместо нашего.
  //
  // Раньше здесь стояло исключение «фокус ушёл в другое наше окно, это
  // переключение внутри приложения, не трогаем». Оно работало только
  // потому, что проверка была МГНОВЕННОЙ: в момент blur ни одно наше окно
  // ещё не успело получить фокус, и условие не срабатывало. С переводом
  // проверки на отложенную (BLUR_SETTLE_MS, ради бага с кликом по пункту
  // меню) вторая окно браузера к этому моменту УЖЕ в фокусе — исключение
  // начало срабатывать, и оверлей первого окна оставался висеть поверх
  // второго. Живой прогон это подтвердил.
  //
  // Исключение остаётся, но только для НАШЕЙ поверхности: фокус в
  // самом оверлее или в его родителе — это не уход из приложения.
  // Всё остальное (чужое приложение, ДРУГОЕ окно браузера) означает, что
  // наше окно больше не сверху, и оверлей надо гасить.
  const focused = BrowserWindow.getFocusedWindow()
  if (
    focused &&
    !focused.isDestroyed() &&
    (focused.id === holder.id || focused.id === parent.id)
  ) {
    log('lifecycle', 'focus moved to own surface, ignored', {
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
  // Весь стек: приложение ушло в фон, и оставшийся уровень наверху
  // висел бы поверх чужого окна.
  closeStack(parent)
  return true
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
export function restoreFocusToParent(
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

/**
 * Возврат к нижнему уровню стека после Esc.
 *
 * Esc снимает верхний уровень (см. closeOverlay), но окно остаётся на
 * экране: под диалогом лежит меню, и оно должно выглядеть как до
 * открытия диалога.
 *
 * Что здесь происходит, по порядку:
 *
 * 1. Геометрия пересчитывается по ОСТАВШИМСЯ уровням. Окно было объединением
 *    меню и диалога; снятие диалога оставляет окно вдвое больше нужного.
 *    Новое объединение — снова по прямоугольникам оставшихся уровней.
 *
 * 2. В renderer уходит push укороченного стека. Renderer не знает, что
 *    уровень снят, — без сообщения он продолжил бы рисовать диалог.
 *
 * 3. Ничего не гасится: прозрачность, размонтирование и возврат фокуса
 *    здесь были бы лишними. Окно мигало бы, а фокус ушёл бы на родителя
 *    вместо меню.
 *
 * Токен снятой сессии обязателен: из пула приходит сообщение для всех
 * уровней, и без сверки укороченный стек применился бы к уже закрытой
 * сессии.
 */
function restoreStackAfterPop(parent: BrowserWindow, poppedSessionId: number): void {
  const overlay = getPooledOverlay(parent.id)
  if (!overlay) return
  const remaining = stackOf<OverlayRequest>(parent.id)
  if (remaining.length === 0) return

  const pending = pendingGeometry.get(parent.id)
  if (!pending) return
  // Уровень снятой сессии ищется по ТОКЕНУ. Срез по длине стека
  // оставлял бы в геометрии уровень, которого в стеке уже нет, и union
  // после возврата считался бы по снятой карточке.
  const index = pending.levels.findIndex((l) => l.sessionId === poppedSessionId)
  if (index < 0) return
  const levels = pending.levels.filter((_, ix) => ix !== index)
  if (levels.length === 0) return
  // Геометрия ОСТАВШЕГОСЯ уровня могла устареть: пока лежал диалог, его
  // измерение пересчитало union и записало сюда прямоугольник меню заново.
  // Этот прямоугольник — актуальный, трогать его нельзя.

  //
  // РАЗМЕР ОКНА ПРИ ВОЗВРАТЕ НЕ МЕНЯЕТСЯ — и это главное решение шага.
  //
  // Первый вариант считал union заново по оставшимся уровням, и окно
  // сжималось с прямоугольника «меню + диалог» до прямоугольника меню.
  // Меню при этом не двигалось — ДВИГАЛСЯ ЕГО СДВИГ ВНУТРИ ОКНА, на 73 px
  // влево. Это и было моргание:
  //
  //   union after pop  was: { x: 270, y: 104, w: 348, h: 312 }
  //                    now: { x: 343, y: 108, w: 224, h: 304 }
  //
  // Меню прыгало внутри окна, а не двигалось по экрану. Счёт setBounds
  // был ровно один — моргание давал не он, а смена сдвига уровня.
  //
  // Теперь окно и сдвиги не трогаются: меню стоит там же, где стояло.
  // При следующем открытии диалога union считается заново по тем же
  // уровням и даёт ПРЕЖНЕЕ значение, поэтому прыжка не будет и там.
  //
  //
  // ПОРЯДОК КРИТИЧЕН: сначала push, потом setBounds.
  //
  // Обратный порядок (сначала двигаем окно, потом сообщаем renderer) давал
  // моргание: окно сжималось под двухуровневым стеком, а renderer ещё
  // рисовал в нём диалог. Секунду карточка вылезала за границу окна —
  // это и было видно как «меню иконки моргает».
  //
  // Теперь renderer узнаёт об укорочении стека ДО того, как окно
  // изменит размер, и к моменту сжатия на экране остаётся только меню.
  //
  // Анимации при возврате не трогаем: настройка одна на приложение, и
  // гасить её в push значило бы рисковать залипанием no-anim, если
  // следующее сообщение не дойдёт. Подавление на один кадр делает
  // renderer (см. suppressAnimationsForFrame).
  //
  // Заморозка окна. Стек укорочен, и пересчитывать окно по нему нельзя:
  // единственный оставшийся уровень (меню) задал бы окну свои размеры,
  // и меню снова прыгнуло бы внутри него.
  //
  // Снимается при следующем полном показе (showOverlay) и при закрытии
  // стека (closeStack удаляет pendingGeometry).
  pendingGeometry.set(parent.id, { ...pending, levels, frozen: true })
  const union = pending.union
  pushPayload(overlay, buildPushMessage(parent, levels, union))
  log('session', 'stack popped, window kept', {
    parentId: parent.id,
    popped: poppedSessionId,
    depth: remaining.length,
    union: { x: union.x, y: union.y, w: union.width, h: union.height }
  })
  //
  // Фокус: win.focus() ниже ставит фокус на ОКНО, а обработчик keydown
  // висит на элементе списка внутри renderer. Меню после возврата — новая
  // компонентная копия, и оно пересоздаётся, поэтому нативного
  // autofocus у него нет: фокус надо поставить после кадра, в котором
  // элемент появится.
  //
  // Раньше фокус просто не возвращался, и навигация умирала: меню было
  // кликабельно, но стрелки не двигали подсветку.
  // Окно возвращаем в фокус: без focus() клавиатура в него не попадёт,
  // потому что открыто оно через showInactive(). Фокус на ЭЛЕМЕНТ внутри
  // ставит renderer — здесь вершина уже смонтирована, и одной копии
  // логики достаточно.
  try {
    overlay.focus()
  } catch (err) {
    logError('overlay focus failed after stack pop', err)
  }
  //
  // Фокус возвращаем на ОКНО, а не на родителя. Пользователь снял диалог
  // и вернулся к меню — уводить клавиатуру из него означало бы, что
  // стрелки не работают, пока он снова не кликнет.
  //
  // DOM-фокус при этом уехал вместе со снятым уровнем (диалог), и
  // renderer ставит его заново сам: MenuList фокусирует себя в
  // onMounted, а контент верхнего уровня пересоздаётся при укорочении
  // стека.
  log('session', 'returned to lower level', {
    parentId: parent.id,
    popped: poppedSessionId,
    depth: remaining.length,
    kind: remaining[remaining.length - 1].request.kind
  })
}

export function closeOverlay(parent: BrowserWindow): void {
  const entry = sessionOf<OverlayRequest>(parent.id)
  if (!entry) return
  const depth = stackDepth(parent.id)
  log('session', 'closing', {
    parentId: parent.id,
    kind: entry.request.kind,
    depth
  })
  // Запоминаем закрытое меню с его триггером: следующий вызов showOverlay
  // с тем же ключом в пределах TOGGLE_ECHO_MS — это эхо открывающего клика,
  // а не намерение открыть заново (см. ветку toggle в showOverlay).
  if (isDismissableMenuLike(entry.request.kind)) {
    lastClosed.set(parent.id, {
      toggleKey: entry.request.toggleKey,
      at: Date.now()
    })
  }
  // Снимаем только ВЕРХНИЙ уровень. Пока в стеке есть что лежать
  // под ним, окно остаётся на экране, а пользователь возвращается к
  // нижнему уровню — это и есть «Esc возвращает к меню».
  //
  // Гасить окно целиком при непустом стеке нельзя: под диалогом лежит
  // меню, и закрытие верхнего уровня погасило бы и его.
  const isTopOnly = depth <= 1
  clearSession(parent.id, isTopOnly ? undefined : entry.sessionId)
  if (!isTopOnly) {
    // Возврат к нижнему уровню: окно уже на месте и показывает стек
    // целиком, поэтому достаточно убрать верхний уровень из push и
    // дождаться кадра. Подсветку и фокус не трогаем — фокус на окне уже
    // стоит, и переводить его на родителя пользователь не просил.
    restoreStackAfterPop(parent, entry.sessionId)
    return
  }
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
      // Метка передачи фокуса обновляется перед возвратом: оверлей
      // держит фокус прямо сейчас, и без свежей метки
      // restoreFocusToParent на Linux решит, что метка протухла, и
      // оставит клавиатуру в закрытом окне.
      noteFocusHandoff(parent.id)
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

/**
 * Закрыть сессию при смене активной вкладки.
 *
 * Приёмка шага 5: «при быстром переключении вкладок с открытым меню
 * пункты соответствуют текущей вкладке». Пока вкладка менялась, оверлей
 * оставался прежним: setActiveTab про него ничего не знает, и пункты
 * контекстного меню вкладки висели уже над другой страницей.
 *
 * Закрываем ЛЮБУЮ сессию, а не только меню. Утверждение приёмки про меню,
 * но оставшаяся сессия после переключения вкладки бессмысленна в любом
 * виде: диалог иконки привязан к вкладке (onIconApply замыкание
 * конкретной записи), панель поиска — к webContents страницы, тост тем
 * более. Исключение делалось бы ради симметрии с closeOverlayIfMenu, но
 * там клик по shell гасит только меню, потому что у диалога есть кнопка
 * Отмена и он не должен исчезать от чужого клика. Переключение вкладки —
 * не чужой клик, это другая задача целиком.
 *
 * Порядок важен: снимаем сессию и только потом гасим окно. Иначе renderer
 * успеет применить патч от уже неактуальной сессии.
 */
export function closeOverlayOnTabChange(parent: BrowserWindow, tabId: number): void {
  const entry = sessionOf<OverlayRequest>(parent.id)
  if (!entry) return
  log('session', 'active tab changed -> close overlay', {
    parentId: parent.id,
    kind: entry.request.kind,
    tabId
  })
  // Весь стек: комментарий функции прямо говорит, что оставшаяся сессия
  // бессмысленна при любом виде, а closeOverlay снял бы только верх.
  closeStack(parent)
}

/**
 * Закрывает ВЕСЬ стек сессий родителя.
 *
 * closeOverlay снимает верхний уровень — это нужно для Esc и Cancel.
 * Но есть случаи, когда стек должен уйти целиком:
 *
 *   - клик по shell при открытом меню (closeOverlayIfMenu): клик должен
 *     убирать меню, а не лежащий поверх диалог;
 *   - смена активной вкладки, перемещение и сворачивание окна, уход из
 *     приложения: оставшаяся сессия бессмысленна при любом виде.
 *
 * Без отдельной функции каждый такой случай вызывал бы closeOverlay в
 * цикле по глубине, и при глубине 1 тот же цикл вёл себя иначе, чем при
 * глубине 2 — расхождение проявилось бы только на вложенных диалогах.
 */
export function closeStack(parent: BrowserWindow): void {
  const depth = stackDepth(parent.id)
  if (depth === 0) return
  if (depth === 1) {
    closeOverlay(parent)
    return
  }
  log('session', 'closing whole stack', { parentId: parent.id, depth })
  // Меню в корне запоминаем с его триггером — тот же смысл, что и при
  // закрытии верхнего уровня: следующий клик по тому же триггеру должен
  // распознаться как эхо, а не открыть меню заново.
  const root = stackOf<OverlayRequest>(parent.id)[0]
  if (isDismissableMenuLike(root.request.kind)) {
    lastClosed.set(parent.id, {
      toggleKey: root.request.toggleKey,
      at: Date.now()
    })
  }
  const overlay = getPooledOverlay(parent.id)
  // pendingGeometry снимаем ДО сессий: иначе восстановление после снятия
  // сессии найдёт геометрию уже несуществующего стека.
  // Стек снят целиком: заморозка и геометрия больше не нужны, и
  // следующий показ посчитает окно заново с нуля.
  pendingGeometry.delete(parent.id)
  for (const entry of stackOf<OverlayRequest>(parent.id)) {
    dropPendingPush(entry.overlay, entry.sessionId)
  }
  clearSession(parent.id)
  if (!overlay) return
  try {
    if (!overlay.isDestroyed()) {
      hideContent(overlay, parent.id)
      noteFocusHandoff(parent.id)
      restoreFocusToParent(overlay, parent, Date.now())
    }
  } catch {
    // Уже закрыто — игнорим.
  }
}

/**
 * Закрыть активный оверлей, но ТОЛЬКО если это меню.
 *
 * Клик по любому месту вне меню (вкладка, адресная строка, панель
 * закладок) должен его гасить — как в обычных браузерах. Диалоги
 * (icon/dialog) и панель поиска так не закрываются: у них своя логика
 * (Esc, Cancel, toggle), и клик по shell не должен их сносить.
 */
export function closeOverlayIfMenu(parent: BrowserWindow): void {
  // Меню — КОРЕНЬ стека: клик по shell должен убирать его целиком, а не
  // верхний уровень. Без этой проверки клик по панели при открытом
  // «Change icon» закрыл бы диалог и оставил меню — ровно наоборот.
  if (stackDepth(parent.id) > 1) {
    closeStack(parent)
    return
  }
  const entry = sessionOf<OverlayRequest>(parent.id)
  if (!entry) return
  if (!isDismissableMenuLike(entry.request.kind)) return
  const age = Date.now() - entry.openedAt
  if (age < OPEN_SETTLE_MS) {
    log('session', 'shell click during open, ignored', {
      parentId: parent.id,
      ageMs: age
    })
    return
  }
  log('session', 'closing on shell click', { parentId: parent.id, ageMs: age })
  // Весь стек: клик по shell убирает меню, а не лежащий поверх диалог.
  closeStack(parent)
}

// Активный оверлей родителя (для проброса found-in-page в панель поиска).
export function getActiveOverlay(parent: BrowserWindow): BrowserWindow | undefined {
  const entry = sessionOf<OverlayRequest>(parent.id)
  return entry && !entry.overlay.isDestroyed() ? entry.overlay : undefined
}

export function getActiveRequest(parent: BrowserWindow): OverlayRequest | undefined {
  return sessionOf<OverlayRequest>(parent.id)?.request
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
  const entry = sessionOf<OverlayRequest>(parent.id)
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
  const parentId = parentIdOfOverlay(overlay)
  if (parentId === undefined) return undefined
  return BrowserWindow.fromId(parentId) ?? undefined
}
