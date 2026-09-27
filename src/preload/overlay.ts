import { contextBridge, ipcRenderer } from 'electron'

// Preload оверлей-окна (меню, тосты, попапы поверх WebContentsView).
// Канал overlay:* изолирован от browserAPI основного окна.
const overlayAPI = {
  select: (id: string): Promise<boolean> => ipcRenderer.invoke('overlay:select', id),
  dismiss: (): Promise<boolean> => ipcRenderer.invoke('overlay:dismiss'),
  // Диалог с полем ввода: значение уходит через overlay:submit.
  submit: (value: string): Promise<boolean> => ipcRenderer.invoke('overlay:submit', value),
  // Общий диалог иконки: кнопка + ввод уходят через overlay:submit-icon.
  // false = main отклонил источник (ошибка верификации), диалог не закрывается.
  submitIcon: (buttonId: string, value: string): Promise<boolean> =>
    ipcRenderer.invoke('overlay:submit-icon', buttonId, value),
  // Поиск по странице: запрос, навигация и закрытие панели.
  findQuery: (opts: {
    query: string
    matchCase: boolean
    wholeWord: boolean
    useRegex: boolean
  }): Promise<boolean> => ipcRenderer.invoke('find:query', opts),
  findNext: (): Promise<boolean> => ipcRenderer.invoke('find:next'),
  findPrev: (): Promise<boolean> => ipcRenderer.invoke('find:prev'),
  findClose: (): Promise<boolean> => ipcRenderer.invoke('find:close')
}

export type OverlayAPI = typeof overlayAPI

contextBridge.exposeInMainWorld('overlayAPI', overlayAPI)

declare global {
  interface Window {
    overlayAPI: OverlayAPI
  }
}
