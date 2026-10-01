import { BrowserWindow } from 'electron'
import { log } from './logger'

// Сессии оверлея: токены, реестр активных сессий и защита от гонок.
//
// Отдельный модуль потому, что состояние сессий нужно и сервису (показ и
// команды), и будущему стеку вложенности (шаг 8), и проверке команд на
// renderer'е. Держать это в service.ts — значит держать в том же файле,
// где и presentation: шаг 8 всё равно его тронет.

// Запрос, ради которого открыта сессия, — произвольный: его форму задаёт
// владелец (сейчас service.ts со своим OverlayRequest). Дженерик вместо
// копии типа: копия разошлась бы с оригиналом при первом же добавлении
// поля, а session.ts обязан знать только про токен, а не про содержимое
// запроса.
export interface Session<R = unknown> {
  overlay: BrowserWindow
  request: R
  sessionId: number
  openedAt: number
}

// Монотонный счётчик токенов. Каждая сессия получает новый: renderer
// сверяет с ним патчи и подтверждения, а main отбрасывает команды с
// устаревшим токеном.
let tokenCounter = 0

// Выдаёт токен новой сессии. Монотонный и без пропусков: пропуск означал
// бы, что команда с токеном пропущенной сессии совпадёт с будущей.
export function nextSessionId(): number {
  tokenCounter += 1
  return tokenCounter
}

// Родитель -> его активная сессия. Форма запроса намеренно скрыта за
// unknown: реестр обслуживает и сервис, и будущий стек вложенности
// (шаг 8), и хранить тут чужую форму значило бы дублировать тип. Читающий
// называет нужный тип сам: sessionOf<OverlayRequest>(id).
const sessions = new Map<number, Session<unknown>>()

// id окна оверлея -> id родителя. Обратная карта: команды приходят от
// renderer'а оверлея, а адресованы родителю. Раньше родителя находили
// перебором sessions, и таких мест было пять — каждое O(n) и каждое с
// молчаливым «нашлось первое совпадение».
const parentOfOverlayId = new Map<number, number>()

/**
 * Регистрирует сессию и синхронно ведёт обратную карту.
 *
 * Обёртка существует, чтобы карту нельзя было забыть обновить: беда
 * линейного перебора как раз из-за того, что истина о родителе жила в
 * сессии, а второй структуры никто не поддерживал.
 */
export function setSession<R>(parentId: number, session: Session<R>): void {
  sessions.set(parentId, session as Session<unknown>)
  parentOfOverlayId.set(session.overlay.id, parentId)
}

/**
 * Снимает сессию и убирает обратную запись.
 *
 * Важно: снимается только сессия ИМЕННО этого родителя. Повторный показ
 * того же оверлея на другого родителя (окно переиспользуется из пула)
 * перезапишет карту, и старый вызов не должен снести новую запись.
 */
export function clearSession(parentId: number): void {
  const session = sessions.get(parentId)
  if (session && parentOfOverlayId.get(session.overlay.id) === parentId) {
    parentOfOverlayId.delete(session.overlay.id)
  }
  sessions.delete(parentId)
}

/**
 * Активная сессия родителя, если есть.
 *
 * Тип запроса по умолчанию unknown, а не any: вызывающий, который знает
 * форму (сервис знает OverlayRequest), называет её явно. Иначе любая
 * опечатка в свойстве прошла бы компиляцию и всплыла бы в логах.
 */
export function sessionOf<R = unknown>(parentId: number): Session<R> | undefined {
  return sessions.get(parentId) as Session<R> | undefined
}

/**
 * Родитель по id окна оверлея, либо undefined если оверлей не активен.
 * Замена перебора sessions по полю overlay.
 */export function parentIdOfOverlay(overlay: BrowserWindow): number | undefined {
  const parentId = parentOfOverlayId.get(overlay.id)
  if (parentId === undefined) return undefined
  // Пара может разъехаться: сессию сняли в обход, а карту забыли. Сверяем,
  // что запись всё ещё указывает на это окно, иначе считаем оверлей чужим.
  const session = sessions.get(parentId)
  if (!session || session.overlay !== overlay) {
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
 * Токен сверяется и с активной сессией, и с тем, что оверлей вообще наш:
 * иначе команда от чужого окна прошла бы.
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
  const session = sessions.get(parentId)
  if (!session) {
    log('session', 'STALE, dropped: session closed', {
      parentId,
      overlayId: overlay.id,
      sessionId
    })
    return false
  }
  if (session.sessionId !== sessionId) {
    log('session', 'STALE, dropped: token mismatch', {
      parentId,
      got: sessionId,
      current: session.sessionId
    })
    return false
  }
  return true
}

/** Активна ли сессия с таким токеном у родителя. */
export function isCurrentSession(parentId: number, sessionId: number): boolean {
  const session = sessions.get(parentId)
  return !!session && session.sessionId === sessionId
}
