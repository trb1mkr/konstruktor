// Стек сессий оверлея: активных сессий на родителя может быть несколько.
//
// Каждый уровень стека — своя поверхность в одном окне. При
// NESTED_DIALOGS = false стек всегда глубиной 1, и это обычное поведение:
// onSelect открывает новую сессию, она вытесняет старую, и старая
// размонтируется.
//
// Стек меняет это на два уровня в одном окне: меню остаётся на месте, а
// диалог появляется поверх. Esc снимает верхний уровень и возвращает
// меню.
//
// Ключевые решения, которые неочевидны:
//
// 1. Сессии несут СВОЙ anchor. Меню и диалог выровнены по-разному: меню
//    прижато к точке клика, диалог — по центру окна. Если бы вложенная
//    сессия наследовала anchor родительской, диалог оказался бы там же,
//    где меню.
//
// 2. Уровень задаёт СУБОКНО, а не окно. Меню у края экрана разворачивается
//    влево, диалог по центру — и их окна пересекаться не могут. Одно
//    окно, покрывающее оба уровня, — единственный способ показать их
//    одновременно. Плата: окно не может быть размером карточки.
//
// 3. isCommandCurrent сверяет токен со ВСЕМ стеком, а не с вершиной.
//    Клик по пункту меню — команда от нижнего уровня, пока сверху лежит
//    диалог. Проверка «только вершина» сделала бы меню мёртвым, и
//    «Change icon» перестал бы работать.

import { BrowserWindow } from 'electron'
import { log } from './logger'

// Запрос, ради которого открыта сессия, — произвольный: его форму задаёт
// владелец (сейчас service.ts со своим OverlayRequest). Дженерик вместо
// копии типа: копия разошлась бы с оригиналом при первом же добавлении
// поля, а session.ts обязан знать только про токен и уровень, а не про
// содержимое запроса.
export interface Session<R = unknown> {
  overlay: BrowserWindow
  request: R
  sessionId: number
  openedAt: number
}

// Монотонный счётчик токенов. Каждая сессия получает новый: renderer
// сверяет с ним патчи и подтверждения, а main отбрасо��ывает команды с
// устаревшим токеном.
let tokenCounter = 0

// Выдаёт токен новой сессии. Монотонный и без пропусков: пропуск означал
// бы, что команда с токеном пропущенной сессии совпадёт с будущей.
export function nextSessionId(): number {
  tokenCounter += 1
  return tokenCounter
}

// Родитель -> стек его сессий, снизу вверх. Вершина стека — та, что на
// экране сейчас.
//
// Форма запроса намеренно скрыта за unknown: реестр обслуживает и
// сервис, и проекцию стека для renderer, и хранить тут чужую форму
// значило бы дублировать тип. Читающий называет нужный тип сам:
// stackOf<OverlayRequest>(id).
const stacks = new Map<number, Session<unknown>[]>()

// id окна оверлея -> id родителя. Обратная карта: команды приходят от
// renderer'а оверлея, а адресованы родителю. Раньше родителя находили
// перебором sessions, и таких мест было пять — каждое O(n) и каждое с
// молчаливым «нашлось первое совпадение».
const parentOfOverlayId = new Map<number, number>()

/**
 * Регистрирует сессию ПОВЕРХ текущей и синхронно ведёт обратную карту.
 *
 * Обёртка существует, чтобы карту нельзя было забыть обновить: беда
 * линейного перебора как раз из-за того, что истина о родителе жила в
 * сессии, а второй структуры никто не поддерживал.
 */
export function setSession<R>(parentId: number, session: Session<R>): void {
  const stack = stacks.get(parentId)
  if (stack) {
    stack.push(session as Session<unknown>)
  } else {
    stacks.set(parentId, [session as Session<unknown>])
  }
  parentOfOverlayId.set(session.overlay.id, parentId)
}

/**
 * Снимает сессию и убирает обратную запись.
 *
 * Сессия ищется по токену, а не по позиции: записи отличаются именно
 * токеном, и снятие по индексу сдвинуло бы соседей мимо. Без токена
 * снимается весь стек — так закрывается родительское окно приложения.
 */
export function clearSession(parentId: number, sessionId?: number): void {
  const stack = stacks.get(parentId)
  if (!stack) return
  if (sessionId === undefined) {
    for (const s of stack) {
      if (parentOfOverlayId.get(s.overlay.id) === parentId) {
        parentOfOverlayId.delete(s.overlay.id)
      }
    }
    stacks.delete(parentId)
    return
  }
  const index = stack.findIndex((s) => s.sessionId === sessionId)
  if (index < 0) return
  const removed = stack.splice(index, 1)[0]
  //
  // Обратная карта — это id окна оверлея -> id родителя, и окно у ВСЕХ
  // уровней одно. Снимали её вместе с уровнем, и после снятия верхнего
  // (Esc, Cancel, клик по подложке) оверлей переставал находить своего
  // родителя при живом стеке:
  //
  //   returned to lower level { popped: 2, depth: 1, kind: 'menu' }
  //   STALE, dropped: overlay has no active session { sessionId: 1 }
  //
  // Сессия 1 (меню) в стеке была, но оверлей её уже не видел: клик и
  // клавиши отбрасывались, и меню умирало до перезапуска.
  //
  // Карта снимается, только когда стек опустел — тогда окно больше не
  // обслуживает ни одной сессии.
  if (stack.length === 0) {
    if (removed && parentOfOverlayId.get(removed.overlay.id) === parentId) {
      parentOfOverlayId.delete(removed.overlay.id)
    }
    stacks.delete(parentId)
  }
}

