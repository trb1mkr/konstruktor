// DnD-обработчики панели вкладок: старт/подсветка/дроп/вынос за окно,
// слияние окон, коммит единого ряда. Выделено из TabStrip.vue.
//
// Низкоуровневая механика (липкий токен, зазор) — в createStripDrag
// ниже; здесь — обработчики событий SFC вокруг неё. НОВЫЙ drag-сценарий
// (автоскролл, предпросмотр вставки) добавляется сюда, не в TabStrip.
import { ref, type Ref } from 'vue'
import { tabs } from '../../core/useTabs'
import { createStripDrag, stripItemDragOver, gapWidthFor as gapWidth, resetStripDrag } from './useStripDrag'

export interface TabStripDragDeps {
  // Корень панели: геометрия для определения «вынес за окно».
  strip: Ref<HTMLElement | null>
  // Зоны ряда для коммита перестановки (пinned решает, куда вставлять).
  pinnedStrip: Ref<string[]>
  normalStrip: Ref<string[]>
  // Активация вкладки при старте drag (как при клике).
  activate: (id: number) => void
}

export function useTabStripDrag(deps: TabStripDragDeps) {
  const stripDrag = createStripDrag()
  const dragId = stripDrag.dragId
  const dragGroupId = stripDrag.dragGroupId
  const dragOverToken = stripDrag.dragOverToken
  const dragWidth = stripDrag.dragWidth
  // Подсветка конкретной вкладки при onDragOver (зоны tab-on-tab).
  const dragOverId = ref<number | null>(null)
  // true пока чужой drag (из другого окна) висит над панелью — подсветка слияния.
  const mergeHover = ref(false)

  function reset() {
    resetStripDrag(stripDrag)
    dragOverId.value = null
  }

  // --- Слияние окон: прием чужой вкладки из другого окна ---

  function dragHasTab(e: DragEvent): boolean {
    const types = Array.from(e.dataTransfer?.types ?? [])
    return types.includes('application/x-konstruktor-tab') || types.includes('text/plain')
  }

  // Id чужой вкладки из dataTransfer. null = свой таб уже здесь или не таб.
  function extractForeignTabId(e: DragEvent): number | null {
    const raw =
      e.dataTransfer?.getData('application/x-konstruktor-tab') ??
      e.dataTransfer?.getData('text/plain') ??
      ''
    const m = raw.match(/(\d+)/)
    if (!m) return null
    const id = Number(m[1])
    if (tabs.value.some((t) => t.id === id)) return null
    return id
  }

  // --- DnD единого ряда: вкладки и группы одного ранга ---

  // Общий коммит перестановки единого ряда: вставить moving ПЕРЕД target.
  // Возвращает false если двигать нечего (чуждая зона, тот же индекс).
  async function commitStripOrder(target: string, moving: string): Promise<boolean> {
    const pinned = deps.pinnedStrip.value.includes(target)
    const arr = [...(pinned ? deps.pinnedStrip.value : deps.normalStrip.value)]
    if (!arr.includes(moving)) return false
    const fromIdx = arr.indexOf(moving)
    let toIdx = arr.indexOf(target)
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return false
    // Движение вперед: после вырезки индексы левеют — целимся перед целью.
    const [item] = arr.splice(fromIdx, 1)
    if (fromIdx < toIdx) toIdx -= 1
    arr.splice(toIdx, 0, item)
    const next = pinned
      ? { pinned: arr, normal: [...deps.normalStrip.value] }
      : { pinned: [...deps.pinnedStrip.value], normal: arr }
    await window.browserAPI.reorderStrip([...next.pinned, ...next.normal])
    return true
  }

  function onDragStart(id: number, e: DragEvent) {
    dragId.value = id
    dragGroupId.value = null
    const el = e.currentTarget instanceof HTMLElement ? e.currentTarget : null
    dragWidth.value = el?.offsetWidth || 160
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move'
      // Формат метки свой: чужие окна отличают наш drag от файлов/текста.
      e.dataTransfer.setData('application/x-konstruktor-tab', String(id))
      e.dataTransfer.setData('text/plain', `konstruktor-tab:${id}`)
    }
    deps.activate(id)
  }

  function onDragOver(id: number, e: DragEvent) {
    e.preventDefault()
    if (dragId.value === null || dragId.value === id) return
    dragOverId.value = id
  }

  function onDragLeave() {
    // Зазар НЕ сбрасываем: margin сдвигает цель вправо, курсор оказывается
    // в зазаре -> dragleave -> сброс -> возврат -> dragover -> цикл прыгания.
    // Токен живет до дропа/dragend/ухода с панели, поэтому сдвиг стабилен.
    dragOverId.value = null
  }

  async function onDrop(id: number, e: DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    const from = dragId.value
    reset()
    dragId.value = null
    if (from === id) return
    // Чужой дроп на вкладку: втягиваем вкладку в это окно.
    if (from === null) {
      const fid = extractForeignTabId(e)
      mergeHover.value = false
      if (fid === null) return
      await window.browserAPI.attachTab(fid)
      return
    }
    // Единый ряд: дроп вкладки на вкладку = вставка перед целью.
    // Minimize зону не меняет: все вкладки в обычном ряду, двигаются свободно.
    const arr = [...deps.normalStrip.value]
    const moving = `t:${from}`
    const target = `t:${id}`
    const fromIdx = arr.indexOf(moving)
    const toIdx = arr.indexOf(target)
    if (fromIdx < 0 || toIdx < 0) return
    arr.splice(toIdx, 0, ...arr.splice(fromIdx, 1))
    await window.browserAPI.reorderStrip([...deps.pinnedStrip.value, ...arr])
  }

  // Вынос за окно: если pointerup случился вне панели — detach в новое окно.
  // Отслеживаем через dragend + координаты курсора относительно панели.
  async function onDragEnd(e: DragEvent) {
    const id = dragId.value
    reset()
    mergeHover.value = false
    if (id === null || !deps.strip.value) return
    // dropEffect 'none' = дроп приняли в другом окне (merge) — новое не создаем.
    if (e.dataTransfer && e.dataTransfer.dropEffect !== 'none') return
    const r = deps.strip.value.getBoundingClientRect()
    // Курсор в экранных координатах: client + screen offset.
    const sx = e.screenX
    const sy = e.screenY
    const insideX = e.clientX >= r.left - 8 && e.clientX <= r.right + 8
    const insideY = e.clientY >= r.top - 40 && e.clientY <= r.bottom + 40
    if ((!insideX || !insideY) && sx !== 0 && sy !== 0) {
      await window.browserAPI.detachTab(id, { x: sx, y: sy })
    }
  }

  // Подсветка позиции дропа в едином ряду — липкий токен из useStripDrag.
  // Чужой drag (из другого окна): токена нет, только разрешаем дроп
  // и подсвечиваем панель тем же пунктиром, дроп разберут токены/полоса.
  function onStripItemDragOver(token: string, e: DragEvent) {
    if (dragId.value === null && dragGroupId.value === null) {
      if (!dragHasTab(e)) return
      e.preventDefault()
      e.stopPropagation()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      mergeHover.value = true
      return
    }
    stripItemDragOver(stripDrag, token, e)
  }

  // Дроп на элемент единого ряда: вставляем перетаскиваемое ПЕРЕД целью.
  // Вкладка на вкладку/группу, группа на группу/вкладку — ранг одинаковый.
  // Цель берем из липкого токена: после сдвига курсор уже не над целью
  // (над зазором/исходником), а событие drop приходит элементу под курсором.
  async function onStripItemDrop(token: string, e: DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    const fromTab = dragId.value
    const fromGroup = dragGroupId.value
    const target = dragOverToken.value ?? token
    reset()
    // Чужой дроп на элемент ряда: втягиваем вкладку в это окно.
    if (fromTab === null && fromGroup === null) {
      const fid = extractForeignTabId(e)
      mergeHover.value = false
      if (fid === null) return
      await window.browserAPI.attachTab(fid)
      return
    }
    const moving = fromTab !== null ? `t:${fromTab}` : `g:${fromGroup!}`
    await commitStripOrder(target, moving)
  }

  // Старт перетаскивания корневой группы: метка своя, как у вкладок.
  function onGroupDragStart(instanceId: string, e: DragEvent) {
    dragGroupId.value = instanceId
    dragId.value = null
    const el = e.currentTarget instanceof HTMLElement ? e.currentTarget : null
    dragWidth.value = el?.offsetWidth || 160
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('application/x-konstruktor-group', instanceId)
      e.dataTransfer.setData('text/plain', `konstruktor-group:${instanceId}`)
    }
  }

  // Событие из шаблона приходит с аргументом, но само оно не нужно: группы
  // не detach'атся, обработчик только сбрасывает состояние перетаскивания.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  function onGroupDragEnd(_event?: DragEvent) {
    reset()
    mergeHover.value = false
    // Группы не detach'атся — просто сбрасываем состояние.
  }

  function onStripDragOver(e: DragEvent) {
    // Свой drag над зазором между элементами (после сдвига цели курсор
    // уже не над целью): разрешаем дроп, иначе браузер его заблокирует.
    // Подсветку слияния при этом не включаем — это не чужое окно.
    if (dragId.value !== null || dragGroupId.value !== null) {
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      return
    }
    if (!dragHasTab(e)) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    mergeHover.value = true
  }

  function onStripDragLeave(e: DragEvent) {
    if (deps.strip.value && e.relatedTarget instanceof Node && deps.strip.value.contains(e.relatedTarget)) return
    mergeHover.value = false
    // Ушли с панели целиком — зазор больше не нужен.
    dragOverToken.value = null
  }

  async function onStripDrop(e: DragEvent) {
    mergeHover.value = false
    // Свой drag, отпущенный в зазоре между элементами (мимо всех токенов):
    // дроп идет по липкому токену — иначе перестановка терялась бы.
    if (dragId.value !== null || dragGroupId.value !== null) {
      e.preventDefault()
      const target = dragOverToken.value
      const moving =
        dragId.value !== null ? `t:${dragId.value}` : `g:${dragGroupId.value!}`
      reset()
      if (target) await commitStripOrder(target, moving)
      return
    }
    // Чужой дроп на пустое место полосы: втягиваем вкладку в это окно.
    e.preventDefault()
    const fid = extractForeignTabId(e)
    if (fid === null) return
    await window.browserAPI.attachTab(fid)
  }

  // Дроп вкладки на заголовок группы: положить вкладку в группу.
  // Перетаскивание групп (dragGroupId) сюда не относится — им занимается
  // единый ряд (onStripItemDrop), поэтому групповой drag игнорим и даем
  // событию всплыть до корня узла для reorder.
  function onGroupDragOver(e: DragEvent) {
    if (dragGroupId.value !== null) return
    if (dragId.value === null) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  }

  async function onGroupDrop(instanceId: string, e: DragEvent) {
    if (dragGroupId.value !== null) return
    e.preventDefault()
    e.stopPropagation()
    const from = dragId.value
    reset()
    // Чужой дроп на заголовок группы: втягиваем и кладем в группу.
    if (from === null) {
      const fid = extractForeignTabId(e)
      mergeHover.value = false
      if (fid === null) return
      await window.browserAPI.attachTab(fid)
      await window.browserAPI.addTabToGroup(fid, instanceId)
      return
    }
    await window.browserAPI.addTabToGroup(from, instanceId)
  }

  // Ширина плейсхолдера — из useStripDrag (прозрачный элемент перед целью).
  function gapWidthForToken(token: string): number {
    return gapWidth(stripDrag, token)
  }

  return {
    dragId,
    dragGroupId,
    dragOverToken,
    dragWidth,
    dragOverId,
    mergeHover,
    onDragStart,
    onDragOver,
    onDragLeave,
    onDrop,
    onDragEnd,
    onStripItemDragOver,
    onStripItemDrop,
    onGroupDragStart,
    onGroupDragEnd,
    onGroupDragOver,
    onGroupDrop,
    onStripDragOver,
    onStripDragLeave,
    onStripDrop,
    gapWidthForToken
  }
}
