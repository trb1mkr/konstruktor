// Loopback-мост между расширениями и main.
//
// Зачем сервер, а не IPC: preload в service worker расширения не доходит,
// а мир preload для страниц расширения изолирован от скриптов страницы
// (замеры фазы 0, см. docs/plans/EXTENSIONS_PLAN.md). Остаётся сетевой
// канал, доступный и service worker'у, и контент-скрипту, и странице:
//   вызовы  — POST /rpc        (расширение -> main)
//   события — WS   /events     (main -> расширение)
//
// Безопасность: слушаем только 127.0.0.1, порт случайный на запуск,
// каждый запрос обязан нести токен запуска. Заголовок Origin у запросов
// расширения — chrome-extension://<id>; по нему определяется расширение
// (нужно для проверки прав).
import { createHash, randomBytes } from 'crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { Socket } from 'net'
import { join } from 'path'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { app, shell } from 'electron'
import type { ChromeTabLike } from '../../shared/extensions-types'
import { findExtensionByElectronId, getExtensionsSync } from './extensionStore'
import { commandsOfRecord, type RegisteredCommand } from './commands'
import { getSettings, saveSettings } from '../store/settingsStore'
import { getHistory, searchHistory } from '../store/historyStore'
import { getDownloads } from '../store/downloadsStore'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

// Возможности хоста, которые нужны мосту. Собираются в windows/deps.ts:
// extensions не импортирует кластеры окон и вкладок напрямую (иначе цикл).
export interface ExtensionHostDeps {
  listWindows(): { id: number; focused: boolean; incognito: boolean }[]
  listTabs(windowId?: number): ChromeTabLike[]
  activeWindowId(): number | null
  focusedWindowId(): number | null
  openTab(url: string, opts: { active: boolean; windowId?: number }): number | null
  closeTab(id: number): boolean
  activateTab(id: number): boolean
  navigateTab(id: number, url: string): boolean
  reloadTab(id: number): boolean
  createWindow(url?: string): number | null
  closeWindow(id: number): boolean
  notify(toast: { title: string; body?: string }): void
  downloadUrl(url: string): void
}

// Состояние кнопки расширения на панели + пункты контекстного меню.
export interface ActionState {
  title: string
  badge: string
  badgeColor: string
  icon: string
  popup: string
}

export interface ContextMenuItem {
  id: string
  title: string
  contexts: string[]
  parentId?: string
  documentUrlPatterns?: string[]
}

interface BridgeState {
  server: Server | null
  port: number
  token: string
  sockets: Map<string, Socket[]>
  alarms: Map<string, NodeJS.Timeout>
  actions: Map<string, ActionState>
  menus: Map<string, ContextMenuItem[]>
  onActionChange: (() => void) | null
}

const state: BridgeState = {
  server: null,
  port: 0,
  token: '',
  sockets: new Map(),
  alarms: new Map(),
  actions: new Map(),
  menus: new Map(),
  onActionChange: null
}

let deps: ExtensionHostDeps | null = null

export function registerExtensionHost(next: ExtensionHostDeps): void {
  deps = next
}

function host(): ExtensionHostDeps {
  if (!deps) throw new Error('extension host deps not registered')
  return deps
}

export function setActionChangeListener(cb: (() => void) | null): void {
  state.onActionChange = cb
}

export function bridgePort(): number {
  return state.port
}

export function bridgeToken(): string {
  return state.token
}

// --- WebSocket: сервер шлёт только текстовые кадры, этого достаточно ---

function wsAccept(key: string): string {
  return createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64')
}

