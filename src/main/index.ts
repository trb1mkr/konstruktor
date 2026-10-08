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
import { watchPaintedOnce } from './overlay/service'
import { initI18n } from './i18n'
import { watchSystemTheme } from './browserTheme'
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
