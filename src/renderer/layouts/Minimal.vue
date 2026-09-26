<script setup lang="ts">
import { ref } from 'vue'
import { useTabs } from '../core/useTabs'
import { useLayoutInsets } from '../core/layoutEngine'
import TabStrip from '../components/stdlib/TabStrip.vue'
import AddressBar from '../components/stdlib/AddressBar.vue'

// Пресет: минимум — вкладки сверху, адрес снизу, без закладок и меню.
useTabs()
const topPanel = ref<HTMLElement | null>(null)
const bottomPanel = ref<HTMLElement | null>(null)
useLayoutInsets({ top: topPanel, bottom: bottomPanel })
</script>

<template>
  <div class="shell">
    <div ref="topPanel" class="panel-top">
      <TabStrip />
    </div>
    <div ref="bottomPanel" class="panel-bottom">
      <AddressBar />
    </div>
  </div>
</template>

<style scoped>
.shell { display: flex; flex-direction: column; height: 100%; }
.panel-top { display: flex; flex-direction: column; }
.panel-bottom { display: flex; flex-direction: column; margin-top: auto; }
</style>
