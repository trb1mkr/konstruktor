// Диагностика разработки: автооткрытие меню, лог фокуса/ввода,
// цикл панели поиска, периодическая сводка оверлеев.
// Выделено из index.ts: всё включается только флагами окружения,
// в проде код мёртвый. Флаги НЕ входят в обычный OVERLAY_DEBUG,
// кроме сводки статистики (см. OVERLAY_DEBUG в OVERLAY.md).
import { app, BrowserWindow, screen } from 'electron'
import { getState, windows, type WindowState } from './windows/browserState'
import { showOverlay, closeOverlay, getActiveOverlay, getActiveRequest } from './overlay'
import { showBrowserMenu } from './windows/browserMenu'
import { openFindOverlay } from './find/findManager'
import { log, dumpStats as dumpOverlayStats } from './overlay/logger'
import {
  activateExtension,
  extensionsMenuModel,
  extensionsState,
  installFromPath,
  setExtensionPinned,
} from './extensions/manager'
import { bridgePort } from './extensions/bridge'
import { createTab, setActiveTab } from './windows/deps'
import { clearOrigin } from './permissions/permissionsStore'
import { workspaceFile } from './workspaces/paths'
import { bootWorkspaceId } from './workspaces/registry'
import { langFor } from './i18n'
import { originOfUrl } from './permissions/policy'
import { parseAccelerator } from '../shared/hotkeys'
import { isHotkeyActionId } from '../shared/hotkey-actions'
import { acceleratorFor } from './hotkeys'
import { PERMISSIONS_URL } from './pages/internalPages'
import { showPermissionsMenu } from './permissions/ipc'
import { existsSync, readFileSync } from 'fs'

// Запрос микрофона из страницы для автопрогона разрешений: результат
// приходит строкой, чтобы его можно было напечатать одной строкой лога.
const ASK_MEDIA_JS =
  'navigator.mediaDevices ? navigator.mediaDevices.getUserMedia({audio:true})' +
  '.then(function(){return "GRANTED"})' +
  '.catch(function(e){return "DENIED:" + e.name})' +
  ' : "NO-MEDIADEVICES"'

