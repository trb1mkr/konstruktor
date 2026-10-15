// Разрешения веб-страниц: обработчики сессий, промпт оверлеем и очередь.
//
// Как устроено в Chromium и почему нужны ДВА обработчика. Сначала идёт
// ПРОВЕРКА разрешения (`setPermissionCheckHandler`, синхронная) — её
// спрашивает `navigator.permissions.query` и часть внутренних путей
// Chromium. И только если проверка отказала, идёт ЗАПРОС
// (`setPermissionRequestHandler`) — вот его и должен показать промпт.
// Проверка отвечает по сохранённому решению, а нерешённое отдаёт
// «нет»: если бы она отвечала «да», Chromium счёл бы разрешение уже
// выданным и до промпта дело не дошло бы.
//
// Промпт живёт в оверлей-окне (kind 'permission') — нарисовать его поверх
// WebContentsView больше негде. Очередь на окно: поверхность в окне одна,
// и два одновременных запроса показались бы по очереди.
//
// Приёмка «скрытие и возвращение при переключении назад» реализована
// через карту shown: при переключении вкладки промпт помечается hidden и
// снимается с экрана, но решение НЕ принимается — при возврате на ту же
// вкладку он показывается снова. Отдельно отслеживается закрытие
// поверхности пользователем (Esc, клик по подложке, уход из приложения,
// вытеснение меню) — это отказ, и страница обязана его получить, иначе
// getUserMedia повиснет навсегда.
import { desktopCapturer, session, webContents } from 'electron'
import {
  INCOGNITO_PARTITION,
  NORMAL_PARTITION,
  getState,
  parentOfSenderView,
  windows,
  type WindowState,
} from '../windows/browserState'
import { getActiveRequest, setOverlayEndedListener, showOverlay } from '../overlay'
import type { OverlayRequest } from '../overlay'
import { log } from '../overlay/logger'
import { t } from '../i18n'
import { pushTabsState } from '../tabs/tabsManager'
import { setCaptureChangeHandler } from './captureIndicator'
import {
  SCOPE_ICON,
  SCOPE_LABEL,
  classify,
  isExtensionOrigin,
  isInternalOrigin,
  type PermissionScope,
} from './policy'
import { getDecision, loadPermissions, setDecision } from './permissionsStore'

// Один запрос, ожидающий решения. Очередь хранится по родительскому окну:
// поверхность оверлея у окна одна, и показывать может только один промпт.
interface Prompt {
  parentId: number
  tabId: number
  origin: string
  host: string
  scopes: PermissionScope[]
  /** Решение запоминается (обычное окно) или только на сеанс (приватное). */
  persist: boolean
  /** Снят с экрана переключением вкладки; решение ещё не принято. */
  hidden: boolean
  settled: boolean
  /** Снимает подписки на события вкладки. */
  cleanup: () => void
  /** Закрывает запрос: отдаёт решение и убирает промпт из очереди. */
  finish: (allow: boolean) => void
  /** Разбор выбора из промпта: 'allow::1' | 'block::0'. */
  onAnswer: (id: string) => void
}

const queues = new Map<number, Prompt[]>()
const shown = new Map<number, Prompt>()

/**
 * Разбирает URL/строку origin в пару «origin + хост».
 *
 * Возвращает null, если строку не удалось разобрать: у запроса без
 * валидного origin нет и ключа для хранения решения, а выдавать доступ
 * «кому-то» нельзя.
 */
function parseOrigin(url: string | undefined): { origin: string; host: string } | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    if (!parsed.origin || parsed.origin === 'null') return null
    return { origin: parsed.origin, host: parsed.hostname || parsed.origin }
  } catch {
    return null
  }
}

/** Типы медиа из запроса: `details.mediaTypes` (может быть пустым). */
function requestMediaTypes(details: unknown): string[] {
  const types = (details as { mediaTypes?: unknown } | undefined)?.mediaTypes
  return Array.isArray(types) ? types.filter((x): x is string => typeof x === 'string') : []
}

/** Тип медиа из проверки: `details.mediaType` — одна строка. */
function checkMediaTypes(details: unknown): string[] {
  const type = (details as { mediaType?: unknown } | undefined)?.mediaType
  return typeof type === 'string' && type !== 'unknown' ? [type] : []
}

/** Вкладка окна по её webContents. */
function tabIdOf(ws: WindowState, sender: Electron.WebContents): number | undefined {
  for (const [id, rec] of ws.tabs) {
    if (rec.view?.webContents?.id === sender.id) return id
  }
  return undefined
}

