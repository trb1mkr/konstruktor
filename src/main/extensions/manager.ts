// Ядро системы расширений: установка, реестр, загрузка в сессию, состояние.
//
// Разделение обязанностей: crx.ts разбирает контейнер, manifestRewrite.ts
// приводит манифест к MV3, compatShim.ts генерирует шимы, bridge.ts даёт
// канал в main, а здесь — жизненный цикл и единая точка правды для UI.
//
// Ключевой инвариант: расширения живут только в persistent-сессии
// (in-memory бросает ошибку), поэтому инкогнито-окна их не видят.
import { session, dialog, app, nativeImage } from 'electron'
import { createHash } from 'crypto'
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat as fsStat,
  unlink,
  writeFile
} from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { basename, extname, join, resolve } from 'path'
import type {
  ExtensionActionInfo,
  ExtensionInfo,
  ExtensionInstallResult,
  ExtensionsMenuModel,
  ExtensionsState
} from '../../shared/extensions-types'
import { windows } from '../windows/browserState'
import { getSettingsSync } from '../store/settingsStore'
import { workspaceExtensionsDir } from '../workspaces/paths'
import { bootWorkspaceId, partitionFor } from '../workspaces/registry'
import {
  chromeIdFromCrxId,
  chromeIdFromKey,
  extractZipPayload,
  isCrxBuffer,
  localizeManifest,
  manifestFromCrx,
  parseCrx,
  readManifestFile,
  writeManifestFile
} from './crx'
import { CS_SHIM_FILE, rewriteManifest } from './manifestRewrite'
import { contentShimSource, shimSource, swBootFileName, swBootSource, swShimFileName } from './compatShim'
import { openActionPopup, popupPageExists } from './popup'
import { log, logError } from '../overlay/logger'
import { clearExtensionCommands, setExtensionCommands } from './commands'
import { scheduleUpdateCheck } from './updater'
import {
  actionPopupPage,
  actionState,
  bridgePort,
  bridgeToken,
  extensionActionStates,
  fireActionClick,
  setActionChangeListener,
  startBridge
} from './bridge'
import {
  findExtensionRecord,
  getExtensionsSync,
  loadExtensions,
  removeExtensionRecord,
  resetExtensionsCache,
  upsertExtension,
  type ExtensionRecord
} from './extensionStore'
import { tFor } from '../i18n'

// --- Карта установки: где лежат расширения пользователя ----------------

/**
 * Каталог расширений рабочего пространства.
 *
 * Расширения принадлежат пространству: у каждого свой реестр и свои
 * файлы. Партиция тоже своя, иначе одно и то же расширение грузилось бы
 * в общую сессию и видело cookies чужих пространств.
 */
export function extensionsRoot(wsId = bootWorkspaceId()): string {
  return workspaceExtensionsDir(wsId)
}

function installDirFor(id: string, wsId = bootWorkspaceId()): string {
  return join(extensionsRoot(wsId), id)
}

// Путь источника в каноническом виде — основа идентификатора расширения,
// установленного из папки (у .crx идентификатор берётся из заголовка).
// Без нормализации одна и та же папка, указанная по-разному, давала разные
// id и вторую копию расширения в списке: «ext/demo» и
// «D:\repo\ext\demo» — это два разных хеша.
// Регистр не трогаем: он часть ключа, и его смена переименовала бы id уже
// установленных расширений (то есть снова дала бы вторую копию в списке).
function normalizeSource(path: string): string {
  return resolve(path)
}

