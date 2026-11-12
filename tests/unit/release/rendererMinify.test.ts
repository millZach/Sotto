// @vitest-environment node
import type { UserConfig } from 'vite'
import { expect, it } from 'vitest'
import config from '../../../electron.vite.config'

type Scope = 'main' | 'preload' | 'renderer'
const build = (scope: Scope): UserConfig['build'] => (config as Record<Scope, UserConfig>)[scope].build

/**
 * The window parses everything it loads at start before React runs. Minified, its first scripts went from 7.81 MB to
 * 4.04 MB (`docs/perf/2026-11-10-minified-window.md`, #2396); electron-vite's default would put them back.
 */
it('minifies the window and widget bundle', () => {
  expect(build('renderer')?.minify).toBe('esbuild')
  // Stylesheets follow the script setting unless this says otherwise.
  expect(build('renderer')?.cssMinify).toBeUndefined()
})

it('builds no source maps, since every file under out/ ships in the package', () => {
  for (const scope of ['main', 'preload', 'renderer'] as const) expect(build(scope)?.sourcemap, scope).toBeUndefined()
})