/**
 * Точка вызова промпта: левый нижний угол адресной строки.
 *
 * Положение панели внутри окна знает только shell (пресеты кладут её и
 * сверху, и снизу), поэтому угол приходит отдельным каналом. Пока его нет
 * — берём левый верхний угол области страницы: промпт встанет под верхней
 * панелью, что для классической раскладки и есть адресная строка.
 */
function anchorFor(ws: WindowState): { x: number; y: number } {
  if (ws.permissionAnchor) return ws.permissionAnchor
  const ins = ws.uiInsets
  return { x: Math.max(0, ins.left + 8), y: Math.max(0, ins.top) }
}

/** Подписка на смерть запроса: уход со страницы или закрытие вкладки. */
function watchTab(ws: WindowState, tabId: number, onGone: () => void): () => void {
  const rec = ws.tabs.get(tabId)
  const wc = rec?.view?.webContents
  if (!wc || wc.isDestroyed()) return () => {}
  const onNavigate = (): void => onGone()
  const onDestroyed = (): void => onGone()
  wc.on('did-navigate', onNavigate)
  wc.on('destroyed', onDestroyed)
  return () => {
    try {
      if (wc.isDestroyed()) return
      wc.removeListener('did-navigate', onNavigate)
      wc.removeListener('destroyed', onDestroyed)
    } catch {
      // webContents уже мёртв — снимать нечего.
    }
  }
}

/**
 * Собирает запрос на показ промпта.
 *
 * Собирается при каждом показе, а не хранится в очереди: точка вызова
 * (адресная строка) может переехать между скрытием и возвратом —
 * пользователь мог сменить пресет раскладки.
 */
function permissionRequest(ws: WindowState, prompt: Prompt): OverlayRequest {
  return {
    kind: 'permission',
    anchor: anchorFor(ws),
    permission: {
      host: prompt.host,
      origin: prompt.origin,
      lines: prompt.scopes.map((scope) => ({
        icon: SCOPE_ICON[scope],
        text: t(SCOPE_LABEL[scope]),
      })),
      buttons: [
        { id: 'block', label: t('permissions.block') },
        { id: 'allow', label: t('permissions.allow') },
      ],
      rememberLabel: t('permissions.remember'),
      // Приватное окно решение не сохранит — чекбокс там не показываем.
      ephemeral: !prompt.persist,
    },
    onSelect: (id) => prompt.onAnswer(id),
  }
}

/**
 * Показывает промпт для активной вкладки, если он есть в очереди и
 * поверхность свободна.
 *
 * Ничего не показывает, когда на экране другой оверлей (меню, диалог):
 * вытеснять его промптом значит закрыть чужую поверхность без действия
 * пользователя. Следующий повод для показа (новый запрос, смена вкладки,
 * закрытие меню) вызовет pump заново.
 */
function pump(ws: WindowState): void {
  const parent = ws.window
  if (!parent || parent.isDestroyed()) return
  const queue = queues.get(parent.id)
  if (!queue) return
  const activeTab = ws.activeTabId
  const cur = shown.get(parent.id)
  if (cur && !cur.settled && cur.tabId === activeTab) return
  const next = queue.find((p) => !p.settled && p.tabId === activeTab)
  if (!next) return
  if (getActiveRequest(parent)) return
  shown.set(parent.id, next)
  log('session', 'permission prompt shown', {
    parentId: parent.id,
    origin: next.origin,
    scopes: next.scopes,
  })
  showOverlay(parent, permissionRequest(ws, next))
}

/**
 * Публичный «пнуть очередь»: вызывается после смены активной вкладки.
 *
 * Отдельно от pump (внутренней) потому, что модуль депса вкладок не знает
 * ни про очередь, ни про её правила, и ему нужен один вызов на событие.
 */
export function pumpPrompts(ws: WindowState): void {
  pump(ws)
}

/**
 * Помечает показанный промпт скрытым: активная вкладка меняется.
 *
 * Вызывается ДО фактического переключения (порядок в deps.setActiveTab
 * задан фокусом): closeOverlayOnTabChange снимает поверхность, и без метки
 * это выглядело бы как «пользователь закрыл промпт» — то есть отказом.
 *
 * Метка ставится БЕЗ сравнения вкладок: переключение на ту же вкладку
 * (клик по активной) тоже снимает поверхность, и сравнивать нечего —
 * решение всё равно не принято. Показ повторит pumpPrompts сразу после
 * переключения, если вкладка промпта снова активна.
 */
