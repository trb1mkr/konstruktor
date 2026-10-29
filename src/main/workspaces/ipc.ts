// IPC страницы рабочих пространств (konstruktor://workspaces).
//
// Страница живёт ВНУТРИ одного пространства, но управляет всеми сразу:
// поэтому все обработчики адресуют пространство по id, а не по сессии
// отправителя. Единственное, что берётся из окна — запрет на удаление
// пространства, в котором открыто окно.
//
// Список отдаётся вместе с признаком «открыто» и числом вкладок из слепка:
// без них пользователь не отличит пространство, в котором сейчас работают,
// от забытого, и удалил бы данные открытого.
import { ipcMain } from 'electron'
import { readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { windows } from '../windows/browserState'
import { openWorkspaceWindows } from '../windows/deps'
import { initExtensions } from '../extensions/manager'
import { resetExtensionsCache } from '../extensions/extensionStore'
import { resetSettingsCache } from '../store/settingsStore'
import { tFor } from '../i18n'
import { userDataDir, workspaceFile } from './paths'
import { CONFIG_SECTIONS, copyWorkspaceSections, type ConfigSection } from './configCopy'
import {
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  partitionFor,
  readWorkspaceMeta,
  updateWorkspaceMeta,
  workspaceExists,
  type WorkspaceMeta
} from './registry'
import { readWorkspaceWindows } from './windowSnapshot'

/** Пространство в том виде, в каком его показывает страница. */
export interface WorkspaceSummary {
  id: string
  name: string
  icon: string
  color: string
  createdAt: number
  updatedAt: number
  /** Когда пространство открывали последний раз; undefined — не открывали. */
  lastOpenedAt?: number
  /** Есть ли сейчас окно этого пространства. */
  running: boolean
  /** Сколько вкладок лежит во всех окнах слепка (0 — слепка нет). */
  tabs: number
  /** Сохранённые группы вкладок (шаблоны из groups.json). */
  groups: number
  /** Закладки пространства: bookmarks.json. */
  bookmarks: number
}

/**
 * Результат операции: странице нужен код, а не текст — текст переводит она.
 *
 * `last` — попытка удалить последнее оставшееся пространство: без него
 * браузеру негде хранить данные.
 */
export type WorkspaceResult =
  | { ok: true; workspace?: WorkspaceSummary; copied?: ConfigSection[]; focused?: boolean }
  | { ok: false; error: 'last' | 'running' | 'missing' | 'failed' }

/** Пространства, в которых сейчас есть живые окна. */
function runningIds(): Set<string> {
  const out = new Set<string>()
  for (const ws of windows.values()) {
    if (ws.window && !ws.window.isDestroyed()) out.add(ws.workspaceId)
  }
  return out
}

/**
 * Длина JSON-массива в файле пространства.
 *
 * Читается синхронно и мимо кэшей сторов: странице нужны счётчики ВСЕХ
 * пространств сразу, а `getGroups`/`getBookmarks` поднимают кэш каждого
 * пространства — это чтение до десятка файлов ради двух чисел. Файлов
 * может не быть (новая пространство) — тогда 0.
 */
function countEntries(wsId: string, file: string): number {
  try {
    const parsed = JSON.parse(readFileSync(workspaceFile(wsId, file), 'utf-8')) as unknown
    return Array.isArray(parsed) ? parsed.length : 0
  } catch {
    return 0
  }
}

function summary(meta: WorkspaceMeta, running: Set<string>): WorkspaceSummary {
  const snapshot = readWorkspaceWindows(meta.id)
  return {
    id: meta.id,
    name: meta.name,
    icon: meta.icon,
    color: meta.color,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    lastOpenedAt: meta.lastOpenedAt,
    running: running.has(meta.id),
    tabs: snapshot.reduce((sum, w) => sum + w.tabs.length, 0),
    groups: countEntries(meta.id, 'groups.json'),
    bookmarks: countEntries(meta.id, 'bookmarks.json')
  }
}

function summaryOf(id: string): WorkspaceSummary | undefined {
  const meta = readWorkspaceMeta(id)
  return meta ? summary(meta, runningIds()) : undefined
}

/** Поднимает окно уже открытого пространства вместо второго комплекта окон. */
function focusWorkspace(id: string): boolean {
  for (const ws of windows.values()) {
    if (ws.workspaceId !== id) continue
    const win = ws.window
    if (!win || win.isDestroyed()) continue
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    return true
  }
  return false
}

/**
 * Удаление каталога партиции Chromium.
 *
 * Electron хранит persist-партицию в `userData/Partitions/<имя без
 * префикса persist:>`. Удаление best-effort: каталог может быть занят, и
 * тогда он остаётся мусором, но данные пространства уже убраны и id больше
 * не выдаётся.
 */
function removePartition(partition: string): void {
  const name = partition.replace(/^persist:/, '')
  try {
    rmSync(join(userDataDir(), 'Partitions', name), { recursive: true, force: true })
  } catch {
    // Занято или нет прав — пространства уже нет, мусор не мешает.
  }
}

export function registerWorkspacesIpc(): void {
  ipcMain.handle('workspaces:list', (): WorkspaceSummary[] => {
    const running = runningIds()
    return listWorkspaces().map((meta) => summary(meta, running))
  })

  ipcMain.handle(
    'workspaces:create',
    async (
      _e,
      input?: {
        name?: string
        icon?: string
        color?: string
        copyFrom?: string
        sections?: string[]
      }
    ): Promise<WorkspaceResult> => {
      try {
        const meta = createWorkspace({
          name: input?.name,
          icon: input?.icon,
          color: input?.color
        })
        let copied: ConfigSection[] = []
        if (input?.copyFrom && input.copyFrom !== meta.id && workspaceExists(input.copyFrom)) {
          copied = await copyWorkspaceSections(input.copyFrom, meta.id, input.sections)
        }
        console.log('[workspace] created:', meta.id, meta.name, copied)
        return { ok: true, workspace: summaryOf(meta.id), copied }
      } catch (err) {
        console.log('[workspace] create failed:', err)
        return { ok: false, error: 'failed' }
      }
    }
  )

  ipcMain.handle(
    'workspaces:update',
    (_e, input: { id: string; name?: string; icon?: string; color?: string }): WorkspaceResult => {
      if (!input?.id) return { ok: false, error: 'missing' }
      const meta = updateWorkspaceMeta(input.id, {
        name: input.name,
        icon: input.icon,
        color: input.color
      })
      if (!meta) return { ok: false, error: 'missing' }
      return { ok: true, workspace: summaryOf(meta.id) }
    }
  )

  // Дублирование = создание + копирование ВСЕХ секций конфигурации.
  // Cookies, история и загрузки не копируются: это данные, а не настройка.
  ipcMain.handle(
    'workspaces:duplicate',
    async (_e, input: { id: string; name?: string }): Promise<WorkspaceResult> => {
      const src = input?.id ? readWorkspaceMeta(input.id) : null
      if (!src) return { ok: false, error: 'missing' }
      // Имя копии по умолчанию — на языке ИСХОДНОГО пространства.
      const t = tFor(src.id)
      try {
        const meta = createWorkspace({
          name:
            input.name?.trim() ||
            t('workspaces.copySuffix', { name: src.name }),
          icon: src.icon,
          color: src.color
        })
        const copied = await copyWorkspaceSections(src.id, meta.id, CONFIG_SECTIONS)
        console.log('[workspace] duplicated:', src.id, '->', meta.id, copied)
        return { ok: true, workspace: summaryOf(meta.id), copied }
      } catch (err) {
        console.log('[workspace] duplicate failed:', err)
        return { ok: false, error: 'failed' }
      }
    }
  )

  ipcMain.handle('workspaces:delete', (_e, id: string): WorkspaceResult => {
    if (!id) return { ok: false, error: 'missing' }
    const meta = readWorkspaceMeta(id)
    if (!meta) return { ok: false, error: 'missing' }
    // Последнее пространство не удаляется: браузеру негде хранить данные.
    // Раньше здесь стоял запрет на default — он оказался про происхождение
    // профиля, а не про данные (см. registry.deleteWorkspace).
    if (listWorkspaces().length <= 1) return { ok: false, error: 'last' }
    // Удалять пространство с живыми окнами нельзя: вкладки и сессия
    // Chromium пишут в его каталог, и файлы вернулись бы после удаления.
    if (runningIds().has(id)) return { ok: false, error: 'running' }
    const ok = deleteWorkspace(id)
    if (ok) {
      resetSettingsCache(id)
      resetExtensionsCache(id)
      removePartition(meta.partition)
      console.log('[workspace] deleted:', id, meta.name)
    }
    return ok ? { ok: true } : { ok: false, error: 'failed' }
  })

  ipcMain.handle('workspaces:open', async (_e, id: string): Promise<WorkspaceResult> => {
    if (!id || !workspaceExists(id)) return { ok: false, error: 'missing' }
    // Уже открыто: поднимаем окно вместо второго комплекта. Иначе каждый
    // клик по «Открыть» плодил бы окна с одними и теми же вкладками.
    if (focusWorkspace(id)) return { ok: true, focused: true }
    void initExtensions(id)
    openWorkspaceWindows(id)
    return { ok: true }
  })

  // Идентификатор для проверки из диагностики: страница не должна сама
  // угадывать партицию пространства.
  ipcMain.handle('workspaces:partition', (_e, id: string) => partitionFor(id))
}
