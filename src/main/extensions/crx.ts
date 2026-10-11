// Разбор контейнера CRX3/CRX2 и распаковка полезной нагрузки.
// Electron не умеет .crx вообще (только распакованные папки), поэтому
// контейнер разбираем сами, а содержимое (обычный zip) отдаём adm-zip.
//
// Раскладка контейнера (проверено на боевом файле из Chrome Web Store):
//   CRX3: 'Cr24' + uint32 LE version=3 + uint32 LE headerSize + CrxFileHeader + zip
//   CRX2: 'Cr24' + uint32 LE version=2 + uint32 LE keyLen + uint32 LE sigLen + key + sig + zip
//
// Важная деталь CRX3: длина заголовка — ОБЫЧНЫЙ uint32 с малым порядком,
// а не varint. Varint внутри — уже в полях protobuf. Ошибка здесь даёт
// «Invalid CEN header» от adm-zip, потому что zip начинается не там.
//
// Подпись не проверяется: расширение попадает в реестр как «неподписанное»
// (см. src/main/extensions/EXTENSIONS.md). Из заголовка берём только crx_id
// или публичный ключ — для того же идентификатора, что и в Chrome.
import AdmZip from 'adm-zip'
import { createHash } from 'crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { dirname, join, resolve, sep } from 'path'

const MAGIC = Buffer.from('Cr24')

export interface CrxContents {
  // Содержимое после заголовка — zip-архив.
  payload: Buffer
  version: number
  // Публичный ключ CRX2; у CRX3 он внутри protobuf и не извлекается.
  publicKey: Buffer | null
  // crx_id из подписанной части заголовка CRX3 (16 байт) — тот же
  // идентификатор, что показывает Chrome. У CRX2 его нет.
  crxId: Buffer | null
}

export function isCrxBuffer(buf: Buffer): boolean {
  return buf.length > 12 && buf.subarray(0, 4).equals(MAGIC)
}

// Varint protobuf: младшие 7 бит, старший бит — продолжение.
function readVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let value = 0
  let shift = 0
  let i = offset
  while (i < buf.length && shift < 64) {
    const byte = buf[i]
    value += (byte & 0x7f) * Math.pow(2, shift)
    i++
    if ((byte & 0x80) === 0) break
    shift += 7
  }
  return { value, next: i }
}

export function parseCrx(buf: Buffer): CrxContents {
  if (!isCrxBuffer(buf)) throw new Error('not a crx container')
  const version = buf.readUInt32LE(4)
  if (version === 3) {
    const headerSize = buf.readUInt32LE(8)
    const headerStart = 12
    const start = headerStart + headerSize
    if (start >= buf.length) throw new Error('crx3 header out of range')
    const header = buf.subarray(headerStart, start)
    return { payload: buf.subarray(start), version, publicKey: null, crxId: readCrxId(header) }
  }
  if (version === 2) {
    const keyLen = buf.readUInt32LE(8)
    const sigLen = buf.readUInt32LE(12)
    const keyStart = 16
    const publicKey = buf.subarray(keyStart, keyStart + keyLen)
    const payloadStart = keyStart + keyLen + sigLen
    if (payloadStart >= buf.length) throw new Error('crx2 header out of range')
    return { payload: buf.subarray(payloadStart), version, publicKey, crxId: null }
  }
  throw new Error('unsupported crx version: ' + version)
}

// Минимальный сканер protobuf: ищем поле 10000 (signed_header_data),
// внутри него — поле 1 (crx_id) длиной ровно 16 байт. Полноценная схема
// не нужна, а полноценный protobuf-парсер — лишняя зависимость.
function readCrxId(header: Buffer): Buffer | null {
  let i = 0
  while (i < header.length) {
    const key = readVarint(header, i)
    i = key.next
    const field = Math.floor(key.value / 8)
    const wire = key.value % 8
    if (wire === 2) {
      const len = readVarint(header, i)
      i = len.next
      const end = i + len.value
      if (end > header.length) return null
      if (field === 10000) return readSignedDataCrxId(header, i, end)
      i = end
    } else if (wire === 0) {
      i = readVarint(header, i).next
    } else if (wire === 5) {
      i += 4
    } else if (wire === 1) {
      i += 8
    } else {
      return null
    }
  }
  return null
}

function readSignedDataCrxId(header: Buffer, start: number, end: number): Buffer | null {
  let j = start
  while (j < end) {
    const key = readVarint(header, j)
    j = key.next
    const field = Math.floor(key.value / 8)
    const wire = key.value % 8
    if (wire === 2) {
      const len = readVarint(header, j)
      j = len.next
      if (field === 1 && len.value === 16) return header.subarray(j, j + 16)
      j += len.value
    } else if (wire === 0) {
      j = readVarint(header, j).next
    } else {
      return null
    }
  }
  return null
}

