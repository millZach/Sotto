import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    exclude: [...configDefaults.exclude, 'tests/e2e/**', 'scripts/tts-bench/**', 'scripts/voice-perf/**', '**/.worktrees/**'],
    setupFiles: ['./tests/setup.ts'],
  },
})
