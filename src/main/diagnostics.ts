// Диагностика разработки: автооткрытие меню, лог фокуса/ввода,
// цикл панели поиска, периодическая сводка оверлеев.
// Выделено из index.ts: всё включается только флагами окружения,
// в проде код мёртвый. Флаги НЕ входят в обычный OVERLAY_DEBUG,
// кроме сводки статистики (см. OVERLAY_DEBUG в OVERLAY.md).
import { BrowserWindow } from 'electron'
import { getState, type WindowState } from './windows/browserState'
import { showOverlay, closeOverlay, getActiveOverlay } from './overlay'
import { openFindOverlay } from './find/findManager'
import { log, dumpStats as dumpOverlayStats } from './overlay/logger'

export function setupDiagnostics(bootState: WindowState): void {
  // ДИАГНОСТИКА: автооткрытие меню через N мс после старта. Нужно, чтобы
  // попасть в окно задержки загрузки страницы (OVERLAY_PAGE_LOAD_DELAY_MS)
  // без ручной гонки мышью. Значение 0 или пусто — выключено.
  //
  // Окно берём из bootState, а не из getAllWindows()[0]: в списке первым
  // может оказаться оверлей, у которого contentBounds 1x1 и координаты
  // за экраном — меню уехало бы в -259,-99.
  const autoOpenAt = Number(process.env['OVERLAY_AUTO_OPEN_MS'] ?? '0') || 0
  if (autoOpenAt > 0) {
    setTimeout(() => {
      const win = bootState.window
      if (!win || win.isDestroyed()) return
      log('lifecycle', 'auto-opening menu', { afterMs: autoOpenAt })
      showOverlay(win, {
        kind: 'menu',
        anchor: { x: 400, y: 300 },
        items: [
          { id: 'auto-1', label: 'Auto item 1', icon: '📥' },
          { id: 'auto-2', label: 'Auto item 2', icon: '🕘' }
        ],
        onSelect: () => undefined
      })
    }, autoOpenAt)
  }

  // Диагностика фокуса и ввода. Отдельный флаг, НЕ входит в обычный
  // OVERLAY_DEBUG: логирует каждую нажатую клавишу, поэтому в обычном
  // режиме это слишком шумно. Включать точечно, при разборе ввода.
  //
  // Что показывает:
  //   focus  — у какого окна фокус и кто из webContents его держит. Нужно,
  //            потому что окно может сообщать isFocused() === true и при
  //            этом не получать клавиатуру: WM отдал фокус окну, а
  //            конвейер ввода Chromium не активирован.
  //   key    — приход ЛЮБОЙ клавиши в каждый webContents процесса,
  //            включая view вкладок. Пробел, на котором спотыкались
  //            прежние замеры: вкладка — это WebContentsView, и её
  //            webContents НЕ входит в BrowserWindow.getAllWindows(),
  //            так что подписка только на окна показывает ложное
  //            «ввода нет».
  if (process.env['OVERLAY_FOCUS_DEBUG']) {
    const watched = new Set<string>()
    const watch = (wc: Electron.WebContents, tag: string): void => {
      const key = wc.id + ':' + tag
      if (watched.has(key)) return
      watched.add(key)
      wc.on('before-input-event', (_e, input) => {
        if (input.type !== 'keyDown') return
        log('lifecycle', 'focus: key', {
          where: tag,
          key: input.key,
          code: input.code,
          ctrl: input.control,
          meta: input.meta,
          wcFocused: wc.isFocused()
        })
      })
    }
    const sweep = (): void => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (w.isDestroyed()) continue
        watch(w.webContents, 'window:' + w.id)
        // View вкладок — вложенные WebContentsView, их нет в
        // getAllWindows(), но клавиатуру принимают они.
        try {
          for (const child of w.contentView.children) {
            // View — базовый тип, webContents есть не у всех потомков.
            const wc = (child as { webContents?: Electron.WebContents }).webContents
            if (wc) watch(wc, 'view-under:' + w.id)
          }
        } catch {
          // Обход дерева view не критичен для диагностики.
        }
      }
    }
    sweep()
    setInterval(sweep, 500)
    setInterval(() => {
      const focused = BrowserWindow.getFocusedWindow()
      log('lifecycle', 'focus: owner', {
        focusedId: focused ? focused.id : null,
        windows: BrowserWindow.getAllWindows()
          .map((w) => (w.isDestroyed() ? 'dead' : String(w.isFocused())))
          .join(',')
      })
    }, 1000)
  }

  // ДИАГНОСТИКА: два открытия панели поиска подряд, второе — сразу после
  // закрытия первой и БЕЗ клика по веб-странице. Раньше такой сценарий
  // не работал: после закрытия фокус оставался в прозрачном окне оверлея,
  // Ctrl+F уходил в его webContents, и панель не открывалась до клика по
  // странице. Значение 0 или пусто — выключено.
  const findCycleAt = Number(process.env['OVERLAY_FIND_CYCLE_MS'] ?? '0') || 0
  if (findCycleAt > 0) {
    setTimeout(() => {
      const win = bootState.window
      if (!win || win.isDestroyed()) return
      log('lifecycle', 'find cycle: opening #1', {})
      const ws1 = getState(win)
      if (ws1) openFindOverlay(ws1)
      setTimeout(() => {
        if (win.isDestroyed()) return
        log('lifecycle', 'find cycle: closing #1', {})
        closeOverlay(win)
        setTimeout(() => {
          if (win.isDestroyed()) return
          // Клика по странице здесь нет намеренно: проверяем, что фокус
          // вернулся сам и второй вызов проходит без участия пользователя.
          log('lifecycle', 'find cycle: opening #2 (no page click)', {})
          const ws = getState(win)
          log('lifecycle', 'find cycle: parent focused before #2', {
            focused: win.isFocused()
          })
          if (ws) openFindOverlay(ws)
          const ov = getActiveOverlay(win)
          log('lifecycle', 'find cycle: #2 result', {
            opened: !!ov && !ov.isDestroyed()
          })
        }, 400)
      }, 700)
    }, findCycleAt)
  }

  // Сводка по времени открытия оверлеев раз в 5 минут (OVERLAY_DEBUG != silent).
  setInterval(() => dumpOverlayStats(), 5 * 60 * 1000)
}
