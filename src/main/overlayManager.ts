// Фасад оверлеев. Вся логика живёт в overlay/service.ts.
//
// Файл оставлен как точка входа для существующих вызовов: 14 мест в
// index.ts, groupsMenu.ts, findManager.ts и windowsManager.ts импортируют
// имена отсюда. Миграция на service идёт по одному вызову на шаге 10 —
// пока все идут через этот файл, менять их можно независимо от
// внутреннего устройства сервиса.
//
// Новый код должен импортировать из './overlay/service' напрямую.

export {
  ensureOverlayWindow,
  showOverlay,
  closeOverlay,
  closeOverlayIfMenu,
  closeOverlayOnTabChange,
  getActiveOverlay,
  getActiveRequest,
  getParentOfOverlay,
  resolveOverlaySelect,
  resolveOverlayDismiss,
  resolveOverlaySubmit,
  resolveOverlaySubmitIcon,
  updateActiveOverlay,
  updateOverlayBySender
} from './overlay/service'

export type {
  OverlayMenuItem,
  OverlayDialogButton,
  IconDialogState
} from './overlay/service'

// Реэкспорт верификации иконки: исторически жил здесь, и старые вызовы
// импортируют его из overlayManager.
export { verifyIconSource } from './iconVerify'
