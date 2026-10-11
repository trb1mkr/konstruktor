// Приведение чужого манифеста к тому, что реально исполняет Chromium 152.
//
// Причина обязательности: контент-скрипты Manifest V2 удалены из Chromium,
// поэтому расширение с `manifest_version: 2` грузится, но не инжектится
// (проверено пробником фазы 0). Лечится переводом манифеста в MV3;
// фон при этом переезжает на сгенерированный service worker, который
// через importScripts поднимает легаси-скрипты расширения.
//
// Ни одна деградация не проходит молча: всё, что нельзя перевести,
// вырезается и попадает в warnings — их показывает страница расширений.

export const SW_BOOT_FILE = 'konstruktor-sw-boot.js'
export const CS_SHIM_FILE = 'konstruktor-cs-shim.js'

export interface RewriteOutcome {
  manifest: Record<string, unknown>
  warnings: string[]
  // Скрипты фона в порядке подъёма (legacy-цепочка).
  backgroundScripts: string[]
  // Фон объявлен модулем: importScripts к нему неприменим, нужен import().
  backgroundModule: boolean
  // В расширении есть контент-скрипты: им подставляется шим.
  hasContentScripts: boolean
  // Секция commands как есть: сочетания обслуживает свой перехватчик.
  manifestCommands: Record<string, unknown>
}

const HOST_PATTERN = /^(\*|https?|file|ftp|\*:\/\/)/i

function isHostPattern(value: string): boolean {
  return value === '<all_urls>' || HOST_PATTERN.test(value)
}

function asArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

// Ключи, которые Chromium 152 в MV3 не исполняет, а Electron не поддерживает.
// Значение — текст предупреждения с последствием для пользователя.
//
// `commands` и `update_url` здесь НЕТ намеренно: клавиатурные команды
// обслуживает свой перехватчик (commands.ts), а автообновление — updater.ts.
const DROP_WITH_WARNING: Record<string, string> = {
  omnibox: 'omnibox (адресная строка) не поддерживается: значок расширения в строке не появится',
  chrome_url_overrides: 'подмена внутренних страниц недоступна',
  externally_connectable: 'связь с внешними приложениями отключена',
  tts: 'синтез речи недоступен',
  tts_engine: 'движок синтеза речи недоступен'
}

const DROP_SILENT = new Set(['browser_specific_settings', 'applications', 'nacl_modules'])

// Приведение списка web_accessible_resources из формы MV2 (массив строк)
// к форме MV3. Точность важна: открывать ресурсы всем сайтам без нужды
// нельзя — это дыра. Берыём matches контент-скриптов, затем хосты
// расширения, и только если ничего не осталось — сообщаем о расширении.
function normalizeWebAccessibleResources(
  value: unknown,
  matches: string[],
  warnings: string[]
): unknown {
  if (!Array.isArray(value)) return value
  if (!value.every((v) => typeof v === 'string')) return value
  const resources = value as string[]
  if (matches.length > 0) {
    return [{ resources, matches }]
  }
  warnings.push('web_accessible_resources открыт всем сайтам: у расширения нет списка хостов')
  return [{ resources, matches: ['<all_urls>'] }]
}

