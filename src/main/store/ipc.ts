// IPC хранилищ: история, загрузки, настройки, ярлыки стартовой страницы.
// Выделено из index.ts: чтение/запись JSON + побочные эффекты settings:save
// (тема, язык, зум, fullscreen). Инкогнито-окна получают пустые списки —
// см. историю вопросов в STORES.md.
import { app, ipcMain, shell } from 'electron'
import { windows } from '../windows/browserState'
import { layoutActiveView } from '../windows/windowsManager'
import { pushTabsState, wsOf } from '../windows/deps'
import {
  getHistory,
  searchHistory,
  getTimeline,
  deleteVisit,
  deleteEntry,
  clearHistory
} from './historyStore'
import {
  getDownloads,
  searchDownloads,
  removeDownload,
  clearDownloads,
  addDownload,
  updateDownload,
  newDownloadId,
  type DownloadEntry
} from './downloadsStore'
import { getSettings, getSettingsSync, saveSettings } from './settingsStore'
import { setHotkeyCapture } from '../hotkeys'
import { getShortcuts, addShortcut, removeShortcut } from './shortcutsStore'
import { getBookmarks, toggleBookmark, removeBookmark } from './bookmarksStore'
import { tFor } from '../i18n'
import { applyThemeToViewsFor, effectivePageTheme, syncProcessScheme } from '../browserTheme'
import { applyZoomToWs, percentOf, zoomModeFor } from '../zoomManager'
import { applyExtensionsEnabled } from '../extensions/manager'
import { showOverlay } from '../overlay'
import { join } from 'path'

