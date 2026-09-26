import { ref } from 'vue'

// Текущая тема shell: 'dark' | 'light' | 'system' | 'slate'.
// 'system' резолвится через matchMedia в эффективную dark/light.
// Источник — main через settings, shell подписывается при старте
// и на каждое изменение настроек.
// Кастомные компоненты могут игнорировать тему: обернуть свой корень
// в .theme-lock — внутри него CSS-переменные зафиксированы на dark.
export type BrowserTheme = 'dark' | 'light' | 'system' | 'slate'
export type EffectiveTheme = 'dark' | 'light' | 'slate'

export const theme = ref<BrowserTheme>('dark')
export const effectiveTheme = ref<EffectiveTheme>('dark')
// Скругление углов окна: по дефолту выключено.
export const roundedCorners = ref(false)

const systemMq =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: light)')
    : null

function resolveEffective(next: BrowserTheme): EffectiveTheme {
  if (next === 'system') return systemMq?.matches ? 'light' : 'dark'
  return next
}

export function setTheme(next: BrowserTheme): void {
  theme.value = next
  effectiveTheme.value = resolveEffective(next)
  document.documentElement.dataset.theme = effectiveTheme.value
}

// Системная тема сменилась на уровне ОС — пересчитать эффективную.
if (systemMq) {
  const onSystem = () => {
    if (theme.value === 'system') setTheme('system')
  }
  if (typeof systemMq.addEventListener === 'function') systemMq.addEventListener('change', onSystem)
  else systemMq.addListener(onSystem)
}

export async function loadTheme(): Promise<void> {
  try {
    const s = await window.browserAPI.getSettings()
    const t = s.theme as BrowserTheme
    setTheme(t === 'light' || t === 'system' || t === 'slate' ? t : 'dark')
    roundedCorners.value = s.roundedCorners === true
    document.documentElement.dataset.rounded = roundedCorners.value ? 'on' : 'off'
  } catch {
    setTheme('dark')
    roundedCorners.value = false
    document.documentElement.dataset.rounded = 'off'
  }
}
