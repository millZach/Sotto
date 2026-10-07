// Captures what Mermaid 11.17.2 draws for one diagram of each kind a visual's steps can light, with the settings the
// app's renderer uses, so the unit tests find step targets in real output rather than in hand-written SVG.
// Run with `node tests/fixtures/mermaidSteps/capture.mjs` after a Mermaid upgrade, then check the tests still pass.
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { CONFIG, SOURCES } from './sources.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')

const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  await page.setContent('<!doctype html><body></body>')
  await page.addScriptTag({ content: await readFile(join(root, 'node_modules/mermaid/dist/mermaid.min.js'), 'utf8') })
  for (const [name, source] of Object.entries(SOURCES)) {
    const svg = await page.evaluate(async ({ source, config, id }) => {
      globalThis.mermaid.initialize(config)
      return (await globalThis.mermaid.render(id, source)).svg
    }, { source, config: CONFIG, id: `sotto-diagram-${name}` })
    await writeFile(join(here, `${name}.svg`), svg)
  }
} finally { await browser.close() }
