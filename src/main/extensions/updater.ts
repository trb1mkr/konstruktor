// Обновление установленных расширений.
//
// Chrome не кладёт адрес обновления в .crx из веб-магазина (его добавляет
// сам магазин при установке), поэтому адрес строится по источнику:
//   - своё расширение с секцией update_url — адрес оттуда;
//   - расширение из .crx с Chrome-идентификатором — эндпоинт веб-магазина.
// Ответ в обоих случаях — тот же XML (gupdate/updatecheck), его и разбираем.
//
// XML разбирается регулярками, а не парсером: нужен один атрибут из одного
// элемента, а тянуть зависимость ради этого незачем. Формат стабилен
// с 2011 года и описан в документации Chrome (self-hosting extensions).
import { app, net } from 'electron'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { getExtensionsSync, type ExtensionRecord } from './extensionStore'
import { installFromPath } from './manager'

export interface UpdateResult {
  id: string
  name: string
  from: string
  to: string
}

const CWS_ENDPOINT = 'https://clients2.google.com/service/update2/crx'
const PROD_VERSION = '124.0.0.0'

// Адрес проверки обновлений: сначала свой (update_url), затем веб-магазин.
export function updateUrlFor(rec: ExtensionRecord): string | null {
  if (rec.updateUrl) return rec.updateUrl
  if (rec.source === 'crx' && /^[a-p]{32}$/.test(rec.id)) {
    return (
      CWS_ENDPOINT +
      '?response=updatecheck&prodversion=' +
      PROD_VERSION +
      '&acceptformat=crx2,crx3&x=id%3D' +
      rec.id +
      '%26uc'
    )
  }
  return null
}

// Сравнение версий по сегментам: '1.2.10' > '1.2.9'. Нечисловые сегменты
// сравниваются как строки — этого достаточно для версий расширений.
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = candidate.split('.').map((s) => Number.parseInt(s, 10))
  const b = current.split('.').map((s) => Number.parseInt(s, 10))
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const x = Number.isFinite(a[i]) ? a[i] : 0
    const y = Number.isFinite(b[i]) ? b[i] : 0
    if (x !== y) return x > y
  }
  return false
}

interface UpdateCheck {
  codebase: string
  version: string
}

// Разбор ответа updatecheck. Атрибуты в XML могут идти в любом порядке,
// поэтому версия и код ищутся независимо.
export function parseUpdateXml(xml: string): UpdateCheck | null {
  const codebase = /codebase\s*=\s*['"]([^'"]+)['"]/i.exec(xml)
  const version = /version\s*=\s*['"]([^'"]+)['"]/i.exec(xml)
  if (!codebase || !version) return null
  return { codebase: codebase[1], version: version[1] }
}

async function fetchText(url: string): Promise<string> {
  const res = await net.fetch(url)
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return await res.text()
}

async function downloadToTemp(url: string): Promise<string> {
  const res = await net.fetch(url)
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const buffer = Buffer.from(await res.arrayBuffer())
  const dir = await mkdtemp(join(tmpdir(), 'konstruktor-ext-upd-'))
  const file = join(dir, 'update.crx')
  await writeFile(file, buffer)
  return file
}

// Проверка и установка обновлений. Ошибки отдельных расширений не роняют
// остальные: сеть может быть недоступна, а адрес обновления — протухнуть.
export async function checkExtensionUpdates(): Promise<UpdateResult[]> {
  const results: UpdateResult[] = []
  for (const rec of getExtensionsSync()) {
    if (!rec.enabled) continue
    const url = updateUrlFor(rec)
    if (!url) continue
    try {
      const xml = await fetchText(url)
      const check = parseUpdateXml(xml)
      if (!check || !isNewerVersion(check.version, rec.version)) continue
      const file = await downloadToTemp(check.codebase)
      try {
        const installed = await installFromPath(file)
        if (installed.ok) {
          results.push({
            id: rec.id,
            name: rec.name,
            from: rec.version,
            to: check.version
          })
        }
      } finally {
        await rm(join(file, '..'), { recursive: true, force: true }).catch(() => undefined)
      }
    } catch {
      // Молча: неудачная проверка одного расширения не должна шуметь тостом.
    }
  }
  return results
}

// Отложенная проверка при старте: не мешает загрузке первой страницы.
export function scheduleUpdateCheck(delayMs = 20000): void {
  setTimeout(() => {
    void checkExtensionUpdates().then((updates) => {
      if (updates.length > 0) {
        console.log('[extensions] обновлено:', JSON.stringify(updates))
      }
    })
  }, delayMs)
  void app
}
