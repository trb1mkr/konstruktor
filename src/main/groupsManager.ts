// IPC групп вкладок: тонкий роутер groups:* -> groupsInstances/groupsMenu/store.
// Мутации экземпляров — в groupsInstances.ts, меню — в groupsMenu.ts,
// здесь только хендлеры, broadcast и связь вкладка<->группа.
import { BrowserWindow, ipcMain } from 'electron'
import {
  getState,
  findTab,
  windows,
  type WindowState
} from './browserState'
import {
  ensureStripToken,
  removeStripToken
} from './stripOrder'
import {
  getGroups,
  updateSavedGroup,
  deleteSavedGroup
} from './groupsStore'
import { START_URL } from './startPage'
import {
  openInstance,
  createAndOpen,
  toggleCollapse,
  togglePin,
  promoteToRoot,
  syncSavedUrls,
  removeSavedInstances,
  type GroupTabDeps
} from './groupsInstances'
import { showGroupContextMenu } from './groupsMenu'

export type { GroupTabDeps }

type WsOf = (e: { sender: Electron.WebContents }) => WindowState

export function registerGroupsIpc(wsOf: WsOf, deps: GroupTabDeps): void {
  const { createTab, closeTab, pushTabsState, pruneEmptyGroup } = deps

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
  const menuDeps = { ...deps, broadcastGroups }

  ipcMain.handle('groups:list', () => getGroups())
  // Создать шаблон + сразу открыть экземпляр в этом окне.
  ipcMain.handle(
    'groups:create',
    async (e, input: { name?: string; icon?: string; color?: string; pinned?: boolean }) => {
      const ws = wsOf(e)
      const { savedId, instanceId } = await createAndOpen(ws, deps, input)
      broadcastGroups()
      const saved = (await getGroups()).find((g) => g.id === savedId)!
      return { saved, instanceId }
    }
  )
  // Открыть шаблон: новый экземпляр, можно несколько одинаковых.
  // Дочерние группы открываются рекурсивно внутрь родителя.
  ipcMain.handle('groups:open', async (e, savedId: string) => {
    const ws = wsOf(e)
    const list = await getGroups()
    if (!list.some((g) => g.id === savedId)) throw new Error(`Group ${savedId} not found`)
    openInstance(ws, deps, savedId)
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
    removeSavedInstances(ws, savedId)
    pushTabsState(ws)
    broadcastGroups()
    return true
  })
  ipcMain.handle('groups:toggle-collapse', (e, instanceId: string) => {
    return toggleCollapse(wsOf(e), deps, instanceId)
  })
  ipcMain.handle('groups:toggle-pin', (e, instanceId: string) => {
    return togglePin(wsOf(e), deps, instanceId)
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
        const nid = openInstance(ws, deps, childSavedId, inst.instanceId)
        void nid
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
      promoteToRoot(ws, inst.instanceId)
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
      showGroupContextMenu(win, ws, payload.instanceId, { x: payload.x, y: payload.y }, menuDeps)
    }
  )
}

// Совместимость: старый openSavedGroup(ws, savedId, createTab, pushTabsState, strip?).
// Оставлен для внешних вызовов — внутри используем openInstance.
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
  void strip
  void START_URL
  return openInstance(ws, {
    createTab,
    closeTab: () => undefined,
    setActiveTab: () => undefined,
    pushTabsState,
    pruneEmptyGroup: () => undefined
  }, savedId)
}
