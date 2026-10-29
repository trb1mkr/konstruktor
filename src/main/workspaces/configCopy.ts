// Копирование секций конфигурации между рабочими пространствами.
//
// Дублирование пространства — это НЕ копирование каталога. Cookies, кэш и
// партиция принадлежат машине, история и загрузки — данные, а не настройки,
// а слепок окон описывает момент. Копируются только секции конфигурации, и
// списком: страница пространств даёт выбрать, что переносить.
//
// Набор секций — он же набор единиц будущей синхронизации (см.
// WORKSPACES.md), поэтому список живёт отдельным модулем, а не в IPC.
import { readFileSync } from 'fs'
import { writeJsonAtomicSync } from './atomic'
import { workspaceFile } from './paths'
import { copyExtensions } from '../extensions/copy'

export const CONFIG_SECTIONS = [
  'settings',
  'bookmarks',
  'groups',
  'shortcuts',
  'permissions',
  // Расширения копируются вместе с файлами: реестр без каталогов
  // бесполезен (см. extensions/copy.ts).
  'extensions'
] as const

export type ConfigSection = (typeof CONFIG_SECTIONS)[number]

// Файл секции. У расширений его нет: там реестр ПЛЮС каталоги с файлами,
// и одной атомарной записью JSON дело не ограничивается — см. copyExtensions.
const SECTION_FILE: Record<Exclude<ConfigSection, 'extensions'>, string> = {
  settings: 'settings.json',
  bookmarks: 'bookmarks.json',
  groups: 'groups.json',
  shortcuts: 'shortcuts.json',
  permissions: 'permissions.json'
}

/**
 * Поля `settings.json`, которые описывают МАШИНУ и МОМЕНТ, а не настройку.
 *
 * Геометрия окна и список вкладок — состояние пространства-источника: в
 * копии они открыли бы окно в чужом месте и с чужими вкладками. DNS живёт в
 * общем settings-global.json; в старых файлах он ещё встречается, и
 * копировать его в пространство нельзя.
 *
 * Языка здесь НЕТ: с этапа 8 это настройка пространства, и копия настроек
 * обязана приехать на языке источника — иначе «дублировать пространство»
 * давало бы копию с чужим интерфейсом.
 */
const SETTINGS_VOLATILE = ['windowBounds', 'windowMaximized', 'sessionTabs', 'dnsMode', 'dnsCustom']

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as unknown
  } catch {
    return null
  }
}

/**
 * Копирует выбранные секции из одного пространства в другое.
 *
 * `requested` — какие секции нужны. `undefined` — все: так работает
 * дублирование. Пустой массив — пустое пространство.
 *
 * Возвращает РЕАЛЬНО скопированные секции: файла могло не быть (например,
 * пользователь ни разу не открывал историю групп), и обещать копирование
 * несуществующего нельзя — страница показывает это пользователю.
 */
export async function copyWorkspaceSections(
  fromId: string,
  toId: string,
  requested?: readonly string[]
): Promise<ConfigSection[]> {
  if (fromId === toId) return []
  const wanted = CONFIG_SECTIONS.filter((s) => requested === undefined || requested.includes(s))
  const copied: ConfigSection[] = []
  for (const section of wanted) {
    // Расширения копируются отдельно: у секции есть каталоги с файлами и
    // абсолютные пути в реестре, которые нужно переписать.
    if (section === 'extensions') {
      const count = await copyExtensions(fromId, toId)
      if (count > 0) copied.push('extensions')
      continue
    }
    const file = SECTION_FILE[section]
    const data = readJson(workspaceFile(fromId, file))
    if (data === null) continue
    if (section === 'settings' && data && typeof data === 'object' && !Array.isArray(data)) {
      for (const key of SETTINGS_VOLATILE) delete (data as Record<string, unknown>)[key]
    }
    try {
      writeJsonAtomicSync(workspaceFile(toId, file), data)
      copied.push(section)
    } catch {
      // Диск или права: остальные секции всё равно копируем.
    }
  }
  return copied
}
