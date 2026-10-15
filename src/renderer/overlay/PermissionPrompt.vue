<script setup lang="ts">
import { ref } from 'vue'

// Промпт разрешения веб-страницы — overlay-kind 'permission'.
//
// Показывается, когда сайт просит камеру, микрофон, геолокацию и т.п.
// Условия запроса приходят из main ГОТОВЫМИ строками: таблица разрешений
// живёт в main (permissions/policy.ts), и собирать подписи в renderer
// значило бы продублировать её в двух процессах.
//
// Выбор уходит через overlay:submit строкой 'id::1' (1 — запомнить
// решение). Отдельного канала вид не заводит: submit уже несёт пару
// «кнопка + значение», и тот же путь используется диалогами.
//
// Escape не ловим: окно оверлея слушает его глобально и закрывает сессию
// — main трактует это как отказ и вызывает callback(false) обработчика
// разрешения. Отказ обязан дойти до страницы, иначе getUserMedia повиснет.
const props = defineProps<{
  sessionId?: number
  permission: {
    host: string
    origin: string
    lines: { icon: string; text: string }[]
    buttons: { id: string; label: string }[]
    rememberLabel: string
    ephemeral: boolean
  }
}>()

const emit = defineEmits<{
  (e: 'submit', value: string): void
}>()

// Чекбокс «запомнить» включён по умолчанию: пользователь редко хочет
// отвечать на тот же вопрос при следующем заходе на сайт. Приватное окно
// решение всё равно не сохранит — там чекбокса нет (ephemeral).
const remember = ref(true)

function choose(id: string): void {
  emit('submit', id + '::' + (remember.value ? '1' : '0'))
}

function onKey(e: KeyboardEvent): void {
  // Enter — разрешить, как в Chrome. На кнопке Enter обрабатывает сама
  // кнопка: без этой проверки клик пришёл бы дважды.
  if (e.key !== 'Enter' || e.target instanceof HTMLButtonElement) return
  e.preventDefault()
  choose('allow')
}
</script>

<template>
  <div class="permission-prompt" @mousedown.stop @keydown="onKey">
    <div class="perm-title">{{ $t('permissions.title', { host: props.permission.host }) }}</div>
    <div class="perm-lines">
      <div v-for="(line, i) in props.permission.lines" :key="i" class="perm-line">
        <span class="perm-line-icon">{{ line.icon }}</span>
        <span class="perm-line-text">{{ line.text }}</span>
      </div>
    </div>
    <div class="perm-origin" :title="props.permission.origin">{{ props.permission.origin }}</div>
    <!-- Кнопки идут ПЕРЕД чекбоксом в DOM, чтобы фокус при открытии попадал
         на кнопку, а не на чекбокс: главный мир оверлея ставит фокус на
         первый focusable уровня, и чекбокс получал бы рамку фокуса первым
         же кадром. Визуальный порядок задан через order — чекбокс выше
         кнопок, как и раньше. -->
    <div class="perm-actions">
      <button
        v-for="b in props.permission.buttons"
        :key="b.id"
        class="perm-btn"
        :class="{ 'perm-btn--primary': b.id === 'allow' }"
        @click="choose(b.id)"
      >
        {{ b.label }}
      </button>
    </div>
    <label v-if="!props.permission.ephemeral" class="perm-remember">
      <input v-model="remember" type="checkbox" />
      <span>{{ props.permission.rememberLabel }}</span>
    </label>
  </div>
</template>

<style scoped>
/* Поля вокруг карточки — по образцу меню: 4px отделяют скруглённые углы
   от кромки окна, иначе композитор их срезает (та же причина, по которой
   overlay:measured считает и поля). */
.permission-prompt {
  margin: 4px;
  width: 372px;
  display: flex;
  flex-direction: column;
  background: var(--ov-bg);
  border: 1px solid var(--ov-border);
  border-radius: 12px;
  padding: 14px;
  color: var(--ov-text);
  font-size: 13px;
}
.perm-title {
  font-size: 14px;
  line-height: 1.35;
  margin-bottom: 10px;
}
.perm-lines {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.perm-line {
  display: flex;
  align-items: center;
  gap: 8px;
}
.perm-line-icon {
  width: 18px;
  text-align: center;
  flex: none;
}
.perm-origin {
  margin-top: 10px;
  font-size: 11px;
  color: var(--ov-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.perm-remember {
  order: 4;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  color: var(--ov-dim);
  cursor: pointer;
}
.perm-remember input {
  accent-color: #4a8cf7;
  cursor: pointer;
}
.perm-actions {
  order: 5;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}
.perm-btn {
  padding: 6px 14px;
  font-size: 13px;
  color: var(--ov-text);
  background: var(--ov-btn-bg);
  border: 1px solid var(--ov-border);
  border-radius: 6px;
  cursor: pointer;
}
.perm-btn:hover {
  background: var(--ov-btn-hover);
}
.perm-btn--primary {
  background: #4a8cf7;
  border-color: #4a8cf7;
  color: #fff;
}
.perm-btn--primary:hover {
  background: #3d7de0;
}
</style>
