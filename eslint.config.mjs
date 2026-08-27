import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'coverage/**',
      'node_modules/**',
      'out/**',
      'playwright-report/**',
      'release/**',
      'resources/runtime/*.mjs',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
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
