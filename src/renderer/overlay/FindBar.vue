<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'

// Панель поиска по странице в стиле VS Code: поле ввода, счетчик,
// кнопки prev/next, флаги Aa (match case), ab (whole word), .* (regex).
// Живет в оверлей-окне kind 'find' в правом верхнем углу области страницы.
// Каждый ввод/флаг шлет find:query в main, main гоняет webContents.findInPage.
// counter приходит из модели (overlay:update), а не пишется в DOM скриптом
// из main. Раньше main слал executeJavaScript с querySelector по .find-count,
// и значение не жило в состоянии: пересоздание компонента его теряло, а
// разметка с данными расходились при переименовании класса.
// sessionId приходит от корня: команды find:* несут токен сессии,
// и без него main не может отличить ввод из текущей панели от
// запоздалого ввода из предыдущей (окно оверлея у всех сессий одно).
const props = defineProps<{
  initial?: string
  counter?: string
  sessionId?: number
}>()

const query = ref(props.initial ?? '')
const matchCase = ref(false)
const wholeWord = ref(false)
const useRegex = ref(false)
const input = ref<HTMLInputElement | null>(null)
let debounce: ReturnType<typeof setTimeout> | null = null

function send() {
  void window.overlayAPI.findQuery({
    query: query.value,
    matchCase: matchCase.value,
    wholeWord: wholeWord.value,
    useRegex: useRegex.value
  }, props.sessionId)
}

function sendDebounced() {
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(send, 150)
}

function next() {
  void window.overlayAPI.findNext(props.sessionId)
}

function prev() {
  void window.overlayAPI.findPrev(props.sessionId)
}

async function close() {
  await window.overlayAPI.findClose(props.sessionId)
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') void close()
  else if (e.key === 'Enter') {
    if (e.shiftKey) prev()
    else next()
  }
}

watch([matchCase, wholeWord, useRegex], send)

onMounted(() => {
  input.value?.focus()
  input.value?.select()
  send()
})

onUnmounted(() => {
  if (debounce) clearTimeout(debounce)
})
</script>

<template>
  <div class="find-root" @mousedown.stop>
    <div class="find-bar">
      <input
        ref="input"
        v-model="query"
        class="find-input"
        :placeholder="$t('find.placeholder')"
        spellcheck="false"
        @input="sendDebounced"
        @keydown="onKey"
      />
      <span class="find-count">{{ counter }}</span>
      <button
        class="find-btn"
        :class="{ on: matchCase }"
        :title="$t('find.matchCase')"
        @click="matchCase = !matchCase"
      >Aa</button>
      <button
        class="find-btn"
        :class="{ on: wholeWord }"
        :title="$t('find.wholeWord')"
        @click="wholeWord = !wholeWord"
      ><span class="wb">ab</span></button>
      <button
        class="find-btn"
        :class="{ on: useRegex }"
        :title="$t('find.regex')"
        @click="useRegex = !useRegex"
      >.*</button>
      <button class="find-btn nav" :title="$t('find.prev')" @click="prev">↑</button>
      <button class="find-btn nav" :title="$t('find.next')" @click="next">↓</button>
      <button class="find-btn close" :title="$t('find.close')" @click="close">✕</button>
    </div>
    <div class="find-status" data-find-status></div>
  </div>
</template>

<style scoped>
.find-root {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
}
.find-bar {
  display: flex;
  align-items: center;
  gap: 2px;
  background: var(--ov-bg);
  border: 1px solid var(--ov-border);
  border-radius: 8px;
  padding: 6px 6px 6px 10px;
}
.find-input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  color: var(--ov-text);
  font-size: 13px;
}
.find-count {
  font-size: 12px;
  color: #888;
  white-space: nowrap;
  padding: 0 4px;
}
.find-count:empty { display: none; }
.find-btn {
  background: transparent;
  border: none;
  border-radius: 6px;
  color: #999;
  font-size: 12px;
  min-width: 26px;
  height: 26px;
  padding: 0 5px;
  cursor: pointer;
  line-height: 1;
}
.find-btn:hover { background: #333; color: #fff; }
.find-btn.on { background: #555; color: #fff; }
.find-btn .wb { border-bottom: 2px solid currentColor; }
.find-btn.nav { font-size: 13px; }
.find-btn.close { color: #888; }
.find-status { display: none; }
</style>
