// Таблица разрешений веб-страниц: что спрашивать, что решать сразу.
//
// Модуль чистый — без Electron и без i18n, — поэтому его можно проверить
// без запуска приложения, и он не тянет за собой оконный код. Таблица
// здесь единственный источник правды: и промпт, и страница настроек, и
// проверка решения читают её.
//
// Раскладка повторяет модель Chromium: разрешение `media` приходит ДВУМЯ
// областями (звук и видео), и решение по ним запоминается раздельно, как
// в Chrome — «разрешил микрофон, но не камеру» обязано работать.

/** Решение пользователя по одному разрешению для одного origin. */
export type Decision = 'allow' | 'block'

/**
 * Область решения: то, что запоминается для сайта в permissions.json.
 *
 * Состав плоский и совпадает с тем, что видит пользователь в промпте, —
 * одно разрешение Chromium может дать одну или две области (media).
 */
export type PermissionScope =
  | 'media:audio'
  | 'media:video'
  | 'geolocation'
  | 'notifications'
  | 'clipboard-read'
  | 'display-capture'
  | 'midi'
  | 'midiSysex'
  | 'speaker-selection'
  | 'window-management'
  | 'idle-detection'
  | 'local-fonts'
  | 'sensors'

/** Все области — порядок задаёт и промпт, и список в настройках. */
export const ALL_SCOPES: PermissionScope[] = [
  'media:audio',
  'media:video',
  'display-capture',
  'geolocation',
  'notifications',
  'clipboard-read',
  'midi',
  'midiSysex',
  'speaker-selection',
  'window-management',
  'idle-detection',
  'local-fonts',
  'sensors',
]

/**
 * Ключ перевода подписи области.
 *
 * Иконка и подпись нужны в двух местах (промпт и настройки), поэтому
 * лежат рядом с областью, а не в вызывающем коде.
 */
export const SCOPE_LABEL = {
  'media:audio': 'permissions.scope.microphone',
  'media:video': 'permissions.scope.camera',
  'display-capture': 'permissions.scope.screen',
  geolocation: 'permissions.scope.geolocation',
  notifications: 'permissions.scope.notifications',
  'clipboard-read': 'permissions.scope.clipboard',
  midi: 'permissions.scope.midi',
  midiSysex: 'permissions.scope.midiSysex',
  'speaker-selection': 'permissions.scope.speaker',
  'window-management': 'permissions.scope.screens',
  'idle-detection': 'permissions.scope.idle',
  'local-fonts': 'permissions.scope.fonts',
  sensors: 'permissions.scope.sensors',
} as const satisfies Record<PermissionScope, string>

/** Иконка области. Эмодзи — кроссплатформенные, Emoji 1.0 с VS16. */
export const SCOPE_ICON: Record<PermissionScope, string> = {
  'media:audio': '🎤',
  'media:video': '📷',
  'display-capture': '🖥️',
  geolocation: '📍',
  notifications: '🔔',
  'clipboard-read': '📋',
  midi: '🎹',
  midiSysex: '🎹',
  'speaker-selection': '🔊',
  'window-management': '📺',
  'idle-detection': '⏳',
  'local-fonts': '🔤',
  sensors: '📡',
}

/** Результат разбора запроса Chromium. */
export interface Classified {
  /**
   * Области, по которым нужно сверить решение или спросить. Пусто, если
   * решение уже принято таблицей (auto).
   */
  scopes: PermissionScope[]
  /** Готовое решение без промпта; null — спрашивать пользователя. */
  auto: Decision | null
}

// Разрешения без вопроса: у них нет пользовательского риска, а промпт
// на каждое означал бы шум (полноэкранный режим, захват указателя, DRM).
const AUTO_ALLOW = new Set([
  'fullscreen',
  'automatic-fullscreen',
  'pointerLock',
  'keyboardLock',
  'clipboard-sanitized-write',
  'mediaKeySystem',
  'persistent-storage',
  'screen-wake-lock',
  'system-wake-lock',
  'captured-surface-control',
  // display-capture: согласие спрашивает обработчик getDisplayMedia
  // (setDisplayMediaRequestHandler), а не промпт разрешения — иначе
  // пользователь получил бы два диалога на одно действие.
  'display-capture',
])

// Простые области: одно разрешение Chromium — одна область решения.
const SIMPLE: Record<string, PermissionScope> = {
  geolocation: 'geolocation',
  'geolocation-approximate': 'geolocation',
  notifications: 'notifications',
  'clipboard-read': 'clipboard-read',
  midi: 'midi',
  midiSysex: 'midiSysex',
  'speaker-selection': 'speaker-selection',
  'window-management': 'window-management',
  'idle-detection': 'idle-detection',
  'local-fonts': 'local-fonts',
  sensors: 'sensors',
}

/**
 * Разбирает запрос Chromium в области решения.
 *
 * Что не перечислено — запрещено по умолчанию: устройства (usb/hid/serial),
 * выход во внешние приложения, сторонние cookies, NFC, WebXR, печать,
 * установка приложений и всё неизвестное. Молчаливое разрешение здесь
 * было бы опаснее отказа: отказ виден странице и объясним.
 *
 * @param permission строка разрешения из Electron.
 * @param mediaTypes типы медиа: для запроса это `details.mediaTypes`,
 *   для проверки — единственный `details.mediaType`. Пусто = любые медиа.
 */
export function classify(permission: string, mediaTypes: string[] = []): Classified {
  if (AUTO_ALLOW.has(permission)) return { scopes: [], auto: 'allow' }
  if (permission === 'media') {
    // Пустой список — запрос «любые медиа»: спрашиваем про оба типа, иначе
    // решение по камере не запомнилось бы, и промпт возвращался бы.
    const any = mediaTypes.length === 0
    const scopes: PermissionScope[] = []
    if (any || mediaTypes.includes('audio')) scopes.push('media:audio')
    if (any || mediaTypes.includes('video')) scopes.push('media:video')
    return { scopes, auto: null }
  }
  const simple = SIMPLE[permission]
  if (simple) return { scopes: [simple], auto: null }
  return { scopes: [], auto: 'block' }
}

/**
 * origin из URL, либо пустая строка, если строку нельзя разобрать.
 *
 * Своя функция, а не new URL на месте: вызывается и из обработчиков
 * разрешений, и при сборке бейджа вкладки, и падать на `about:blank` не
 * должна нигде.
 */
export function originOfUrl(url: string | undefined): string {
  if (!url) return ''
  try {
    const parsed = new URL(url)
    return parsed.origin === 'null' ? '' : parsed.origin
  } catch {
    return ''
  }
}

/**
 * Ссылается ли запрос на внутренние страницы браузера.
 *
 * `konstruktor://` — свои страницы (настройки, история, старт): они не
 * сайты, и разрешения им не выдаются. Проверка отдельная, а не через
 * таблицу, потому что origin приходит в разных формах.
 */
export function isInternalOrigin(origin: string): boolean {
  return /^konstruktor:/i.test(origin)
}

/**
 * Ссылается ли запрос на страницу расширения.
 *
 * Решение пользователя (п. 4 приёмки): расширения получают медиа и прочее
 * без промпта. Схема — единственный признак: реестра расширений в этом
 * модуле нет, и зависимость от него тянула бы сюда систему расширений.
 */
export function isExtensionOrigin(origin: string): boolean {
  return /^(chrome-extension|moz-extension):/i.test(origin)
}