// Идентификатор из crx_id: 16 байт, каждый — два полубайта в 'a'..'p'.
export function chromeIdFromCrxId(crxId: Buffer): string {
  let id = ''
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (crxId[i] >> 4))
    id += String.fromCharCode(97 + (crxId[i] & 0x0f))
  }
  return id
}

// Chrome-идентификатор: SHA-256 публичного ключа, первые 16 байт,
// полубайты отображены в 'a'..'p'.
export function chromeIdFromKey(key: Buffer): string {
  const hash = createHash('sha256').update(key).digest()
  let id = ''
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (hash[i] >> 4))
    id += String.fromCharCode(97 + (hash[i] & 0x0f))
  }
  return id
}

// Идентификатор расширения без ключа: считаем от пути установки.
export function idFromPath(dir: string): string {
  return chromeIdFromKey(Buffer.from(resolve(dir), 'utf8'))
}

// Распаковка zip-полезной нагрузки в каталог без zip-slip:
// каждая запись проверяется на выход за пределы targetDir.
export function extractZipPayload(payload: Buffer, targetDir: string): number {
  const zip = new AdmZip(payload)
  const root = resolve(targetDir) + sep
  let count = 0
  for (const entry of zip.getEntries()) {
    const rel = entry.entryName.replace(/\\/g, '/')
    const dest = resolve(join(targetDir, rel))
    if (!dest.startsWith(root)) throw new Error('unsafe path in crx: ' + rel)
    if (entry.isDirectory) {
      mkdirSync(dest, { recursive: true })
      continue
    }
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, entry.getData())
    count++
  }
  return count
}

// Манифест из полезной нагрузки без распаковки на диск: нужен, чтобы
// прочитать имя и версию до установки.
export function manifestFromCrx(payload: Buffer): Record<string, unknown> {
  const zip = new AdmZip(payload)
  const entry = zip.getEntry('manifest.json')
  if (!entry) throw new Error('manifest.json not found in crx')
  return JSON.parse(entry.getData().toString('utf8')) as Record<string, unknown>
}

export function readManifestFile(dir: string): Record<string, unknown> {
  const p = join(dir, 'manifest.json')
  if (!existsSync(p)) throw new Error('manifest.json not found in ' + dir)
  return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
}

export function writeManifestFile(dir: string, manifest: Record<string, unknown>): void {
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
}

// Разворачивание локализованных метаданных: в манифестах Chrome поля вида
// "__MSG_extName__" подставляются из _locales/<locale>/messages.json.
// Chromium в Electron этого не делает для наших целей (мы читаем манифест
// сами для реестра и UI), поэтому без разворота в списке расширений
// показывалось бы «__MSG_extName__» (так и было с uBlock Origin Lite).
const MSG_PATTERN = /__MSG_([A-Za-z0-9_@]+)__/g

function readLocaleMessages(dir: string, locale: string): Record<string, string> {
  const candidates = [locale, locale.toUpperCase(), locale.toLowerCase(), 'en', 'en_US']
  for (const name of candidates) {
    const file = join(dir, '_locales', name, 'messages.json')
    if (!existsSync(file)) continue
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<
        string,
        { message?: string } | undefined
      >
      const table: Record<string, string> = {}
      for (const [key, value] of Object.entries(raw)) {
        if (value && typeof value.message === 'string') table[key] = value.message
      }
      return table
    } catch {
      // Битый каталог — пробуем следующий.
    }
  }
  return {}
}

// Подстановка с учётом плейсхолдеров $1..$9 из значения по умолчанию.
function substitute(message: string, subs: string[]): string {
  return message.replace(/\$(\d+)/g, (_m, n: string) => subs[Number(n) - 1] ?? '')
}

export function localizeManifest(
  manifest: Record<string, unknown>,
  dir: string
): Record<string, unknown> {
  const locale = typeof manifest.default_locale === 'string' ? manifest.default_locale : 'en'
  const table = readLocaleMessages(dir, locale)
  const keys = Object.keys(table)
  if (keys.length === 0) return manifest

  const resolve = (value: unknown): unknown => {
    if (typeof value !== 'string' || !value.includes('__MSG_')) return value
    return value.replace(MSG_PATTERN, (whole, key: string) => {
      const entry = table[key]
      return entry === undefined ? whole : substitute(entry, [])
    })
  }

  const next: Record<string, unknown> = { ...manifest }
  next.name = resolve(next.name)
  next.description = resolve(next.description)
  const action = next.action
  if (action && typeof action === 'object' && !Array.isArray(action)) {
    const rec = { ...(action as Record<string, unknown>) }
    rec.default_title = resolve(rec.default_title)
    next.action = rec
  }
  return next
}