function wsTextFrame(text: string): Buffer {
  const data = Buffer.from(text, 'utf8')
  const len = data.length
  let header: Buffer
  if (len < 126) {
    header = Buffer.from([0x81, len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, data])
}

export function pushEvent(electronId: string, event: string, args: unknown[]): void {
  const payload = JSON.stringify({ event, args })
  const frame = wsTextFrame(payload)
  for (const socket of state.sockets.get(electronId) ?? []) {
    try {
      socket.write(frame)
    } catch {
      // Сокет уже закрыт — вычистится по 'close'.
    }
  }
}

export function extensionIdFromOrigin(origin: string | undefined): string {
  if (!origin) return ''
  const m = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin)
  return m ? m[1] : ''
}

// --- Права: метод моста требует разрешения из манифеста ------------------

// Проверяются только те API, где Chrome действительно требует объявления:
// tabs.create и contextMenus в MV3 работают без разрешения, а downloads
// и notifications — нет. Строгий список здесь важнее полноты: лишняя
// проверка ломала бы рабочие расширения.
const METHOD_PERMISSION: Record<string, string> = {
  'downloads.download': 'downloads',
  'notifications.create': 'notifications',
  'notifications.clear': 'notifications',
  'notifications.getAll': 'notifications'
}

// Возможности собственного API: имя метода -> capability из манифеста.
// Не-native расширения конструктора не получают вообще: у них нет секции
// konstruktor, а без неё доступ к внутренностям браузера не выдаётся.
const METHOD_CAPABILITY: Record<string, string> = {
  'konstruktor.settings.get': 'settings',
  'konstruktor.settings.patch': 'settings',
  'konstruktor.tabs.list': 'tabs',
  'konstruktor.tabs.open': 'tabs',
  'konstruktor.history.query': 'history',
  'konstruktor.downloads.list': 'downloads',
  'konstruktor.storage.get': 'storage',
  'konstruktor.storage.set': 'storage',
  'konstruktor.storage.remove': 'storage',
  'konstruktor.notify': 'notify',
  'konstruktor.openExternal': 'openExternal'
}

function assertPermission(electronId: string, method: string): void {
  const capability = METHOD_CAPABILITY[method]
  if (capability) {
    const rec = findExtensionByElectronId(electronId)
    if (!rec) throw new Error('unknown extension: ' + electronId)
    if (!rec.native) throw new Error('konstruktor API is available to native extensions only')
    if (!(rec.capabilities ?? []).includes(capability)) {
      throw new Error('capability "' + capability + '" is not declared by the extension')
    }
    return
  }
  const required = METHOD_PERMISSION[method]
  if (!required) return
  const rec = findExtensionByElectronId(electronId)
  if (!rec) throw new Error('unknown extension: ' + electronId)
  if (!rec.permissions.includes(required)) {
    throw new Error('permission "' + required + '" is not declared by the extension')
  }
}

// --- Хранилище собственного API konstruktor.storage ----------------------

async function nativeStoragePath(id: string): Promise<string> {
  const dir = join(app.getPath('userData'), 'extensions', id)
  await mkdir(dir, { recursive: true })
  return join(dir, 'konstruktor-storage.json')
}

async function nativeStorageGet(id: string, keys?: string[]): Promise<Record<string, unknown>> {
  try {
    const raw = JSON.parse(await readFile(await nativeStoragePath(id), 'utf8')) as Record<
      string,
      unknown
    >
    if (!keys || keys.length === 0) return raw
    const out: Record<string, unknown> = {}
    for (const k of keys) if (k in raw) out[k] = raw[k]
    return out
  } catch {
    return {}
  }
}

async function nativeStorageSet(id: string, patch: Record<string, unknown>): Promise<void> {
  const current = await nativeStorageGet(id)
  await writeFile(
    await nativeStoragePath(id),
    JSON.stringify({ ...current, ...patch }, null, 2),
    'utf8'
  )
}

async function nativeStorageRemove(id: string, keys: string[]): Promise<void> {
  const current = await nativeStorageGet(id)
  for (const k of keys) delete current[k]
  await writeFile(await nativeStoragePath(id), JSON.stringify(current, null, 2), 'utf8')
}