// Отпечаток файлов расширения: имена + размеры + время правки.
//
// Зачем: Chromium кэширует версию service worker'а ВМЕСТЕ с картой его
// модулей, поэтому правка фонового скрипта расширения (обновление с диска,
// новая версия из магазина) без смены URL загрузчика не применяется —
// замерено пробником. Служебные файлы в отпечаток не входят: их имена
// сами зависят от отпечатка, иначе получился бы цикл.
//
// manifest.json тоже исключён, и это не мелочь: его мы перезаписываем на
// КАЖДОМ старте (указатель на загрузчик), поэтому его время правки менялось
// бы каждый запуск, отпечаток и имя загрузчика — вместе с ним, а Chromium
// на следующем старте восстанавливал бы регистрацию на только что
// удалённый файл: воркер падал (DidStartWorkerFail) и расширение
// исполнялось в урезанном контексте без chrome.runtime. Проверено: имя
// загрузчика менялось между двумя запусками без единой правки кода.
async function sourceStamp(dir: string): Promise<string> {
  const parts: string[] = []
  const walk = async (rel: string): Promise<void> => {
    try {
      const entries = await readdir(join(dir, rel), { withFileTypes: true })
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('konstruktor-') || entry.name === 'manifest.json') continue
        const child = rel ? rel + '/' + entry.name : entry.name
        if (entry.isDirectory()) {
          await walk(child)
          continue
        }
        try {
          const info = await fsStat(join(dir, child))
          parts.push(child + ':' + info.size + ':' + Math.floor(info.mtimeMs))
        } catch {
          parts.push(child + ':missing')
        }
      }
    } catch {
      return
    }
  }
  await walk('')
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16)
}

// Служебные файлы расширения: контентный шим и загрузчик service worker'а.
// У классического фона шим вшит в загрузчик; у модульного — лежит рядом
// отдельным файлом (module-скрипт нельзя подключить importScripts'ом).
// Имена служебных файлов меняются вместе с шимом и с файлами расширения,
// поэтому в каталоге остаются файлы прошлых версий — их удаляем, чтобы
// не копить мусор в userData.
async function writeShimFiles(rec: ExtensionRecord): Promise<void> {
  const shim = shimSource({ port: bridgePort(), token: bridgeToken() })
  const stamp = await sourceStamp(rec.dir)
  const bootName = swBootFileName(shim, stamp)
  const shimName = swShimFileName(shim)
  const hasBackground = (rec.backgroundScripts ?? []).length > 0
  const isModule = rec.backgroundModule === true
  await writeFile(join(rec.dir, CS_SHIM_FILE), contentShimSource(), 'utf8')
  if (hasBackground) {
    if (isModule) await writeFile(join(rec.dir, shimName), shim, 'utf8')
    await writeFile(
      join(rec.dir, bootName),
      swBootSource(shim, rec.backgroundScripts ?? [], isModule, stamp),
      'utf8'
    )
  }
  await removeStaleServiceFiles(rec.dir, [bootName, shimName])
  await pointManifestAtBoot(rec.dir, bootName, hasBackground, isModule)
}

// Чистка служебных файлов прошлых версий и старого подключаемого шима.
async function removeStaleServiceFiles(dir: string, keep: string[]): Promise<void> {
  try {
    const names = await readdir(dir)
    for (const name of names) {
      const isService = /^konstruktor-(sw-boot|sw-shim).*\.js$/.test(name)
      const isLegacy = name === 'konstruktor-sw-boot.js' || name === 'konstruktor-shim.js'
      if (isLegacy || (isService && !keep.includes(name))) {
        await unlink(join(dir, name)).catch(() => undefined)
      }
    }
  } catch {
    // Каталога нет — чистить нечего.
  }
}

// Манифест ссылается на загрузчик с актуальным именем файла:
// без обновления Chromium считал бы, что у расширения старый воркер.
async function pointManifestAtBoot(
  dir: string,
  bootName: string,
  hasBackground: boolean,
  isModule: boolean
): Promise<void> {
  const file = join(dir, 'manifest.json')
  try {
    const manifest = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    if (hasBackground) {
      manifest.background = isModule
        ? { service_worker: bootName, type: 'module' }
        : { service_worker: bootName }
    } else delete manifest.background
    await writeFile(file, JSON.stringify(manifest, null, 2), 'utf8')
  } catch {
    // Манифеста нет — загрузка расширения всё равно упадёт с понятной ошибкой.
  }
}

