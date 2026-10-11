// Клавиатурные команды расширений: разбор секции commands манифеста,
// сопоставление с вводом и доставка события в фон расширения.
//
// Зачем свой перехватчик: Chromium в Electron не обслуживает MV3-команды
// расширений (проверено пробником — манифест грузится, но комбинация
// не срабатывает), поэтому сочетания ищет браузер. Событие уходит в фон
// через мост тем же событием, что ждёт расширение — commands.onCommand.
//
// Команды сравниваются по input.code (физическая клавиша), а не по key:
// на русской раскладке key = 'н' вместо 'y', и команда молча не сработала
// бы — та же ловушка, что у Ctrl+F и зума (см. FIND.md «Ctrl+F и раскладка»).
import type { ExtensionRecord } from './extensionStore'

export interface ParsedCommand {
  id: string
  description: string
  // Исходная строка сочетания: нужна для chrome.commands.getAll.
  accelerator: string
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  // Физический код клавиши Electron (KeyY, Digit1, F5…). null = только
  // модификаторы либо незнакомая клавиша, такая команда не срабатывает.
  code: string | null
}

export interface RegisteredCommand extends ParsedCommand {
  recordId: string
  electronId: string
}

// Клавиши Chrome, у которых имя не совпадает с кодом Electron.
const KEY_CODES: Record<string, string> = {
  comma: 'Comma',
  period: 'Period',
  slash: 'Slash',
  semicolon: 'Semicolon',
  quote: 'Quote',
  backquote: 'Backquote',
  minus: 'Minus',
  equal: 'Equal',
  space: 'Space',
  insert: 'Insert',
  delete: 'Delete',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  tab: 'Tab'
}

// Имя клавиши -> физический код. Буквы и цифры разворачиваются в KeyX/DigitN,
// остальные берутся из таблицы; неизвестное имя даёт null.
function keyToCode(name: string): string | null {
  const lower = name.toLowerCase()
  if (KEY_CODES[lower]) return KEY_CODES[lower]
  if (/^[a-z]$/.test(lower)) return 'Key' + lower.toUpperCase()
  if (/^[0-9]$/.test(lower)) return 'Digit' + lower
  if (/^f([1-9]|1[0-2])$/.test(lower)) return lower.toUpperCase()
  return null
}

// Разбор одного сочетания вида «Ctrl+Shift+Y».
export function parseAccelerator(accelerator: string): Omit<ParsedCommand, 'id' | 'description'> | null {
  const parts = accelerator
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 0) return null
  const parsed: Omit<ParsedCommand, 'id' | 'description'> = {
    accelerator,
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    code: null
  }
  for (const part of parts) {
    const lower = part.toLowerCase()
    if (lower === 'ctrl' || lower === 'macctrl') parsed.ctrl = true
    else if (lower === 'alt') parsed.alt = true
    else if (lower === 'shift') parsed.shift = true
    else if (lower === 'command' || lower === 'cmd' || lower === 'meta') parsed.meta = true
    else parsed.code = keyToCode(part)
  }
  if (!parsed.ctrl && !parsed.alt && !parsed.meta) {
    // Chrome не разрешает команды без Ctrl/Alt/Command: одиночные клавиши
    // перехватывали бы ввод на странице.
    parsed.shift = false
  }
  return parsed
}

// Сочетание для текущей платформы: у Chrome есть default и переопределения
// по ОС (windows/mac/linux, у macOS ещё chromeos).
function acceleratorForPlatform(value: Record<string, unknown>, platform: string): string | null {
  const override = value[platform]
  if (typeof override === 'string' && override.length > 0) return override
  const def = value['default']
  return typeof def === 'string' && def.length > 0 ? def : null
}

// Секция commands манифеста -> список команд. Служебные команды вида
// `_execute_action` пропускаются: они относятся к попапу кнопки, а не
// к сочетаниям клавиш.
export function parseCommands(
  commands: unknown,
  platform: NodeJS.Platform = process.platform
): ParsedCommand[] {
  if (!commands || typeof commands !== 'object' || Array.isArray(commands)) return []
  const key = platform === 'darwin' ? 'mac' : platform === 'linux' ? 'linux' : 'windows'
  const out: ParsedCommand[] = []
  for (const [id, value] of Object.entries(commands as Record<string, unknown>)) {
    if (id.startsWith('_')) continue
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const rec = value as Record<string, unknown>
    const suggested = rec.suggested_key
    if (!suggested || typeof suggested !== 'object' || Array.isArray(suggested)) continue
    const accelerator = acceleratorForPlatform(suggested as Record<string, unknown>, key)
    if (!accelerator) continue
    const parsed = parseAccelerator(accelerator)
    if (!parsed) continue
    out.push({
      id,
      description: typeof rec.description === 'string' ? rec.description : '',
      ...parsed
    })
  }
  return out
}

// --- Реестр и перехват --------------------------------------------------

const registry = new Map<string, RegisteredCommand[]>()

export function setExtensionCommands(rec: ExtensionRecord): void {
  registry.delete(rec.id)
  if (!rec.enabled || !rec.electronId) return
  const parsed = parseCommands(rec.manifestCommands, process.platform)
  if (parsed.length === 0) return
  registry.set(
    rec.id,
    parsed.map((c) => ({ ...c, recordId: rec.id, electronId: rec.electronId ?? '' }))
  )
}

export function clearExtensionCommands(recordId: string): void {
  registry.delete(recordId)
}

export function listRegisteredCommands(): RegisteredCommand[] {
  return [...registry.values()].flat()
}

// Что пришло из before-input-event. Структура — под Electron.Input, но
// объявленная сама: модуль не тянет electron-тип в сигнатуру.
export interface CommandKeyInput {
  type: string
  code?: string
  control: boolean
  alt: boolean
  shift: boolean
  meta: boolean
}

// Совпадает ли ввод с одной из команд. Возвращает список команд: одно
// сочетание могут объявить несколько расширений, и все обязаны получить
// событие — Chrome ведёт себя так же.
export function matchCommands(input: CommandKeyInput): RegisteredCommand[] {
  if (input.type !== 'keyDown') return []
  return listRegisteredCommands().filter(
    (c) =>
      c.code !== null &&
      c.code === (input.code ?? '') &&
      c.ctrl === input.control &&
      c.alt === input.alt &&
      c.shift === input.shift &&
      c.meta === input.meta
  )
}

// Список команд для chrome.commands.getAll: имя, сочетание и описание.
export function commandsOfRecord(recordId: string): {
  name: string
  shortcut: string
  description: string
}[] {
  return (registry.get(recordId) ?? []).map((c) => ({
    name: c.id,
    shortcut: c.accelerator,
    description: c.description
  }))
}
