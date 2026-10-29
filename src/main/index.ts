// Точка входа main-процесса: кастомная схема, Secure DNS до ready,
// регистрация IPC и старт. Доменные каналы разнесены по register*Ipc
// рядом со своими модулями: окно/меню — windows/, вкладки/панель —
// tabs/, группы — groups/, хранилища — store/, роутинг страниц —
// pages/, оверлей — overlay/. Здесь — только wiring и жизненный цикл app.
import { app, protocol, session, BrowserWindow } from 'electron'
import { createWindow, openWorkspaceWindows } from './windows/deps'
import { bootWorkspaceId, ensureWorkspaceLayoutSync, createWorkspace, workspaceExists, readWorkspaceMeta } from './workspaces/registry'
import { markAppQuitting, persistWorkspaceWindowsSync } from './workspaces/windowSnapshot'
import { endWorkspaceSession } from './workspaces/sessions'
import { windows } from './windows/browserState'
import { ensureWorkspaceSession, onWorkspaceSession } from './workspaces/electronSession'
import { ensureGlobalSettingsSync, getGlobalSettingsSync } from './store/settingsStore'
import { registerTabsIpc } from './tabs/tabsIpc'
import { registerWorkspacesIpc } from './workspaces/ipc'
import { registerTabsMenuIpc } from './tabs/tabsMenu'
import { registerWindowIpc } from './windows/windowIpc'
import { registerBrowserMenuIpc } from './windows/browserMenu'
import { registerGroupsIpc } from './groups/groupsManager'
import { registerStoresIpc, setupDownloads } from './store/ipc'
import { registerInternalProtocol } from './pages/protocol'
import { registerInternalPreload } from './pages/internalBridge'
import { registerOverlayIpc } from './overlay/ipc'
import { registerExtensionsIpc } from './extensions/ipc'
import { initExtensions, shutdownExtensions } from './extensions/manager'
import { registerPermissionsIpc } from './permissions/ipc'
import { initPermissions, installPermissionHandlers } from './permissions/permissionManager'
import { registerCaptureIpc } from './permissions/captureIndicator'
import { watchPaintedOnce } from './overlay/service'
import { initI18n } from './i18n'
import { watchSystemTheme, applyWebContentSchemeFor } from './browserTheme'
import { applySecureDns, dnsServersFor } from './store/dnsConfig'
import { setupDiagnostics } from './diagnostics'

// Кастомная схема должна стать privileged ДО ready, иначе WebContentsView ее не отрендерит.
protocol.registerSchemesAsPrivileged([
  { scheme: 'konstruktor', privileges: { standard: true, secure: true } }
])

// Secure DNS применяется ДО ready через command-line switches.
//
// Раскладка рабочих пространств готовится ПЕРВОЙ: старый профиль переезжает
// в workspaces/default, и только после этого известно, где лежат настройки.
// DNS живёт в общем settings-global.json — это поле процесса, а не
// пространства: switches ставятся один раз на запуск.
try {
  ensureWorkspaceLayoutSync()
  ensureGlobalSettingsSync()
  const { dnsMode, dnsCustom } = getGlobalSettingsSync()
  applySecureDns(dnsServersFor(dnsMode, dnsCustom))
} catch {
  // Нет настроек — системный DNS.
}

/**
 * Регистрация на сессию пространства.
 *
 * Порядок хуков — это порядок подготовки: страницы (protocol + preload),
 * разрешения, загрузки. Хуки вызываются из ensureWorkspaceSession при
 * открытии первого окна пространства и только один раз на пространство.
 *
 * defaultSession не принадлежит ни одному пространству, но Chromium может
 * спросить разрешение и у неё — её готовим отдельно, в пространство запуска.
 */
function registerSessionHooks(): void {
  onWorkspaceSession((ses, ctx) => registerInternalProtocol(ses, ctx.wsId))
  onWorkspaceSession((ses) => registerInternalPreload(ses))
  onWorkspaceSession((ses, ctx) => installPermissionHandlers(ses, ctx.persist, ctx.wsId))
  onWorkspaceSession((ses, ctx) => setupDownloads(ses, ctx.wsId, !ctx.persist))
}

function registerIpc() {
  registerTabsIpc()
  registerTabsMenuIpc()
  registerWindowIpc()
  registerBrowserMenuIpc()
  registerStoresIpc()
  registerGroupsIpc()
  // Каналы расширений: список, установка, тумблеры, клик по кнопке.
  registerExtensionsIpc()
  // Пространства: список, создание, дублирование, правка, удаление.
  registerWorkspacesIpc()
  // Разрешения страниц: якорь адресной строки, меню бейджа, управление
  // решениями на странице настроек. Плюс отчёты страниц о захвате медиа.
  registerPermissionsIpc()
  registerCaptureIpc()
  // Оверлейные каналы (overlay:*, find:*) — в overlay/ipc.ts.
  registerOverlayIpc()
  // Учёт подтверждений отрисовки оверлея. Слушатель должен стоять ДО
  // первого показа: иначе подтверждение, пришедшее между отправкой push
  // и подпиской ожидания, улетело бы в пустоту, и показ завершился бы
  // аварийным гашением по таймауту.
  watchPaintedOnce()
}

