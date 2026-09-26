import { onMounted, onUnmounted, type Ref } from 'vue'

// Сообщает main-стороне отступы UI, чтобы WebContentsView занял остаток.
// Каждый layout-SFC вызывает это с ref на свои панели.
export function useLayoutInsets(panels: {
  top?: Ref<HTMLElement | null>
  bottom?: Ref<HTMLElement | null>
  left?: Ref<HTMLElement | null>
  right?: Ref<HTMLElement | null>
}) {
  function measure(): void {
    if (!window.browserAPI) return
    const insets = {
      top: panels.top?.value?.offsetHeight ?? 0,
      bottom: panels.bottom?.value?.offsetHeight ?? 0,
      left: panels.left?.value?.offsetWidth ?? 0,
      right: panels.right?.value?.offsetWidth ?? 0
    }
    window.browserAPI.updateLayout(insets)
  }

  let observer: ResizeObserver | null = null
  // Панели монтируются/размонтируются (v-if контентного fullscreen):
  // пересчитываем отступы при изменении DOM, а не только resize.
  let domObserver: MutationObserver | null = null

  onMounted(() => {
    measure()
    window.addEventListener('resize', measure)
    observer = new ResizeObserver(measure)
    for (const p of Object.values(panels)) {
      if (p?.value) observer.observe(p.value)
    }
    domObserver = new MutationObserver(measure)
    domObserver.observe(document.body, { childList: true, subtree: true })
    // Повторный замер после монтирования стилей.
    requestAnimationFrame(measure)
  })

  onUnmounted(() => {
    window.removeEventListener('resize', measure)
    observer?.disconnect()
    domObserver?.disconnect()
  })

  return { measure }
}
