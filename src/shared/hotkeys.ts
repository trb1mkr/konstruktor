// Отображение сочетаний клавиш в подписях меню.
//
// Вход — синтаксис Electron-акселератора (`CmdOrCtrl+R`, `Shift+CmdOrCtrl+T`),
// тот же, что у пунктов системного меню по умолчанию: одна строка-источник
// и на Windows/Linux, и на macOS, а платформенный вид получается здесь.
//
// Renderer эту функцию не вызывает: main кладёт готовую строку в
// `MenuItem.hotkey`, и renderer только рисует её. Поэтому платформа
// приходит параметром, а не берётся из `process` — shared собирается
// и в контекст renderer, где `process` нет.

/**
 * Подпись сочетания для показа в меню.
 *
 * На Windows/Linux: `Ctrl+R`. На macOS — без плюсов и со символами:
 * `⌘R`, `⇧⌘T`. Разделитель и символы — как в системных меню macOS,
 * иначе подпись читалась бы как чужеродная.
 *
 * Неизвестный токен отдаётся как есть: лучше видимая опечатка в подписи,
 * чем молча выброшенная часть сочетания.
 */
export function formatAccelerator(accelerator: string, platform: string): string {
  const mac = platform === 'darwin'
  const parts = accelerator
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
  const out = parts.map((part) => {
    switch (part.toLowerCase()) {
      case 'cmdorctrl':
      case 'commandorcontrol':
      case 'ctrl':
      case 'control':
        return mac ? '⌘' : 'Ctrl'
      case 'shift':
        return mac ? '⇧' : 'Shift'
      case 'alt':
      case 'option':
        return mac ? '⌥' : 'Alt'
      case 'meta':
      case 'cmd':
      case 'command':
        return '⌘'
      default:
        return part
    }
  })
  // macOS: модификаторы слитно, без разделителя (`⇧⌘T`). Windows/Linux:
  // через плюс (`Ctrl+Shift+T`).
  return mac ? out.join('') : out.join('+')
}

/** Модификаторы акселератора. `primary` — «CmdOrCtrl» (Ctrl на ПК, ⌘ на mac). */
export interface ParsedHotkey {
  primary: boolean
  ctrl: boolean
  meta: boolean
  alt: boolean
  shift: boolean
  /** Код клавиши Electron (KeyR, Digit0, F11). null — только модификаторы. */
  code: string | null
}

// «CmdOrCtrl» разворачивается в primary, а не в ctrl/meta: на macOS это
// Command, на ПК — Ctrl, и один токен должен означать «главный модификатор
// платформы». Сравнение с вводом тогда не зависит от платформы (см.
// matchesInput): primary принимает и control, и meta.
const MODIFIERS: Record<string, 'primary' | 'ctrl' | 'meta' | 'alt' | 'shift'> = {
  cmdorctrl: 'primary',
  commandorcontrol: 'primary',
  ctrl: 'ctrl',
  control: 'ctrl',
  cmd: 'meta',
  command: 'meta',
  meta: 'meta',
  super: 'meta',
  alt: 'alt',
  option: 'alt',
  shift: 'shift'
}

// Имя клавиши в акселераторе -> код Electron. Буквы/цифры/F-клавиши
// разворачиваются регуляркой, остальное берётся из таблицы.
const KEY_CODES: Record<string, string> = {
  '=': 'Equal',
  plus: 'Equal',
  '-': 'Minus',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  ';': 'Semicolon',
  "'": 'Quote',
  '`': 'Backquote',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '\\': 'Backslash',
  space: 'Space',
  spacebar: 'Space',
  tab: 'Tab',
  enter: 'Enter',
  return: 'Enter',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight'
}

function keyToCode(name: string): string | null {
  const lower = name.toLowerCase()
  if (KEY_CODES[lower]) return KEY_CODES[lower]
  if (/^[a-z]$/.test(lower)) return 'Key' + lower.toUpperCase()
  if (/^[0-9]$/.test(lower)) return 'Digit' + lower
  if (/^f([1-9]|1[0-2])$/.test(lower)) return lower.toUpperCase()
  return null
}

/**
 * Разобрать акселератор в код клавиши и модификаторы.
 *
 * Возвращает null, если клавиши нет (одни модификаторы) или ничего не
 * распознано: такой акселератор сопоставлять не с чем.
 */
export function parseAccelerator(accelerator: string): ParsedHotkey | null {
  const parts = accelerator
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 0) return null
  const parsed: ParsedHotkey = {
    primary: false,
    ctrl: false,
    meta: false,
    alt: false,
    shift: false,
    code: null
  }
  for (const part of parts) {
    const modifier = MODIFIERS[part.toLowerCase()]
    if (modifier) {
      parsed[modifier] = true
      continue
    }
    const code = keyToCode(part)
    if (code) parsed.code = code
  }
  return parsed.code ? parsed : null
}

/** Ввод клавиши: то, что есть у Electron Input и у KeyboardEvent. */
export interface HotkeyInput {
  code?: string
  control: boolean
  meta: boolean
  shift: boolean
  alt: boolean
}

/**
 * Совпадает ли нажатие с разобранным акселератором.
 *
 * Сравнение точное по shift/alt: сочетание без shift не сработает при
 * зажатом shift. Так «Ctrl+Shift+R» (жёсткая перезагрузка) не срабатывает
 * как обычная. Сравнение по `code` — раскладка (русская 'а' = KeyF).
 *
 * primary («CmdOrCtrl») принимает любой из control/meta: на macOS это
 * Command, на ПК — Ctrl, и разбирать платформу здесь не нужно.
 */
export function matchesInput(input: HotkeyInput, parsed: ParsedHotkey): boolean {
  if (!parsed.code || input.code !== parsed.code) return false
  if (input.shift !== parsed.shift) return false
  if (input.alt !== parsed.alt) return false
  if (parsed.primary) return input.control || input.meta
  return input.control === parsed.ctrl && input.meta === parsed.meta
}