export function setupDiagnostics(bootState: WindowState): void {
  // Автопрогон разрешений: KONSTRUKTOR_PERM_SMOKE=<url> открывает страницу
  // в новой вкладке, просит у неё микрофон, нажимает «Разрешить» в промпте
  // и просит ещё раз. Проверяет всю цепочку: обработчик ЗАПРОСА вызывается
  // при отказе обработчика ПРОВЕРКИ (иначе промпта не было бы вовсе), ответ
  // доходит до страницы, решение ложится в permissions.json и повторный
  // запрос идёт без промпта. Решение сайта в конце снимается — профиль
  // разработчика прогон не засоряет.
  //
  // Страница обязана быть в защищённом контексте (http://localhost или
  // https), иначе `navigator.mediaDevices` не существует вовсе.
  const permUrl = process.env['KONSTRUKTOR_PERM_SMOKE']
  if (permUrl) {
    const waitMs = Number(process.env['KONSTRUKTOR_PERM_SMOKE_MS'] ?? '3000') || 3000
    void (async () => {
      const idle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
      await idle(waitMs)
      const id = createTab(bootState, permUrl)
      setActiveTab(bootState, id)
      const view = (): Electron.WebContents | undefined => {
        const rec =
          bootState.activeTabId !== null ? bootState.tabs.get(bootState.activeTabId) : undefined
        return rec?.view.webContents
      }
      const ask = (): Promise<unknown> => {
        const wc = view()
        if (!wc || wc.isDestroyed()) return Promise.resolve('no-view')
        return wc.executeJavaScript(ASK_MEDIA_JS, true).catch((e: unknown) => 'ERROR:' + String(e))
      }
      console.log('[perm-smoke] opened:', permUrl)
      await idle(1200)
      console.log('[perm-smoke] url:', view()?.getURL())
      // clickAllow: нажимает основную кнопку промпта, как это сделал бы
      // пользователь. Ждём появления поверхности в цикле, а не одним
      // замером: промпт показывает оверлей асинхронно, а при потере
      // фокуса окна (например, фокус забрал терминал автопрогона) он
      // закрывается отказом — это штатное поведение, и прогон должен
      // просто сказать об этом, а не падать.
      const clickAllow = async (): Promise<string> => {
        const win = bootState.window
        for (let i = 0; i < 12; i++) {
          const overlay = win ? getActiveOverlay(win) : undefined
          if (overlay) {
            const clicked = await overlay.webContents
              .executeJavaScript(
                "(() => { const b = document.querySelector('.perm-btn--primary');" +
                  ' if (!b) return false; b.click(); return true })()',
              )
              .catch(() => false)
            if (clicked) return `clicked (after ${i * 250}ms)`
          }
          await idle(250)
        }
        return 'no prompt to click (overlay closed or never shown)'
      }
      // Первый запрос: промпт должен появиться, ответа пользователя ещё нет.
      const first = ask()
      console.log('[perm-smoke] allow:', await clickAllow())
      console.log('[perm-smoke] first request:', await first)
      await idle(1200)
      // Второй запрос: решение запомнено, промпта быть не должно.
      console.log('[perm-smoke] second request:', await ask())
      const file = workspaceFile(bootWorkspaceId(), 'permissions.json')
      console.log(
        '[perm-smoke] permissions.json:',
        existsSync(file) ? readFileSync(file, 'utf-8').replace(/\s+/g, ' ') : '(нет файла)',
      )
      // Страница разрешений: решения печатаются с неё — список живёт
      // здесь, и по тексту видно, что решение записалось, что канал
      // permissions:list отвечает, что подписи областей собираются и что
      // решения разложены по подзаголовкам статусов.
      const setId = createTab(bootState, PERMISSIONS_URL)
      setActiveTab(bootState, setId)
      await idle(1500)
      const pageText = (): Promise<unknown> =>
        view()
          ?.executeJavaScript(
            "(() => { const el = document.getElementById('list');" +
              ' return el ? JSON.stringify(el.textContent) : "NO-ELEMENT" })()',
          )
          .catch((e: unknown) => 'ERROR:' + String(e)) ?? Promise.resolve('no-view')
      console.log('[perm-smoke] permissions page:', await pageText())
      // Оформление страницы: подзаголовки статуса обязаны быть обычного
      // цвета и размера (не тусклые), раздел проверки — стоять ВЫШЕ
      // кнопки общего сброса, а корзина в строке области — быть отдельной
      // квадратной КНОПКОЙ (тег и размер). Всё измерением, а не на глаз.
      console.log(
        '[perm-smoke] page layout:',
        await view()
          ?.executeJavaScript(
            [
              '(() => {',
              "  const title = document.querySelector('.group-title');",
              "  const test = document.getElementById('test-site');",
              "  const reset = document.getElementById('clear-all');",
              "  const bin = document.querySelector('.entry .reset-btn');",
              "  const binBox = bin ? bin.getBoundingClientRect() : null;",
              '  if (!title) return \'NO-TITLE\';',
              '  const cs = getComputedStyle(title);',
              '  return JSON.stringify({',
              "    title: title.textContent.trim(),",
              '    fontSize: cs.fontSize,',
              '    color: cs.color,',
              '    testAboveReset:',
              '      !!test && !!reset &&',
              '      test.getBoundingClientRect().top < reset.getBoundingClientRect().top,',
              "    binTag: bin ? bin.tagName.toLowerCase() : null,",
              '    binBox: binBox ? [binBox.width, binBox.height] : null,',
              '  });',
              '})()',
            ].join('\n'),
          )
          .catch((e: unknown) => 'ERROR:' + String(e)),
      )
      // Снятие ОДНОЙ области: жмём кнопку в строке первой разрешённой
      // области и печатаем страницу снова. Остальные решения сайта должны
      // остаться — иначе точечный сброс был бы тем же сбросом сайта.
      const cleared = await view()
        ?.executeJavaScript(
          '(() => { const b = document.querySelector(\'[data-act="reset-scope"]\');' +
            ' if (!b) return "NO-BUTTON"; const scope = b.dataset.scope; b.click();' +
            ' return scope })()',
        )
        .catch((e: unknown) => 'ERROR:' + String(e))
      console.log('[perm-smoke] reset one scope:', cleared)
      await idle(1200)
      console.log('[perm-smoke] page after reset:', await pageText())
      // Сброс ПРЯМО ИЗ МЕНЮ: открываем меню бейджа тем же вызовом, что и
      // кнопка в адресной строке, и жмём первый пункт области. Проверяет
      // нажимаемость пунктов и то, что снятие из меню работает так же,
      // как со страницы.
      const wid = bootState.window?.id ?? -1
      if (wid >= 0) {
        // Меню бейджа строится по АКТИВНОЙ вкладке: сейчас активна страница
        // разрешений, у которой origin нет. Возвращаемся на сайт прогона.
        setActiveTab(bootState, id)
        await idle(1000)
        // Фокус окну: меню гаснет при уходе приложения из фокуса, а прогон
        // запускается из терминала, который фокус и забирает.
        bootState.window?.focus()
        await idle(300)
        showPermissionsMenu(bootState, { x: 300, y: 300 })
        // Ждём появления поверхности в цикле: показ асинхронный.
        let menu = bootState.window ? getActiveOverlay(bootState.window) : undefined
        for (let i = 0; i < 10 && !menu; i++) {
          await idle(250)
          menu = bootState.window ? getActiveOverlay(bootState.window) : undefined
        }
        // Структура меню: подзаголовки, строки и корзины. Печатается
        // целиком — по ней видно, что корзина есть у КАЖДОГО пункта
        // области, что строка-справка — не button, а сама корзина — button.
        console.log(
          '[perm-smoke] menu layout:',
          await menu?.webContents
            .executeJavaScript(
              [
                '(() => {',
                "  return Array.from(document.querySelectorAll('.menu-item')).map((el) => {",
                "    const label = el.querySelector('.menu-label');",
                "    const action = el.querySelector('.menu-action');",
                '    const cs = getComputedStyle(el);',
                '    return {',
                "      text: (label ? label.textContent : '').trim(),",
                "      tag: el.tagName.toLowerCase(),",
                "      plain: el.classList.contains('menu-item--plain'),",
                '      disabled: el.disabled === true,',
                "      heading: el.classList.contains('menu-item--heading'),",
                '      color: cs.color,',
                '      fontSize: cs.fontSize,',
                "      action: action ? action.textContent.trim() : null,",
                "      actionTag: action ? action.tagName.toLowerCase() : null,",
                "      actionBox: action",
                '        ? [action.getBoundingClientRect().width, action.getBoundingClientRect().height]',
                '        : null,',
                '    };',
                '  });',
                '})()',
              ].join('\n'),
            )
            .catch((e: unknown) => 'ERROR:' + String(e)),
        )
        // Клик именно по КОРЗИНЕ строки-справки: проверяет, что она —
        // нажимаемая кнопка, а не часть строки. Строка при этом не
        // нажимается вовсе, поэтому раньше в логе был тот же id.
        const menuClicked = await menu?.webContents
          .executeJavaScript(
            [
              '(() => {',
              "  const action = document.querySelector('.menu-item--plain .menu-action');",
              "  if (!action) return 'NO-ACTION-BUTTON';",
              "  const row = action.closest('.menu-item');",
              "  const label = row && row.querySelector('.menu-label');",
              '  action.click();',
              "  return (label ? label.textContent : '').trim();",
              '})()',
            ].join('\n'),
          )
          .catch((e: unknown) => 'ERROR:' + String(e))
        console.log('[perm-smoke] menu trash clicked:', menuClicked)
        await idle(1200)
      }
      await clearOrigin(originOfUrl(permUrl), true)
      app.quit()
    })()
  }
  // Корректный выход приложения через N мс — проверка хука before-quit
  // с выгрузкой расширений.
  const quitAt = Number(process.env['KONSTRUKTOR_APP_QUIT_MS'] ?? '0') || 0
  if (quitAt > 0) setTimeout(() => app.quit(), quitAt)
  // Закрытие окна как крестиком (а не выход из приложения) через N мс.
  // Нужно для проверки слепка окон: путь закрытия и путь выхода разные,
  // и ошибка в одном из них видна только так.
  const closeAt = Number(process.env['KONSTRUKTOR_CLOSE_WINDOW_MS'] ?? '0') || 0
  if (closeAt > 0) {
    setTimeout(() => {
      const win = bootState.window
      if (win && !win.isDestroyed()) {
        console.log('[diag] closing window (like the close button):', bootState.key)
        win.close()
      }
    }, closeAt)
  }
  // Аварийное завершение через N мс: убивает процесс без before-quit,
  // поэтому маркер сессии остаётся на диске. Следующий запуск обязан
  // предложить восстановление — иначе проверять этот путь можно только
  // настоящим падением.
  //
  // Именно SIGKILL: `process.exit(1)` аварию НЕ имитирует — Electron
  // прогоняет закрытие окон, хук 'closed' снимает маркер, и сессия
  // записывается штатной (проверено: ложное «всё чисто»).
  const crashAt = Number(process.env['KONSTRUKTOR_CRASH_MS'] ?? '0') || 0
  if (crashAt > 0) {
    setTimeout(() => {
      console.log('[diag] simulating crash: SIGKILL, no shutdown handlers')
      process.kill(process.pid, 'SIGKILL')
    }, crashAt)
  }
  // Цикл переключения вкладок: снимает тот самый «лечебный» эффект,
  // который пользователь делает руками. С `KONSTRUKTOR_LAYOUT_DEBUG=1`
  // по строкам [layout] видно, меняются ли bounds: если после цикла те же
  // числа, а картинка стала правильной, дело не в раскладке.
  const cycleAt = Number(process.env['KONSTRUKTOR_CYCLE_TABS_MS'] ?? '0') || 0
  if (cycleAt > 0) {
    setTimeout(() => {
      const ws = bootState
      if (!ws.window || ws.window.isDestroyed()) return
      const order = [...ws.tabOrder]
      if (order.length < 2) return
      console.log('[diag] cycling tabs, window bounds:', JSON.stringify(ws.window.getBounds()))
      console.log('[diag] display:', JSON.stringify(screen.getDisplayMatching(ws.window.getBounds())))
      // Уходим на соседнюю вкладку и назад — ровно то, что делает
      // пользователь, когда артефакт «лечится».
      const other = order.find((id) => id !== ws.activeTabId)
      if (other === undefined) return
      setActiveTab(ws, other)
      setTimeout(() => {
        if (!ws.window || ws.window.isDestroyed()) return
        const back = order.find((id) => id !== other)
        if (back !== undefined) setActiveTab(ws, back)
      }, 800)
    }, cycleAt)
  }
  // Внутренняя страница и её сценарий без мыши.
  //
  //   KONSTRUKTOR_OPEN_URL=konstruktor://workspaces  открыть в активной вкладке
  //   KONSTRUKTOR_EVAL_MS=N                          через N мс выполнить скрипт
  //   KONSTRUKTOR_EVAL_JS=<js>                       и напечатать результат
  //
  // Скрипт выполняется в САМОЙ странице, то есть через её preload и её IPC:
  // так проверяется вся цепочка «страница -> мост -> main», а не только
  // сборка HTML. Обе строки идут в лог префиксом [diag].
  const openUrl = process.env['KONSTRUKTOR_OPEN_URL']
  if (openUrl) {
    const at = Number(process.env['KONSTRUKTOR_OPEN_URL_MS'] ?? '1500') || 1500
    setTimeout(() => {
      const rec = bootState.activeTabId !== null ? bootState.tabs.get(bootState.activeTabId) : undefined
      if (!rec) {
        console.log('[diag] open url: no active tab')
        return
      }
      console.log('[diag] open url:', openUrl)
      void rec.view.webContents.loadURL(openUrl)
    }, at)
  }
  const evalJs = process.env['KONSTRUKTOR_EVAL_JS']
  if (evalJs) {
    const at = Number(process.env['KONSTRUKTOR_EVAL_MS'] ?? '4000') || 4000
    // Цель выполнения: вкладка (по умолчанию), shell окна или окно
    // оверлея. Без выбора цели нельзя проверить ни состав меню (рисует
    // оверлей), ни кнопки shell — они живут в разных webContents.
    const target = process.env['KONSTRUKTOR_EVAL_TARGET'] ?? 'tab'
    setTimeout(() => {
      const win = bootState.window
      const tab =
        bootState.activeTabId !== null ? bootState.tabs.get(bootState.activeTabId) : undefined
      const contents =
        target === 'shell'
          ? win?.webContents
          : target === 'overlay'
            ? win
              ? getActiveOverlay(win)?.webContents
              : undefined
            : tab?.view?.webContents
      if (!contents || contents.isDestroyed()) {
        console.log('[diag] eval: no target', target)
        return
      }
      console.log('[diag] eval target:', target)
      void contents
        .executeJavaScript(evalJs)
        .then((result: unknown) => console.log('[diag] eval:', JSON.stringify(result)))
        .catch((err: unknown) => console.log('[diag] eval failed:', String(err)))
    }, at)
  }
  // Сочетание клавиш без клавиатуры: KONSTRUKTOR_HOTKEY_TEST=<действие>
  // посылает в активную вкладку то самое сочетание, которое назначено
  // действию, через sendInputEvent. Проверяет всю цепочку
  // before-input-event -> matchHotkey -> действие, включая вызов
  // preventDefault: руками это не воспроизвести без клавиатуры и фокуса.
  const hotkeyTest = process.env['KONSTRUKTOR_HOTKEY_TEST']
  if (hotkeyTest) {
    const at = Number(process.env['KONSTRUKTOR_HOTKEY_TEST_MS'] ?? '4000') || 4000
    setTimeout(() => {
      const rec =
        bootState.activeTabId !== null ? bootState.tabs.get(bootState.activeTabId) : undefined
      if (!rec) {
        console.log('[diag] hotkey test: no active tab')
        return
      }
      const action = isHotkeyActionId(hotkeyTest) ? hotkeyTest : null
      if (!action) {
        console.log('[diag] hotkey test: unknown action', hotkeyTest)
        return
      }
      const accelerator = acceleratorFor(action, bootState.workspaceId)
      const parsed = parseAccelerator(accelerator)
      if (!parsed || !parsed.code) {
        console.log('[diag] hotkey test: accelerator not parsed', accelerator)
        return
      }
      // code вида 'KeyT' -> keyCode 'T'. sendInputEvent знает и имена
      // ('t'), и коды; берём букву/цифру из code, служебные клавиши — как есть.
      const keyCode = parsed.code.startsWith('Key')
        ? parsed.code.slice(3)
        : parsed.code.startsWith('Digit')
          ? parsed.code.slice(5)
          : parsed.code
      const modifiers: ('control' | 'meta' | 'alt' | 'shift')[] = []
      if (parsed.primary || parsed.ctrl) modifiers.push('control')
      if (parsed.meta) modifiers.push('meta')
      if (parsed.alt) modifiers.push('alt')
      if (parsed.shift) modifiers.push('shift')
      console.log('[diag] hotkey test:', action, accelerator, keyCode, modifiers)
      rec.view.webContents.sendInputEvent({
        type: 'keyDown',
        keyCode,
        modifiers
      })
      rec.view.webContents.sendInputEvent({
        type: 'keyUp',
        keyCode,
        modifiers
      })
    }, at)
  }
  // Меню браузера без мыши: тот же вызов, что у кнопки ☰, плюс состав
  // в лог. Нужно потому, что пункты меню проверяются только глазами, а
  // ошибка в id пункта тихая: пункт есть, но ничего не открывает.
  //
  // Обход ВСЕХ окон, а не только стартового: язык — настройка пространства,
  // и проверить это можно лишь сравнив меню двух пространств, открытых
  // одновременно. В логе у каждого набора — workspaceId и lang.
  const browserMenuAt = Number(process.env['KONSTRUKTOR_BROWSER_MENU_MS'] ?? '0') || 0
  if (browserMenuAt > 0) {
    setTimeout(() => {
      for (const ws of windows.values()) {
        const win = ws.window
        if (!win || win.isDestroyed()) continue
        showBrowserMenu(win, { x: 400, y: 300 })
        const request = getActiveRequest(win)
        console.log(
          `[diag] browser menu items (${ws.workspaceId}, lang=${langFor(ws.workspaceId)}):`,
          (request?.items ?? []).map((i) => `${i.id}:${i.label}`)
        )
      }
    }, browserMenuAt)
  }
  // Автопрогон расширений: KONSTRUKTOR_EXT_SMOKE=<путь к папке или .crx>
  // ставит расширение, печатает состояние и выходит. Проверяет всю
  // цепочку разом: распаковку, переписывание манифеста, загрузку в сессию,
  // запуск фона и работу loopback-моста (в логе видно id и ошибку).
  const extSmokePath = process.env['KONSTRUKTOR_EXT_SMOKE']
  if (extSmokePath) {
    const waitMs = Number(process.env['KONSTRUKTOR_EXT_SMOKE_MS'] ?? '3000') || 3000
    setTimeout(() => {
      log('lifecycle', 'ext-smoke: installing', { path: extSmokePath })
      void installFromPath(extSmokePath)
        .then(async (result) => {
          console.log('[ext-smoke] install:', JSON.stringify(result))
          console.log('[ext-smoke] bridge port:', bridgePort())
          await new Promise((r) => setTimeout(r, 1500))
          console.log('[ext-smoke] state:', JSON.stringify(extensionsState()))
          // Закрепляем ИМЕННО установленное расширение (по id из результата),
          // а не list[0]: в профиле уже может лежать другое расширение, и
          // прежняя версия закрепляла его — из-за чего после прогона
          // «закреплённым» оказывался не тот значок. Фолбэк на первый —
          // только если установка не отдала id.
          const installedId = result.info?.id
          const targetId = installedId ?? extensionsState().list[0]?.id
          if (targetId) {
            await setExtensionPinned(targetId, true)
            const pinned = extensionsState()
              .list.filter((e) => e.pinned)
              .map((e) => e.name)
            console.log('[ext-smoke] pinned:', JSON.stringify(pinned))
            console.log('[ext-smoke] menu:', JSON.stringify(extensionsMenuModel()))
          }
          return undefined
        })
        .catch((e: unknown) => {
          console.error('[ext-smoke] error:', e)
        })
        .finally(() => {
          // Выход через quit, а не exit: хук before-quit выгружает
          // расширения и снимает их регистрации в партиции. С app.exit
          // регистрации остаются, и следующий старт поднимает воркер
          // расширения в урезанном контексте (DidStartWorkerFail).
          app.quit()
        })
    }, waitMs)
  }
  // Диагностика меню расширений: открывает меню расширений тем же вызовом,
  // что и IPC-обработчик, спустя N мс после старта.
  const extMenuAt = Number(process.env['KONSTRUKTOR_EXT_MENU_MS'] ?? '0') || 0
  if (extMenuAt > 0) {
    setTimeout(() => {
      const win = bootState.window
      if (!win || win.isDestroyed()) return
      // Профиль и полное состояние — видно, куда пишет dev (userData)
      // и что реально лежит в реестре/меню.
      console.log('[diag] userData:', app.getPath('userData'))
      console.log('[diag] ext state:', JSON.stringify(extensionsState()))
      console.log('[diag] ext menu:', JSON.stringify(extensionsMenuModel()))
      log('lifecycle', 'auto-opening extensions menu', { afterMs: extMenuAt })
      showOverlay(win, {
        kind: 'extensions',
        anchor: { x: 400, y: 300 },
        extensions: extensionsMenuModel(),
        toggleKey: 'extensions-menu',
        onSelect: (id: string) => console.log('[diag] ext menu select:', id),
      })
    }, extMenuAt)
  }

  // ДИАГНОСТИКА (попап расширения): открывает попап первого расширения с
  // default_popup тем же вызовом, что и клик по значку. Нужно, чтобы
  // проверить попап без мыши: в его содержимом (tabs.query, отрисовка,
  // размер) видно, дошли ли до страницы вкладка и фон.
  const extPopupAt = Number(process.env['KONSTRUKTOR_EXT_POPUP_MS'] ?? '0') || 0
  if (extPopupAt > 0) {
    setTimeout(() => {
      const win = bootState.window
      if (!win || win.isDestroyed()) return
      const rec = extensionsState().list.find((e) => e.action?.hasPopup)
      if (!rec) {
        console.log('[diag] popup: нет расширения с default_popup')
        return
      }
      const width = win.getContentBounds().width
      const ws = getState(win)
      const activeRec = ws && ws.activeTabId !== null ? ws.tabs.get(ws.activeTabId) : undefined
      console.log('[diag] popup:', rec.name, 'tab=', activeRec?.url ?? '(нет)')
      // Якорь — как у закреплённого значка справа в адресной строке:
      // правый нижний угол под панелью (y ≈ высота панели), а не верх окна.
      void activateExtension(rec.id, win, { x: width - 48, y: 40, right: width - 48 })
    }, extPopupAt)
  }

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
          { id: 'auto-2', label: 'Auto item 2', icon: '🕘' },
        ],
        onSelect: () => undefined,
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
          wcFocused: wc.isFocused(),
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
          .join(','),
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
            focused: win.isFocused(),
          })
          if (ws) openFindOverlay(ws)
          const ov = getActiveOverlay(win)
          log('lifecycle', 'find cycle: #2 result', {
            opened: !!ov && !ov.isDestroyed(),
          })
        }, 400)
      }, 700)
    }, findCycleAt)
  }

  // Сводка по времени открытия оверлеев раз в 5 минут (OVERLAY_DEBUG != silent).
  setInterval(() => dumpOverlayStats(), 5 * 60 * 1000)
}