// Локализация расширения: Electron не умеет chrome.i18n, читаем _locales сами.
async function extensionMessage(dir: string, key: string, subs: string[]): Promise<string> {
  const locales = ['en', 'ru']
  for (const locale of locales) {
    for (const name of [locale, locale.toUpperCase()]) {
      try {
        const raw = await readFile(join(dir, '_locales', name, 'messages.json'), 'utf8')
        const table = JSON.parse(raw) as Record<string, { message?: string }>
        const entry = table[key]
        if (entry && typeof entry.message === 'string') {
          return entry.message.replace(/\$(\d+)/g, (_m, n: string) => subs[Number(n) - 1] ?? '')
        }
      } catch {
        // Нет каталога — пробуем следующий.
      }
    }
  }
  return ''
}

// --- Разбор RPC ----------------------------------------------------------

interface RpcRequest {
  token: string
  method: string
  args: unknown[]
}

function tabSnapshot(id: number): ChromeTabLike | undefined {
  return host().listTabs().find((t) => t.id === id)
}

async function dispatch(electronId: string, method: string, args: unknown[]): Promise<unknown> {
  assertPermission(electronId, method)
  const rec = findExtensionByElectronId(electronId)
  const arg0 = args[0] as Record<string, unknown> | undefined

  switch (method) {
    case 'tabs.create': {
      const props = (arg0 ?? {}) as { url?: string; active?: boolean; windowId?: number }
      return host().openTab(props.url ?? 'about:blank', {
        active: props.active !== false,
        windowId: props.windowId
      })
    }
    case 'tabs.remove': {
      const id = Number(args[0])
      if (!host().closeTab(id)) throw new Error('tab not found: ' + id)
      return undefined
    }
    case 'tabs.update': {
      const id = Number(args[0])
      const props = (args[1] ?? {}) as { url?: string; active?: boolean }
      if (props.url) host().navigateTab(id, props.url)
      if (props.active) host().activateTab(id)
      return tabSnapshot(id)
    }
    case 'tabs.reload': {
      host().reloadTab(Number(args[0]))
      return undefined
    }
    case 'tabs.query': {
      const info = (arg0 ?? {}) as { active?: boolean; windowId?: number; url?: string }
      let list = host().listTabs(info.windowId)
      if (info.active) list = list.filter((t) => t.active)
      if (info.url) {
        const pattern = info.url
        list = list.filter((t) => matchPattern(pattern, t.url))
      }
      return list
    }
    case 'windows.create': {
      const props = (arg0 ?? {}) as { url?: string }
      const id = host().createWindow(Array.isArray(props.url) ? props.url[0] : props.url)
      return id === null ? null : { id }
    }
    case 'windows.getCurrent':
      return { id: host().activeWindowId() }
    case 'windows.getAll':
      return host().listWindows().map((w) => ({ id: w.id, focused: w.focused }))
    case 'windows.update':
      return { id: Number(args[0]) }
    case 'windows.remove': {
      host().closeWindow(Number(args[0]))
      return undefined
    }
    case 'action.setBadgeText': {
      const o = (arg0 ?? {}) as { text?: string }
      const cur = actionState(electronId)
      cur.badge = o.text ?? ''
      state.actions.set(electronId, cur)
      state.onActionChange?.()
      return undefined
    }
    case 'action.setBadgeBackgroundColor': {
      const o = (arg0 ?? {}) as { color?: string | number[] }
      const cur = actionState(electronId)
      cur.badgeColor = Array.isArray(o.color)
        ? '#' +
          o.color
            .slice(0, 3)
            .map((n) => Number(n).toString(16).padStart(2, '0'))
            .join('')
        : String(o.color ?? '')
      state.actions.set(electronId, cur)
      state.onActionChange?.()
      return undefined
    }
    case 'action.setTitle': {
      const o = (arg0 ?? {}) as { title?: string }
      const cur = actionState(electronId)
      cur.title = o.title ?? cur.title
      state.actions.set(electronId, cur)
      state.onActionChange?.()
      return undefined
    }
    case 'action.setIcon':
    case 'action.setPopup': {
      return undefined
    }
    case 'contextMenus.create': {
      if (!rec) throw new Error('unknown extension')
      const props = (arg0 ?? {}) as {
        id?: string
        title?: string
        contexts?: string[]
        parentId?: string
        documentUrlPatterns?: string[]
      }
      const list = state.menus.get(rec.id) ?? []
      list.push({
        id: props.id ?? 'menu-' + (list.length + 1),
        title: props.title ?? '',
        contexts: props.contexts ?? ['page'],
        parentId: props.parentId,
        documentUrlPatterns: props.documentUrlPatterns
      })
      state.menus.set(rec.id, list)
      return undefined
    }
    case 'contextMenus.remove': {
      if (rec) {
        const list = (state.menus.get(rec.id) ?? []).filter((m) => m.id !== String(args[0]))
        state.menus.set(rec.id, list)
      }
      return undefined
    }
    case 'contextMenus.removeAll': {
      if (rec) state.menus.set(rec.id, [])
      return undefined
    }
    case 'notifications.create': {
      const title = String(args[0] ?? '')
      const options = (args[1] ?? {}) as { title?: string; message?: string; body?: string }
      host().notify({
        title: options.title ?? title ?? rec?.name ?? '',
        body: options.message ?? options.body ?? ''
      })
      return ''
    }
    case 'notifications.clear':
      return true
    case 'notifications.getAll':
      return {}
    case 'alarms.create': {
      const name = String(args[0] ?? '')
      const info = (args[1] ?? {}) as { periodInMinutes?: number; delayInMinutes?: number }
      if (!rec) throw new Error('unknown extension')
      const key = rec.id + ':' + name
      const existing = state.alarms.get(key)
      if (existing) clearTimeout(existing)
      const minutes = info.periodInMinutes ?? info.delayInMinutes ?? 1
      const ms = Math.max(1000, minutes * 60000)
      const timer = setInterval(() => {
        pushEvent(electronId, 'alarms.onAlarm', [{ name, scheduledTime: Date.now() }])
      }, ms)
      state.alarms.set(key, timer)
      return undefined
    }
    case 'alarms.clear': {
      if (rec) {
        const key = rec.id + ':' + String(args[0] ?? '')
        const timer = state.alarms.get(key)
        if (timer) clearInterval(timer)
        state.alarms.delete(key)
      }
      return true
    }
    case 'alarms.clearAll': {
      if (rec) {
        for (const [key, timer] of state.alarms) {
          if (key.startsWith(rec.id + ':')) {
            clearInterval(timer)
            state.alarms.delete(key)
          }
        }
      }
      return true
    }
    case 'alarms.getAll':
      return []
    case 'commands.getAll':
      return rec ? commandsOfRecord(rec.id) : []
    case 'i18n.getMessage': {
      if (!rec) return ''
      return extensionMessage(rec.dir, String(args[0] ?? ''), (args[1] as string[]) ?? [])
    }
    case 'downloads.download': {
      const o = (arg0 ?? {}) as { url?: string }
      if (o.url) host().downloadUrl(o.url)
      return 0
    }
    case 'konstruktor.settings.get':
      return getSettings()
    case 'konstruktor.settings.patch': {
      const patch = (arg0 ?? {}) as Record<string, unknown>
      await saveSettings(patch as Parameters<typeof saveSettings>[0])
      return getSettings()
    }
    case 'konstruktor.tabs.list':
      return host().listTabs()
    case 'konstruktor.tabs.open': {
      const o = (arg0 ?? {}) as { url?: string }
      return host().openTab(o.url ?? 'about:blank', { active: true })
    }
    case 'konstruktor.history.query': {
      const o = (arg0 ?? {}) as { query?: string; limit?: number }
      return o.query ? searchHistory(o.query, o.limit ?? 50) : getHistory(o.limit ?? 100)
    }
    case 'konstruktor.downloads.list':
      return getDownloads(Number(args[0]) || 100)
    case 'konstruktor.storage.get':
      return rec ? nativeStorageGet(rec.id, args[0] as string[] | undefined) : {}
    case 'konstruktor.storage.set':
      if (rec) await nativeStorageSet(rec.id, (arg0 ?? {}) as Record<string, unknown>)
      return true
    case 'konstruktor.storage.remove':
      if (rec) await nativeStorageRemove(rec.id, (args[0] as string[]) ?? [])
      return true
    case 'konstruktor.notify': {
      const o = (arg0 ?? {}) as { title?: string; body?: string }
      host().notify({ title: o.title ?? rec?.name ?? '', body: o.body ?? '' })
      return true
    }
    case 'konstruktor.openExternal': {
      const url = String(args[0] ?? '')
      if (url) void shell.openExternal(url)
      return true
    }
    // Служебный RPC шима: сохранить текст пользовательского скрипта файлом
    // в каталоге расширения. Нужен для chrome.userScripts — он принимает код
    // СТРОКОЙ, тогда как chrome.scripting регистрирует только ПУТИ. У самого
    // шима доступа к файловой системе нет: это код расширения, а не main.
    // Имя жёстко ограничено шаблоном, чтобы исключить выход из каталога.
    case 'shim.writeUserScriptFile': {
      const name = String(arg0 ?? '')
      const code = String(args[1] ?? '')
      if (!rec) throw new Error('unknown extension')
      if (!/^konstruktor-us-[A-Za-z0-9_-]+\.js$/.test(name)) {
        throw new Error('bad user script file name')
      }
      if (!rec.permissions.includes('userScripts')) {
        throw new Error('permission "userScripts" is not declared by the extension')
      }
      await writeFile(join(rec.dir, name), code, 'utf8')
      return name
    }
    default:
      throw new Error('unknown method: ' + method)
  }
}