function iconDataUrl(dir: string, value: unknown): string {
  const rel =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object'
        ? (Object.values(value as Record<string, unknown>).find((v) => typeof v === 'string') as
            | string
            | undefined)
        : undefined
  if (!rel) return ''
  const path = join(dir, rel.replace(/^\//, ''))
  if (!existsSync(path)) return ''
  try {
    const ext = extname(path).slice(1).toLowerCase()
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'svg' ? 'image/svg+xml' : 'image/png'
    const image = nativeImage.createFromPath(path)
    if (image.isEmpty()) return ''
    // Кнопка на панели мелкая: ужимаем до 32px, чтобы data URL не раздувался.
    const resized = image.resize({ width: 32, height: 32 })
    return 'data:' + mime + ';base64,' + resized.toPNG().toString('base64')
  } catch {
    return ''
  }
}

// --- Состояние кнопок расширения для shell ------------------------------

// Сведения о кнопке расширения для shell, меню и страницы расширений.
//
// Живое состояние (что расширение задало вызовами action.*) есть только
// у загруженного в сессию расширения: выключение снимает запись из Map
// (см. disableExtension). Поэтому привязки к electronId быть не должно —
// значок и подпись из манифеста лежат в реестре (actionSeed) и остаются
// на месте у выключенного расширения. Пока проверка требовала electronId,
// у выключенного расширения info.action становился null, и страница
// расширений показывала вместо значка первую букву имени.
function actionInfoFor(rec: ExtensionRecord): ExtensionActionInfo | null {
  const seed = rec.actionSeed
  const liveId = rec.electronId
  // Отличаем «состояние задано» от «состояния нет»: actionState() на
  // незарегистрированный id отдаёт пустую заготовку, и по ней одной
  // нельзя понять, работает кнопка или нет.
  const hasLive = !!liveId && extensionActionStates().has(liveId)
  if (!seed && !hasLive) return null
  const live = hasLive && liveId ? actionState(liveId) : null
  return {
    id: rec.id,
    title: live?.title || seed?.title || rec.name,
    badge: live?.badge ?? '',
    badgeColor: live?.badgeColor || seed?.badgeColor || '',
    icon: live?.icon || seed?.icon || '',
    hasPopup: !!(live?.popup || seed?.popup)
  }
}

function toInfo(rec: ExtensionRecord): ExtensionInfo {
  return {
    id: rec.id,
    electronId: rec.electronId ?? '',
    name: rec.name,
    version: rec.version,
    description: rec.description,
    dir: rec.dir,
    enabled: rec.enabled,
    pinned: rec.pinned === true,
    source: rec.source,
    permissions: rec.permissions,
    hosts: rec.hosts,
    warnings: rec.warnings,
    installedAt: rec.installedAt,
    manifestVersion: rec.manifestVersion,
    hasBackground: (rec.backgroundScripts ?? []).length > 0,
    contentScriptCount: rec.contentScriptCount ?? 0,
    native: rec.native,
    capabilities: rec.capabilities ?? [],
    action: actionInfoFor(rec),
    error: rec.error ?? ''
  }
}

export function extensionsState(wsId = bootWorkspaceId()): ExtensionsState {
  const settings = getSettingsSync(wsId)
  return {
    list: getExtensionsSync(wsId).map(toInfo),
    enabled: settings.extensionsEnabled !== false,
    devMode: settings.extensionsDevMode === true
  }
}

// Пуш состояния во все окна пространства: shell (кнопки) и открытую
// страницу расширений. Чужим окнам состояние не нужно: у них свой реестр.
export function pushExtensionsState(wsId = bootWorkspaceId()): void {
  const payload = extensionsState(wsId)
  for (const ws of windows.values()) {
    if (ws.workspaceId !== wsId) continue
    ws.window?.webContents.send('extensions:state', payload)
  }
}

// --- Загрузка в сессию ---------------------------------------------------

function extensionSession(wsId = bootWorkspaceId()): Electron.Session {
  return session.fromPartition(partitionFor(wsId))
}

async function loadRecord(rec: ExtensionRecord, wsId = bootWorkspaceId()): Promise<void> {
  const t = tFor(wsId)
  if (getSettingsSync(wsId).extensionsEnabled === false) {
    rec.error = t('extensions.errDisabled')
    return
  }
  // Реестр и каталог расширения живут раздельно, и они могут разойтись:
  // каталог удалили руками, антивирус или чистящая утилита. Без этой
  // проверки запись каждый старт валилась бы ENOENT на первом же файле
  // шима, а причина в UI выглядела бы загадочно.
  if (!existsSync(join(rec.dir, 'manifest.json'))) {
    // Регистрацию снимаем и здесь: иначе Chromium продолжит будить воркер
    // удалённого расширения, и в лог каждый старт сыпались бы его ошибки
    // (замерено: после удаления каталога пробника воркер ещё жил и падал).
    if (rec.electronId) {
      try {
        extensionSession(wsId).extensions.removeExtension(rec.electronId)
      } catch {
        // Регистрации нет — цель достигнута.
      }
    }
    clearExtensionCommands(rec.id)
    rec.electronId = ''
    rec.error = t('extensions.errMissing')
    return
  }
  try {
    await writeShimFiles(rec)
    // Прошлая регистрация снимается явно: Chromium держит её в партиции
    // между запусками, и без снятия может поднять старую версию воркера
    // со ссылками на файлы, которых уже нет.
    if (rec.electronId) {
      try {
        extensionSession(wsId).extensions.removeExtension(rec.electronId)
      } catch {
        // Регистрации нет — цель достигнута.
      }
    }
    const ext = await extensionSession(wsId).extensions.loadExtension(rec.dir)
    rec.electronId = ext.id
    rec.error = ''
    // Команды ставятся ПОСЛЕ успешной загрузки: сочетание без живущего
    // фона ничего не сделает, а перехватывать ввод оно уже начнёт.
    setExtensionCommands(rec)
  } catch (e) {
    rec.electronId = ''
    clearExtensionCommands(rec.id)
    rec.error = String((e as Error)?.message ?? e)
  }
}

async function unloadRecord(rec: ExtensionRecord, wsId = bootWorkspaceId()): Promise<void> {
  if (!rec.electronId) return
  try {
    extensionSession(wsId).extensions.removeExtension(rec.electronId)
  } catch {
    // Расширение уже выгружено — цель достигнута.
  }
  clearExtensionCommands(rec.id)
  rec.electronId = ''
}

// --- Установка ----------------------------------------------------------

interface InstallPlan {
  raw: Record<string, unknown>
  key: Buffer | null
  // Готовый идентификатор из заголовка CRX3: не зависит от пути установки.
  crxId: Buffer | null
  extract: (targetDir: string) => Promise<number>
  source: ExtensionRecord['source']
  dirHint: string
}

async function applyPlan(plan: InstallPlan): Promise<ExtensionInstallResult> {
  const outcome = rewriteManifest(plan.raw)
  // Своя экосистема: секция konstruktor в манифесте. Возможности
  // проверяются мостом на каждом вызове, а не только на установке.
  const nativeSection = plan.raw.konstruktor
  const native = !!nativeSection && typeof nativeSection === 'object'
  const capabilities =
    native && Array.isArray((nativeSection as Record<string, unknown>).capabilities)
      ? ((nativeSection as Record<string, unknown>).capabilities as unknown[]).filter(
          (c): c is string => typeof c === 'string'
        )
      : []
  const declaredKey = typeof plan.raw.key === 'string' ? plan.raw.key : ''
  const keyBuffer =
    plan.key ??
    (declaredKey ? Buffer.from(declaredKey, 'base64') : Buffer.from(plan.dirHint, 'utf8'))
  // Приоритет источников идентификатора: crx_id из заголовка (тот же, что
  // в Chrome) -> публичный ключ CRX2 -> путь установки. От пути считается
  // только распакованная папка без ключа, поэтому её id нестабилен между
  // машинами — это осознанно, своей сборки ключ мы не знаем.
  const id = plan.crxId ? chromeIdFromCrxId(plan.crxId) : chromeIdFromKey(keyBuffer)
  const dir = installDirFor(id)

  await mkdir(extensionsRoot(), { recursive: true })
  await rm(dir, { recursive: true, force: true })
  await plan.extract(dir)
  if (!existsSync(join(dir, 'manifest.json'))) {
    throw new Error('manifest.json not found after extraction')
  }

  // Метаданные разворачиваются после распаковки: каталог _locales лежит
  // внутри расширения, а до установки читать его неоткуда.
  const manifest = localizeManifest(outcome.manifest, dir)
  writeManifestFile(dir, manifest)

  const record: ExtensionRecord = {
    id,
    electronId: '',
    name: String(manifest.name ?? basename(plan.dirHint)),
    version: String(manifest.version ?? '1.0.0'),
    description: String(manifest.description ?? ''),
    dir,
    enabled: true,
    source: plan.source,
    permissions: Array.isArray(manifest.permissions) ? (manifest.permissions as string[]) : [],
    hosts: Array.isArray(manifest.host_permissions)
      ? (manifest.host_permissions as string[])
      : [],
    warnings: [...outcome.warnings],
    installedAt: Date.now(),
    manifestVersion: 3,
    native,
    capabilities,
    backgroundScripts: outcome.backgroundScripts,
    backgroundModule: outcome.backgroundModule,
    contentScriptCount: Array.isArray(manifest.content_scripts)
      ? manifest.content_scripts.length
      : 0,
    actionSeed: seedAction(manifest, dir),
    manifestCommands: outcome.manifestCommands,
    updateUrl: typeof plan.raw.update_url === 'string' ? plan.raw.update_url : undefined,
    error: ''
  }

  if (native) {
    record.warnings.push(
      'собственное расширение конструктора: секция konstruktor с возможностями ' +
        (capabilities.join(', ') || 'нет')
    )
  }

  // Расширения без MV3-совместимого фона и без контент-скриптов ничего
  // не делают: предупреждаем сразу, а не молча.
  if (outcome.backgroundScripts.length === 0 && record.contentScriptCount === 0) {
    record.warnings.push('у расширения нет ни фона, ни контент-скриптов: работать нечему')
  }

  // Блокировка запросов: API declarativeNetRequest в этом Electron есть,
  // но статические наборы правил (rule_resources) не загружаются — замер
  // пробником: объявленный и включённый набор отсутствует в
  // getEnabledRulesets(), testMatchOutcome не находит совпадений.
  // Динамические правила при этом работают (запрос не доходит до сети),
  // поэтому формулировка про наборы, а не про API целиком. Без
  // предупреждения блокировщик выглядел бы исправным, молча ничего не блокируя.
  if (declaresRequestBlocking(manifest)) {
    record.warnings.push(
      'наборы правил блокировки (declarativeNetRequest) не загружаются: блокировка не работает'
    )
  }

  await upsertExtension(record)
  await loadRecord(record)
  await upsertExtension(record)
  pushExtensionsState()
  return { ok: true, warnings: record.warnings, info: toInfo(record) }
}

// Объявляет ли расширение блокировку запросов: статические наборы правил
// (rule_resources), само разрешение declarativeNetRequest или старый
// webRequestBlocking из MV2.
function declaresRequestBlocking(manifest: Record<string, unknown>): boolean {
  if (manifest.declarative_net_request !== undefined) return true
  const perms = Array.isArray(manifest.permissions) ? (manifest.permissions as unknown[]) : []
  return perms.some(
    (p) => p === 'declarativeNetRequest' || p === 'declarativeNetRequestWithHostAccess'
  )
}

interface ActionSeed {
  title: string
  badgeColor: string
  icon: string
  popup: string
}

function seedAction(manifest: Record<string, unknown>, dir: string): ActionSeed | undefined {  const action = manifest.action
  if (!action || typeof action !== 'object') return undefined
  const rec = action as Record<string, unknown>
  return {
    title: typeof rec.default_title === 'string' ? rec.default_title : '',
    badgeColor: '#666666',
    icon: iconDataUrl(dir, rec.default_icon),
    popup: typeof rec.default_popup === 'string' ? rec.default_popup : ''
  }
}

export async function installFromFolder(wsId?: string): Promise<ExtensionInstallResult> {
  const t = tFor(wsId)
  const picked = await dialog.showOpenDialog({
    title: t('extensions.chooseFolder'),
    properties: ['openDirectory']
  })
  if (picked.canceled || picked.filePaths.length === 0) return { ok: false, error: 'cancelled' }
  return installFromPath(picked.filePaths[0])
}

export async function installFromArchive(wsId?: string): Promise<ExtensionInstallResult> {
  const t = tFor(wsId)
  const picked = await dialog.showOpenDialog({
    title: t('extensions.chooseArchive'),
    filters: [{ name: 'Chrome extension', extensions: ['crx'] }],
    properties: ['openFile']
  })
  if (picked.canceled || picked.filePaths.length === 0) return { ok: false, error: 'cancelled' }
  return installFromPath(picked.filePaths[0])
}

// Единая точка установки: папка или .crx — различаем по содержимому файла.
export async function installFromPath(path: string): Promise<ExtensionInstallResult> {
  try {
    // Источник нормализуется ДО расчёта id: у папки без ключа он считается
    // от пути, и «ext/x» с «D:\\repo\\ext\\x» давали РАЗНЫЕ id, то есть
    // две копии одного расширения в списке. Приводим к абсолютному виду
    // и — на Windows, где регистр в путях не значим — к нижнему регистру.
    const source = normalizeSource(path)
    const info = await fsStat(source)
    if (info.isDirectory()) {
      const raw = readManifestFile(source)
      return await applyPlan({
        raw,
        key: null,
        crxId: null,
        extract: async (target) => {
          await cp(source, target, { recursive: true })
          return 0
        },
        source: 'folder',
        dirHint: source
      })
    }
    const buffer = await readFile(source)
    if (!isCrxBuffer(buffer)) {
      return { ok: false, error: 'файл не является .crx-контейнером' }
    }
    const parsed = parseCrx(buffer)
    const crxManifest = manifestFromCrx(parsed.payload)
    return await applyPlan({
      raw: crxManifest,
      key: parsed.publicKey,
      crxId: parsed.crxId,
      extract: async (target) => extractZipPayload(parsed.payload, target),
      source: 'crx',
      dirHint: source
    })
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) }
  }
}

