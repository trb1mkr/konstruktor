// Копирование расширений между рабочими пространствами.
//
// Расширение в реестре — это не только строка в extensions.json: это ещё и
// каталог с файлами, и абсолютный путь `dir` в записи. Поэтому копирование
// секции «Расширения» — это копирование каталогов плюс переписывание путей,
// и одного `writeJsonAtomic` здесь мало (в отличие от остальных секций).
//
// Путь в реестре ПЕРЕПИСЫВАЕТСЯ на каталог целевого пространства. Оставить
// исходный нельзя: реестр хранит абсолютные пути, и копия указывала бы в
// чужой каталог — при удалении пространства-источника расширения копии
// пропали бы, а до тех пор два пространства делили бы одни файлы и правка
// в одном видна в другом.
//
// `electronId` — идентификатор регистрации в партиции Chromium. Он выдаётся
// при загрузке и принадлежит ПАРТИЦИИ, поэтому в копию не переносится:
// с чужим electronId реестр считал бы копию уже загруженной и не загрузил
// бы её вовсе. `error` тоже чистится — она относится к загрузке в чужой
// сессии.
import { cp, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { workspaceExtensionsDir } from '../workspaces/paths'
import { windows } from '../windows/browserState'
import { getSettingsSync } from '../store/settingsStore'
import { loadExtensions, resetExtensionsCache, saveExtensions, type ExtensionRecord } from './extensionStore'
import { applyExtensionsEnabled } from './manager'

/** Есть ли у пространства живые окна: только тогда нужна догрузка на лету. */
function isWorkspaceRunning(wsId: string): boolean {
  for (const ws of windows.values()) {
    if (ws.workspaceId !== wsId) continue
    if (ws.window && !ws.window.isDestroyed()) return true
  }
  return false
}

/**
 * Копирует расширения из одного пространства в другое.
 *
 * Возвращает число реально скопированных расширений: каталога могло не
 * быть (запись осталась после ручной чистки), и обещать копирование всего
 * списка нельзя.
 *
 * Копия приходит ВЫКЛЮЧЕННОЙ? Нет — состояние `enabled` переносится как
 * есть: пользователь выбирал «скопировать конфигурацию», а не «начать с
 * выключенными».
 */
export async function copyExtensions(fromId: string, toId: string): Promise<number> {
  if (fromId === toId) return 0
  const source = await loadExtensions(fromId)
  if (source.length === 0) return 0
  const targetRoot = workspaceExtensionsDir(toId)
  const copied: ExtensionRecord[] = []
  for (const rec of source) {
    if (!rec.dir || !existsSync(rec.dir)) continue
    // Каталог в целевом пространстве называется по id расширения — так же,
    // как при установке (installDirFor). Копия по оригинальному имени папки
    // разошлась бы с тем, что делает установка, и повторное копирование
    // создало бы второй каталог для того же расширения.
    const dir = join(targetRoot, rec.id)
    try {
      await rm(dir, { recursive: true, force: true })
      await cp(rec.dir, dir, { recursive: true })
    } catch {
      // Диск или права: остальные расширения всё равно копируем.
      continue
    }
    copied.push({
      ...rec,
      dir,
      // Регистрация принадлежит партиции: выдаётся заново при загрузке.
      electronId: undefined,
      error: ''
    })
  }
  if (copied.length === 0) return 0
  // Слияние по id: в целевом пространстве расширения могло уже стоять
  // (копия поверх существующего — это замена файлов и записи, а не дубль,
  // иначе в списке появились бы две строки с одним id).
  const existing = await loadExtensions(toId)
  const merged = [...existing]
  for (const rec of copied) {
    const idx = merged.findIndex((r) => r.id === rec.id)
    if (idx >= 0) merged[idx] = rec
    else merged.push(rec)
  }
  resetExtensionsCache(toId)
  await saveExtensions(merged, toId)
  console.log('[extensions] copied:', fromId, '->', toId, copied.map((r) => r.name))
  // Пространство уже открыто — поднимаем копии сразу, иначе они появятся
  // только после перезапуска, и пользователь решит, что копирование не
  // сработало.
  if (isWorkspaceRunning(toId) && getSettingsSync(toId).extensionsEnabled !== false) {
    await applyExtensionsEnabled(true, toId)
  }
  return copied.length
}