// RPC из окна попапа расширения и из шима (chrome.userScripts). Отдельная
// точка входа нужна потому, что попапу недоступен ни loopback-токен (он зашит
// только в сгенерированный шим), ни fetch-путь как единственный канал:
// страница расширения в Electron получает урезанный `chrome.tabs` — `query`
// есть, а `create`/`update`/`remove`/`reload` отсутствуют (замер
// 2026-10-11). Из-за этого расширения, открывающие что-то вкладкой из попапа
// (MetaMask открывает так онбординг), падали на вызове. Проверки прав и
// логика — те же, что у моста.
export async function dispatchExtensionRpc(
  electronId: string,
  method: string,
  args: unknown[]
): Promise<unknown> {
  return dispatch(electronId, method, args)
}

// Сопоставление URL с шаблоном match pattern (упрощённое, подмножество Chrome).
export function matchPattern(pattern: string, url: string): boolean {
  if (pattern === '<all_urls>' || pattern === '*://*/*') return true
  const m = /^(\*|https?|file|ftp):\/\/([^/]+)(\/.*)?$/.exec(pattern)
  if (!m) return false
  const [, scheme, hostPart, pathPart] = m
  let ok: boolean
  try {
    const target = new URL(url)
    if (scheme !== '*' && target.protocol !== scheme + ':') return false
    if (hostPart === '*') ok = true
    else if (hostPart.startsWith('*.')) ok = target.hostname.endsWith(hostPart.slice(1))
    else ok = target.hostname === hostPart
  } catch {
    return false
  }
  if (!ok) return false
  if (!pathPart || pathPart === '/*') return true
  return url.includes(pathPart.replace('*', ''))
}

