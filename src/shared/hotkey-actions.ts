// Реестр действий браузера, которым можно назначить горячую клавишу.
//
// Единственный источник правды по составу настраиваемых действий: из него
// строятся и обработчики клавиш (main), и таблица в настройках, и подписи
// в меню. Поэтому реестр живёт в shared: он нужен и main, и renderer, а
// самодостаточен (нет импортов из electron/vue/process).
//
// Акселератор по умолчанию — в синтаксисе Electron (`CmdOrCtrl+R`). Это
// НЕ подпись: подпись для показа строит formatAccelerator (shared/hotkeys).
// Названия действий для таблицы настроек — в `settingsPage.ts` через
// литеральные ключи i18n (секция `hotkeys.actions`).

export type HotkeyActionId =
  | 'reload'
  | 'close-tab'
  | 'new-tab'
  | 'reopen-closed'
  | 'find'
  | 'devtools'
  | 'fullscreen'

export interface HotkeyActionDef {
  id: HotkeyActionId
  /** Акселератор по умолчанию в синтаксисе Electron. */
  defaultAccelerator: string
}

export const HOTKEY_ACTIONS: readonly HotkeyActionDef[] = [
  { id: 'reload', defaultAccelerator: 'CmdOrCtrl+R' },
  { id: 'close-tab', defaultAccelerator: 'CmdOrCtrl+W' },
  { id: 'new-tab', defaultAccelerator: 'CmdOrCtrl+T' },
  // Возврат последней закрытой вкладки или окна. Стоит СРАЗУ после
  // new-tab: при совпадении сочетаний (пользователь назначил одно и то же)
  // срабатывает первый по реестру, и порядок здесь — осмысленный.
  { id: 'reopen-closed', defaultAccelerator: 'CmdOrCtrl+Shift+T' },
  { id: 'find', defaultAccelerator: 'CmdOrCtrl+F' },
  { id: 'devtools', defaultAccelerator: 'F12' },
  { id: 'fullscreen', defaultAccelerator: 'F11' }
]

/** Значения по умолчанию по каждому действию. */
export const DEFAULT_HOTKEYS: Record<HotkeyActionId, string> = HOTKEY_ACTIONS.reduce(
  (acc, a) => {
    acc[a.id] = a.defaultAccelerator
    return acc
  },
  {} as Record<HotkeyActionId, string>
)

/**
 * Переопределения сочетаний, как они лежат в настройках: разреженная карта
 * «действие -> акселератор». Пустая строка или отсутствие ключа = дефолт.
 */
export type HotkeyOverrides = Partial<Record<HotkeyActionId, string>>

/** Известен ли такой идентификатор действия. */
export function isHotkeyActionId(id: string): id is HotkeyActionId {
  return HOTKEY_ACTIONS.some((a) => a.id === id)
}
