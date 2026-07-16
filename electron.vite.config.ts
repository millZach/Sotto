import { resolve } from 'node:path'

import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

// Preview code is inert unless the renderer was built with this exact test-only gate.
const visualPreviewEnvironment = process.env.TALKTYPE_VISUAL_PREVIEW === '1' ? '1' : '0'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    // Sandboxed preload scripts cannot resolve arbitrary node_modules at runtime.
    plugins: [externalizeDepsPlugin({ exclude: ['zod'] })],
  },
  renderer: {
    define: {
      'import.meta.env.TALKTYPE_VISUAL_PREVIEW': JSON.stringify(visualPreviewEnvironment),
    },
    build: {
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'src/renderer/index.html'),
          widget: resolve(__dirname, 'src/renderer/widget.html'),
          transcriptionWorker: resolve(
            __dirname,
            'src/renderer/src/transcription/worker.ts',
          ),
        },
      },
    },
  },
})