export function actionState(electronId: string): ActionState {
  return (
    state.actions.get(electronId) ?? {
      title: '',
      badge: '',
      badgeColor: '',
      icon: '',
      popup: ''
    }
  )
}

export function extensionActionStates(): Map<string, ActionState> {
  return state.actions
}

export function extensionMenuItems(recId: string): ContextMenuItem[] {
  return state.menus.get(recId) ?? []
}

// Пользователь выбрал пункт меню расширения: уходит в service worker.
export function fireMenuClick(recId: string, itemId: string, info: Record<string, unknown>): void {
  const rec = getExtensionsSync().find((r) => r.id === recId)
  if (!rec?.electronId) return
  const item = (state.menus.get(recId) ?? []).find((m) => m.id === itemId)
  if (!item) return
  pushEvent(rec.electronId, 'contextMenus.onClicked', [info, { id: item.id, title: item.title }])
}

// Клик по кнопке расширения решает вызывающий: при наличии попапа
// открывается окно попапа, иначе фону уходит событие action.onClicked.
// Здесь остаются только эти две отдельные операции — иначе bridge знал бы
// про окна, чего он делать не должен.
export function actionPopupPage(recId: string): { electronId: string; page: string } | null {
  const rec = getExtensionsSync().find((r) => r.id === recId)
  if (!rec?.electronId) return null
  const action = actionState(rec.electronId)
  const page = action.popup || rec.actionSeed?.popup || ''
  if (!rec.electronId || !page) return null
  return { electronId: rec.electronId, page }
}

