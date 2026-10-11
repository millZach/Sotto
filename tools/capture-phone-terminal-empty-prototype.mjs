// Usage: node tools/capture-phone-terminal-empty-prototype.mjs [output-folder]; captures copy scenarios in approved variant B, not SwiftUI.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { chromium } from '@playwright/test'

const folder = resolve(process.argv[2] ?? 'artifacts/phone-terminals')
await mkdir(folder, { recursive: true })
// The layout was already chosen. This throwaway copy checks empty wording in that room.
const source = await readFile('docs/prototypes/terminal-agent-state-prototype.html', 'utf8')
const prototype = source.replace('function renderPhone() {', `function renderPhone() {
  const emptyCopy = new URLSearchParams(location.search).get('empty');`)
  .replace('const warm = needCount > 0;', `if (emptyCopy) body = '<div style="position:relative;margin:32px 22px;color:var(--tt-text-muted);font-size:16px">' +
    (emptyCopy === 'terminals' ? 'No threads or terminals here yet. Tap New thread to start one.' : 'No threads here yet. Tap New thread to start one.') + '</div>';
  const warm = !emptyCopy && needCount > 0;`)
  .replace('const working = THREADS.filter', 'const working = emptyCopy ? 0 : THREADS.filter')
  .replace("const needCount = S.terms.filter", "const needCount = emptyCopy ? 0 : S.terms.filter")
  .replace("const doneCount = S.terms.filter", "const doneCount = emptyCopy ? 0 : S.terms.filter")
const file = resolve(tmpdir(), 'sotto-884-empty-list-prototype.html')
await writeFile(file, prototype, 'utf8')
const browser = await chromium.launch({ channel: 'msedge' })
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, reducedMotion: 'reduce' })
  for (const empty of ['threads', 'terminals']) {
    await page.goto(`${pathToFileURL(file).href}?variant=B&empty=${empty}`)
    await page.locator('#phone').screenshot({ path: resolve(folder, `empty-${empty}-prototype.png`) })
  }
} finally { await browser.close() }
process.stdout.write(`Prototype: ${file}\n`)