export function handleTabChange(ws: WindowState): void {
  const parent = ws.window
  if (!parent) return
  const cur = shown.get(parent.id)
  if (!cur || cur.settled) return
  cur.hidden = true
  log('session', 'permission prompt hidden by tab switch', { origin: cur.origin })
}

/**
 * Поверхность окна снята. Разбираем, что это было.
 *
 * Скрытие переключением вкладки решением не считается: промпт остаётся в
 * очереди и вернётся, когда пользователь вернётся на ту же вкладку. Всё
 * остальное (Esc, клик по подложке, уход из приложения, вытеснение меню,
 * прерванный показ) — отказ, и он обязан дойти до страницы.
 */
function onOverlayEnded(parentId: number): void {
  const ws = windows.get(parentId)
  const cur = shown.get(parentId)
  if (!cur) {
    if (ws) pump(ws)
    return
  }
  shown.delete(parentId)
  if (cur.hidden) {
    cur.hidden = false
    return
  }
  if (cur.settled) return
  log('session', 'permission prompt closed -> denied', {
    origin: cur.origin,
    scopes: cur.scopes,
  })
  cur.finish(false)
}

/** Ставит запрос в очередь и ждёт решения пользователя. */
function askUser(
  ws: WindowState,
  tabId: number,
  origin: string,
  host: string,
  scopes: PermissionScope[],
  persist: boolean,
): Promise<boolean> {
  const parent = ws.window
  if (!parent || parent.isDestroyed()) return Promise.resolve(false)
  const parentId = parent.id
  return new Promise<boolean>((resolve) => {
    // Поля-замыкания заполняются ПОСЛЕ создания объекта: finish и
    // onAnswer замкнуты на сам промпт (убрать себя из очереди, отдать
    // решение), а ссылку на него до создания объекта не получить.
    const prompt: Prompt = {
      parentId,
      tabId,
      origin,
      host,
      scopes,
      persist,
      hidden: false,
      settled: false,
      cleanup: () => {},
      finish: () => {},
      onAnswer: () => {},
    }
    const finish = (allow: boolean): void => {
      if (prompt.settled) return
      prompt.settled = true
      prompt.cleanup()
      const list = queues.get(parentId)
      if (list) {
        const ix = list.indexOf(prompt)
        if (ix >= 0) list.splice(ix, 1)
        if (list.length === 0) queues.delete(parentId)
      }
      if (shown.get(parentId) === prompt) shown.delete(parentId)
      resolve(allow)
      pump(ws)
    }
    prompt.finish = finish
    prompt.onAnswer = (id: string): void => {
      const [action, rememberRaw] = id.split('::')
      const allow = action === 'allow'
      const remember = rememberRaw === '1'
      if (remember) {
        for (const scope of scopes) {
          void setDecision(origin, scope, allow ? 'allow' : 'block', persist)
        }
      }
      log('session', 'permission answer', { origin, scopes, allow, remember })
      finish(allow)
    }
    prompt.cleanup = watchTab(ws, tabId, () => {
      if (!prompt.settled) finish(false)
    })
    const list = queues.get(parentId)
    if (list) list.push(prompt)
    else queues.set(parentId, [prompt])
    log('session', 'permission prompt queued', { origin, scopes, tabId, persist })
    pump(ws)
  })
}