// --- Управление ---------------------------------------------------------

export async function enableExtension(id: string): Promise<boolean> {
  const rec = findExtensionRecord(id)
  if (!rec) return false
  rec.enabled = true
  await loadRecord(rec)
  await upsertExtension(rec)
  pushExtensionsState()
  return rec.error === ''
}

export async function disableExtension(id: string): Promise<boolean> {
  const rec = findExtensionRecord(id)
  if (!rec) return false
  await unloadRecord(rec)
  rec.enabled = false
  rec.error = ''
  extensionActionStates().delete(rec.electronId ?? '')
  await upsertExtension(rec)
  pushExtensionsState()
  return true
}

export async function removeExtension(id: string): Promise<boolean> {
  const rec = findExtensionRecord(id)
  if (!rec) return false
  await unloadRecord(rec)
  await rm(rec.dir, { recursive: true, force: true })
  await removeExtensionRecord(id)
  pushExtensionsState()
  return true
}

export async function reloadExtension(id: string): Promise<boolean> {
  const rec = findExtensionRecord(id)
  if (!rec) return false
  await unloadRecord(rec)
  await loadRecord(rec)
  await upsertExtension(rec)
  pushExtensionsState()
  return rec.error === ''
}

export function extensionsMenuModel(wsId = bootWorkspaceId()): ExtensionsMenuModel {
  return {
    items: extensionsState(wsId).list.map((info) => ({
      id: info.id,
      name: info.name,
      icon: info.action?.icon ?? '',
      badge: info.action?.badge ?? '',
      badgeColor: info.action?.badgeColor ?? '',
      canPin: !!info.action,
      pinned: info.pinned,
      enabled: info.enabled,
      hasPopup: info.action?.hasPopup ?? false,
      warningCount: info.warnings.length
    })),
    enabled: getSettingsSync(wsId).extensionsEnabled !== false
  }
}

