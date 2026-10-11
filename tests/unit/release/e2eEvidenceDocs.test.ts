// @vitest-environment node
import { readFileSync } from 'node:fs'
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
