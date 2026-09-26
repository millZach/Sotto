import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'artifacts/phase-three-themes/**',
      'artifacts/thread-browser-player/**',
      'artifacts/codex-questions-thread-agents/**',
      'artifacts/agent-browser/**',
      'artifacts/browser-grant/**',
      'artifacts/new-thread-setup/**',
      '.cache/**',
      'artifacts/settled-folder-new-thread/**',
      'artifacts/agents-view/**',
      'artifacts/queued-steering/**',
      '.worktrees/**',
      '.claude/tmp/**',
      // Agent worktrees are whole checkouts of this repository, so linting them would lint
      // every file twice and confuse the parser about which tsconfig root it is under.
      '.claude/worktrees/**',
      'coverage/**',
      'artifacts/question-choices/**',
      'artifacts/sidebar-question/**',
      'artifacts/tools-rail-run/**',
      'artifacts/git-settings/**',
      'artifacts/review-comments-run/**',
      'artifacts/git-interface-run/**',
      'artifacts/worktree-origin-fallback-run/**',
      'artifacts/agent-control-smoke/**',
      'artifacts/activity-performance/**',
      'artifacts/process-creature/**',
      'artifacts/held-action/**',
      'artifacts/working-creature/**',
      'artifacts/background-command/**',
      'artifacts/terminal-loading/**',
      'artifacts/thread-sidebar/**',
      'artifacts/forge-hand-test/**',
      'artifacts/effort-furnace/**',
      'artifacts/effort-slider/**',
      'artifacts/natural-voice-qa/**',
      'artifacts/tts-bench/**',
      'artifacts/voice-perf/**',
      'artifacts/new-thread-saved-draft/**',
      'artifacts/codex-stream-freeze/**',
      'artifacts/codex-images/**',
      'artifacts/shell-detail-visibility/**',
      'artifacts/issue-146/**',
      'artifacts/codex-connection-recovery/**',
      'artifacts/devin-local-provider/**',
      'node_modules/**',
      'out/**',
      'playwright-report/**',
      'release/**',
      'resources/runtime/*.mjs',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['tests/fixtures/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', setTimeout: 'readonly', setInterval: 'readonly' } },
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: { tsconfigRootDir: import.meta.dirname },
      globals: {
        __dirname: 'readonly',
        console: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        process: 'readonly',
        window: 'readonly',
      },
    },
  },
  {
    // The LLM bench is a plain Node script.
    files: ['scripts/llm-bench/**/*.mjs'],
    languageOptions: {
      globals: {
        AbortSignal: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        URL: 'readonly',
      },
    },
  },
  {
    // The ASR bench is a plain Node script.
    files: ['scripts/asr-bench/**/*.mjs'],
    languageOptions: {
      globals: {
        AbortController: 'readonly',
        Blob: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        FormData: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },
  {
    // The memory bench is a plain Node script.
    files: ['scripts/memeval/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
    },
  },
  {
    // The perf bench runs in Node but injects callbacks into a Playwright page.
    files: ['scripts/perf-bench/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        window: 'readonly',
      },
    },
  },
)
