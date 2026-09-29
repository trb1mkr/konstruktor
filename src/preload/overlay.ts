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
  findClose: (): Promise<boolean> => ipcRenderer.invoke('find:close'),
  // Диагностика (шаг 1 рефакторинга): renderer сообщает main о своих
  // наблюдениях — какая анимация играет, какие классы на элементах.
  // Канал однонаправленный и безопасный: принимает только строки.
  trace: (message: string): void => {
    ipcRenderer.send('overlay:trace', message)
  },
  // Готовность отрисовки: renderer подтверждает, что новый payload уже
  // применён и компонент смонтирован. Main держит окно прозрачным до этого
  // сигнала, иначе между setOpacity(1) и обновлением DOM пользователь видит
  // старые пункты меню (вспышку предыдущего содержимого).
  // token — идентификатор текущей сессии, чтобы отсечь запоздалые подтверждения.
  ready: (token: number): void => {
    ipcRenderer.send('overlay:ready', token)
  }
}

export type OverlayAPI = typeof overlayAPI

contextBridge.exposeInMainWorld('overlayAPI', overlayAPI)

declare global {
  interface Window {
    overlayAPI: OverlayAPI
  }
}
