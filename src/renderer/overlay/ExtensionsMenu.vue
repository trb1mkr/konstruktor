<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { ExtensionMenuEntry } from '../../shared/extensions-types'

// Меню расширений — overlay-kind 'extensions', открывается кнопкой-пазлом
// справа от адресной строки (как в Chrome и Яндекс Браузере).
//
// Живёт в overlay-окне, а не выпадашкой в панели: список длинный и
// выходит за пределы панели shell, а всё, что ниже инсетов, перекрыто
// WebContentsView. Позиционирование и закрытие по клику мимо даёт
// overlay (align 'anchor-end', dismissable menu-like).
//
// Каждая строка — расширение. Слева значок и имя (клик открывает попап
// расширения или шлёт ему событие), справа только закрепление. В конце
// списка — вход на страницу расширений: построчные действия там не нужны,
// карточка расширения и её настройки доступны на самой странице,
// а фиксированной кнопкой список не раздувается. Закреплённые
// дополнительно видны на панели.
const props = defineProps<{
  items?: ExtensionMenuEntry[]
  enabled?: boolean
  sessionId?: number
}>()

// Идентификаторы команд совпадают с разбором в extensions/ipc.ts:
// 'pin:<id>', 'unpin:<id>', 'open:<id>', 'manage'.
function send(id: string) {
  void window.overlayAPI.select(id, props.sessionId)
}

function rowIcon(item: ExtensionMenuEntry): string {
  return item.icon || ''
}

function letter(name: string): string {
  return (name || '?').slice(0, 1).toUpperCase()
}

// Фокус на контейнер, а не на первую строку.
//
// OverlayRoot.focusTopLevel() ставит фокус на первый элемент уровня.
// Без tabindex у корня им становится первая кнопка строки (`.ext-main`),
// и она на открытии обводится фокус-рамкой — хотя пользователь ничего
// не выбирал. Корень как цель фокуса убирает это: он не интерактивен,
// и обводки у него нет (как у `.menu-list` в MenuList).
const root = ref<HTMLElement | null>(null)

onMounted(() => {
  root.value?.focus()
})
</script>

<template>
  <div ref="root" class="ext-menu" role="menu" tabindex="0" @mousedown.stop>
    <div class="ext-title">{{ $t('extensions.menu') }}</div>
    <div v-if="!items || items.length === 0" class="ext-empty">
      {{ $t('extensions.empty') }}
    </div>
    <div
      v-for="item in items"
      :key="item.id"
      class="ext-row"
      :class="{ off: !item.enabled }"
    >
      <button class="ext-main" type="button" :title="item.name" @click="send('open:' + item.id)">
        <span class="ext-ico">
          <img v-if="rowIcon(item)" :src="rowIcon(item)" alt="" />
          <span v-else class="ext-letter">{{ letter(item.name) }}</span>
          <span
            v-if="item.badge"
            class="ext-badge"
            :style="item.badgeColor ? { background: item.badgeColor } : {}"
            >{{ item.badge }}</span
          >
        </span>
        <span class="ext-name">{{ item.name }}</span>
        <span v-if="item.warningCount" class="ext-warn" :title="$t('extensions.warnings')">!</span>
      </button>
      <button
        v-if="item.canPin"
        class="ext-act"
        type="button"
        :title="item.pinned ? $t('extensions.unpin') : $t('extensions.pin')"
        :class="{ pinned: item.pinned }"
        @click="send((item.pinned ? 'unpin:' : 'pin:') + item.id)"
      >
        {{ item.pinned ? '📌' : '📌' }}
      </button>
    </div>
    <div class="ext-sep"></div>
    <button class="ext-manage" type="button" @click="send('manage')">
      <span class="ext-manage-ico">⚙️</span>{{ $t('extensions.manageAll') }}
    </button>
  </div>
</template>

<style scoped>
/* 4px по краям — те же поля, что у меню и попапа зума: иначе композитор
   срезает скруглённые углы карточки на кромке окна. */
.ext-menu {
  margin: 4px 4px 0 0;
  background: var(--ov-bg);
  border: 1px solid var(--ov-border);
  border-radius: 12px;
  padding: 6px;
  min-width: 280px;
  /* Контейнер получает фокус (см. script), но рамки у него быть не должно:
     фокус-обводка на открытии читалась бы как выбор первого пункта. */
  outline: none;
}
.ext-title {
  font-size: 12px;
  color: var(--ov-dim);
  padding: 6px 10px 8px;
}
.ext-empty {
  font-size: 13px;
  color: var(--ov-dim);
  padding: 10px;
}
.ext-row {
  display: flex;
  align-items: center;
  gap: 2px;
  border-radius: 8px;
}
.ext-row:hover { background: var(--ov-hover); }
.ext-row.off .ext-name,
.ext-row.off .ext-ico { opacity: 0.5; }
.ext-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 8px;
  background: transparent;
  border: none;
  color: var(--ov-text);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  border-radius: 8px;
}
.ext-ico {
  position: relative;
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.ext-ico img { width: 18px; height: 18px; }
.ext-letter { font-size: 13px; color: var(--ov-dim); }
.ext-badge {
  position: absolute;
  right: -4px;
  top: -4px;
  min-width: 13px;
  height: 13px;
  padding: 0 3px;
  border-radius: 7px;
  background: #666;
  color: #fff;
  font-size: 9px;
  line-height: 13px;
  text-align: center;
}
.ext-name {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ext-warn { color: #e2b04a; font-weight: 700; padding: 0 4px; }
.ext-act {
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 6px;
  color: var(--ov-dim);
  font-size: 13px;
  cursor: pointer;
  opacity: 0.55;
}
/* Кнопка действия проявляется на наведение строки или когда состояние
   включено: постоянно видимые значки превращали список в рябь. */
.ext-row:hover .ext-act { opacity: 1; }
.ext-act.pinned { opacity: 1; }
.ext-act:hover { background: var(--ov-hover); color: var(--ov-text); }
.ext-act.pinned { transform: rotate(-45deg); }
.ext-sep {
  height: 1px;
  background: var(--ov-border);
  margin: 6px 4px;
}
.ext-manage {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  background: transparent;
  border: none;
  border-radius: 8px;
  color: var(--ov-text);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.ext-manage:hover { background: var(--ov-hover); }
.ext-manage-ico { font-size: 15px; color: var(--ov-dim); }
</style>
