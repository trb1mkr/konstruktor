// Горячие клавиши браузера в main: разрешение настроек, сопоставление
// ввода с действием и подписи для меню.
//
// Живёт в main, а не в shared, потому что читает настройки
// (getSettingsSync) и берёт process.platform для подписи. Сама механика —
// чистые функции в shared/hotkeys: их же использует renderer, чтобы
// дублировать обработку клавиш (App.vue) по тем же сочетаниям.
//
// Реестр действий — shared/hotkey-actions: один список для обработчиков,
// таблицы настроек и подписей в меню.
import { getSettingsSync } from './store/settingsStore'
import { formatAccelerator, matchesInput, parseAccelerator } from '../shared/hotkeys'
import { HOTKEY_ACTIONS, type HotkeyActionId, type HotkeyOverrides } from '../shared/hotkey-actions'
import type { WebContents } from 'electron'

/** Ввод клавиши: подмножество Electron.Input, нужное для сопоставления. */
export interface HotkeyKeyInput {
  type: string
  code?: string
  control: boolean
  meta: boolean
  shift: boolean
  alt: boolean
}

/**
 * Действующие сочетания: переопределения из настроек поверх дефолтов.
 *
 * Пустая строка в переопределении = сочетание снято пользователем, и это
 * НЕ дефолт: у действия нет подписи в меню (`hotkeyLabel` отдаёт пусто),
 * а сопоставление (`matchHotkey`) его пропускает. Отсутствие ключа
 * отличается от пустого значения — там действует дефолт.
 */
export function resolvedHotkeys(): Record<HotkeyActionId, string> {
  const overrides: HotkeyOverrides = getSettingsSync().hotkeys ?? {}
  const out = {} as Record<HotkeyActionId, string>
  for (const action of HOTKEY_ACTIONS) {
    const value = overrides[action.id]
    out[action.id] = typeof value === 'string' ? value : action.defaultAccelerator
  }
  return out
}

/** Акселератор действия (с учётом настроек) в синтаксисе Electron. */
export function acceleratorFor(id: HotkeyActionId): string {
  return resolvedHotkeys()[id]
}

/** Подпись действия для меню: «Ctrl+R» на ПК, «⌘R» на macOS. */
export function hotkeyLabel(id: HotkeyActionId): string {
  return formatAccelerator(acceleratorFor(id), process.platform)
}

/**
 * Сопоставить нажатие с действием по действующим сочетаниям.
 *
 * Первое совпадение по порядку реестра. Страница настроек дубли не
 * блокирует — только предупреждает (красная строка и модальное окно), а
 * `normalizeHotkeys` отсекает лишь дубли внутри переопределений. Поэтому
 * порядок реестра здесь решает: из двух действий с одним сочетанием
 * сработает первое.
 */
export function matchHotkey(input: HotkeyKeyInput): HotkeyActionId | null {
  if (input.type !== 'keyDown') return null
  const hotkeys = resolvedHotkeys()
  for (const action of HOTKEY_ACTIONS) {
    const parsed = parseAccelerator(hotkeys[action.id])
    if (parsed && matchesInput(input, parsed)) return action.id
  }
  return null
}

// Захват сочетаний: пока таблица горячих клавиш в настройках держит поле
// в фокусе, браузерные сочетания молчат. Иначе Ctrl+W закрыл бы вкладку
// настроек, а Ctrl+R перезагрузил бы её прямо в момент ввода — сочетание
// не удалось бы набрать.
const capturing = new Set<number>()
const hooked = new Set<number>()

/**
 * Включить/выключить захват сочетаний для webContents.
 *
 * Вместе с флагом ставится `setIgnoreMenuShortcuts`: акселераторы
 * дефолтного меню Electron (Ctrl+R — «Reload», Ctrl+W — «Close», F11)
 * гасятся именно им, а не `preventDefault` в `before-input-event` — тот
 * убил бы и `keydown` страницы, и поле не получило бы нажатие
 * (docs/TROUBLESHOOTING.md, «preventDefault в before-input-event»).
 */
export function setHotkeyCapture(wc: WebContents, on: boolean): void {
  if (wc.isDestroyed()) return
  if (on) {
    capturing.add(wc.id)
    hookCaptureCleanup(wc)
  } else {
    capturing.delete(wc.id)
  }
  wc.setIgnoreMenuShortcuts(on)
}

/**
 * Захвачен ли ввод сочетаний этим webContents.
 *
 * Флаг помимо набора требует фокуса: потеря фокуса на уровне окна не
 * гарантирует DOM-событие `blur` на поле, и залипший захват оставил бы
 * браузер без горячих клавиш. Проверка идёт только из
 * `before-input-event`, который и так стреляет в focused webContents,
 * поэтому живого захвата она не отменяет.
 */
export function isHotkeyCapture(wc: WebContents): boolean {
  return !wc.isDestroyed() && wc.isFocused() && capturing.has(wc.id)
}

// Снятие флага при уходе страницы: вкладку могли закрыть или увести в
// навигацию мимо `blur` поля.
function hookCaptureCleanup(wc: WebContents): void {
  if (hooked.has(wc.id)) return
  hooked.add(wc.id)
  wc.once('destroyed', () => {
    hooked.delete(wc.id)
    capturing.delete(wc.id)
  })
}