// Закрепление: только расширения с action попадают на панель.
export async function setExtensionPinned(id: string, pinned: boolean): Promise<boolean> {
  const rec = findExtensionRecord(id)
  if (!rec) return false
  rec.pinned = pinned
  await upsertExtension(rec)
  pushExtensionsState()
  return true
}

// Клик по значку расширения (панель или строка меню): попап, если он есть,
// иначе событие action.onClicked в фон.
export async function activateExtension(
  id: string,
  parent: Electron.BrowserWindow | null,
  anchor: { x: number; y: number; right: number }
): Promise<boolean> {
  const target = actionPopupPage(id)
  if (target && parent && popupPageExists(findExtensionRecord(id)?.dir ?? '', target.page)) {
    return openActionPopup({
      parent,
      electronId: target.electronId,
      extId: id,
      page: target.page,
      anchor
    })
  }
  return fireActionClick(id)
}

// --- Старт --------------------------------------------------------------

let started = false
/** Пространства, для которых расширения уже подняты. */
const startedSpaces = new Set<string>()

export async function initExtensions(wsId = bootWorkspaceId()): Promise<void> {
  if (startedSpaces.has(wsId)) return
  startedSpaces.add(wsId)
  await loadExtensions(wsId)
  if (!started) {
    // Мост loopback — один на процесс: он обслуживает расширения всех
    // пространств, а расширение различается по Origin запроса.
    await startBridge()
    setActionChangeListener(() => {
      for (const id of startedSpaces) pushExtensionsState(id)
    })
    started = true
  }
  if (getSettingsSync(wsId).extensionsEnabled === false) return
  for (const rec of getExtensionsSync(wsId)) {
    if (!rec.enabled) continue
    await loadRecord(rec, wsId)
    await upsertExtension(rec, wsId)
  }
  // Чистка сирот идёт ПОСЛЕ загрузки своих расширений: Chromium поднимает
  // расширения из профиля асинхронно, и до первой загрузки список
  // getAllExtensions() пуст (замерено: loaded: 0 при старте).
  await dropOrphanRegistrations(wsId)
  pushExtensionsState(wsId)
  // Обновления проверяются в фоне: старт браузера из-за сети не задерживаем.
  scheduleUpdateCheck()
}