export function rewriteManifest(raw: Record<string, unknown>): RewriteOutcome {
  const warnings: string[] = []
  const srcVersion = typeof raw.manifest_version === 'number' ? raw.manifest_version : 2
  const manifest: Record<string, unknown> = { ...raw }

  if (srcVersion !== 3) {
    warnings.push(
      'расширение объявлено для Manifest V2: манифест переведён на V3, контент-скрипты и фон продолжат работать'
    )
  }

  // Разрешения: хосты отделяются от имён API. Фильтр по обеим формам:
  // в MV2 хосты лежали в permissions, в MV3 — в host_permissions.
  const legacyPermissions = asArray(raw.permissions)
  const legacyOptional = asArray(raw.optional_permissions)
  const hosts = [
    ...legacyPermissions.filter(isHostPattern),
    ...asArray(raw.host_permissions),
    ...asArray(raw.optional_host_permissions)
  ]
  const apis = [
    ...legacyPermissions.filter((p) => !isHostPattern(p)),
    ...legacyOptional.filter((p) => !isHostPattern(p))
  ]
  const uniqueApis = [...new Set(apis)]
  const uniqueHosts = [...new Set(hosts)]
  if (uniqueApis.length > 0) manifest.permissions = uniqueApis
  else delete manifest.permissions
  if (uniqueHosts.length > 0) manifest.host_permissions = uniqueHosts
  else delete manifest.host_permissions
  delete manifest.optional_permissions
  delete manifest.optional_host_permissions

  if (uniqueApis.includes('webRequestBlocking')) {
    warnings.push(
      'webRequestBlocking передан в режиме наблюдения: блокирующая модификация запросов недоступна'
    )
  }

  // Фон: MV2 scripts/page -> service worker конструктора.
  const bgRaw = asRecord(raw.background)
  const backgroundScripts = [
    ...asArray(bgRaw.scripts),
    ...(typeof bgRaw.page === 'string' ? [bgRaw.page] : []),
    ...(typeof bgRaw.service_worker === 'string' ? [bgRaw.service_worker] : [])
  ]
  const backgroundModule = bgRaw.type === 'module'
  const hasBackground = backgroundScripts.length > 0

  if (hasBackground) {
    // type: 'module' переносим в переписанный манифест: без него Chromium
    // грузит загрузчик как классический воркер, а тот подключает скрипты
    // расширения статическими import'ами.
    manifest.background = backgroundModule
      ? { service_worker: SW_BOOT_FILE, type: 'module' }
      : { service_worker: SW_BOOT_FILE }
    if (bgRaw.persistent === true && srcVersion === 2) {
      warnings.push('постоянный фон переведён на service worker: время жизни управляет Chromium')
    }
  } else {
    if (Object.keys(bgRaw).length > 0) {
      warnings.push('фон без скриптов пропущен')
    }
    delete manifest.background
  }

  // browser_action/page_action -> action (в MV3 это единая поверхность).
  const legacyAction = asRecord(raw.browser_action)
  const pageAction = asRecord(raw.page_action)
  const action = { ...pageAction, ...legacyAction, ...asRecord(raw.action) }
  if (Object.keys(action).length > 0) manifest.action = action
  delete manifest.browser_action
  delete manifest.page_action
  if (Object.keys(pageAction).length > 0) {
    warnings.push('page_action объединён с action: отдельной кнопки в панели нет')
  }

  // Контент-скрипты: шим встаёт первым в каждом блоке js.
  const contentScripts = Array.isArray(raw.content_scripts) ? raw.content_scripts : []
  for (const block of contentScripts) {
    const rec = asRecord(block)
    const js = asArray(rec.js)
    if (js.length === 0 || !Array.isArray(rec.js)) {
      warnings.push('контент-скрипт без js пропущен')
      continue
    }
    rec.js = [CS_SHIM_FILE, ...js]
  }
  if (contentScripts.length > 0) manifest.content_scripts = contentScripts

  // Политика безопасности: в MV3 это объект, а не строка.
  if (typeof raw.content_security_policy === 'string') {
    manifest.content_security_policy = { extension_pages: raw.content_security_policy }
  }

  if (raw.web_accessible_resources !== undefined) {
    manifest.web_accessible_resources = normalizeWebAccessibleResources(
      raw.web_accessible_resources,
      uniqueHosts,
      warnings
    )
  }

  // Клавиатурные команды остаются в манифесте: их читает свой перехватчик
  // (commands.ts) и шим chrome.commands. Chromium MV3 их не исполняет,
  // но и не падает от их наличия.
  const commands = asRecord(raw.commands)
  if (Object.keys(commands).length > 0) manifest.commands = commands

  // update_url в записанный манифест НЕ попадает: Chromium считает его
  // служебным для веб-магазина. Адрес вытаскивается в запись реестра
  // при установке и используется своим updater.ts.
  delete manifest.update_url

  for (const [key, message] of Object.entries(DROP_WITH_WARNING)) {
    if (key in manifest) {
      delete manifest[key]
      warnings.push(message)
    }
  }
  for (const key of DROP_SILENT) delete manifest[key]

  manifest.manifest_version = 3
  if (typeof manifest.name !== 'string') manifest.name = 'Unnamed extension'
  if (typeof manifest.version !== 'string') manifest.version = '1.0.0'

  return {
    manifest,
    warnings,
    backgroundScripts,
    backgroundModule,
    hasContentScripts: contentScripts.length > 0,
    manifestCommands: commands
  }
}
