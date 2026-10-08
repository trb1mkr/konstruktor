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
import { getSettings, saveSettings } from './settingsStore'
import { getShortcuts, addShortcut, removeShortcut } from './shortcutsStore'
import { setLocalePreference, t } from '../i18n'
import { applyThemeToViews } from '../browserTheme'
import { applyZoomToWs, percentOf, zoomModeFor } from '../zoomManager'
import { showOverlay } from '../overlay'
import { join } from 'path'

export function registerStoresIpc(): void {
  // История: чтение/поиск/удаление. Инкогнито-окнам отдаем пусто.
  ipcMain.handle('history:list', async (e, limit?: number) => {
    if (wsOf(e).incognito) return []
    return getHistory(limit ?? 200)
  })
  ipcMain.handle('history:search', async (e, query: string, limit?: number) => {
    if (wsOf(e).incognito) return []
    return searchHistory(query, limit ?? 50)
  })
  ipcMain.handle('history:delete', async (e, url: string) => {
    if (wsOf(e).incognito) return false
    await deleteEntry(url)
    return true
  })
  ipcMain.handle('history:timeline', async (e, query?: string, limit?: number) => {
    if (wsOf(e).incognito) return []
    return getTimeline(query ?? '', limit ?? 2000)
  })
  ipcMain.handle('history:delete-visit', async (e, url: string, at: number) => {
    if (wsOf(e).incognito) return false
    await deleteVisit(url, at)
    return true
  })
  ipcMain.handle('history:clear', async (e) => {
    if (wsOf(e).incognito) return false
    await clearHistory()
    return true
  })
  // Загрузки: список/поиск/удаление/открытие файла. Инкогнито читает общий список.
  ipcMain.handle('downloads:list', (e, limit?: number) => {
    if (wsOf(e).incognito) return []
    return getDownloads(limit ?? 200)
  })
  ipcMain.handle('downloads:search', (e, query: string, limit?: number) => {
    if (wsOf(e).incognito) return []
    return searchDownloads(query, limit ?? 100)
  })
  // remove/clear/open тоже закрыты: инкогнито видело пустой список, но
  // могло удалить или открыть чужую запись по id из основного окна.
  ipcMain.handle('downloads:remove', async (e, id: string) => {
    if (wsOf(e).incognito) return false
    await removeDownload(id)
    return true
  })
  ipcMain.handle('downloads:clear', async (e) => {
    if (wsOf(e).incognito) return false
    await clearDownloads()
    return true
  })
  ipcMain.handle('downloads:open', async (e, id: string) => {
    if (wsOf(e).incognito) return false
    const list = await getDownloads(200)
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
  ipcMain.handle('downloads:icon', async (_e, id: string) => {
    const list = await getDownloads(200)
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
  ipcMain.handle('settings:get', () => getSettings())
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
        roundedCorners?: boolean
        fullscreenMode?: string
        rememberBounds?: boolean
        rememberTabs?: boolean
        zoomMode?: string
        zoomSync?: boolean
      }
    ) => {
      const next = await saveSettings(patch)
      // Язык меняется ДО рассылки: последующие сборки меню уже на новом
      // языке, а shell получает код из того же settings:changed.
      if (patch.locale !== undefined) await setLocalePreference(patch.locale)
      // Shell перечитывает тему/скругление/язык без перезагрузки: пуш во все окна.
      // Смена сценария F11 сбрасывает контентный fullscreen: view возвращается
      // в обычные bounds, иначе окно останется в рассинхроне с настройкой.
      // Смена темы обновляет color-scheme открытых сайтов (см. applyThemeToViews).
      if (
        patch.theme !== undefined ||
        patch.roundedCorners !== undefined ||
        patch.fullscreenMode !== undefined ||
        patch.locale !== undefined
      ) {
        for (const ws of windows.values()) {
          if (patch.fullscreenMode !== undefined && ws.contentFullscreen) {
            ws.contentFullscreen = false
            layoutActiveView(ws)
            ws.window?.webContents.send('window:content-fullscreen', false)
          }
          // locale — сырое значение настройки: shell резолвит 'auto' сам
          // через navigator.language, как и при старте. Неизменённое значение
          // в changeLanguage превращается в no-op.
          ws.window?.webContents.send('settings:changed', { locale: next.locale })
        }
        if (patch.theme !== undefined) applyThemeToViews(next.theme)
      }
      // Режим зума применяется к уже открытым view сразу: политика —
      // свойство webContents, а не partition, и без sweep новая настройка
      // действовала бы только на вкладки, открытые после неё.
      if (patch.zoomMode !== undefined) {
        const mode = zoomModeFor(next)
        for (const ws of windows.values()) {
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
        const seedWs = [...windows.values()].find((w) => w.activeTabId !== null)
        const rec = seedWs?.activeTabId != null ? seedWs.tabs.get(seedWs.activeTabId) : undefined
        if (seedWs && rec) {
          applyZoomToWs(seedWs, percentOf(rec.view.webContents), pushTabsState)
        }
      }
      void e
      return next
    }
  )
  // Плитки табло стартовой страницы.
  ipcMain.handle('shortcuts:list', () => getShortcuts())
  ipcMain.handle('shortcuts:add', (_e, input: { name?: string; url: string }) =>
    addShortcut(input)
  )
  ipcMain.handle('shortcuts:remove', (_e, url: string) => removeShortcut(url))
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
export function setupDownloads(ses: Electron.Session, privateMode = false) {
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
    // партиция окна-шелла разные (вкладки живут в NORMAL/INCOGNITO, окно
    // всегда в INCOGNITO — см. windowsManager), так что сравнение не
    // нашло бы ни одного окна.
    const ownerWindow = [...windows.values()].find(
      (ws) =>
        ws.incognito === privateMode &&
        ws.window &&
        !ws.window.isDestroyed()
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
    void addDownload(entry)
    item.on('updated', () => {
      void updateDownload(id, {
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        state: 'progressing'
      })
    })
    item.once('done', (_ev, state) => {
      const finalState =
        state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted'
      void updateDownload(id, {
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        state: finalState,
        endedAt: Date.now()
      }).then(() => {
        if (finalState !== 'completed') return
        // Тост шлём в то окно, где шла загрузка. Раньше он рассылался во
        // все окна, и скачивание в обычном окне всплывало тостом в
        // приватном — в другом окне и о другом действии.
        if (!ownerWindow || ownerWindow.isDestroyed()) return
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
