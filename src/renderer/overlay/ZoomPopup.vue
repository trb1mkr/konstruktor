<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'

// Попап масштаба страницы — overlay-kind 'zoom', открывается по бейджу
// 🔬 в адресной строке. Отдельный вид, а не меню с пунктом: форма своя
// (поле процента + `−`/`+` + Reset), и поведение своё — команды select
// НЕ закрывают попап (держит их main, см. holdOnSelect в overlay/service),
// а submit ручного процента закрывает.
//
// Живёт в overlay-окне, а не DOM-выпадашкой в панели: в пресете Minimal
// адресная строка снизу, и выпадашку перекрыл бы WebContentsView.
//
// sessionId приходит от корня: команды несут токен сессии, и без него
// main не отличил бы ввод из текущего попапа от запоздалого (окно
// оверлея у всех сессий одно).
const props = defineProps<{
  percent?: number
  sessionId?: number
}>()

// Локальная копия для набора текста: пока пользователь печатает, проп
// его не перетирает — патч приходит только после `+`/`−`/`Reset`.
const value = ref(String(props.percent ?? 100))
const input = ref<HTMLInputElement | null>(null)

watch(
  () => props.percent,
  (p) => {
    if (p !== undefined) value.value = String(p)
  }
)

function step(id: 'zoom-in' | 'zoom-out' | 'zoom-reset') {
  void window.overlayAPI.select(id, props.sessionId)
}

function submit() {
  void window.overlayAPI.submit(value.value, props.sessionId)
}

function onKey(e: KeyboardEvent) {
  // Escape НЕ ловим: окно оверлея слушает его глобально в main
  // (before-input-event) и закрывает сессию там же, где и меню — иначе
  // два обработчика закрыли бы попап дважды.
  if (e.key === 'Enter') {
    e.preventDefault()
    submit()
  }
}

onMounted(() => {
  // Автофокус поля обязателен (OVERLAY.md «Фокус»): без него стрелки и
  // Enter не доходят. Поле — ПЕРВЫЙ focusable в DOM, поэтому и
  // focusTopLevel из корня, и focus() из main ставят фокус именно на него.
  input.value?.focus()
  input.value?.select()
})
</script>

<template>
  <div class="zoom-popup" @mousedown.stop>
    <div class="zoom-row">
      <!-- Поле первым в DOM (фокус), но вторым визуально: flex order
           даёт кадр `− 100% +`, как в обычных браузерах. -->
      <input
        ref="input"
        v-model="value"
        class="zoom-input"
        inputmode="numeric"
        spellcheck="false"
        @keydown="onKey"
      />
      <button class="zoom-step" title="Zoom out" @click="step('zoom-out')">−</button>
      <button class="zoom-step" title="Zoom in" @click="step('zoom-in')">+</button>
      <!-- Сброс — символом и в том же стиле, что `−`/`+`: текстовая
           кнопка выпадала из ряда и делала карточку шире. -->
      <button class="zoom-step zoom-reset" title="Reset zoom to 100%" @click="step('zoom-reset')">
        ↺
      </button>
    </div>
  </div>
</template>

<style scoped>
/* Положение карточки внутри окна — по образцу меню: 4px отделяют
   скруглённые углы от кромки окна, иначе их срезает композитор
   (та же причина, по которой overlay:measured считает и поля). */
.zoom-popup {
  margin: 4px 4px 0 0;
  background: var(--ov-bg);
  border: 1px solid var(--ov-border);
  border-radius: 12px;
  padding: 6px;
}
.zoom-row {
  display: flex;
  align-items: center;
  gap: 4px;
}
.zoom-input {
  order: 2;
  width: 62px;
  padding: 5px 6px;
  text-align: center;
  font-size: 13px;
  color: var(--ov-text);
  background: var(--ov-input-bg);
  border: 1px solid var(--ov-input-border);
  border-radius: 6px;
  outline: none;
}
.zoom-input:focus { border-color: var(--ov-dim); }
.zoom-step {
  order: 1;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  font-size: 15px;
  line-height: 1;
  color: var(--ov-text);
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}
.zoom-step:hover { background: var(--ov-hover); }
/* `+` и `↺` идут после поля: смежный селектор даёт им order 3, а при
   равном order решает порядок в DOM — обе после `−`. */
.zoom-step + .zoom-step { order: 3; }
</style>