// Снятие регистраций, которых нет в реестре.
//
// Chromium хранит расширения в партиции сам, отдельно от extensions.json:
// после удаления записи (или каталога) регистрация остаётся и её воркер
// продолжает подниматься на каждом старте, засоряя лог своими ошибками —
// замерено на удалённом пробнике. Чистим по факту: всё зарегистрированное
// в партиции, чего нет среди наших electronId, снимаем.
//
// Источников два, и оба нужны. Публичный getAllExtensions() отдаёт только
// УСПЕШНО загруженные расширения, а сироты как раз обычно ломаются:
// в живом профиле нашлась такая регистрация, и её воркер падал на каждом
// старте (DidStartWorkerFail), при этом в getAllExtensions() её не было.
// Полный список лежит в Preferences партиции (extensions.settings);
// читаем его как строку JSON, без своей модели — формат внутренний,
// и при его смене достаточно тихо пропустить этот источник.
async function dropOrphanRegistrations(wsId = bootWorkspaceId()): Promise<void> {
  const known = new Set(
    getExtensionsSync(wsId)
      .map((rec) => rec.electronId)
      .filter((id): id is string => !!id)
  )
  const ids = new Set<string>(readPersistedExtensionIds(wsId))
  try {
    for (const ext of extensionSession(wsId).extensions.getAllExtensions()) ids.add(ext.id)
  } catch {
    // Список недоступен — работаем по сохранённому.
  }
  const dropped: string[] = []
  for (const id of ids) {
    if (known.has(id)) continue
    try {
      extensionSession(wsId).extensions.removeExtension(id)
      dropped.push(id)
    } catch {
      // Регистрации уже нет — цель достигнута.
    }
  }
  log('lifecycle', 'ext: регистрации', { registered: ids.size, dropped, wsId })
}