/** Устанавливает обработчики разрешений на одну сессию. */
function installHandlers(ses: Electron.Session, persist: boolean): void {
  // Проверка: только по сохранённому решению, без промпта (обработчик
  // синхронный). Нерешённое разрешение отдаёт false — тогда Chromium
  // пойдёт в обработчик запроса, и промпт покажется там.
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    const cls = classify(permission, checkMediaTypes(details))
    if (cls.auto) return cls.auto === 'allow'
    const parsed =
      parseOrigin(requestingOrigin) ??
      parseOrigin((details as { securityOrigin?: string } | undefined)?.securityOrigin)
    if (!parsed || isInternalOrigin(parsed.origin)) return false
    if (isExtensionOrigin(parsed.origin)) return true
    return cls.scopes.every((scope) => getDecision(parsed.origin, scope, persist) === 'allow')
  })

  // Запрос: сверяем решение, при нерешённых областях показываем промпт.
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const cls = classify(permission, requestMediaTypes(details))
    if (cls.auto) {
      callback(cls.auto === 'allow')
      return
    }
    const detailsUrl = (details as { requestingUrl?: string } | undefined)?.requestingUrl
    const parsed =
      parseOrigin(detailsUrl) ??
      parseOrigin((details as { securityOrigin?: string } | undefined)?.securityOrigin) ??
      parseOrigin(wc.getURL())
    if (!parsed || isInternalOrigin(parsed.origin)) {
      log('session', 'permission denied (origin)', { permission, url: detailsUrl })
      callback(false)
      return
    }
    if (isExtensionOrigin(parsed.origin)) {
      callback(true)
      return
    }
    const { origin, host } = parsed
    if (cls.scopes.some((scope) => getDecision(origin, scope, persist) === 'block')) {
      log('session', 'permission denied (remembered)', { origin, permission })
      callback(false)
      return
    }
    const undecided = cls.scopes.filter(
      (scope) => getDecision(origin, scope, persist) === undefined,
    )
    if (undecided.length === 0) {
      callback(true)
      return
    }
    const parent = parentOfSenderView(wc)
    const ws = parent ? getState(parent) : undefined
    if (!ws) {
      log('session', 'permission denied (no window)', { origin, permission })
      callback(false)
      return
    }
    const tabId = tabIdOf(ws, wc) ?? ws.activeTabId ?? -1
    void askUser(ws, tabId, origin, host, undecided, persist).then((allow) => {
      callback(allow)
    })
  })

  // Устройства (usb/hid/serial): отказ. Отдельные обработчики выбора
  // устройства не ставим — без них запрос отменяется сам, что и нужно.
  ses.setDevicePermissionHandler(() => false)

  // Захват экрана: согласие спрашивает ЭТОТ обработчик, а не промпт
  // разрешения (display-capture в таблице разрешён сразу) — иначе на одно
  // действие приходилось бы два диалога. Источник — первый экран: выбора
  // окна/вкладки пока нет, и вместо молчаливой выдачи всей системы
  // пользователь видит явный промпт.
  ses.setDisplayMediaRequestHandler((request, callback) => {
    // Типизация Electron считает, что в callback всегда приходит набор
    // потоков, тогда как по документации null и есть отказ:
    // getDisplayMedia() получает AbortError. Приведение нужно только
    // типам, поведение в рантайме штатное.
    const deny = (): void => (callback as unknown as (streams: null) => void)(null)
    void (async () => {
      const parsed = parseOrigin(request.securityOrigin)
      if (!parsed || isInternalOrigin(parsed.origin)) {
        deny()
        return
      }
      const { origin, host } = parsed
      let allow: boolean
      if (isExtensionOrigin(origin)) {
        allow = true
      } else {
        const stored = getDecision(origin, 'display-capture', persist)
        if (stored === 'allow') allow = true
        else if (stored === 'block') allow = false
        else {
          const wc = request.frame ? webContents.fromFrame(request.frame) : null
          const parent = wc ? parentOfSenderView(wc) : undefined
          const ws = parent ? getState(parent) : undefined
          if (!ws || !wc) {
            deny()
            return
          }
          const tabId = tabIdOf(ws, wc) ?? ws.activeTabId ?? -1
          allow = await askUser(ws, tabId, origin, host, ['display-capture'], persist)
        }
      }
      if (!allow) {
        deny()
        return
      }
      try {
        // thumbnailSize 0x0: превью источника нам не нужен, а на Linux
        // сборка миниатюр ещё и заметно дороже самого выбора.
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 0, height: 0 },
        })
        if (sources.length === 0) {
          deny()
          return
        }
        log('session', 'display capture granted', { origin, source: sources[0].name })
        callback({ video: sources[0] })
      } catch (err) {
        log('error', `display capture failed: ${String(err)}`)
        deny()
      }
    })()
  })
}

/**
 * Ставит обработчики разрешений на все сессии приложения.
 *
 * Все три — те же, что у внутренних страниц и загрузок:
 * `defaultSession`, обычная партиция вкладок и приватная. Приватная пишет
 * решения только в память (persist: false).
 */
export async function initPermissions(): Promise<void> {
  // Кэш решений читаем до первого окна: обработчик проверки синхронный, и
  // без прогретого кэша первое же разрешение выглядело бы нерешённым даже
  // при сохранённом ответе.
  await loadPermissions()
  setOverlayEndedListener(onOverlayEnded)
  setCaptureChangeHandler((ws) => pushTabsState(ws))
  installHandlers(session.defaultSession, true)
  installHandlers(session.fromPartition(NORMAL_PARTITION), true)
  installHandlers(session.fromPartition(INCOGNITO_PARTITION), false)
  log('session', 'permission handlers installed')
}
