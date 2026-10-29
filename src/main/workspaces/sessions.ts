// Сессии рабочего пространства: интервалы в sessions.json и маркер запуска.
//
// Сессия — отрезок времени, пока пространство было запущено. Своих данных у
// неё нет: это запись интервала плюс слепок окон, снятый при закрытии. Нужна
// она ровно для одного: отличить штатный выход от аварийного. Штатный выход
// снимает маркер, аварийный оставляет его на диске, и следующий запуск по
// маркеру понимает, что вкладки нужно ПРЕДЛОЖИТЬ к восстановлению, а не
// открыть молча.
//
// Маркер пишется синхронно и до первого окна: отложенная запись могла бы не
// дойти до диска к моменту падения, и авария выглядела бы штатным выходом.
// По той же причине снятие маркера синхронное.
//
// Почему не «PID + проверка процесса»: PID переиспользуется, а при запуске
// второго экземпляра браузера проверка чужого процесса дала бы ложное
// «сессия ещё идёт». Маркер — это факт «этот запуск не закрылся сам».
import { randomUUID } from 'crypto'
import { readFileSync, rmSync } from 'fs'
import { writeJsonAtomicSync } from './atomic'
import { workspaceFile } from './paths'

/** Интервал запуска пространства. */
export interface SessionRecord {
  id: string
  startedAt: number
  /** Когда сессия закрылась. Поля нет — сессия не закрывалась (авария). */
  endedAt?: number
  /** false — приложение не закрыло сессию само. */
  clean: boolean
}

/**
 * Маркер незакрытого запуска (`session.lock`).
 *
 * `startedAt` нужен для текста диалога восстановления и для записи в
 * sessions.json: к моменту следующего старта процесса, который упал, уже
 * нет, и спросить его не о чем.
 */
export interface SessionMarker {
  id: string
  startedAt: number
  pid: number
}

interface SessionsFile {
  schemaVersion: number
  sessions: SessionRecord[]
}

const SCHEMA = 1
/** Сколько интервалов хранить. История запусков нужна только как история. */
const MAX_SESSIONS = 50

export function workspaceSessionsPath(wsId: string): string {
  return workspaceFile(wsId, 'sessions.json')
}

function markerPath(wsId: string): string {
  return workspaceFile(wsId, 'session.lock')
}

export function readSessions(wsId: string): SessionRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(workspaceSessionsPath(wsId), 'utf-8')) as Partial<
      SessionsFile
    >
    if (!Array.isArray(parsed.sessions)) return []
    return parsed.sessions.filter(
      (s): s is SessionRecord =>
        !!s && typeof s.id === 'string' && typeof s.startedAt === 'number' && typeof s.clean === 'boolean'
    )
  } catch {
    return []
  }
}

function appendSession(wsId: string, record: SessionRecord): void {
  const sessions = readSessions(wsId)
  sessions.push(record)
  try {
    writeJsonAtomicSync(workspaceSessionsPath(wsId), {
      schemaVersion: SCHEMA,
      sessions: sessions.slice(-MAX_SESSIONS)
    } satisfies SessionsFile)
  } catch {
    // Диск или права: история запусков не повод ронять браузер.
  }
}

/** Маркер прошлого запуска, если он остался. Только чтение. */
export function readSessionMarker(wsId: string): SessionMarker | null {
  try {
    const parsed = JSON.parse(readFileSync(markerPath(wsId), 'utf-8')) as Partial<SessionMarker>
    if (typeof parsed.id !== 'string' || typeof parsed.startedAt !== 'number') return null
    return { id: parsed.id, startedAt: parsed.startedAt, pid: Number(parsed.pid) || 0 }
  } catch {
    return null
  }
}

/**
 * Начинает сессию пространства.
 *
 * Оставшийся маркер означает, что прошлый запуск не закрылся сам: он
 * дописывается записью с `clean: false` и удаляется. Возвращённый `crash` —
 * данные именно того запуска; по ним решается, предлагать ли восстановление.
 */
export function beginWorkspaceSession(wsId: string): { crash: SessionMarker | null } {
  const previous = readSessionMarker(wsId)
  if (previous) {
    console.log('[session] previous run did not close:', wsId, previous.id)
    appendSession(wsId, { id: previous.id, startedAt: previous.startedAt, clean: false })
  }
  const marker: SessionMarker = { id: randomUUID(), startedAt: Date.now(), pid: process.pid }
  try {
    writeJsonAtomicSync(markerPath(wsId), marker)
    console.log('[session] begin:', wsId, marker.id)
  } catch {
    // Без маркера сессия не определится как аварийная — но окна открывать
    // всё равно можно.
  }
  return { crash: previous }
}

/** Закрывает сессию штатно: запись интервала и снятие маркера. */
export function endWorkspaceSession(wsId: string): void {
  const marker = readSessionMarker(wsId)
  if (!marker) return
  console.log('[session] end:', wsId, marker.id)
  appendSession(wsId, {
    id: marker.id,
    startedAt: marker.startedAt,
    endedAt: Date.now(),
    clean: true
  })
  try {
    rmSync(markerPath(wsId), { force: true })
  } catch {
    // Не снявшийся маркер даст ложное «аварийное завершение» на следующем
    // старте: диалог покажется, но вкладки в целости.
  }
}