// Идентификаторы расширений, записанные в профиль партиции.
// Путь: <userData>/Partitions/<partition>/Preferences -> extensions.settings.
function readPersistedExtensionIds(wsId = bootWorkspaceId()): string[] {
  try {
    const file = join(
      app.getPath('userData'),
      'Partitions',
      partitionFor(wsId).replace(/^persist:/, ''),
      'Preferences'
    )
    if (!existsSync(file)) return []
    const prefs = JSON.parse(readFileSync(file, 'utf8')) as {
      extensions?: { settings?: Record<string, unknown> }
    }
    return Object.keys(prefs.extensions?.settings ?? {})
  } catch {
    return []
  }
}

// Выгрузка всех расширений при выходе из приложения.
//
// Зачем: Chromium хранит регистрацию service worker'а расширения в партиции
// и на следующем старте поднимает её ДО того, как наш код вызовет
// loadExtension. В этот момент расширение ещё не загружено, контекст
// урезанный — `chrome` без родных API, — и фон падает: в логе
// «Cannot read properties of undefined (reading 'onMessage')»,
// «DidStartWorkerFail», а расширение всё равно потом загружается нашим
// вызовом. Снятие регистраций при выходе убирает сам повод: следующий старт
// начинается с чистого списка, а расширения поднимаем мы сами.
//
// Ошибка на одной записи не должна мешать остальным: выход из приложения
// не место для частичной работы.
export async function shutdownExtensions(): Promise<void> {
  // При выходе выгружаем расширения ВСЕХ поднятых пространств: иначе
  // воркеры останутся зарегистрированными в партициях и на следующем старте
  // поднимутся раньше нашего кода (см. комментарий выше).
  for (const wsId of [...startedSpaces]) {
    for (const rec of getExtensionsSync(wsId)) {
      if (!rec.electronId) continue
      try {
        await unloadRecord(rec, wsId)
        await upsertExtension(rec, wsId)
      } catch (e) {
        logError('extensions shutdown failed', e)
      }
    }
  }
}

// Смена глобального выключателя расширений: выгружает или поднимает всё.
export async function applyExtensionsEnabled(
  enabled: boolean,
  wsId = bootWorkspaceId()
): Promise<void> {
  if (enabled) {
    if (!startedSpaces.has(wsId)) {
      await initExtensions(wsId)
      return
    }
    for (const rec of getExtensionsSync(wsId)) {
      if (!rec.enabled || rec.electronId) continue
      await loadRecord(rec, wsId)
      await upsertExtension(rec, wsId)
    }
  } else {
    for (const rec of getExtensionsSync(wsId)) {
      if (rec.electronId) await unloadRecord(rec, wsId)
      await upsertExtension(rec, wsId)
    }
  }
  pushExtensionsState(wsId)
}

// Пересборка кэша из файла: нужно странице расширений после установки извне.
export async function refreshExtensions(
  wsId = bootWorkspaceId()
): Promise<ExtensionsState> {
  resetExtensionsCache(wsId)
  await loadExtensions(wsId)
  return extensionsState(wsId)
}
