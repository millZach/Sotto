import { Buffer } from 'node:buffer'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'

import sharp from 'sharp'

const manifest = JSON.parse(await readFile(resolve(process.cwd(), 'artifacts/design/app-review/manifest.json'), 'utf8'))
const outputRoot = resolve(process.cwd(), 'test-results/design-capture/contact-sheets')
const columns = 4
const cellWidth = 320
const cellHeight = 230
const imageWidth = 300
const imageHeight = 190

function escapeXml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

await mkdir(outputRoot, { recursive: true })
for (const category of ['onboarding', 'home', 'history', 'settings', 'help', 'scale', 'widget']) {
  const entries = manifest.entries.filter((entry) => entry.category === category)
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
    composites.push({ input: thumbnail, left: left + 10, top: top + 30 })
    composites.push({
      input: Buffer.from(`<svg width="${cellWidth}" height="30"><rect width="100%" height="100%" fill="#f7f8fa"/><text x="10" y="20" font-family="Segoe UI, sans-serif" font-size="12" fill="#20232a">${label}</text></svg>`),
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
  }).composite(composites).png().toFile(resolve(outputRoot, `${category}.png`))
}

process.stdout.write(`Created design contact sheets in ${outputRoot}\n`)
