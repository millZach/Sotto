// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { expect, it } from 'vitest'

it.each([
  ['theme-library-evidence.spec.ts', 'SOTTO_THEMES_E2E'],
  ['appearance-evidence.spec.ts', 'SOTTO_APPEARANCE_EVIDENCE'],
  ['theme-palettes-evidence.spec.ts', 'SOTTO_THEME_EVIDENCE'],
  ['theme-branding-evidence.spec.ts', 'SOTTO_THEME_BRANDING_EVIDENCE'],
])('documents how to enable the opt-in capture %s', (file, variable) => {
  const source = readFileSync(`tests/e2e/${file}`, 'utf8')
  expect(source).toContain(`process.env.${variable}`)
  const guide = readFileSync('docs/ci.md', 'utf8')
  const command = `${variable}=1 npx playwright test tests/e2e/${file}`
  expect(guide.includes(command), `Missing capture command: ${command}`).toBe(true)
})


it.each(['Owl dark', 'stable light'])('keeps the documented Watcher %s capture available in a checkout', label => {
  const note = resolve('docs/verification/2026-10-11-watcher-thread-tools.md')
  const match = readFileSync(note, 'utf8').match(new RegExp(`\\[${label}\\]\\(([^)]+)\\)`))
  expect(match, 'Missing documented capture').not.toBeNull()
  const file = resolve(dirname(note), match![1]!)
  expect(existsSync(file), 'Missing capture file').toBe(true)
  const ignored = spawnSync('git', ['check-ignore', '--quiet', '--no-index', file], { windowsHide: true })
  expect(ignored.status, 'Documented capture must not be ignored').toBe(1)
})
