// Пути рабочих пространств. Единственное место, где собирается раскладка
// userData: сторы спрашивают путь у этого модуля, а не склеивают его сами.
//
// Каталог пространства содержит ВСЕ мутируемые данные браузера: настройки,
// историю, загрузки, группы, закладки, разрешения, реестр расширений и их
// файлы. Общими для приложения остаются только реестр пространств и
// settings-global.json (DNS и язык — на процесс, см. WORKSPACES.md).
import { app } from 'electron'
import { join } from 'path'

/** Корень данных приложения (Electron userData). */
export function userDataDir(): string {
  return app.getPath('userData')
}

/** Реестр пространств: порядок в списке и последнее открытое. */
export function workspaceRegistryFile(): string {
  return join(userDataDir(), 'workspaces.json')
}

/** Общие настройки процесса: DNS и язык интерфейса. */
export function globalSettingsFile(): string {
  return join(userDataDir(), 'settings-global.json')
}

export function workspacesRoot(): string {
  return join(userDataDir(), 'workspaces')
}

export function workspaceDir(wsId: string): string {
  return join(workspacesRoot(), wsId)
}

/** Файл внутри каталога пространства: 'history.json', 'settings.json' и т.п. */
export function workspaceFile(wsId: string, name: string): string {
  return join(workspaceDir(wsId), name)
}

/** Каталог установленных расширений пространства. */
export function workspaceExtensionsDir(wsId: string): string {
  return join(workspaceDir(wsId), 'extensions')
}
