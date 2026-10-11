// Контракт расширений: общий для main, shell-прелоада и внутренних страниц.
// Живёт в shared, чтобы форма не дублировалась: типы стираются при сборке,
// но расхождение имён полей ловится компилятором.

// Откуда приехало расширение: папка, .crx или собственная сборка konstruktor.
export type ExtensionSource = 'folder' | 'crx' | 'konstruktor'

// Кнопка расширения на панели: состояние хранит main, shell только рисует.
export interface ExtensionActionInfo {
  // Идентификатор расширения, по которому shell шлёт клик.
  id: string
  // Заголовок (title) — всплывающая подсказка и имя в списке.
  title: string
  badge: string
  badgeColor: string
  // data URL иконки; пустая строка = рисуем первую букву имени.
  icon: string
  // У расширения есть default_popup: клик открывает окно, а не событие.
  hasPopup: boolean
}

export interface ExtensionInfo {
  id: string
  // Идентификатор, который присвоил Chromium при загрузке.
  // Пусто у выключенных: заполняется в момент loadExtension.
  electronId: string
  name: string
  version: string
  description: string
  dir: string
  enabled: boolean
  // Закреплено на панели: иконка видна всегда. Не закреплённые
  // собираются под кнопкой меню расширений (как в Chrome и Yandex).
  pinned: boolean
  source: ExtensionSource
  // Разрешения API (в терминах манифеста) и хосты-шаблоны.
  permissions: string[]
  hosts: string[]
  // Деградации, внесённые переписыванием манифеста и шимом.
  warnings: string[]
  installedAt: number
  manifestVersion: number
  hasBackground: boolean
  contentScriptCount: number
  // Расширение написано под konstruktor.* (своя экосистема).
  native: boolean
  capabilities: string[]
  action: ExtensionActionInfo | null
  // Ошибка последней загрузки: пустая строка = загружено штатно.
  error: string
}

// Строка меню расширений: то, что нужно панели, без служебных полей
// реестра (пути, манифеста, прав) — они в меню не показываются.
export interface ExtensionMenuEntry {
  id: string
  name: string
  // data URL иконки; пустая строка = первая буква имени.
  icon: string
  badge: string
  badgeColor: string
  // Расширение можно закрепить на панели (есть action).
  canPin: boolean
  pinned: boolean
  enabled: boolean
  // Клик по строке открывает попап расширения, а не шлёт событие.
  hasPopup: boolean
  // Число заметок о совместимости: выход на страницу расширений.
  warningCount: number
}

export interface ExtensionsMenuModel {
  items: ExtensionMenuEntry[]
  enabled: boolean
}

export interface ExtensionsState {
  list: ExtensionInfo[]
  // Глобальный выключатель расширений из настроек.
  enabled: boolean
  devMode: boolean
}

export interface ExtensionInstallResult {
  ok: boolean
  error?: string
  warnings?: string[]
  info?: ExtensionInfo
}

// Событие клика по кнопке расширения: shell -> main -> shim расширения.
export interface ExtensionActionClick {
  id: string
  anchor: { x: number; y: number }
}

// Событие обновления состояния для shell: тот же список, что у страницы.
export type ExtensionsPush = ExtensionsState

// Вкладка в терминах chrome.tabs.Tab (используется шимом совместимости).
export interface ChromeTabLike {
  id: number
  index: number
  windowId: number
  url: string
  title: string
  active: boolean
  pinned: boolean
  incognito: boolean
  // Издаёт ли вкладка звук прямо сейчас. Расширения проверяют это поле
  // перед работой со звуком (AHA Music — перед поиском музыки), поэтому
  // оно должно отражать реальность, а не отсутствовать.
  audible: boolean
}