export function registerStoresIpc(): void {
  // Пространство отправителя. Все хранилища ниже принадлежат ему: у каждого
  // пространства свои история, загрузки, настройки и закладки.
  const wsIdOf = (e: { sender: Electron.WebContents }): string => wsOf(e).workspaceId
  // История: чтение/поиск/удаление. Инкогнито-окнам отдаем пусто.
  ipcMain.handle('history:list', async (e, limit?: number) => {
    if (wsOf(e).incognito) return []
    return getHistory(limit ?? 200, wsIdOf(e))
  })
  ipcMain.handle('history:search', async (e, query: string, limit?: number) => {
    if (wsOf(e).incognito) return []
    return searchHistory(query, limit ?? 50, wsIdOf(e))
  })
  ipcMain.handle('history:delete', async (e, url: string) => {
    if (wsOf(e).incognito) return false
    await deleteEntry(url, wsIdOf(e))
    return true
  })
  ipcMain.handle('history:timeline', async (e, query?: string, limit?: number) => {
    if (wsOf(e).incognito) return []
    return getTimeline(query ?? '', limit ?? 2000, wsIdOf(e))
  })
  ipcMain.handle('history:delete-visit', async (e, url: string, at: number) => {
    if (wsOf(e).incognito) return false
    await deleteVisit(url, at, wsIdOf(e))
    return true
  })
  ipcMain.handle('history:clear', async (e) => {
    if (wsOf(e).incognito) return false
    await clearHistory(wsIdOf(e))
    return true
  })
  // Загрузки: список/поиск/удаление/открытие файла. Инкогнито читает общий список.
  ipcMain.handle('downloads:list', (e, limit?: number) => {
    if (wsOf(e).incognito) return []
    return getDownloads(limit ?? 200, wsIdOf(e))
  })
  ipcMain.handle('downloads:search', (e, query: string, limit?: number) => {
    if (wsOf(e).incognito) return []
    return searchDownloads(query, limit ?? 100, wsIdOf(e))
  })
  // remove/clear/open тоже закрыты: инкогнито видело пустой список, но
  // могло удалить или открыть чужую запись по id из основного окна.
  ipcMain.handle('downloads:remove', async (e, id: string) => {
    if (wsOf(e).incognito) return false
    await removeDownload(id, wsIdOf(e))
    return true
  })
  ipcMain.handle('downloads:clear', async (e) => {
    if (wsOf(e).incognito) return false
    await clearDownloads(wsIdOf(e))
    return true
  })
  ipcMain.handle('downloads:open', async (e, id: string) => {
    if (wsOf(e).incognito) return false
    const list = await getDownloads(200, wsIdOf(e))
    const found = list.find((d) => d.id === id)
    if (!found) return false
    try {
      const res = await shell.openPath(found.path)
      return res === ''
    } catch {
      return false
    }
  })
  // Системная иконка файла через Electron app.getFileIcon.
  // Возвращает dataURL PNG; пустая строка = fallback на эмодзи по расширению.
  ipcMain.handle('downloads:icon', async (e, id: string) => {
    const list = await getDownloads(200, wsIdOf(e))
    const found = list.find((d) => d.id === id)
    if (!found) return ''
    try {
      const icon = await app.getFileIcon(found.path, { size: 'normal' })
      if (icon.isEmpty()) return ''
      return icon.toDataURL()
    } catch {
      return ''
    }
  })
  // Настройки браузера.
  ipcMain.handle('settings:get', (e) => getSettings(wsIdOf(e)))
  // Резолв темы внутренней страницы конструктором (см. THEMES.md).
  //
  // Странице нужен именно разрешенный вариант: matchMedia внутри нее
  // не годится: nativeTheme.themeSource может быть перекрыт базовой
  // темой веб-контента, и медиазапрос вернул бы схему сайтов, а не
  // страницы. Канал async: sync-IPC видят и обычные сайты (прелоад
  // регистрируется на всю сессию), а блокировать main из чужого
  // документа нельзя.
  ipcMain.handle('theme:page', (e) =>
    effectivePageTheme(getSettingsSync(wsIdOf(e)).theme ?? 'dark')
  )
  ipcMain.handle(
    'settings:save',
    async (
      e,
      patch: {
        searchEngine?: string
        homepage?: string
        devtools?: boolean
        dnsMode?: string
        dnsCustom?: string
        locale?: string
        animations?: boolean
        theme?: string
        webContentTheme?: string
        roundedCorners?: boolean
        fullscreenMode?: string
        rememberBounds?: boolean
        rememberTabs?: boolean
        zoomMode?: string
        zoomSync?: boolean
        extensionsEnabled?: boolean
        extensionsDevMode?: boolean
        menuShowIcons?: boolean
        menuShowText?: boolean
        menuShowHotkeys?: boolean
        menuHotkeysOnHover?: boolean
        hotkeys?: Record<string, string>
      }
    ) => {
      const wsId = wsIdOf(e)
      const next = await saveSettings(patch, wsId)
      // Язык — настройка пространства: он уже лежит в его settings.json и
      // уезжает в settings:changed ниже (shell резолвит 'auto' сам).
      // Глобального языка у процесса нет, поэтому менять нечего:
      // страницы собираются в языке своей партии, меню — `tFor(wsId)`.
      // Открытые внутренние страницы перерисуются после reload вкладки —
      // HTML запекается в момент запроса (см. pages/protocol.ts).
      // Shell перечитывает тему/скругление/язык без перезагрузки: пуш во все окна.
      // Смена сценария F11 сбрасывает контентный fullscreen: view возвращается
      // в обычные bounds, иначе окно останется в рассинхроне с настройкой.
      // Смена темы обновляет color-scheme открытых сайтов (см. applyThemeToViews).
      if (
        patch.theme !== undefined ||
        patch.webContentTheme !== undefined ||
        patch.roundedCorners !== undefined ||
        patch.fullscreenMode !== undefined ||
        patch.locale !== undefined ||
        // Смена хоткеев: shell дублирует обработку клавиш (App.vue), и его
        // действующие сочетания обязаны совпасть с main.
        patch.hotkeys !== undefined
      ) {
        for (const ws of windows.values()) {
          // Настройки принадлежат пространству: чужим окнам их изменение
          // не рассылается, иначе тема одного пространства переписала бы UI
          // другого.
          if (ws.workspaceId !== wsId) continue
          if (patch.fullscreenMode !== undefined && ws.contentFullscreen) {
            ws.contentFullscreen = false
            layoutActiveView(ws)
            ws.window?.webContents.send('window:content-fullscreen', false)
          }
          // locale — сырое значение настройки: shell резолвит 'auto' сам
          // через navigator.language, как и при старте. Неизменённое значение
          // в changeLanguage превращается в no-op.
          ws.window?.webContents.send('settings:changed', {
            locale: next.locale,
            hotkeys: next.hotkeys
          })
        }
        if (patch.theme !== undefined || patch.webContentTheme !== undefined) {
          // Сначала схема в Chromium (prefers-color-scheme сайтов и окон
          // расширений), потом перекраска view и внутренних страниц.
          // Тема — настройка пространства: перекрашиваются вкладки только
          // своего пространства, а общую на процесс схему меняет лишь его
          // фокусированное окно (nativeTheme один на процесс).
          syncProcessScheme()
          applyThemeToViewsFor(wsId)
        }
      }
      // Режим зума применяется к уже открытым view сразу: политика —
      // свойство webContents, а не partition, и без sweep новая настройка
      // действовала бы только на вкладки, открытые после неё.
      if (patch.zoomMode !== undefined) {
        const mode = zoomModeFor(next)
        for (const ws of windows.values()) {
          if (ws.workspaceId !== wsId) continue
          for (const rec of ws.tabs.values()) {
            const wc = rec.view.webContents
            if (!wc.isDestroyed()) wc.setZoomMode(mode)
          }
          pushTabsState(ws)
        }
      }
      // Включение единого зума выравнивает вкладки СРАЗУ, а не к следующему
      // шагу лестницы: иначе после включения проценты остаются разными,
      // пока пользователь не изменит зум повторно.
      if (patch.zoomSync === true) {
        const seedWs = [...windows.values()].find(
          (w) => w.workspaceId === wsId && w.activeTabId !== null
        )
        const rec = seedWs?.activeTabId != null ? seedWs.tabs.get(seedWs.activeTabId) : undefined
        if (seedWs && rec) {
          applyZoomToWs(seedWs, percentOf(rec.view.webContents), pushTabsState)
        }
      }
      // Глобальный выключатель расширений: выгрузка из сессии или обратная
      // загрузка всех включённых. Состояние рассылается своим пушем.
      if (patch.extensionsEnabled !== undefined) {
        await applyExtensionsEnabled(patch.extensionsEnabled, wsId)
      }
      return next
    }
  )
  // Захват сочетаний на время редактирования таблицы горячих клавиш
  // (konstruktor://settings): пока поле в фокусе, браузерные сочетания
  // молчат — иначе Ctrl+W закрыл бы вкладку прямо во время ввода.
  // Обработчик синхронный: порядок focus/blur-сообщений обязан совпасть
  // с порядком их отправки (переход по Tab между полями).
  ipcMain.handle('hotkeys:capture', (e, on: boolean) => {
    setHotkeyCapture(e.sender, on === true)
    return true
  })
  // Плитки табло стартовой страницы.
  ipcMain.handle('shortcuts:list', (e) => getShortcuts(wsIdOf(e)))
  ipcMain.handle('shortcuts:add', (e, input: { name?: string; url: string }) =>
    addShortcut(input, wsIdOf(e))
  )
  ipcMain.handle('shortcuts:remove', (e, url: string) => removeShortcut(url, wsIdOf(e)))
  // Закладки панели: раньше жили в localStorage шелла (in-memory партиция),
  // из-за чего не переживали перезапуск. Теперь они в пространстве.
  ipcMain.handle('bookmarks:list', (e) => getBookmarks(wsIdOf(e)))
  ipcMain.handle(
    'bookmarks:toggle',
    (e, input: { title: string; url: string; favicon?: string }) =>
      toggleBookmark(input, wsIdOf(e))
  )
  ipcMain.handle('bookmarks:remove', (e, url: string) => removeBookmark(url, wsIdOf(e)))
}

