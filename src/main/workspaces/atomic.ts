// Атомарная запись JSON: временный файл рядом с целевым и rename поверх.
//
// Оборванная запись (питание, kill, падение) оставляет либо старый файл
// целиком, либо новый целиком, но не половину. Это требование будущей
// синхронизации, но оно дешевле ввода сразу: переделывать формат записи
// во всех сторах потом дороже, чем писать через один хелпер с самого начала.
import { mkdirSync, renameSync, writeFileSync } from 'fs'
import { mkdir, rename, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { randomBytes } from 'crypto'

/**
 * Имя временного файла — УНИКАЛЬНОЕ для каждой записи.
 *
 * Общее `<file>.tmp` на все записи ломалось на параллельных: история
 * пишется на каждую навигацию, и две записи подряд берут один и тот же
 * tmp. Первая успевала переименовать его, вторая — нет, и `rename` падала
 * с ENOENT (в логе «history record failed»), а данные терялись. Уборки не
 * требуется: имя уникально, поэтому мусор остаётся только от оборванной
 * записи, и он не мешает следующей.
 */
function tempPath(file: string): string {
  return `${file}.${process.pid}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}.tmp`
}

/** Синхронная атомарная запись. Нужна хукам 'close', где async не доживает. */
export function writeJsonAtomicSync(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = tempPath(file)
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8')
  renameSync(tmp, file)
}

/** Асинхронная атомарная запись. */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = tempPath(file)
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8')
  await rename(tmp, file)
}
