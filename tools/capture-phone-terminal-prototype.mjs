// Usage: node tools/capture-phone-terminal-prototype.mjs [output-folder]; captures the approved reference, not SwiftUI.
import { mkdir } from 'node:fs/promises'
import process from 'node:process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from '@playwright/test'

const folder = resolve(process.argv[2] ?? 'artifacts/phone-terminals')
await mkdir(folder, { recursive: true })
const browser = await chromium.launch({ channel: 'msedge' })
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, reducedMotion: 'reduce' })
  await page.goto(`${pathToFileURL(resolve('docs/prototypes/terminal-agent-state-prototype.html')).href}?variant=B`)
  await page.screenshot({ path: resolve(folder, 'approved-variant-b.png'), fullPage: true })
} finally { await browser.close() }
