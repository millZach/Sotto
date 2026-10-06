// @vitest-environment node
import { globSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { configDefaults } from 'vitest/config'
import { expect, it } from 'vitest'
import config from '../../../vitest.config'

it('collects only repository tests and leaves external backups and top-level e2e specs out', () => {
  const root = mkdtempSync(join(tmpdir(), 'sotto-discovery-'))
  try {
    for (const file of ['tests/unit/example.test.ts', 'tests/integration/example.test.mjs', '.cache/backup/example.test.ts', 'src/example.test.ts', 'tests/e2e/example.test.ts', 'tests/unit/main/e2e/example.test.ts']) {
      mkdirSync(dirname(join(root, file)), { recursive: true })
      writeFileSync(join(root, file), '')
    }
    const files = globSync(config.test?.include ?? configDefaults.include, {
      cwd: root, exclude: config.test?.exclude ?? configDefaults.exclude,
    })
    expect(files.map(file => file.split(sep).join('/')).sort()).toEqual(['tests/integration/example.test.mjs', 'tests/unit/example.test.ts', 'tests/unit/main/e2e/example.test.ts'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('gives every separate Playwright test tree an npm runner', () => {
  const scripts = Object.values(JSON.parse(readFileSync('package.json', 'utf8')).scripts) as string[]
  for (const config of globSync('tests/**/playwright.config.{ts,mts,cts,js,mjs,cjs}')) {
    const path = config.split(sep).join('/')
    expect(scripts.some(script => script.includes(`--config=${path}`) || script.includes(`--config ${path}`)), path).toBe(true)
  }
})
