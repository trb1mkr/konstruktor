// IPC групп вкладок: шаблоны в groups.json + открытые экземпляры.
// Выделено из index.ts: registerGroupsIpc вешает все groups:* хендлеры.
// Экземпляр = { instanceId, savedId }: один шаблон открывается несколько раз.
import { BrowserWindow, ipcMain } from 'electron'
import {
  getState,
  findTab,
  windows,
  type WindowState
} from './browserState'
import {
  getGroups,
  createSavedGroup,
  updateSavedGroup,
  deleteSavedGroup
} from './groupsStore'
import {
  showOverlay,
  type OverlayMenuItem
} from './overlayManager'
import { START_URL } from './startPage'

let nextInstance = 1

function allocInstance(): string {
  return `i${nextInstance++}`
}

function syncSavedUrls(ws: WindowState, instanceId: string): void {
  const urls = ws.tabOrder
    .map((id) => ws.tabs.get(id))
    .filter((t) => t && t.groupId === instanceId)
    .map((t) => t!.url)
    .filter((u) => u && u !== 'about:blank')
  const inst = ws.openGroups.find((g) => g.instanceId === instanceId)
  if (!inst || urls.length === 0) return
  void updateSavedGroup(inst.savedId, { urls }).catch(() => undefined)
}

export function openSavedGroup(
  ws: WindowState,
  savedId: string,
  createTab: (ws: WindowState, url?: string) => number,
  pushTabsState: (ws: WindowState) => void,
  strip?: {
    ensureStripToken: (ws: WindowState, token: string, pinned: boolean) => void
    removeStripToken: (ws: WindowState, token: string) => void
  }
): string | null {
  if (!ws.window) return null
  void (async () => {
    const list = await getGroups()
    const saved = list.find((g) => g.id === savedId)
    if (!saved) return
    const instanceId = allocInstance()
    ws.openGroups.push({ instanceId, savedId: saved.id, collapsed: false, pinned: false })
    strip?.ensureStripToken(ws, `g:${instanceId}`, false)
    for (const url of saved.urls.length > 0 ? saved.urls : [START_URL]) {
      const id = createTab(ws, url)
      ws.tabs.get(id)!.groupId = instanceId
      // createTab кладет токен вкладки в ряд — вкладка уходит в группу,
      // токен вкладки лишний, иначе ряд рассинхронизируется.
      strip?.removeStripToken(ws, `t:${id}`)
    }
    pushTabsState(ws)
  })()
  // instanceId нужен синхронно для меню — возвращаем последний выданный.
  return ws.openGroups[ws.openGroups.length - 1]?.instanceId ?? null
}

type WsOf = (e: { sender: Electron.WebContents }) => WindowState

