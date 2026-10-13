// Точка входа main-процесса: кастомная схема, Secure DNS до ready,
// регистрация IPC и старт. Доменные каналы разнесены по register*Ipc
// рядом со своими модулями: окно/меню — windows/, вкладки/панель —
// tabs/, группы — groups/, хранилища — store/, роутинг страниц —
// pages/, оверлей — overlay/. Здесь — только wiring и жизненный цикл app.
import { app, protocol, session, BrowserWindow } from 'electron'
import { join } from 'path'
import { readFileSync, existsSync } from 'fs'
import { NORMAL_PARTITION, INCOGNITO_PARTITION } from './windows/browserState'
import { createWindow } from './windows/deps'
import { registerTabsIpc } from './tabs/tabsIpc'
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
import { watchPaintedOnce } from './overlay/service'
import { initI18n } from './i18n'
import { watchSystemTheme, applyWebContentScheme } from './browserTheme'
import { getSettings } from './store/settingsStore'
import { applySecureDns, dnsServersFor } from './store/dnsConfig'
import { setupDiagnostics } from './diagnostics'

// Кастомная схема должна стать privileged ДО ready, иначе WebContentsView ее не отрендерит.
protocol.registerSchemesAsPrivileged([
  { scheme: 'konstruktor', privileges: { standard: true, secure: true } }
])

// Secure DNS применяется ДО ready через command-line switches.
// Читаем settings.json синхронно здесь нельзя (async store) —
// применяем сохраненное значение асинхронно при старте тоже нельзя:
// switches должны встать до инициализации net-стека. Поэтому:
// 1) при старте читаем файл напрямую синхронно, 2) UI правит через store.
try {
  const p = join(app.getPath('userData'), 'settings.json')
  if (existsSync(p)) {
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as { dnsMode?: string; dnsCustom?: string }
    applySecureDns(dnsServersFor(raw.dnsMode ?? 'off', raw.dnsCustom ?? ''))
  }
} catch {
  // Нет настроек — системный DNS.
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
  // Базовая тема веб-контента в Chromium ДО первого окна: иначе первая
  // вкладка отрисуется по теме ОС, а не по настройке. Заодно наполняет
  // кэш настроек: getSettingsSync() на холодном старте отдавал дефолты,
  // и фон первой вкладки всегда был тёмным независимо от темы.
  applyWebContentScheme(await getSettings())
  // Внутренние страницы: один хендл на схему + preload в каждом фрейме.
  // Обе регистрации идут на всех трех партициях: protocol.handle и
  // registerPreloadScript привязаны к сессии, иначе view с
  // persist-партицией не резолвит konstruktor://* и не видит window.konstruktor.
  for (const ses of [
    session.defaultSession,
    session.fromPartition(NORMAL_PARTITION),
    session.fromPartition(INCOGNITO_PARTITION)
  ]) {
    registerInternalProtocol(ses)
    registerInternalPreload(ses)
  }
  setupDownloads(session.defaultSession)
  setupDownloads(session.fromPartition(NORMAL_PARTITION))
  // Приватная партиция вкладок: загрузки идут и сохраняются как обычно
  // (приватность касается cookies и истории), но тост о загрузке
  // показывается только в приватном окне.
  setupDownloads(session.fromPartition(INCOGNITO_PARTITION), true)
  registerIpc()
  // Расширения поднимаются ПОСЛЕ регистрации сессий и ДО первого окна:
  // контент-скрипты и фоновые service worker'ы должны успеть встать
  // до навигации первой вкладки. Мост (loopback) стартует внутри.
  await initExtensions()
  // Системная тема ОС: nativeTheme следит сам и шлет обновления —
  // пересчитываем color-scheme сайтов при смене темы ОС.
  watchSystemTheme()
  const bootState = createWindow()
  setupDiagnostics(bootState)
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
  const unload = shutdownExtensions().catch(() => undefined)
  // Выход не должен зависеть от скорости выгрузки: если она почему-то
  // подвиснет, через секунду всё равно выходим.
  void Promise.race([unload, new Promise((r) => setTimeout(r, 1200))]).finally(() => app.quit())
})
