// IPC расширений: список, установка, тумблер, удаление, клик по кнопке,
// меню расширений. Каналы `extensions:*` обслуживают и страницу
// konstruktor://extensions, и shell (кнопки на панели и пиктограмма-пазл).
import { BrowserWindow, ipcMain, shell } from 'electron'
import { closeOverlay, showOverlay } from '../overlay'
import { EXTENSIONS_URL } from '../pages/internalPages'
import { saveSettings } from '../store/settingsStore'
import { getState } from '../windows/browserState'
import {
  activateExtension,
  disableExtension,
  enableExtension,
  extensionsMenuModel,
  extensionsState,
  installFromArchive,
  installFromFolder,
  installFromPath,
  refreshExtensions,
  reloadExtension,
  removeExtension,
  setExtensionPinned
} from './manager'
import { findExtensionRecord } from './extensionStore'
import { actionPopupExtensionId, closeActionPopup, consumeBlurClosedPopup } from './popup'
import { checkExtensionUpdates } from './updater'

// Открыть внутреннюю страницу расширений в активной вкладке окна.
function openExtensionsPage(win: BrowserWindow): void {
  const ws = getState(win)
  const rec = ws && ws.activeTabId !== null ? ws.tabs.get(ws.activeTabId) : undefined
  if (rec) void rec.view.webContents.loadURL(EXTENSIONS_URL)
}

export function registerExtensionsIpc(): void {
  ipcMain.handle('extensions:list', () => extensionsState())
  ipcMain.handle('extensions:refresh', () => refreshExtensions())
  ipcMain.handle('extensions:install-folder', () => installFromFolder())
  ipcMain.handle('extensions:install-archive', () => installFromArchive())
  ipcMain.handle('extensions:install-path', (_e, path: string) => installFromPath(path))
  ipcMain.handle('extensions:enable', (_e, id: string) => enableExtension(id))
  ipcMain.handle('extensions:disable', (_e, id: string) => disableExtension(id))
  ipcMain.handle('extensions:remove', (_e, id: string) => removeExtension(id))
  ipcMain.handle('extensions:reload', (_e, id: string) => reloadExtension(id))
  // Клик по кнопке расширения на панели. Якорь — правый нижний угол значка
  // в координатах content-области: попап встаёт под панелью, как у кнопки-пазла.
  // Без якоря (старый вызов) берём прежнюю точку у правого края.
  //
  // Повторный клик по значку, чей попап уже открыт, закрывает его (toggle,
  // как в браузерах): клик по ДРУГОМУ значку открывает попап того расширения.
  ipcMain.handle(
    'extensions:action-click',
    (e, id: string, anchor?: { x: number; y: number }) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      if (!win) return false
      // Повторный клик по тому же значку закрывает попап. Два пути закрытия:
      // попап ещё открыт (IPC успел раньше blur) — закрываем напрямую; попап
      // уже закрылся от потери фокуса, вызванной этим же кликом, — тогда его
      // след и есть признак повторного клика.
      if (actionPopupExtensionId() === id || consumeBlurClosedPopup(id)) {
        closeActionPopup()
        return true
      }
      const width = win.getContentBounds().width
      const a = anchor ?? { x: width - 8, y: 0 }
      const x = Math.round(a.x)
      return activateExtension(id, win, { x, y: Math.round(a.y), right: x })
    }
  )
  // Меню расширений: список под кнопкой-пазлом (overlay-kind 'extensions').
  // on, а не handle: мост шлёт якорь одним сообщением, ответ не нужен.
  ipcMain.on('extensions:menu', (e, anchor: { x: number; y: number }) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    // Попап расширения живёт вне оверлея и перекрыл бы меню.
    closeActionPopup()
    const popupAnchor = {
      x: Math.round(anchor.x),
      y: Math.round(anchor.y),
      right: Math.round(anchor.x)
    }
    showOverlay(win, {
      kind: 'extensions',
      anchor: { x: Math.round(anchor.x), y: Math.round(anchor.y) },
      extensions: extensionsMenuModel(),
      toggleKey: 'extensions-menu',
      // Команды строк: pin/unpin/open и manage без id (вход на страницу
      // расширений в конце списка).
      onSelect: (id) => {
        const cut = id.indexOf(':')
        const command = cut < 0 ? id : id.slice(0, cut)
        const extId = cut < 0 ? '' : id.slice(cut + 1)
        if (command === 'manage') {
          closeOverlay(win)
          openExtensionsPage(win)
        } else if (command === 'pin' && extId) {
          void setExtensionPinned(extId, true)
          closeOverlay(win)
        } else if (command === 'unpin' && extId) {
          void setExtensionPinned(extId, false)
          closeOverlay(win)
        } else if (command === 'open' && extId) {
          // Попап открывается поверх страницы, меню при этом убираем:
          // два наложенных слоя читались бы как один глюк.
          closeOverlay(win)
          void activateExtension(extId, win, popupAnchor)
        }
      }
    })
  })
  ipcMain.handle('extensions:set-pinned', (_e, id: string, pinned: boolean) =>
    setExtensionPinned(id, pinned)
  )
  ipcMain.handle('extensions:close-popup', () => {
    closeActionPopup()
    return true
  })
  ipcMain.handle('extensions:open-folder', async (_e, id: string) => {
    const rec = findExtensionRecord(id)
    if (!rec) return false
    const result = await shell.openPath(rec.dir)
    return result === ''
  })
  ipcMain.handle('extensions:set-enabled', async (_e, enabled: boolean) => {
    await saveSettings({ extensionsEnabled: enabled })
    return extensionsState()
  })
  ipcMain.handle('extensions:set-dev-mode', async (_e, on: boolean) => {
    await saveSettings({ extensionsDevMode: on })
    return extensionsState()
  })
  // Ручная проверка обновлений с страницы расширений.
  ipcMain.handle('extensions:check-updates', () => checkExtensionUpdates())
}
