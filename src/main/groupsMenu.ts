// Контекстное меню заголовка группы: полный набор действий.
// Выделено из groupsManager.ts: здесь только showOverlay + onSelect.
// Мутации экземпляров — через groupsInstances.ts, шаблоны — через groupsStore.
import { BrowserWindow } from 'electron'
import { getState, windows, type WindowState } from './browserState'
import { removeStripToken } from './stripOrder'
import {
  getGroups,
  createSavedGroup,
  updateSavedGroup,
  deleteSavedGroup
} from './groupsStore'
import { showOverlay, type OverlayMenuItem } from './overlay'
import { START_URL } from './startPage'
import { t } from './i18n'
import {
  allocInstance,
  syncSavedUrls,
  demoteToChild,
  removeSavedInstances,
  type GroupTabDeps
} from './groupsInstances'

export interface GroupMenuDeps extends GroupTabDeps {
  broadcastGroups: () => void
}

// DFS от child: parent не должен быть достижим — иначе цикл.
function reaches(
  byId: Map<string, { children: string[] }>,
  from: string,
  target: string,
  seen: string[] = []
): boolean {
  if (from === target) return true
  if (seen.includes(from)) return false
  const node = byId.get(from)
  if (!node) return false
  return node.children.some((c) => reaches(byId, c, target, [...seen, from]))
}

export function showGroupContextMenu(
  win: BrowserWindow,
  ws: WindowState,
  instanceId: string,
  anchor: { x: number; y: number },
  deps: GroupMenuDeps
): void {
  const inst = ws.openGroups.find((g) => g.instanceId === instanceId)
  if (!inst) return
  const { closeTab, pushTabsState, pruneEmptyGroup, broadcastGroups } = deps
  const others = ws.openGroups.filter((g) => g.instanceId !== instanceId)
  // Закрепление шаблона: подпись зависит от текущего состояния (async).
  void getGroups().then((list) => {
    const savedNow = list.find((g) => g.id === inst.savedId)
    const pinLabel = savedNow?.pinned
      ? t('groups.menu.unpinFromBookmarks')
      : t('groups.menu.pinToBookmarks')
  const items: OverlayMenuItem[] = [
    { id: 'new-group', label: t('groups.menu.new'), icon: '＋' },
    { id: 'rename', label: t('groups.menu.rename'), icon: '✏️' },
    { id: 'color', label: t('groups.menu.color'), icon: '🎨' },
    { id: 'icon', label: t('groups.menu.icon'), icon: '🖼️' },
    { id: 'nest-into', label: t('groups.menu.nest'), icon: '📥' },
    { id: 'toggle-bookmark-pin', label: pinLabel, icon: '📌' },
    { id: 'close-tabs', label: t('groups.menu.close'), icon: '✕' },
    { id: 'ungroup', label: t('groups.menu.ungroup'), icon: '📂' },
    { id: 'delete-group', label: t('groups.menu.delete'), icon: '🗑️' },
    ...(others.length > 0
      ? [{ id: 'move-tabs', label: t('groups.menu.moveTabs'), icon: '➡️' }]
      : [])
  ]
  showOverlay(win, {
    kind: 'menu',
    anchor: { x: Math.round(anchor.x), y: Math.round(anchor.y) },
    items,
    align: 'start',
    onSelect: (action) => {
      const live = win && !win.isDestroyed() ? getState(win) : undefined
      if (!live) return
      const cur = live.openGroups.find((g) => g.instanceId === instanceId)
      if (!cur) return
      // onSelect у showOverlay синхронный: async-ветки уходят в void-промисы.
      if (action === 'new-group') {
        void createSavedGroup({ name: t('groups.defaultName'), urls: [START_URL] }).then(
          (saved) => {
            const nid = allocInstance()
            live.openGroups.push({
              instanceId: nid,
              savedId: saved.id,
              collapsed: false,
              pinned: false
            })
            pushTabsState(live)
          }
        )
      } else if (action === 'rename' || action === 'color') {
        // Ввод значения — через центральный диалог, результат в onSelect.
        const titles: Record<string, string> = {
          rename: t('dialogs.groupName'),
          color: t('dialogs.groupColor')
        }
        showOverlay(win, {
          kind: 'dialog',
          anchor: { x: 0, y: 0 },
          dialog: {
            title: titles[action] ?? t('groups.defaultName'),
            buttons: [
              { id: 'ok', label: t('common.ok') },
              { id: '__cancel__', label: t('common.cancel') }
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
              title: t('icon.groupTitle'),
              placeholder: t('icon.placeholder'),
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
            removeSavedInstances(other, savedId)
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
                label: s?.name ?? t('groups.defaultName'),
                icon: s?.icon?.startsWith('emoji:')
                  ? s.icon.replace(/^emoji:/, '')
                  : s?.icon || '📁',
                color: s?.color
              }
            })
          if (targets.length === 0) return
          showOverlay(win, {
            kind: 'menu',
            anchor: { x: Math.round(anchor.x), y: Math.round(anchor.y) },
            items: targets,
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
          const targets: OverlayMenuItem[] = groups
            .filter((g) => g.id !== cur2.savedId && !reaches(byId, cur2.savedId, g.id))
            .map((g) => ({
              id: g.id,
              label: g.name,
              icon: g.icon?.startsWith('emoji:') ? g.icon.replace(/^emoji:/, '') : g.icon || '📁',
              color: g.color
            }))
          if (targets.length === 0) return
          showOverlay(win, {
            kind: 'menu',
            anchor: { x: Math.round(anchor.x), y: Math.round(anchor.y) },
            items: targets,
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
                  if (targetInst) demoteToChild(l4, cur4.instanceId, targetInst.instanceId)
                  pushTabsState(l4)
                })
              })
            }
          })
        })
      }
    }
  })
  }).catch(() => undefined)
}
