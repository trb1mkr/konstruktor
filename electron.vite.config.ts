import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { outDir: 'out/main' }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      // Три entry: основное окно, session-preload вкладок, оверлей-окно.
      // Формат cjs: песочница не понимает ESM-import, только require.
      lib: {
        entry: {
          index: 'src/preload/index.ts',
          internal: 'src/view-preload/internal.ts',
          overlay: 'src/preload/overlay.ts'
        }
      },
      rollupOptions: { output: { format: 'cjs' } }
    }
  },
  renderer: {
    root: 'src/renderer',
    plugins: [vue()],
    resolve: {
      alias: { '@': resolve('src/renderer') }
    },
    build: {
      // outDir относительно корня проекта (не root) — 'out/renderer' прямо.
      outDir: 'out/renderer',
      emptyOutDir: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          menu: resolve(__dirname, 'src/renderer/menu.html')
        }
      }
    }
  }
})
