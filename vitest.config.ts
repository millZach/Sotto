import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    exclude: [...configDefaults.exclude, 'tests/e2e/**', 'scripts/tts-bench/**', 'scripts/voice-perf/**', '**/.worktrees/**', '.claude/**'],
    setupFiles: ['./tests/setup.ts'],
    // Waiting is not the assertion. A two-core CI runner with two workers on it takes several times
    // longer over a provider round trip or a child process start than a developer machine does, and a
    // deadline that expires there describes the machine, not the code: what is being tested still
    // fails, only later, when it is genuinely wrong. The slowest test that passed on the runner took
    // 5.3 s, so the default test deadline is three times that, and a poll gets a third of a test.
    testTimeout: 15_000,
    hookTimeout: 15_000,
    expect: { poll: { timeout: 5_000 } },
  },
})