export function fireActionClick(recId: string): boolean {
  const rec = getExtensionsSync().find((r) => r.id === recId)
  if (!rec?.electronId) return false
  pushEvent(rec.electronId, 'action.onClicked', [{ id: host().activeWindowId() ?? -1, url: '' }])
  return true
}

// Доставка события команды в фон расширения. Живёт здесь, а не
// в commands.ts: перехватчиков два (view и окно), и оба обязаны слать
// событие одинаково, а сам реестр команд знает о мосте не должен —
// иначе получается цикл импортов commands <-> bridge.
export function fireExtensionCommand(command: RegisteredCommand): void {
  pushEvent(command.electronId, 'commands.onCommand', [command.id])
}

// --- HTTP-сервер ---------------------------------------------------------

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    // Расширение живёт на chrome-extension:// — без этого заголовка
    // чтение ответа блокируется CORS (проверено в фазе 0).
    'access-control-allow-origin': '*'
  })
  res.end(text)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8')
    })
    req.on('end', () => resolve(data))
    req.on('error', () => resolve(''))
  })
}

// Предварительный запрос CORS (OPTIONS /rpc).
//
// Без него вызовы шима не проходят вообще: Chromium считает fetch из
// chrome-extension:// к 127.0.0.1 запросом в приватную сеть и требует
// успешный preflight — на 404 он падает с «Response to preflight request
// doesn't pass access control check: It does not have HTTP ok status».
// Кроме обычных заголовков CORS нужен Allow-Private-Network: его требует
// Private Network Access для перехода из публичного контекста в loopback.
function handlePreflight(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin ?? '*'
  res.writeHead(204, {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-private-network': 'true',
    'access-control-max-age': '600',
    'content-length': '0'
  })
  res.end()
}

function handleRpc(req: IncomingMessage, res: ServerResponse): void {
  void readBody(req).then(async (raw) => {
    let parsed: RpcRequest
    try {
      parsed = JSON.parse(raw) as RpcRequest
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad request body' })
      return
    }
    if (parsed.token !== state.token) {
      sendJson(res, 403, { ok: false, error: 'bad token' })
      return
    }
    const electronId = extensionIdFromOrigin(req.headers.origin)
    if (!electronId) {
      sendJson(res, 403, { ok: false, error: 'unknown origin' })
      return
    }
    try {
      const result = await dispatch(electronId, String(parsed.method), parsed.args ?? [])
      sendJson(res, 200, { ok: true, result })
    } catch (e) {
      sendJson(res, 200, { ok: false, error: String((e as Error)?.message ?? e) })
    }
  })
}

