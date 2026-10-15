// Каналы разрешений: якорь адресной строки, меню бейджа, управление
// решениями (страница настроек).
//
// Три группы по источнику сообщения:
//   permissions:anchor — приходит от shell (окно браузера). Позиция
//     адресной строки внутри окна: промпт разрешения встаёт под ней.
//   permissions:menu   — приходит от shell при клике по бейджу разрешений.
//   permissions:*      — страница konstruktor://settings: список решений,
//     сброс сайта, сброс всего.
//
// Отдельного канала на сам промпт нет: выбор уходит через overlay:submit
// (kind 'permission'), как у диалогов.
import { ipcMain } from 'electron'
import { BrowserWindow } from 'electron'
import {
  getDecision,
  clearOrigin,
  clearScope,
  clearAllDecisions,
  allDecisions,
} from './permissionsStore'
import { ALL_SCOPES, SCOPE_ICON, SCOPE_LABEL, originOfUrl, type PermissionScope } from './policy'
import { getState, windows, type WindowState } from '../windows/browserState'
import { closeOverlay, showOverlay, type OverlayMenuItem } from '../overlay'
import { pushTabsState } from '../tabs/tabsManager'
import { createTab } from '../windows/deps'
import { log } from '../overlay/logger'
import { t } from '../i18n'
import { PERMISSIONS_URL } from '../pages/internalPages'

/** Решения сайта в виде, удобном для списка в интерфейсе. */
function scopesOf(origin: string, persist: boolean): PermissionScope[] {
  return (Object.keys(SCOPE_ICON) as PermissionScope[]).filter(
    (scope) => getDecision(origin, scope, persist) !== undefined,
  )
}

export function registerPermissionsIpc(): void {
  // Якорь промпта: shell сообщает левый нижний угол адресной строки в
  // координатах содержимого окна. Положение панели знает только он —
  // пресеты кладут её и сверху, и снизу.
  ipcMain.on('permissions:anchor', (e, anchor: { x: number; y: number }) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const ws = win ? getState(win) : undefined
    if (!ws) return
    ws.permissionAnchor = {
      x: Math.max(0, Math.round(anchor.x)),
      y: Math.max(0, Math.round(anchor.y)),
    }
  })

  // Меню бейджа: что этот сайт уже получил. Сборка и показ — в
  // showPermissionsMenu: её же зовёт автопрогон, а обработчик остаётся
  // тонким.
  ipcMain.on('permissions:menu', (e, anchor: { x: number; y: number }) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const ws = win ? getState(win) : undefined
    if (!win || !ws) return
    showPermissionsMenu(ws, anchor)
  })

  // Список решений для страницы настроек. Приватные решения сюда не
  // попадают: они умирают вместе с процессом, и показывать их в списке,
  // который переживёт перезапуск, было бы обманом.
  ipcMain.handle('permissions:list', () => {
    const { origins } = allDecisions()
    return Object.entries(origins).map(([origin, record]) => ({
      origin,
      scopes: Object.entries(record).map(([scope, value]) => ({ scope, value })),
    }))
  })

  ipcMain.handle('permissions:clear-origin', async (_e, origin: string) => {
    await clearOrigin(origin, true)
    return true
  })

  // Снятие одной области: сайт остаётся в списке со своими остальными
  // решениями, а снятая область снова начнёт спрашивать. Бейдж в адресной
  // строке обязан пересчитаться — из разрешённых значков пропадает один.
  ipcMain.handle('permissions:clear-scope', async (_e, origin: string, scope: string) => {
    if (typeof origin !== 'string' || typeof scope !== 'string') return false
    if (!ALL_SCOPES.includes(scope as PermissionScope)) return false
    await clearScope(origin, scope as PermissionScope, true)
    log('session', 'site permission scope cleared', { origin, scope })
    for (const ws of windows.values()) pushTabsState(ws)
    return true
  })

  ipcMain.handle('permissions:clear-all', async () => {
    await clearAllDecisions()
    return true
  })
}

/**
 * Собирает и показывает меню бейджа разрешений.
 *
 * Решения разделены ПО СТАТУСУ подзаголовками, а не подписью «— Разрешено»
 * у каждой строки: список из десяти областей читался бы как десять
 * независимых фактов вместо двух групп.
 *
 * Вынесено из обработчика канала, потому что её же зовёт автопрогон
 * разрешений (`diagnostics.ts`): обработчик остаётся тонким, а логика
 * показа доступна тесту.
 */
