import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'

import sharp from 'sharp'

const manifestPath = resolve(process.cwd(), 'artifacts/design/app-review/manifest.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))

if (manifest.version !== 1 || !Array.isArray(manifest.entries) || manifest.count !== manifest.entries.length) {
  throw new Error('Design capture manifest shape or count is invalid')
}
if (manifest.count !== 66) throw new Error(`Expected 66 review captures, found ${manifest.count}`)

const ids = new Set()
const themes = new Set()
for (const entry of manifest.entries) {
  if (typeof entry.id !== 'string' || ids.has(entry.id)) throw new Error(`Duplicate or invalid capture id: ${entry.id}`)
  ids.add(entry.id)
  themes.add(entry.theme)
  const path = resolve(process.cwd(), entry.relativePath)
  const image = await readFile(path)
  const hash = createHash('sha256').update(image).digest('hex')
  const metadata = await sharp(image).metadata()
  if (hash !== entry.sha256) throw new Error(`Capture hash mismatch: ${entry.relativePath}`)
  if (metadata.width !== entry.width || metadata.height !== entry.height) throw new Error(`Capture geometry mismatch: ${entry.relativePath}`)
}

if (!themes.has('light') || !themes.has('dark') || themes.size !== 2) throw new Error('Both light and dark capture themes are required')

for (const theme of ['light', 'dark']) {
  for (const scale of [100, 125, 150, 200]) {
    if (!ids.has(`scale-${scale}-home-${theme}`)) throw new Error(`Missing ${scale}% ${theme} scale capture`)
  }
  for (const state of ['idle', 'permission', 'listening', 'processing', 'pasted', 'copied', 'cancelled', 'error']) {
    const expected = `widget-${state}-${theme}`
    if (!ids.has(expected)) throw new Error(`Missing ${state} ${theme} widget capture`)
  }
}

process.stdout.write(`Verified ${manifest.entries.length} deterministic design-review captures.\n`)
