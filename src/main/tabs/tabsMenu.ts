// Контекстные меню панели вкладок: ПКМ по вкладке и по пустому месту.
// Выделено из index.ts по образцу groupsMenu/windowMenu: здесь только
// сборка пунктов и их действия, без знания об устройстве оверлея.
import { BrowserWindow, clipboard, ipcMain } from 'electron'
import { findTab, getState } from '../windows/browserState'
import { ensureStripToken, removeStripToken } from './stripOrder'
import { getGroups, createSavedGroup } from '../groups/groupsStore'
import { showOverlay, type OverlayMenuItem } from '../overlay'
import { t } from '../i18n'
import { createTab, closeTab, pushTabsState, pruneEmptyGroup } from '../windows/deps'
import { START_URL } from '../pages/internalPages'

export function registerTabsMenuIpc(): void {
  ipcMain.on('tabs:context-menu', (e, payload: { id: number; x: number; y: number }) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const ws = win ? getState(win) : undefined
    if (!win || !ws) return
    const rec = ws.tabs.get(payload.id)
    if (!rec) return
    const id = payload.id
    // Пункт добавления в группу — всегда: второй уровень показывает
    // открытые группы + шаблоны из закладок (закрытые откроются).
    // Remove — только для вкладки, которая реально в группе.
    const inGroup = !!rec.groupId && ws.openGroups.some((g) => g.instanceId === rec.groupId)
    const items: OverlayMenuItem[] = [
      rec.pinned
        ? { id: 'unpin', label: t('tabs.unpin'), icon: '↔️' }
        : { id: 'pin', label: t('tabs.pin'), icon: '🤏' },
      { id: 'duplicate', label: t('tabs.duplicate'), icon: '👥' },
      { id: 'add-to-group', label: t('tabs.addToGroup'), icon: '📁' },
      ...(inGroup
        ? [{ id: 'remove-from-group', label: t('tabs.removeFromGroup'), icon: '📂' }]
        : []),
      { id: 'rename', label: t('tabs.rename'), icon: '✏️' },
      { id: 'set-icon', label: t('tabs.changeIcon'), icon: '🖼️' },
      { id: 'copy-url', label: t('tabs.copyUrl'), icon: '🔗' },
      { id: 'reload', label: t('tabs.reload'), icon: '🔄' },
      { id: 'close', label: t('tabs.close'), icon: '✕' }
    ]
    showOverlay(win, {
      kind: 'menu',
      anchor: { x: Math.round(payload.x), y: Math.round(payload.y) },
      items,
      align: 'start',
      onSelect: (action) => {
        const target = findTab(id)
        if (!target) return
        const { ws: tws, rec: trec } = target
        if (action === 'pin' || action === 'unpin') {
          trec.pinned = action === 'pin'
          pushTabsState(tws)
        } else if (action === 'duplicate') {
          const newId = createTab(tws, trec.url)
          tws.tabOrder = tws.tabOrder.filter((t) => t !== newId)
          const at = tws.tabOrder.indexOf(id)
          tws.tabOrder.splice(at + 1, 0, newId)
          pushTabsState(tws)
        } else if (action === 'copy-url') {
          clipboard.writeText(trec.url)
        } else if (action === 'reload') {
          trec.view.webContents.reload()
        } else if (action === 'close') {
          closeTab(tws, id)
        } else if (action === 'add-to-group' || action === 'remove-from-group') {
          // Выбор группы — второй уровень меню: открытые экземпляры
          // + шаблоны из закладок (закрытый шаблон откроется и примет вкладку).
          const parent = tws.window
          if (!parent) return
          if (action === 'remove-from-group') {
            const old = trec.groupId
            trec.groupId = undefined
            if (old) {
              pruneEmptyGroup(tws, old)
              removeStripToken(tws, `t:${id}`)
              ensureStripToken(tws, `t:${id}`, trec.pinned)
            }
            pushTabsState(tws)
            return
          }
          void getGroups().then((saved) => {
            const live = findTab(id)
            if (!live) return
            // Все открытые корневые экземпляры (как на панели вкладок)
            // + закрепленные шаблоны из закладок, даже закрытые.
            // Иконка/название/цвет — как задано в шаблоне.
            const byId = new Map(saved.map((g) => [g.id, g]))
            const seen = new Set<string>()
            const targets: OverlayMenuItem[] = []
            for (const g of live.ws.openGroups) {
              if (g.parentInstanceId || seen.has(g.savedId)) continue
              const s = byId.get(g.savedId)
              if (!s) continue
              seen.add(g.savedId)
              targets.push({
                id: g.instanceId,
                label: s.name,
                icon: s.icon?.startsWith('emoji:') ? s.icon.replace(/^emoji:/, '') : s.icon || '📁',
                color: s.color
              })
            }
            for (const g of saved) {
              if (!g.pinned || seen.has(g.id)) continue
              seen.add(g.id)
              targets.push({
                id: `saved:${g.id}`,
                label: t('tabs.closedGroup', { name: g.name }),
                icon: g.icon?.startsWith('emoji:') ? g.icon.replace(/^emoji:/, '') : g.icon || '📁',
                color: g.color
              })
            }
            if (targets.length === 0) return
            showOverlay(parent, {
              kind: 'menu',
              anchor: { x: Math.round(payload.x), y: Math.round(payload.y) },
              items: targets,
              align: 'start',
              onSelect: (targetId) => {
                const cur = findTab(id)
                if (!cur) return
                // Закрытый шаблон: открываем экземпляр, вкладка — первой.
                if (targetId.startsWith('saved:')) {
                  const savedId = targetId.slice('saved:'.length)
                  void getGroups().then((fresh) => {
                    const s = fresh.find((g) => g.id === savedId)
                    const l2 = findTab(id)?.ws
                    if (!s || !l2) return
                    const nid = `i${Date.now()}${Math.floor(Math.random() * 1000)}`
                    l2.openGroups.push({ instanceId: nid, savedId: s.id, collapsed: false, pinned: false })
                    ensureStripToken(l2, `g:${nid}`, false)
                    const old = cur.rec.groupId
                    cur.rec.groupId = nid
                    removeStripToken(l2, `t:${id}`)
                    l2.tabOrder = l2.tabOrder.filter((t) => t !== id)
                    l2.tabOrder.push(id)
                    if (old) pruneEmptyGroup(l2, old)
                    pushTabsState(l2)
                  })
                  return
                }
                const old = cur.rec.groupId
                cur.rec.groupId = targetId
                removeStripToken(cur.ws, `t:${id}`)
                cur.ws.tabOrder = cur.ws.tabOrder.filter((t) => t !== id)
                let at = cur.ws.tabOrder.length
                for (let i = cur.ws.tabOrder.length - 1; i >= 0; i--) {
                  if (cur.ws.tabs.get(cur.ws.tabOrder[i])?.groupId === targetId) {
                    at = i + 1
                    break
                  }
                }
                cur.ws.tabOrder.splice(at, 0, id)
                if (old) pruneEmptyGroup(cur.ws, old)
                pushTabsState(cur.ws)
              }
            })
          })
        } else if (action === 'rename') {
          // Переименование — инлайн в самой вкладке (TabStrip),
          // без отдельных окон: шлем событие в renderer.
          tws.window?.webContents.send('tabs:tab-action', { id, action })
        } else if (action === 'set-icon') {
          // Общий диалог иконки: URL, файл, emoji + отмена, верификация в main.
          const parent = tws.window
          if (!parent) return
          showOverlay(parent, {
            kind: 'icon',
            anchor: { x: 0, y: 0 },
            icon: {
              title: t('icon.tabTitle'),
              placeholder: t('icon.placeholder'),
              initial: trec.customFavicon ?? ''
            },
            onIconApply: (icon) => {
              const live = findTab(id)
              if (!live) return
              // Пустой ввод = сброс к иконке сайта.
              live.rec.customFavicon = icon ? icon : undefined
              pushTabsState(live.ws)
            }
          })
        }
      }
    })
  })
  // Контекстное меню самой панели вкладок (мимо вкладок):
  // создать вкладку, создать группу, закрыть все вкладки окна.
  ipcMain.on('tabs:strip-context-menu', (e, payload: { x: number; y: number }) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const ws = win ? getState(win) : undefined
    if (!win || !ws) return
    const items: OverlayMenuItem[] = [
      { id: 'new-tab', label: t('tabs.newTab'), icon: '＋' },
      { id: 'new-group', label: t('groups.menu.new'), icon: '📁' },
      { id: 'close-all', label: t('groups.menu.close'), icon: '✕' }
    ]
    showOverlay(win, {
      kind: 'menu',
      anchor: { x: Math.round(payload.x), y: Math.round(payload.y) },
      items,
      align: 'start',
      onSelect: (action) => {
        const live = win && !win.isDestroyed() ? getState(win) : undefined
        if (!live) return
        if (action === 'new-tab') {
          createTab(live)
        } else if (action === 'new-group') {
          // Новая группа = шаблон + экземпляр с 1 вкладкой (минимум).
          // createTab кладет токен в ряд, но вкладка сразу уходит в группу —
          // чистим токен вкладки и кладем токен группы, иначе группа не видна.
          void createSavedGroup({ name: t('groups.defaultName'), urls: [START_URL] }).then(
            (saved) => {
              const l2 = win && !win.isDestroyed() ? getState(win) : undefined
              if (!l2) return
              const instanceId = `i${Date.now()}${Math.floor(Math.random() * 1000)}`
              l2.openGroups.push({ instanceId, savedId: saved.id, collapsed: false, pinned: false })
              ensureStripToken(l2, `g:${instanceId}`, false)
              const id = createTab(l2, START_URL)
              l2.tabs.get(id)!.groupId = instanceId
              removeStripToken(l2, `t:${id}`)
              pushTabsState(l2)
            }
          )
        } else if (action === 'close-all') {
          // Закрываем по копии порядка: closeTab мутирует tabOrder.
          for (const id of [...live.tabOrder]) closeTab(live, id)
        }
      }
    })
  })
}