void app.whenReady().then(async () => {
  // Язык интерфейса: init до регистрации страниц и первого окна —
  // иначе сборки страниц и меню ушли бы на неготовом i18next.
  await initI18n()
  // Хуки сессий ставятся ДО первой регистрации: ensureWorkspaceSession
  // перебирает их и для пространства запуска, и для всех следующих.
  registerSessionHooks()
  // Базовая тема веб-контента в Chromium ДО первого окна: иначе первая
  // вкладка отрисуется по теме ОС, а не по настройке. Схема — настройка
  // пространства; здесь ставится схема того, которое стартует (при смене
  // фокуса окна её переставит syncProcessScheme).
  applyWebContentSchemeFor(bootWorkspaceId())
  // defaultSession: страницы и preload нужны и ей — если какая-то
  // служебная страница откроется без партиции. Разрешения для неё ставит
  // initPermissions, загрузки — здесь.
  registerInternalProtocol(session.defaultSession, bootWorkspaceId())
  registerInternalPreload(session.defaultSession)
  setupDownloads(session.defaultSession, bootWorkspaceId())
  // Разрешения страниц: обработчики ставим ДО первого окна — иначе
  // первая же вкладка успела бы запросить доступ до того, как появится
  // промпт, и Chromium отдал бы его по дефолту (без спроса).
  await initPermissions()
  registerIpc()
  // Сессии пространства запуска: поднимаются здесь, до первого окна,
  // потому что createWindow создаёт вкладку уже на did-finish-load.
  // Остальные пространства поднимутся при открытии своих окон.
  ensureWorkspaceSession(bootWorkspaceId())
  // Расширения поднимаются ПОСЛЕ регистрации сессий и ДО первого окна:
  // контент-скрипты и фоновые service worker'ы должны успеть встать
  // до навигации первой вкладки. Мост (loopback) стартует внутри.
  await initExtensions(bootWorkspaceId())
  // Системная тема ОС: nativeTheme следит сам и шлет обновления —
  // пересчитываем color-scheme сайтов при смене темы ОС.
  watchSystemTheme()
  // Старт: последнее открытое пространство и ВСЕ его окна из слепка.
  // Слепка нет — одно окно со стартовой страницей.
  const bootWindows = openWorkspaceWindows(bootWorkspaceId())
  const bootState = bootWindows[0] ?? createWindow({ workspaceId: bootWorkspaceId() })
  setupDiagnostics(bootState)
  // Диагностика изоляции пространств: второе окно в другом пространстве.
  //
  //   KONSTRUKTOR_WORKSPACE=<id>   открыть существующее пространство
  //   KONSTRUKTOR_NEW_WORKSPACE=<имя>  создать и открыть новое
  //
  // Пока нет страницы пространств (шаг 5), это единственный способ проверить,
  // что партиции, история и настройки не смешиваются между окнами.
  const extraId =
    process.env.KONSTRUKTOR_WORKSPACE ??
    (process.env.KONSTRUKTOR_NEW_WORKSPACE
      ? createWorkspace({ name: process.env.KONSTRUKTOR_NEW_WORKSPACE }).id
      : '')
  if (extraId && extraId !== bootWorkspaceId() && workspaceExists(extraId)) {
    const meta = readWorkspaceMeta(extraId)
    console.log('[workspace] opening extra:', extraId, meta?.name, meta?.partition)
    void initExtensions(extraId)
    openWorkspaceWindows(extraId)
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Расширения выгружаются ПЕРЕД выходом, и это не уборка за собой.
//
// Chromium хранит регистрацию service worker'а расширения в партиции и на
// следующем старте поднимает его сам — ДО того, как наш код вызовет
// loadExtension. В этот момент расширение ещё не загружено, контекст
// урезанный (chrome без родных API), и фон падает: в логе
// «Cannot read properties of undefined (reading 'onMessage')» и
// DidStartWorkerFail. Замерено: со снятием регистраций при выходе
// следующий старт проходит без единой ошибки расширений.
let extensionsUnloaded = false
app.on('before-quit', (event) => {
  if (extensionsUnloaded) return
  event.preventDefault()
  extensionsUnloaded = true
  // Окна начинают закрываться сразу после выхода из этого обработчика.
  // Без пометки хук закрытия окна писал бы слепок на каждом закрытии, и
  // к моменту последнего окна в нём осталось бы только оно.
  markAppQuitting()
  // Слепок окон снимается ЗДЕСЬ, пока все окна ещё живы: дальше они
  // закрываются по одному, и `captureWindow` вернул бы только последнее.
  // Там же закрываются сессии: маркер, снятый до закрытия окон, делает
  // выход штатным — иначе следующий запуск считал бы его аварией и
  // предлагал восстановление там, где всё сохранилось нормально.
  for (const wsId of new Set([...windows.values()].map((ws) => ws.workspaceId))) {
    persistWorkspaceWindowsSync(wsId)
    endWorkspaceSession(wsId)
  }
  const unload = shutdownExtensions().catch(() => undefined)
  // Выход не должен зависеть от скорости выгрузки: если она почему-то
  // подвиснет, через секунду всё равно выходим.
  void Promise.race([unload, new Promise((r) => setTimeout(r, 1200))]).finally(() => app.quit())
})
