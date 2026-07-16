import { Buffer } from 'node:buffer'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'

import sharp from 'sharp'

const manifest = JSON.parse(await readFile(resolve(process.cwd(), 'artifacts/design/app-review/manifest.json'), 'utf8'))
const outputArgument = process.argv.find((argument) => argument.startsWith('--output='))?.slice('--output='.length)
const outputRoot = resolve(process.cwd(), outputArgument ?? 'test-results/design-capture/contact-sheets')
const columns = 2
const cellWidth = 520
const cellHeight = 420
const imageWidth = 500
const imageHeight = 360

function escapeXml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

await mkdir(outputRoot, { recursive: true })
const groups = [
  ...['onboarding', 'home', 'history', 'settings', 'help', 'scale', 'widget'].map((category) => ({ id: category, entries: manifest.entries.filter((entry) => entry.category === category) })),
  ...[100, 125, 150, 200].map((scale) => ({ id: `scale-${scale}`, entries: manifest.entries.filter((entry) => entry.scalePercent === scale && entry.category === 'scale') })),
  { id: 'motion', entries: manifest.entries.filter((entry) => entry.motion === 'reduced' || /reduced-motion/u.test(entry.id)) },
  { id: 'focus', entries: manifest.entries.filter((entry) => entry.focusTarget !== undefined && entry.focusTarget !== 'none' || entry.focus === true) },
]
for (const group of groups) {
  const entries = group.entries
  if (entries.length === 0) continue
  const rows = Math.ceil(entries.length / columns)
  const composites = []
  for (const [index, entry] of entries.entries()) {
    const left = (index % columns) * cellWidth
    const top = Math.floor(index / columns) * cellHeight
    const thumbnail = await sharp(resolve(process.cwd(), entry.relativePath))
      .flatten({ background: '#e7e9ee' })
      .resize(imageWidth, imageHeight, { fit: 'contain', background: '#e7e9ee' })
      .png()
      .toBuffer()
    const label = escapeXml(`${entry.id} (${entry.width}x${entry.height})`)
    composites.push({ input: thumbnail, left: left + 10, top: top + 50 })
    composites.push({
      input: Buffer.from(`<svg width="${cellWidth}" height="50"><rect width="100%" height="100%" fill="#f7f8fa"/><text x="10" y="20" font-family="Segoe UI, sans-serif" font-size="12" fill="#20232a">${label}</text><text x="10" y="39" font-family="Segoe UI, sans-serif" font-size="11" fill="#616875">theme=${entry.theme} scale=${entry.scalePercent ?? 100} motion=${entry.motion ?? (entry.reducedMotion ? 'reduced' : 'legacy')} focus=${entry.focusTarget ?? (entry.focus ? 'legacy' : 'none')}</text></svg>`),
      left,
      top,
    })
  }
  await sharp({
    create: {
      width: columns * cellWidth,
      height: rows * cellHeight,
      channels: 3,
      background: '#d9dce3',
    },
  }).composite(composites).png().toFile(resolve(outputRoot, `${group.id}.png`))
}

process.stdout.write(`Created design contact sheets in ${outputRoot}\n`)