function handleUpgrade(req: IncomingMessage, socket: Socket): void {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname !== '/events' || url.searchParams.get('token') !== state.token) {
    socket.destroy()
    return
  }
  const key = req.headers['sec-websocket-key']
  if (typeof key !== 'string') {
    socket.destroy()
    return
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' +
      wsAccept(key) +
      '\r\n\r\n'
  )
  const electronId = url.searchParams.get('ext') ?? ''
  if (!electronId) {
    socket.destroy()
    return
  }
  const list = state.sockets.get(electronId) ?? []
  list.push(socket)
  state.sockets.set(electronId, list)
  socket.on('close', () => {
    const rest = (state.sockets.get(electronId) ?? []).filter((s) => s !== socket)
    state.sockets.set(electronId, rest)
  })
  socket.on('error', () => socket.destroy())
  // Входящие кадры не разбираем: расширение шлёт вызовы через POST /rpc.
  socket.on('data', () => undefined)
}

export function startBridge(): Promise<{ port: number; token: string }> {
  if (state.server) return Promise.resolve({ port: state.port, token: state.token })
  return startBridgeInner()
}

// Адрес и токен моста переживают перезапуск приложения.
//
// Причина не в удобстве: Chromium сохраняет регистрацию service worker'а
// расширения в партиции, и на старте приложения этот worker поднимается
// РАНЬШЕ, чем мы успеваем переписать шим с новым портом. Со случайным
// портом на каждый запуск такой worker стучался бы в закрытую дверь
// (ERR_CONNECTION_REFUSED -> «Failed to fetch», бесконечные реконнекты).
// Со стабильным адресом старый worker попадает туда же, куда и новый.
function endpointPath(): string {
  return join(app.getPath('userData'), 'extensions-bridge.json')
}

async function readEndpoint(): Promise<{ port?: number; token?: string }> {
  try {
    return JSON.parse(await readFile(endpointPath(), 'utf8')) as {
      port?: number
      token?: string
    }
  } catch {
    return {}
  }
}

async function writeEndpoint(): Promise<void> {
  try {
    await mkdir(app.getPath('userData'), { recursive: true })
    await writeFile(
      endpointPath(),
      JSON.stringify({ port: state.port, token: state.token }, null, 2),
      'utf8'
    )
  } catch {
    // Не удалось сохранить адрес — мост всё равно работает до перезапуска.
  }
}

function listenOn(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.method === 'OPTIONS') {
        handlePreflight(req, res)
        return
      }
      if (req.method === 'POST' && req.url === '/rpc') {
        handleRpc(req, res)
        return
      }
      sendJson(res, 404, { ok: false, error: 'not found' })
    })
    server.on('upgrade', (req, socket) => handleUpgrade(req, socket as Socket))
    server.once('error', reject)
    // Слушаем только петлю: наружу мост не торчит.
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      server.on('error', () => undefined)
      resolve(server)
    })
  })
}

async function startBridgeInner(): Promise<{ port: number; token: string }> {
  const saved = await readEndpoint()
  state.token = saved.token ?? randomBytes(24).toString('hex')
  const preferred = typeof saved.port === 'number' ? saved.port : 0
  let server: Server | null = null
  if (preferred > 0) {
    server = await listenOn(preferred).catch(() => null)
    if (!server) console.warn('[extensions] bridge port busy, picking a free one')
  }
  if (!server) server = await listenOn(0)
  const address = server.address()
  if (address && typeof address === 'object') state.port = address.port
  state.server = server
  await writeEndpoint()
  return { port: state.port, token: state.token }
}

export function stopBridge(): void {
  for (const timer of state.alarms.values()) clearInterval(timer)
  state.alarms.clear()
  for (const sockets of state.sockets.values()) for (const s of sockets) s.destroy()
  state.sockets.clear()
  state.server?.close()
  state.server = null
}