export function showPermissionsMenu(ws: WindowState, anchor: { x: number; y: number }): void {
  const win = ws.window
  if (!win || win.isDestroyed()) return
  const rec = ws.activeTabId !== null ? ws.tabs.get(ws.activeTabId) : undefined
  const origin = originOfUrl(rec?.url)
  if (!origin) return
  const persist = !ws.incognito
  const scopes = scopesOf(origin, persist)
  const allowed = scopes.filter((scope) => getDecision(origin, scope, persist) === 'allow')
  const blocked = scopes.filter((scope) => getDecision(origin, scope, persist) !== 'allow')
  const items: OverlayMenuItem[] = []
  // Подзаголовок — неактивный пункт: он не нажимается и пропускается
  // клавиатурной навигацией (MenuList пропускает disabled), то есть ведёт
  // себя как заголовок, а не как пункт. Иконка статуса идёт в ПОЛЕ icon,
  // а не в подпись: колонка иконок одна на весь список, и с иконкой
  // в подписи заголовок сдвигался бы вправо на её ширину.
  const heading = (icon: string, label: string, id: string): OverlayMenuItem => ({
    id,
    label,
    icon,
    heading: true,
    disabled: true,
  })
  // Пункт области: слева область и её решение, справа — кнопка-корзина.
  // Строка — справка (plain): имя области не нажимается, действие одно и
  // живёт в отдельной квадратной кнопке. Пока кнопкой была сама строка,
  // корзина оказывалась вложенной в кнопку — и по разметке (вложенный
  // button невалиден), и на вид.
  const scopeItem = (scope: PermissionScope): OverlayMenuItem => ({
    id: `scope:${scope}`,
    label: t(SCOPE_LABEL[scope]),
    icon: SCOPE_ICON[scope],
    plain: true,
    actionIcon: '🗑️',
    actionTitle: t('permissions.resetScopeHint'),
  })
  if (allowed.length > 0) {
    items.push(heading('✅', t('permissions.allowedHeading'), 'head-allow'))
    items.push(...allowed.map(scopeItem))
  }
  if (blocked.length > 0) {
    items.push(heading('⛔', t('permissions.blockedHeading'), 'head-block'))
    items.push(...blocked.map(scopeItem))
  }
  if (items.length > 0) items.push({ id: 'sep', label: '', icon: '', separator: true })
  items.push(
    // Общий сброс сайта: подпись + корзина. Пункт без текста выпадал из
    // меню — у всех остальных строк текст есть, и пустая строка читалась
    // как недорисованная. Это тот же сброс, что и корзина в шапке карточки
    // на странице разрешений.
    {
      id: 'clear-site',
      label: t('permissions.clearSiteHint'),
      icon: '🗑️',
      disabled: scopes.length === 0,
    },
    { id: 'manage', label: t('permissions.manage'), icon: '⚙️' },
  )
  showOverlay(win, {
    kind: 'menu',
    anchor: { x: Math.round(anchor.x), y: Math.round(anchor.y) },
    items,
    toggleKey: 'permissions-menu',
    onSelect: (id) => {
      const pushAll = (): void => {
        // Решение снято для всех окон: сайт мог быть открыт в нескольких,
        // и бейдж обязан пересчитаться везде.
        for (const other of windows.values()) pushTabsState(other)
      }
      if (id === 'clear-site') {
        void clearOrigin(origin, persist).then(() => {
          log('session', 'site permissions cleared', { origin })
          pushAll()
        })
      } else if (id.startsWith('scope:')) {
        const scope = id.slice('scope:'.length)
        if (!ALL_SCOPES.includes(scope as PermissionScope)) return
        void clearScope(origin, scope as PermissionScope, persist).then(() => {
          log('session', 'site permission scope cleared', { origin, scope })
          pushAll()
        })
      } else if (id === 'manage') {
        // На страницу разрешений, а не в настройки: список решений живёт
        // на ней, и в настройках пользователь нашёл бы только кнопку.
        closeOverlay(win)
        const active = ws.activeTabId !== null ? ws.tabs.get(ws.activeTabId) : undefined
        if (active) void active.view.webContents.loadURL(PERMISSIONS_URL)
        else createTab(ws, PERMISSIONS_URL)
      }
    },
  })
}
