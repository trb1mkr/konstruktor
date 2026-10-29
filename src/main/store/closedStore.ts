// Недавно закрытые вкладки и окна пространства: closed.json.
//
// Зачем отдельный файл, а не история закрытий в windows.json. Слепок окон
// описывает ТЕКУЩЕЕ состояние и перезаписывается целиком на каждое
// изменение; запись «это окно закрыли» в нём жила бы до первого же
// обновления слепка. Список закрытий — журнал: он только дополняется, и
// восстанавливать из него можно в любом порядке.
//
// Запись хранит не «id вкладки» (runtime id умирает вместе с процессом), а
// фрагмент слепка окна (`SnapshotWindow`) — тот же формат, по которому
// восстанавливаются окна при старте. Отсюда бесплатно берутся заголовок,
// иконка, закрепление, группа и активная вкладка.
//
// Ограничение: файл НЕ растёт бесконечно. Список нужен на последние
// несколько закрытий, а не как архив — для архива есть история.
import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { writeJsonAtomic, writeJsonAtomicSync } from '../workspaces/atomic'
import { workspaceFile } from '../workspaces/paths'
import { bootWorkspaceId } from '../workspaces/registry'
import type { SnapshotWindow } from '../workspaces/windowSnapshot'

/** Что именно закрыли. Окно восстанавливается целым, вкладка — одна. */
export type ClosedKind = 'tab' | 'window'

export interface ClosedEntry {
  id: string
  kind: ClosedKind
  at: number
  /**
   * Ключ окна, в котором запись закрылась (`w<N>`).
   *
   * По нему вкладка возвращается «в исходное окно»: если окно с этим
   * ключом ещё живо, вкладка встаёт туда, а не в текущее. Ключ стабилен
   * между запусками — в отличие от runtime id окна.
   */
  windowKey: string
  /** Подпись для меню: заголовок вкладки либо «N вкладок». */
  title: string
  /** Данные восстановления: одно окно или одна вкладка в нём. */
  snapshot: SnapshotWindow
}

interface ClosedFile {
  schemaVersion: number
  entries: ClosedEntry[]
}

const SCHEMA = 1
/** Сколько записей хранить. Список — журнал последних закрытий, не архив. */
const MAX_ENTRIES = 25

const caches = new Map<string, ClosedEntry[]>()

function closedPath(wsId: string): string {
  return workspaceFile(wsId, 'closed.json')
}

export function readClosed(wsId = bootWorkspaceId()): ClosedEntry[] {
  const cached = caches.get(wsId)
  if (cached) return cached
  let list: ClosedEntry[] = []
  try {
    const parsed = JSON.parse(readFileSync(closedPath(wsId), 'utf-8')) as Partial<ClosedFile>
    if (Array.isArray(parsed.entries)) {
      list = parsed.entries.filter(
        (e): e is ClosedEntry =>
          !!e &&
          typeof e.id === 'string' &&
          (e.kind === 'tab' || e.kind === 'window') &&
          typeof e.at === 'number' &&
          !!e.snapshot &&
          Array.isArray(e.snapshot.tabs)
      )
    }
  } catch {
    list = []
  }
  caches.set(wsId, list)
  return list
}

/** Список для меню: новые записи первыми. */
export function listClosed(wsId = bootWorkspaceId(), limit = MAX_ENTRIES): ClosedEntry[] {
  return [...readClosed(wsId)].sort((a, b) => b.at - a.at).slice(0, limit)
}

/** Самая свежая запись — её восстанавливает хоткей. */
export function latestClosed(wsId = bootWorkspaceId()): ClosedEntry | undefined {
  return listClosed(wsId, 1)[0]
}

function save(wsId: string, list: ClosedEntry[], sync: boolean): void {
  const trimmed = [...list].sort((a, b) => a.at - b.at).slice(-MAX_ENTRIES)
  caches.set(wsId, trimmed)
  const payload: ClosedFile = { schemaVersion: SCHEMA, entries: trimmed }
  if (sync) {
    try {
      writeJsonAtomicSync(closedPath(wsId), payload)
    } catch {
      // Диск или права: журнал закрытий не повод ронять закрытие окна.
    }
    return
  }
  void writeJsonAtomic(closedPath(wsId), payload).catch(() => undefined)
}

/**
 * Запоминает закрытие.
 *
 * `sync` — для хука закрытия окна: за ним идёт выход процесса, и
 * незавершённая запись умирает вместе с ним.
 */
export function recordClosed(
  wsId: string,
  input: { kind: ClosedKind; windowKey: string; title: string; snapshot: SnapshotWindow },
  sync = false
): ClosedEntry {
  const entry: ClosedEntry = {
    id: randomUUID(),
    kind: input.kind,
    at: Date.now(),
    windowKey: input.windowKey,
    title: input.title,
    snapshot: input.snapshot
  }
  save(wsId, [...readClosed(wsId), entry], sync)
  return entry
}

/** Забирает запись из журнала: восстановленная запись второй раз не нужна. */
export function takeClosed(wsId: string, id: string): ClosedEntry | undefined {
  const list = readClosed(wsId)
  const entry = list.find((e) => e.id === id)
  if (!entry) return undefined
  save(wsId, list.filter((e) => e.id !== id), false)
  return entry
}

export function clearClosed(wsId = bootWorkspaceId()): void {
  save(wsId, [], false)
}

/** Сброс кэша — при удалении пространства и в диагностике. */
export function resetClosedCache(wsId?: string): void {
  if (wsId) caches.delete(wsId)
  else caches.clear()
}
