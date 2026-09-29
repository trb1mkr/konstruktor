// Логирование системы оверлея: категории + уровни + perf-метки.
// Работает и со старым overlayManager.ts, и с новой папкой overlay/.
//
// Уровни через переменные окружения (проверяются один раз при загрузке):
//   OVERLAY_DEBUG=1  — подробно: каждое событие, каждая метка
//   OVERLAY_DEBUG=2  — максимально (то же + внутренние детали пула)
//   (не задана)     — terse: только открытия/закрытия/ошибки, одной строкой
//
// Env читается один раз: менять уровень на лету нельзя (нужен перезапуск).

export type LogCategory =
  | 'pool' // создание/прогрев/переиспользование окон
  | 'session' // открытие/закрытие сессий, смены вида
  | 'command' // команды renderer -> main (select/submit/dismiss)
  | 'geometry' // расчёт позиции и размера, клампинг
  | 'perf' // тайминги: сколько занял open/push/visible
  | 'lifecycle' // создание/уничтожение окон, blur/close
  | 'error'

type LogLevel = 'silent' | 'terse' | 'debug' | 'verbose'

function readLevel(): LogLevel {
  const raw = process.env['OVERLAY_DEBUG']
  if (raw === '1') return 'debug'
  if (raw === '2') return 'verbose'
  return 'terse'
}

const level = readLevel()
const isSilent = level === 'silent'

// Категории, которые видны в terse-режиме. Остальное — только в debug/verbose.
const terseCategories = new Set<LogCategory>(['session', 'perf', 'error'])

// Цвета для терминала (ANSI). Отключаются, если NO_COLOR задан.
const useColor = !process.env['NO_COLOR']
const paint = (code: string, text: string): string =>
  useColor ? `\x1b[${code}m${text}\x1b[0m` : text

const CATEGORY_COLOR: Record<LogCategory, string> = {
  pool: '36', // cyan
  session: '35', // magenta
  command: '33', // yellow
  geometry: '34', // blue
  perf: '32', // green
  lifecycle: '90', // grey
  error: '31' // red
}

function formatCategory(cat: LogCategory): string {
  return paint(CATEGORY_COLOR[cat], cat.padEnd(9))
}

// Основной логгер. Категория передаётся один раз, дальше только сообщение.
export function log(cat: LogCategory, message: string, detail?: unknown): void {
  if (isSilent) return
  if (level === 'terse' && !terseCategories.has(cat)) return
  const prefix = `[overlay:${formatCategory(cat)}]`
  if (detail === undefined) {
    console.log(`${prefix} ${message}`)
  } else {
    console.log(`${prefix} ${message}`, detail)
  }
}

// Перф-метка: замер интервала между двумя точками. Использование:
//   const t = mark('open:start')
//   ...
//   perf('open', t)          → "open: 4.3ms"
// Метки хранятся в Map по имени — переиспользование метки перезаписывает.
const marks = new Map<string, number>()

export function mark(name: string): string {
  marks.set(name, performance.now())
  return name
}

// Замер от метки до сейчас. Печатает и удаляет метку.
export function perf(label: string, markName: string, detail?: unknown): number {
  const start = marks.get(markName)
  if (start === undefined) {
    log('perf', `${label}: mark "${markName}" not found`)
    return 0
  }
  marks.delete(markName)
  const ms = performance.now() - start
  const msg = `${label}: ${ms.toFixed(1)}ms`
  if (detail === undefined) log('perf', msg)
  else log('perf', msg, detail)
  return ms
}

// Текущее время — для ручных замеров внутри шагов сбора.
export function now(): number {
  return performance.now()
}

// Сбор статистики по времени open за сессию работы приложения.
interface OpenStat {
  count: number
  samples: number[]
}

const openStats: OpenStat = { count: 0, samples: [] }

export function recordOpen(ms: number): void {
  openStats.count++
  openStats.samples.push(ms)
}

// Периодическая сводка: p50/p95/p99/max по всем открытиям.
export function dumpStats(): void {
  if (isSilent || openStats.count === 0) return
  const s = [...openStats.samples].sort((a, b) => a - b)
  const pct = (p: number): number => s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0
  log(
    'perf',
    `stats { open: ${openStats.count}, p50: ${pct(0.5).toFixed(1)}ms, ` +
      `p95: ${pct(0.95).toFixed(1)}ms, p99: ${pct(0.99).toFixed(1)}ms, ` +
      `max: ${s[s.length - 1].toFixed(1)}ms }`
  )
}

// Сброс статистики (для чистого замера).
export function resetStats(): void {
  openStats.count = 0
  openStats.samples = []
}

// Ошибки всегда печатаются (кроме silent) — на любом уровне.
export function logError(message: string, err?: unknown): void {
  if (isSilent) return
  const prefix = `[overlay:${paint(CATEGORY_COLOR.error, 'error'.padEnd(9))}]`
  if (err === undefined) console.error(`${prefix} ${message}`)
  else console.error(`${prefix} ${message}`, err)
}
