<script setup lang="ts">
import { ref } from 'vue'
import { useTabs } from '../core/useTabs'
import { useLayoutInsets } from '../core/layoutEngine'
import TabStrip from '../components/stdlib/TabStrip.vue'
import AddressBar from '../components/stdlib/AddressBar.vue'
import BookmarksBar from '../components/stdlib/BookmarksBar.vue'
import DropdownMenu from '../components/stdlib/DropdownMenu.vue'

// Пресет: классика — всё сверху, сайт под панелями.
useTabs()
const topPanel = ref<HTMLElement | null>(null)
useLayoutInsets({ top: topPanel })
</script>

<template>
  <div class="shell">
    <div ref="topPanel" class="panel-top">
      <div class="top-row">
        <TabStrip class="grow" />
        <DropdownMenu title="☰" />
      </div>
      <AddressBar />
      <BookmarksBar />
    </div>
  </div>
</template>

<style scoped>
.shell { display: flex; flex-direction: column; height: 100%; }
.panel-top { display: flex; flex-direction: column; }
.top-row { display: flex; align-items: stretch; }
.top-row .grow { flex: 1; }
</style>
