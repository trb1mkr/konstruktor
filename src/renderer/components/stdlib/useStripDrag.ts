// DnD единого ряда панели: липкий токен + плейсхолдер зазора.
// Выделено из TabStrip.vue: TabGroupNode только пробрасывает события,
// вся логика коммита живет здесь. Один источник — один коммит.
import { ref, type Ref } from 'vue'

export interface StripDrag {
  dragId: Ref<number | null>
  dragGroupId: Ref<string | null>
  dragOverToken: Ref<string | null>
  dragWidth: Ref<number>
}

export function createStripDrag(): StripDrag {
  return {
    dragId: ref<number | null>(null),
    dragGroupId: ref<string | null>(null),
    dragOverToken: ref<string | null>(null),
    dragWidth: ref(0)
  }
}

// Подсветка позиции дропа: токен элемента под курсором.
// Токен «липкий»: когда цель сдвигается вправо на ширину перетаскиваемого,
// курсор оказывается левее цели — над зазором, исходником или соседом.
// Переключать токен в этот момент нельзя, иначе цель возвращается назад
// и начинается цикл прыгания. Dragover над самим перетаскиваемым
// токен не меняет (но preventDefault делаем, чтобы drop сработал).
export function stripItemDragOver(drag: StripDrag, token: string, e: DragEvent): void {
  if (drag.dragId.value === null && drag.dragGroupId.value === null) return
  const moving = drag.dragId.value !== null ? `t:${drag.dragId.value}` : `g:${drag.dragGroupId.value!}`
  // Над самим перетаскиваемым: токен не меняем, дроп разрешаем.
  if (token === moving) {
    e.preventDefault()
    e.stopPropagation()
    return
  }
  // Группа на саму себя — не подсвечиваем.
  if (drag.dragGroupId.value !== null && token === `g:${drag.dragGroupId.value}`) return
  if (drag.dragOverToken.value === token) {
    e.preventDefault()
    e.stopPropagation()
    return
  }
  e.preventDefault()
  e.stopPropagation()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  drag.dragOverToken.value = token
}

// Ширина плейсхолдера под дроп: ширина перетаскиваемого + зазор ряда.
// Плейсхолдер — отдельный прозрачный элемент ПЕРЕД целью: он занимает
// место в layout, поэтому цель не возвращается назад, а курсор над зазором
// продолжает относиться к цели (dragover плейсхолдера = тот же токен).
export function gapWidthFor(drag: StripDrag, token: string): number {
  if (drag.dragOverToken.value !== token || drag.dragWidth.value <= 0) return 0
  if (drag.dragId.value === null && drag.dragGroupId.value === null) return 0
  if (drag.dragId.value !== null && token === `t:${drag.dragId.value}`) return 0
  if (drag.dragGroupId.value !== null && token === `g:${drag.dragGroupId.value}`) return 0
  return Math.round(drag.dragWidth.value + 4)
}

export function resetStripDrag(drag: StripDrag): void {
  drag.dragId.value = null
  drag.dragGroupId.value = null
  drag.dragOverToken.value = null
  drag.dragWidth.value = 0
}