// Загрузки: один обработчик на сессию. Файл качается через will-download,
// прогресс пишем в downloads.json — страница konstruktor://downloads
// читает через IPC и обновляется раз в секунду.
//
// Загрузки разрешены и в приватном окне: файл всё равно попадает на
// диск, и запрет был искусственным ограничением, а не требованием
// приватности. Приватность касается cookies, кэша и истории навигации.
//
// Поэтому флаг приватности ниже НЕ передаётся: setupDownloads работает
// одинаково для всех партиций, а скрытие следов загрузки — задача
// downloads:* (там приватное окно получает пустой список).
export function setupDownloads(ses: Electron.Session, wsId: string, privateMode = false) {
  ses.on('will-download', (_e, item) => {
    // Окно-владелец загрузки — нужно, чтобы тост о загрузке всплыл
    // в том окне, где шла загрузка, а не во всех сразу.
    //
    // У will-download нет sender: событие сессионное, а не привязано к
    // webContents, и Session не сообщает свою партицию. Поэтому режим
    // передаётся флагом при регистрации обработчика, а окно ищется по
    // нему.
    //
    // Сверять окно с самой сессией обработчика нельзя: партиция ТАБКИ и
    // партиция окна-шелла разные (вкладки живут в партиции пространства,
    // окно — в его приватной), так что сравнение не нашло бы ни одного окна.
    // Поэтому сверяем ТОЛЬКО пространство и режим.
    const ownerWindow = [...windows.values()].find(
      (ws) => ws.workspaceId === wsId && ws.incognito === privateMode && ws.window && !ws.window.isDestroyed()
    )?.window
    const filename = item.getFilename() || 'download'
    const id = newDownloadId()
    const savePath = join(app.getPath('downloads'), filename)
    try {
      item.setSavePath(savePath)
    } catch {
      // Путь занят — Electron сам предложит вариант.
    }
    const entry: DownloadEntry = {
      id,
      url: item.getURL(),
      filename,
      path: savePath,
      totalBytes: item.getTotalBytes(),
      receivedBytes: item.getReceivedBytes(),
      state: 'progressing',
      startedAt: Date.now(),
      endedAt: null
    }
    void addDownload(entry, wsId)
    item.on('updated', () => {
      void updateDownload(
        id,
        {
          receivedBytes: item.getReceivedBytes(),
          totalBytes: item.getTotalBytes(),
          state: 'progressing'
        },
        wsId
      )
    })
    item.once('done', (_ev, state) => {
      const finalState =
        state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted'
      void updateDownload(
        id,
        {
          receivedBytes: item.getReceivedBytes(),
          totalBytes: item.getTotalBytes(),
          state: finalState,
          endedAt: Date.now()
        },
        wsId
      ).then(() => {
        if (finalState !== 'completed') return
        // Тост шлём в то окно, где шла загрузка. Раньше он рассылался во
        // все окна, и скачивание в обычном окне всплывало тостом в
        // приватном — в другом окне и о другом действии.
        if (!ownerWindow || ownerWindow.isDestroyed()) return
        const t = tFor(wsId)
        showOverlay(ownerWindow, {
          kind: 'toast',
          // anchor не задаётся: для тоста он игнорируется, положение
          // считает geometry.ts по углу рабочей области дисплея.
          anchor: { x: 0, y: 0 },
          toast: { title: t('toast.downloadComplete'), body: filename }
        })
      })
    })
  })
}
