// Сессии Chromium рабочего пространства.
//
// Пространство изолирует не только файлы, но и всё, что Chromium держит у
// себя: cookies, localStorage, кэш, зарегистрированные расширения. Это
// делает партиция, а не каталог, поэтому у каждого пространства их две —
// обычная и приватная.
//
// Регистрация на сессию (обработчик konstruktor://, preload внутренних
// страниц, разрешения, загрузки) обязана произойти ДО первой навигации в
// этой партиции. Поэтому ensureWorkspaceSession вызывается при создании
// первого окна пространства, а не при старте приложения: пространств может
// быть много, а поднятые сессии держат память и файлы.
//
// Модуль намеренно не импортирует подсистемы напрямую: он только перебирает
// подписчиков. Иначе вышел бы цикл permissionManager -> windows/deps ->
// windowsManager -> electronSession -> permissionManager.
import { session } from 'electron'
import { partitionFor } from './registry'

/** Префикс приватных партиций: in-memory, на диск ничего не пишется. */
const INCOGNITO_PREFIX = 'incognito-mem-'

/** Партиция приватного режима пространства. */
export function incognitoPartitionFor(wsId: string): string {
  return `${INCOGNITO_PREFIX}${wsId}`
}

export interface WorkspaceSessionContext {
  wsId: string
  partition: string
  /** true — обычная партиция (решения разрешений пишутся на диск). */
  persist: boolean
}

export type WorkspaceSessionHook = (ses: Electron.Session, ctx: WorkspaceSessionContext) => void

const hooks: WorkspaceSessionHook[] = []
const ensured = new Set<string>()

/**
 * Подписка на создание сессий пространства.
 *
 * Регистрируется один раз при старте (index.ts). Хук вызывается для каждой
 * новой пары сессий — обычной и приватной.
 */
export function onWorkspaceSession(hook: WorkspaceSessionHook): void {
  hooks.push(hook)
}

function runHooks(ses: Electron.Session, ctx: WorkspaceSessionContext): void {
  for (const hook of hooks) {
    try {
      hook(ses, ctx)
    } catch (err) {
      // Один сломанный хук не должен оставить сессию без остальных:
      // без preload внутренние страницы теряют window.konstruktor, но
      // вкладки и сайты продолжают работать.
      console.error('[workspace] session hook failed:', err)
    }
  }
}

/**
 * Готовит сессии пространства: обычную и приватную.
 *
 * Повторный вызов — no-op. Возвращает true, если сессии поднимались этим
 * вызовом: по нему вызывающий понимает, стоит ли ждать готовности.
 */
export function ensureWorkspaceSession(wsId: string): boolean {
  if (ensured.has(wsId)) return false
  ensured.add(wsId)
  const normalPartition = partitionFor(wsId)
  const normal = session.fromPartition(normalPartition)
  runHooks(normal, { wsId, partition: normalPartition, persist: true })
  const privatePartition = incognitoPartitionFor(wsId)
  const priv = session.fromPartition(privatePartition)
  runHooks(priv, { wsId, partition: privatePartition, persist: false })
  return true
}

/** Поднимались ли сессии пространства в этом процессе. */
export function workspaceSessionReady(wsId: string): boolean {
  return ensured.has(wsId)
}