/**
 * Активная (верхняя) сессия родителя, если есть.
 *
 * Тип запроса по умолчанию unknown, а не any: вызывающий, который знает
 * форму (сервис знает OverlayRequest), называет её явно. Иначе любая
 * опечатка в свойстве прошла бы компиляцию и всплыла бы в логах.
 */
export function sessionOf<R = unknown>(parentId: number): Session<R> | undefined {
  const stack = stacks.get(parentId)
  if (!stack || stack.length === 0) return undefined
  return stack[stack.length - 1] as Session<R> | undefined
}

/**
 * Сессия по токену, где угодно в стеке, а не только на вершине.
 *
 * Нужна обработке команд нижнего уровня: клик по пункту меню приходит,
 * когда сверху лежит диалог, и его токен — не вершина стека.
 */
export function sessionById<R = unknown>(
  parentId: number,
  sessionId: number
): Session<R> | undefined {
  const stack = stacks.get(parentId)
  if (!stack) return undefined
  return stack.find((s) => s.sessionId === sessionId) as Session<R> | undefined
}

/**
 * Стек родителя, снизу вверх.
 *
 * Копия, а не сам массив: наружу стек отдаётся на чтение (проекция в
 * renderer, отсечение по уровню), и выдача самого массива позволяла бы
 * изменить его мимо setSession.
 */
export function stackOf<R = unknown>(parentId: number): Session<R>[] {
  const stack = stacks.get(parentId)
  return (stack ?? []) as Session<R>[]
}

/** Глубина стека: сколько уровней сейчас на экране. */
export function stackDepth(parentId: number): number {
  return stacks.get(parentId)?.length ?? 0
}

/**
 * Родитель по id окна оверлея, либо undefined если оверлей не активен.
 * Замена перебора sessions по полю overlay.
 */
export function parentIdOfOverlay(overlay: BrowserWindow): number | undefined {
  const parentId = parentOfOverlayId.get(overlay.id)
  if (parentId === undefined) return undefined
  // Пара может разъехаться: сессию сняли в обход, а карту забыли. Сверяем,
  // что запись всё ещё указывает на это окно, иначе считаем оверлей чужим.
  const stack = stacks.get(parentId)
  if (!stack || !stack.some((s) => s.overlay === overlay)) {
    parentOfOverlayId.delete(overlay.id)
    return undefined
  }
  return parentId
}

/**
 * Команда пришла для сессии, которой больше нет.
 *
 * Защита от гонок: окно оверлея переиспользуется, и команда, отправленная
 * для предыдущей сессии, может прийти уже после открытия следующей. Без
 * этой проверки она исполнилась бы против нового содержимого — например,
 * клик по пункту старого меню закрыл бы новое.
 *
 * Токен сверяется со ВСЕМ стеком, а не с вершиной. Клик по пункту меню —
 * команда от нижнего уровня, и он лежит в стеке, пока сверху диалог.
 * Проверка «только вершина» сделала бы нижние уровни нерабочими.
 *
 * @returns true, если команду исполнять можно.
 */
export function isCommandCurrent(
  overlay: BrowserWindow,
  sessionId: number
): boolean {
  const parentId = parentIdOfOverlay(overlay)
  if (parentId === undefined) {
    log('session', 'STALE, dropped: overlay has no active session', {
      overlayId: overlay.id,
      sessionId
    })
    return false
  }
  const stack = stacks.get(parentId)
  if (!stack || stack.length === 0) {
    log('session', 'STALE, dropped: session closed', {
      parentId,
      overlayId: overlay.id,
      sessionId
    })
    return false
  }
  if (!stack.some((s) => s.sessionId === sessionId)) {
    log('session', 'STALE, dropped: token mismatch', {
      parentId,
      got: sessionId,
      depth: stack.length,
      tokens: stack.map((s) => s.sessionId)
    })
    return false
  }
  return true
}

/**
 * Активна ли сессия с таким токеном у родителя — где угодно в стеке.
 *
 * Именно «где угодно», а не «на вершине»: измерение содержимого и
 * патчи модели приходят от уровня, который живёт сейчас, и проверка
 * вершины была бы ловушкой при любой вложенности.
 */
export function isCurrentSession(parentId: number, sessionId: number): boolean {
  const stack = stacks.get(parentId)
  return !!stack && stack.some((s) => s.sessionId === sessionId)
}

/** Сессия с токеном — вершина стека, то есть сейчас на экране. */
export function isTopSession(parentId: number, sessionId: number): boolean {
  const top = sessionOf(parentId)
  return !!top && top.sessionId === sessionId
}
