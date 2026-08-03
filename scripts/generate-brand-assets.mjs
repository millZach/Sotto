// Renders build/icon.svg, build/installer-sidebar.svg and build/tray-template.svg
// into the binary brand assets electron-builder consumes: icon.png, icon.ico,
// installer-sidebar.bmp and the macOS menu-bar template PNGs.
// Run after editing any SVG: node scripts/generate-brand-assets.mjs
import { Buffer } from 'node:buffer'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { log } from 'node:console'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import sharp from 'sharp'

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = path.join(repoRoot, 'build')
const trayDir = path.join(repoRoot, 'resources', 'tray')

// Windows renders BMP-encoded entries most reliably below 256px, so only the
// 256px entry uses PNG compression.
const BMP_SIZES = [16, 24, 32, 48, 64, 128]
const PNG_SIZE = 256

async function renderRgba(svg, size) {
  return sharp(svg, { density: (72 * size) / 96 })
    .resize(size, size)
    .ensureAlpha()
    .raw()
    .toBuffer()
}

function bmpIconEntry(rgba, size) {
  const rowBytes = size * 4
  const maskRowBytes = Math.ceil(size / 32) * 4
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8) // XOR + AND mask heights
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(rowBytes * size + maskRowBytes * size, 20)

  const pixels = Buffer.alloc(rowBytes * size)
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * rowBytes // bottom-up
    for (let x = 0; x < size; x++) {
      const s = srcRow + x * 4
      const d = y * rowBytes + x * 4
      pixels[d] = rgba[s + 2]
      pixels[d + 1] = rgba[s + 1]
      pixels[d + 2] = rgba[s]
      pixels[d + 3] = rgba[s + 3]
    }
  }
  const mask = Buffer.alloc(maskRowBytes * size) // all opaque; alpha channel governs
  return Buffer.concat([header, pixels, mask])
}

async function buildIco(svg) {
  const entries = []
  for (const size of BMP_SIZES) {
    entries.push({ size, data: bmpIconEntry(await renderRgba(svg, size), size) })
  }
  entries.push({
    size: PNG_SIZE,
    data: await sharp(svg, { density: (72 * PNG_SIZE) / 96 }).resize(PNG_SIZE, PNG_SIZE).png().toBuffer(),
  })

  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)

  const dir = Buffer.alloc(entries.length * 16)
  let offset = header.length + dir.length
  entries.forEach((entry, i) => {
    const at = i * 16
    dir[at] = entry.size === 256 ? 0 : entry.size
    dir[at + 1] = entry.size === 256 ? 0 : entry.size
    dir.writeUInt16LE(1, at + 4)
    dir.writeUInt16LE(32, at + 6)
    dir.writeUInt32LE(entry.data.length, at + 8)
    dir.writeUInt32LE(offset, at + 12)
    offset += entry.data.length
  })
  return Buffer.concat([header, dir, ...entries.map((e) => e.data)])
}

function bmp24(rgba, width, height) {
  const rowBytes = Math.ceil((width * 3) / 4) * 4
  const pixelBytes = rowBytes * height
  const file = Buffer.alloc(14 + 40 + pixelBytes)
  file.write('BM', 0)
  file.writeUInt32LE(file.length, 2)
  file.writeUInt32LE(54, 10)
  file.writeUInt32LE(40, 14)
  file.writeInt32LE(width, 18)
  file.writeInt32LE(height, 22)
  file.writeUInt16LE(1, 26)
  file.writeUInt16LE(24, 28)
  file.writeUInt32LE(pixelBytes, 34)
  for (let y = 0; y < height; y++) {
    const srcRow = (height - 1 - y) * width * 4
    for (let x = 0; x < width; x++) {
      const s = srcRow + x * 4
      const d = 54 + y * rowBytes + x * 3
      file[d] = rgba[s + 2]
      file[d + 1] = rgba[s + 1]
      file[d + 2] = rgba[s]
    }
  }
  return file
}

// macOS template images carry the glyph in the alpha channel only; the SVG is
// authored at 16px so the 1x render lands on whole pixels.
const TRAY_TEMPLATE_SOURCE_SIZE = 16

async function trayTemplate() {
  const svg = await readFile(path.join(buildDir, 'tray-template.svg'))
  await mkdir(trayDir, { recursive: true })
  for (const [size, name] of [
    [16, 'sottoTemplate.png'],
    [32, 'sottoTemplate@2x.png'],
  ]) {
    const png = await sharp(svg, {
      density: (72 * size) / TRAY_TEMPLATE_SOURCE_SIZE,
    })
      .resize(size, size)
      .png()
      .toBuffer()
    await writeFile(path.join(trayDir, name), png)
  }
}

const iconSvg = await readFile(path.join(buildDir, 'icon.svg'))
await sharp(iconSvg, { density: 768 }).resize(1024, 1024).png().toFile(path.join(buildDir, 'icon.png'))
await writeFile(path.join(buildDir, 'icon.ico'), await buildIco(iconSvg))

const sidebarSvg = await readFile(path.join(buildDir, 'installer-sidebar.svg'))
const sidebar = await sharp(sidebarSvg, { density: 288 })
  .resize(164, 314)
  .flatten({ background: '#121016' })
  .ensureAlpha()
  .raw()
  .toBuffer()
await writeFile(path.join(buildDir, 'installer-sidebar.bmp'), bmp24(sidebar, 164, 314))

await trayTemplate()

log(
  'Wrote build/icon.png, build/icon.ico, build/installer-sidebar.bmp, resources/tray/sottoTemplate.png, resources/tray/sottoTemplate@2x.png',
)