export function registerGroupsIpc(
  wsOf: WsOf,
  deps: {
    createTab: (ws: WindowState, url?: string) => number
    closeTab: (ws: WindowState, id: number) => void
    setActiveTab: (ws: WindowState, id: number) => void
    pushTabsState: (ws: WindowState) => void
    pruneEmptyGroup: (ws: WindowState, instanceId: string) => void
    // Единый ряд панели: корневые группы того же ранга, что вкладки.
    ensureStripToken: (ws: WindowState, token: string, pinned: boolean) => void
    removeStripToken: (ws: WindowState, token: string) => void
    moveStripToken: (ws: WindowState, token: string, pinned: boolean) => void
  }
): void {
  const { createTab, closeTab, setActiveTab, pushTabsState, pruneEmptyGroup, ensureStripToken, removeStripToken, moveStripToken } = deps

  // Моментальная синхронизация шаблонов: после каждой мутации store
  // рассылаем свежий список во все окна — shell не ждет tabs:state.
  const broadcastGroups = () => {
    void getGroups()
      .then((groups) => {
        for (const ws of windows.values()) {
          ws.window?.webContents.send('groups:changed', groups)
        }
      })
      .catch(() => undefined)
  }

  ipcMain.handle('groups:list', () => getGroups())
  // Создать шаблон + сразу открыть экземпляр в этом окне.
  ipcMain.handle(
    'groups:create',
    async (e, input: { name?: string; icon?: string; color?: string; pinned?: boolean }) => {
      const ws = wsOf(e)
      const saved = await createSavedGroup({
        name: input.name ?? 'Group',
        icon: input.icon ?? '',
        color: input.color ?? '#888888',
        urls: [START_URL],
        pinned: input.pinned
      })
      const instanceId = allocInstance()
      ws.openGroups.push({ instanceId, savedId: saved.id, collapsed: false, pinned: false })
      ensureStripToken(ws, `g:${instanceId}`, false)
      const id = createTab(ws, START_URL)
      ws.tabs.get(id)!.groupId = instanceId
      removeStripToken(ws, `t:${id}`)
      pushTabsState(ws)
      broadcastGroups()
      return { saved, instanceId }
    }
  )
  // Открыть шаблон: новый экземпляр, можно несколько одинаковых.
  // Дочерние группы открываются рекурсивно внутрь родителя.
  ipcMain.handle('groups:open', async (e, savedId: string) => {
    const ws = wsOf(e)
    const list = await getGroups()
    const byId = new Map(list.map((g) => [g.id, g]))
    const saved = byId.get(savedId)
    if (!saved) throw new Error(`Group ${savedId} not found`)
    const openRec = (id: string, parentInstanceId?: string, seen: string[] = []): void => {
      if (seen.includes(id)) return
      const s = byId.get(id)
      if (!s) return
      const instanceId = allocInstance()
      ws.openGroups.push({ instanceId, savedId: s.id, collapsed: false, pinned: false, parentInstanceId })
      // В единый ряд — только корневые: вложенные рисуются внутри родителя.
      if (!parentInstanceId) ensureStripToken(ws, `g:${instanceId}`, false)
      for (const url of s.urls.length > 0 ? s.urls : [START_URL]) {
        const tabId = createTab(ws, url)
        ws.tabs.get(tabId)!.groupId = instanceId
        removeStripToken(ws, `t:${tabId}`)
      }
      for (const child of s.children) openRec(child, instanceId, [...seen, id])
    }
    openRec(savedId)
    pushTabsState(ws)
    return ws.openGroups[ws.openGroups.length - 1]?.instanceId ?? ''
  })
  ipcMain.handle('groups:rename', async (_e, savedId: string, name: string) => {
    const res = await updateSavedGroup(savedId, { name })
    broadcastGroups()
    return res
  })
  ipcMain.handle('groups:set-color', async (_e, savedId: string, color: string) => {
    const res = await updateSavedGroup(savedId, { color })
    broadcastGroups()
    return res
  })
  ipcMain.handle(
    'groups:set-icon',
    async (_e, savedId: string, icon: string) => {
      const res = await updateSavedGroup(savedId, { icon })
      broadcastGroups()
      return res
    }
  )
  // Удалить шаблон: открытые экземпляры разгруппировываются, вкладки живут.
  ipcMain.handle('groups:delete', async (e, savedId: string) => {
    const ws = wsOf(e)
    await deleteSavedGroup(savedId)
    for (const g of ws.openGroups.filter((x) => x.savedId === savedId)) {
      for (const [, rec] of ws.tabs) {
        if (rec.groupId === g.instanceId) rec.groupId = undefined
      }
      removeStripToken(ws, `g:${g.instanceId}`)
    }
    ws.openGroups = ws.openGroups.filter((x) => x.savedId !== savedId)
    pushTabsState(ws)
    broadcastGroups()
    return true
  })
  ipcMain.handle('groups:toggle-collapse', (e, instanceId: string) => {
    const ws = wsOf(e)
    const g = ws.openGroups.find((x) => x.instanceId === instanceId)
    if (!g) return false
    g.collapsed = !g.collapsed
    // Свернутая группа прячет view, кроме активной — иначе пустой экран.
    for (const [id, rec] of ws.tabs) {
      if (rec.groupId !== instanceId) continue
      if (id === ws.activeTabId) continue
      rec.view.setVisible(!g.collapsed)
    }
    pushTabsState(ws)
    return g.collapsed
  })
  ipcMain.handle('groups:toggle-pin', (e, instanceId: string) => {
    const ws = wsOf(e)
    const g = ws.openGroups.find((x) => x.instanceId === instanceId)
    if (!g) return false
    g.pinned = !g.pinned
    // Пин двигает корневую группу между зонами единого ряда.
    if (!g.parentInstanceId) moveStripToken(ws, `g:${instanceId}`, g.pinned)
    pushTabsState(ws)
    return g.pinned
  })
  // Закрепление шаблона на панели закладок: незакрепленная группа
  // живет только на панели вкладок, пока открыта.
  ipcMain.handle('groups:toggle-bookmark-pin', async (_e, savedId: string) => {
    const list = await getGroups()
    const cur = list.find((g) => g.id === savedId)
    if (!cur) throw new Error(`Group ${savedId} not found`)
    const res = await updateSavedGroup(savedId, { pinned: !cur.pinned })
    broadcastGroups()
    return res
  })
  // Вложить группу в группу: дочерний шаблон открывается внутри родителя.
  // Циклы запрещены: проверяем, что target не внутри source.
  ipcMain.handle('groups:nest', async (e, childSavedId: string, parentSavedId: string) => {
    const ws = wsOf(e)
    const list = await getGroups()
    const byId = new Map(list.map((g) => [g.id, g]))
    if (!byId.has(childSavedId) || !byId.has(parentSavedId)) {
      throw new Error('Group not found')
    }
    if (childSavedId === parentSavedId) throw new Error('Cannot nest group into itself')
    // DFS от child: parent не должен быть достижим.
    const reaches = (from: string, target: string, seen: string[] = []): boolean => {
      if (from === target) return true
      if (seen.includes(from)) return false
      const node = byId.get(from)
      if (!node) return false
      return node.children.some((c) => reaches(c, target, [...seen, from]))
    }
    if (reaches(childSavedId, parentSavedId)) throw new Error('Nesting would create a cycle')
    const parent = byId.get(parentSavedId)!
    if (!parent.children.includes(childSavedId)) {
      const res = await updateSavedGroup(parentSavedId, {
        children: [...parent.children, childSavedId]
      })
      broadcastGroups()
      // Если родитель открыт — открываем ребенка внутрь сразу.
      for (const inst of ws.openGroups.filter((g) => g.savedId === parentSavedId)) {
        const nid = allocInstance()
        ws.openGroups.push({
          instanceId: nid,
          savedId: childSavedId,
          collapsed: false,
          pinned: false,
          parentInstanceId: inst.instanceId
        })
        // Вложенная — внутри родителя, в единый ряд не входит.
        const child = byId.get(childSavedId)!
        for (const url of child.urls.length > 0 ? child.urls : [START_URL]) {
          const tabId = createTab(ws, url)
          ws.tabs.get(tabId)!.groupId = nid
          removeStripToken(ws, `t:${tabId}`)
        }
      }
      pushTabsState(ws)
      return res
    }
    return parent
  })
  // Вынуть группу из родителя: связь в store рвется, открытый
  // экземпляр поднимается на верхний уровень панели вкладок.
  ipcMain.handle('groups:unnest', async (e, childSavedId: string, parentSavedId: string) => {
    const ws = wsOf(e)
    const list = await getGroups()
    const parent = list.find((g) => g.id === parentSavedId)
    if (!parent) throw new Error(`Group ${parentSavedId} not found`)
    const res = await updateSavedGroup(parentSavedId, {
      children: parent.children.filter((c) => c !== childSavedId)
    })
    broadcastGroups()
    for (const inst of ws.openGroups.filter(
      (g) => g.savedId === childSavedId && g.parentInstanceId
    )) {
      inst.parentInstanceId = undefined
      // Поднялась на верхний уровень — в конец обычного ряда.
      ensureStripToken(ws, `g:${inst.instanceId}`, inst.pinned)
    }
    pushTabsState(ws)
    return res
  })
  // Положить вкладку в группу: вкладка переезжает в конец группы.
  ipcMain.handle('groups:add-tab', (e, tabId: number, instanceId: string) => {
    const found = findTab(tabId)
    if (!found) throw new Error(`Tab ${tabId} not found`)
    const { ws, rec } = found
    if (!ws.openGroups.some((g) => g.instanceId === instanceId)) {
      throw new Error(`Group instance ${instanceId} not found`)
    }
    const old = rec.groupId
    rec.groupId = instanceId
    // Вкладка уходит из единого ряда внутрь группы.
    removeStripToken(ws, `t:${tabId}`)
    // Переставляем вкладку в конец группы в tabOrder.
    ws.tabOrder = ws.tabOrder.filter((t) => t !== tabId)
    let at = ws.tabOrder.length
    for (let i = ws.tabOrder.length - 1; i >= 0; i--) {
      if (ws.tabs.get(ws.tabOrder[i])?.groupId === instanceId) {
        at = i + 1
        break
      }
    }
    ws.tabOrder.splice(at, 0, tabId)
    if (old) {
      pruneEmptyGroup(ws, old)
      syncSavedUrls(ws, old)
    }
    syncSavedUrls(ws, instanceId)
    pushTabsState(ws)
    return true
  })
  // Убрать вкладку из группы: вкладка остается в окне без группы.
  ipcMain.handle('groups:remove-tab', (e, tabId: number) => {
    const found = findTab(tabId)
    if (!found) throw new Error(`Tab ${tabId} not found`)
    const { ws, rec } = found
    const old = rec.groupId
    rec.groupId = undefined
    // Вышла из группы — в конец своей зоны единого ряда.
    ensureStripToken(ws, `t:${tabId}`, rec.pinned)
    if (old) {
      pruneEmptyGroup(ws, old)
      syncSavedUrls(ws, old)
    }
    pushTabsState(ws)
    return true
  })
  // Разгруппировать: все вкладки экземпляра становятся обычными.
  ipcMain.handle('groups:ungroup', (e, instanceId: string) => {
    const ws = wsOf(e)
    for (const [, rec] of ws.tabs) {
      if (rec.groupId === instanceId) rec.groupId = undefined
    }
    ws.openGroups = ws.openGroups.filter((g) => g.instanceId !== instanceId)
    removeStripToken(ws, `g:${instanceId}`)
    pushTabsState(ws)
    return true
  })
  // Закрыть все вкладки экземпляра: экземпляр исчезает, шаблон остается.
  ipcMain.handle('groups:close-tabs', (e, instanceId: string) => {
    const ws = wsOf(e)
    for (const id of [...ws.tabOrder]) {
      if (ws.tabs.get(id)?.groupId === instanceId) closeTab(ws, id)
    }
    pruneEmptyGroup(ws, instanceId)
    pushTabsState(ws)
    return true
  })
  // Перенести все вкладки экземпляра в другой экземпляр.
  ipcMain.handle('groups:move-tabs', (e, fromInstance: string, toInstance: string) => {
    const ws = wsOf(e)
    if (!ws.openGroups.some((g) => g.instanceId === toInstance)) {
      throw new Error(`Group instance ${toInstance} not found`)
    }
    for (const [, rec] of ws.tabs) {
      if (rec.groupId === fromInstance) rec.groupId = toInstance
    }
    pruneEmptyGroup(ws, fromInstance)
    syncSavedUrls(ws, toInstance)
    pushTabsState(ws)
    return true
  })
  // Контекстное меню заголовка группы: полный набор действий.
  ipcMain.on(
    'groups:context-menu',
    (e, payload: { instanceId: string; x: number; y: number }) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      const ws = win ? getState(win) : undefined
      if (!win || !ws) return
      const inst = ws.openGroups.find((g) => g.instanceId === payload.instanceId)
      if (!inst) return
      const instanceId = payload.instanceId
      const others = ws.openGroups.filter((g) => g.instanceId !== instanceId)
      const items: OverlayMenuItem[] = [
        { id: 'new-group', label: 'New group', icon: '＋' },
        { id: 'rename', label: 'Rename', icon: '✏️' },
        { id: 'color', label: 'Change color', icon: '🎨' },
        { id: 'icon', label: 'Change icon', icon: '🖼️' },
        { id: 'nest-into', label: 'Nest into another group', icon: '📥' },
        { id: 'toggle-bookmark-pin', label: 'Pin to bookmarks bar', icon: '📌' },
        { id: 'close-tabs', label: 'Close group', icon: '✕' },
        { id: 'ungroup', label: 'Ungroup', icon: '📂' },
        { id: 'delete-group', label: 'Delete group', icon: '🗑️' },
        ...(others.length > 0
          ? [{ id: 'move-tabs', label: 'Move tabs to another group', icon: '➡️' }]
          : [])
      ]
      showOverlay(win, {
        kind: 'menu',
        anchor: { x: Math.round(payload.x), y: Math.round(payload.y) },
        items,
        incognito: false,
        align: 'start',
        onSelect: (action) => {
          const live = win && !win.isDestroyed() ? getState(win) : undefined
          if (!live) return
          const cur = live.openGroups.find((g) => g.instanceId === instanceId)
          if (!cur) return
          // onSelect у showOverlay синхронный: async-ветки уходят в void-промисы.
          if (action === 'new-group') {
            void createSavedGroup({ name: 'Group', urls: [START_URL] }).then((saved) => {
              const nid = allocInstance()
              live.openGroups.push({ instanceId: nid, savedId: saved.id, collapsed: false, pinned: false })
              pushTabsState(live)
            })
          } else if (action === 'rename' || action === 'color') {
            // Ввод значения — через центральный диалог, результат в onSelect.
            const titles: Record<string, string> = {
              rename: 'Group name',
              color: 'Group color (e.g. #ff5555)'
            }
            showOverlay(win, {
              kind: 'dialog',
              anchor: { x: 0, y: 0 },
              dialog: {
                title: titles[action] ?? 'Group',
                buttons: [
                  { id: 'ok', label: 'OK' },
                  { id: '__cancel__', label: 'Cancel' }
                ]
              },
              onSelect: (raw) => {
                const sep = raw.indexOf('::')
                const btn = sep >= 0 ? raw.slice(0, sep) : raw
                const text = sep >= 0 ? raw.slice(sep + 2) : ''
                if (btn !== 'ok') return
                if (action === 'rename') {
                  void updateSavedGroup(cur.savedId, { name: text }).then(() => broadcastGroups())
                } else {
                  void updateSavedGroup(cur.savedId, { color: text.trim() }).then(() => broadcastGroups())
                }
              }
            })
          } else if (action === 'icon') {
            // Общий диалог иконки: URL, файл, emoji + отмена, верификация в main.
            void getGroups().then((groups) => {
              const saved = groups.find((g) => g.id === cur.savedId)
              showOverlay(win, {
                kind: 'icon',
                anchor: { x: 0, y: 0 },
                icon: {
                  title: 'Group icon',
                  placeholder: 'URL, file path or emoji (empty resets)',
                  initial: saved?.icon ?? ''
                },
                onIconApply: (icon) => {
                  void updateSavedGroup(cur.savedId, { icon }).then(() => broadcastGroups())
                }
              })
            })
          } else if (action === 'delete-group') {
            // Удалить шаблон отовсюду: из store, из закладок, из всех окон.
            // Вкладки открытых экземпляров разгруппировываются и живут дальше.
            // onSelect синхронный — уходим в void-промис.
            const savedId = cur.savedId
            void deleteSavedGroup(savedId).then(() => {
              const l5 = win && !win.isDestroyed() ? getState(win) : undefined
              if (!l5) {
                broadcastGroups()
                return
              }
              for (const other of windows.values()) {
                for (const g of other.openGroups.filter((x) => x.savedId === savedId)) {
                  for (const [, rec] of other.tabs) {
                    if (rec.groupId === g.instanceId) rec.groupId = undefined
                  }
                  removeStripToken(other, `g:${g.instanceId}`)
                }
                other.openGroups = other.openGroups.filter((x) => x.savedId !== savedId)
                pushTabsState(other)
              }
              broadcastGroups()
            })
          } else if (action === 'close-tabs') {
            for (const id of [...live.tabOrder]) {
              if (live.tabs.get(id)?.groupId === instanceId) closeTab(live, id)
            }
            pruneEmptyGroup(live, instanceId)
            pushTabsState(live)
          } else if (action === 'ungroup') {
            for (const [, rec] of live.tabs) {
              if (rec.groupId === instanceId) rec.groupId = undefined
            }
            live.openGroups = live.openGroups.filter((g) => g.instanceId !== instanceId)
            removeStripToken(live, `g:${instanceId}`)
            pushTabsState(live)
          } else if (action === 'move-tabs') {
            // Второй уровень: выбор целевой группы тем же оверлеем.
            // Имена/иконки/цвета — как задано в шаблонах, без нумерации.
            // Одинаковые имена не нумеруем: пункты различаются иконкой/цветом.
            void getGroups().then((saved) => {
              const byId = new Map(saved.map((g) => [g.id, g]))
              const targets: OverlayMenuItem[] = live.openGroups
                .filter((g) => g.instanceId !== instanceId)
                .map((g) => {
                  const s = byId.get(g.savedId)
                  return {
                    id: g.instanceId,
                    label: s?.name ?? 'Group',
                    icon: s?.icon?.startsWith('emoji:')
                      ? s.icon.replace(/^emoji:/, '')
                      : s?.icon || '📁',
                    color: s?.color
                  }
                })
              if (targets.length === 0) return
              showOverlay(win, {
                kind: 'menu',
                anchor: { x: Math.round(payload.x), y: Math.round(payload.y) },
                items: targets,
                incognito: false,
                align: 'start',
                onSelect: (targetId) => {
                  const l2 = win && !win.isDestroyed() ? getState(win) : undefined
                  if (!l2) return
                  for (const [, rec] of l2.tabs) {
                    if (rec.groupId === instanceId) rec.groupId = targetId
                  }
                  pruneEmptyGroup(l2, instanceId)
                  syncSavedUrls(l2, targetId)
                  pushTabsState(l2)
                }
              })
            })
          } else if (action === 'nest-into' || action === 'toggle-bookmark-pin') {
            // Вложенность и закрепление работают с шаблоном, не с экземпляром.
            void getGroups().then((groups) => {
              const l2 = win && !win.isDestroyed() ? getState(win) : undefined
              const cur2 = l2?.openGroups.find((g) => g.instanceId === instanceId)
              if (!l2 || !cur2) return
              if (action === 'toggle-bookmark-pin') {
                const saved = groups.find((g) => g.id === cur2.savedId)
                if (!saved) return
                void updateSavedGroup(saved.id, { pinned: !saved.pinned }).then(() => broadcastGroups())
                return
              }
              // Кандидаты: все шаблоны кроме себя и своих потомков (без циклов).
              const byId = new Map(groups.map((g) => [g.id, g]))
              const reaches = (from: string, target: string, seen: string[] = []): boolean => {
                if (from === target) return true
                if (seen.includes(from)) return false
                const node = byId.get(from)
                if (!node) return false
                return node.children.some((c) => reaches(c, target, [...seen, from]))
              }
              const targets: OverlayMenuItem[] = groups
                .filter((g) => g.id !== cur2.savedId && !reaches(cur2.savedId, g.id))
                .map((g) => ({
                  id: g.id,
                  label: g.name,
                  icon: g.icon?.startsWith('emoji:') ? g.icon.replace(/^emoji:/, '') : g.icon || '📁',
                  color: g.color
                }))
              if (targets.length === 0) return
              showOverlay(win, {
                kind: 'menu',
                anchor: { x: Math.round(payload.x), y: Math.round(payload.y) },
                items: targets,
                incognito: false,
                align: 'start',
                onSelect: (targetSavedId) => {
                  const l3 = win && !win.isDestroyed() ? getState(win) : undefined
                  const cur3 = l3?.openGroups.find((g) => g.instanceId === instanceId)
                  if (!l3 || !cur3) return
                  void getGroups().then((fresh) => {
                    const parent = fresh.find((g) => g.id === targetSavedId)
                    if (!parent || parent.children.includes(cur3.savedId)) return
                    void updateSavedGroup(parent.id, {
                      children: [...parent.children, cur3.savedId]
                    }).then(() => {
                      broadcastGroups()
                      const l4 = win && !win.isDestroyed() ? getState(win) : undefined
                      const cur4 = l4?.openGroups.find((g) => g.instanceId === instanceId)
                      if (!l4 || !cur4) return
                      // Открытый экземпляр переезжает внутрь целевого экземпляра.
                      const targetInst = l4.openGroups.find((g) => g.savedId === targetSavedId)
                      if (targetInst) {
                        cur4.parentInstanceId = targetInst.instanceId
                        // Ушла внутрь — из единого ряда убираем.
                        removeStripToken(l4, `g:${cur4.instanceId}`)
                      }
                      pushTabsState(l4)
                    })
                  })
                }
              })
            })
          }
        }
      })
    }
  )
}
