// Меню браузера (кнопка ☰): сборка пунктов и гашение по клику мимо.
// Выделено из index.ts по образцу windowMenu.ts: DOM-оверлей в
// прозрачном окне поверх всего, включая WebContentsView. Системный
// Menu.popup не используем: на Windows он всегда светлый и не стилизуется.
import { BrowserWindow, ipcMain } from 'electron'
import { getState, parentOfSenderView } from './browserState'
import { showOverlay, closeOverlay, closeOverlayIfMenu, type OverlayMenuItem } from '../overlay'
import { log } from '../overlay/logger'
import { t } from '../i18n'
import { devToolsStateOf, toggleDevTools } from '../tabs/devtools'
import { switchIncognito } from '../tabs/tabsManager'
import { createTab, pushTabsState, tabsDeps } from './deps'
import { HISTORY_URL, SETTINGS_URL, DOWNLOADS_URL } from '../pages/internalPages'

export function registerBrowserMenuIpc(): void {
  // Renderer шлет якорь ПРАВОГО НИЖНЕГО угла кнопки относительно
  // content-области окна. Оверлей позиционируется в overlay/service.
  ipcMain.on('menu:popup', (e, anchor: { x: number; y: number }) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const ws = win ? getState(win) : undefined
    if (!win || !ws) return
    const openPage = (url: string) => {
      // Внутреннюю страницу открываем в активной вкладке.
      const rec = ws.activeTabId !== null ? ws.tabs.get(ws.activeTabId) : undefined
      if (rec) void rec.view.webContents.loadURL(url)
      else createTab(ws, url)
    }
    const items: OverlayMenuItem[] = [
      // Заглушки: разделы в разработке, пункты неактивны.
      { id: 'profile', label: t('menu.profile'), icon: '👤', disabled: true },
      { id: 'settings', label: t('menu.settings'), icon: '⚙️' },
      { id: 'history', label: t('menu.history'), icon: '🕘' },
      { id: 'downloads', label: t('menu.downloads'), icon: '📥' },
      { id: 'extensions', label: t('menu.extensions'), icon: '🧩', disabled: true },
      // DevTools активной вкладки. Состояние читаем при открытии меню:
      // панель могли закрыть крестиком в самом DevTools, и подпись пункта
      // обязана это отражать.
      {
        id: 'devtools',
        label: devToolsStateOf(ws, ws.activeTabId ?? -1).open
          ? t('menu.devtoolsClose')
          : t('menu.devtoolsOpen'),
        icon: '🛠️'
      },
      // Debug — dev-only пункт, не переводится (см. I18N.md).
      { id: 'debug', label: 'Debug', icon: '🐞', disabled: true },
      // Пункт виден всегда: он переключает режим ТЕКУЩЕГО окна, а не
      // создаёт новое. В приватном окне он предлагает обратный переход,
      // поэтому скрывать его было бы неверно.
      {
        id: 'incognito',
        label: ws.incognito
          ? t('menu.incognitoToNormal')
          : t('menu.incognitoToPrivate'),
        icon: '🕵️'
      }
    ]
    showOverlay(win, {
      kind: 'menu',
      anchor: { x: Math.round(anchor.x), y: Math.round(anchor.y) },
      items,
      // Второй клик по кнопке ☰ закрывает открытое ею же меню.
      toggleKey: 'browser-menu',
      onSelect: (id) => {
        if (id === 'downloads') openPage(DOWNLOADS_URL)
        else if (id === 'history') openPage(HISTORY_URL)
        else if (id === 'settings') openPage(SETTINGS_URL)
        else if (id === 'devtools') {
          // Меню закрываем ДО открытия панели: оверлей лежит поверх view,
          // и докнутые DevTools перерисовали бы его область. Плюс панель
          // забирает фокус, а меню его держит — оставить открытым значало бы
          // оставить окно без фокуса.
          closeOverlay(win)
          if (ws.activeTabId !== null) {
            toggleDevTools(ws, ws.activeTabId)
            pushTabsState(ws)
          }
        } else if (id === 'incognito') {
          // Переключение переоткрывает вкладки, поэтому активный оверлей
          // (меню, открытый поверх вкладок) закрываем заранее: его
          // содержимое сейчас станет неактуальным.
          closeOverlay(win)
          switchIncognito(ws, tabsDeps, !ws.incognito)
        }
      }
    })
  })
  // Клик по shell или по странице мимо открытого меню. Меню живёт в
  // отдельном окне, само оно клик не видит. Закрываем ТОЛЬКО меню:
  // диалоги (icon/dialog) и панель поиска имеют свою логику закрытия
  // и не должны реагировать на клик мимо.
  //
  // Sender бывает двух видов: webContents самого окна (клик по shell) и
  // webContents WebContentsView (клик по странице) — у второго
  // BrowserWindow.fromWebContents вернёт undefined, окно ищем по вкладкам.
  //
  // source различаем для диагностики: какой именно renderer прислал
  // гашение. Без этого нельзя понять, эхо это или настоящий клик.
  ipcMain.on('menu:dismiss-on-shell-click', (e, source?: string) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? parentOfSenderView(e.sender)
    const fromView = !BrowserWindow.fromWebContents(e.sender)
    log('command', 'shell click', {
      source: source ?? (fromView ? 'view' : 'shell'),
      hasWindow: !!win
    })
    if (win) closeOverlayIfMenu(win)
  })
}
