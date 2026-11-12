import sharp from 'sharp'

/**
 * Pictures made in the test, the size of the ones forge's host keeps (November 10, 2026: a median of 307 KB and a mean of
 * 396 KB, `docs/perf/2026-11-10-performance-and-data-audit.md`, finding 5), so no real picture is ever committed. Each is
 * the same bytes every run: its noise comes from a seeded generator, not from chance.
 */
function noise(seed: number): () => number {
  let state = seed >>> 0
  return () => { state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0; return state >>> 24 }
}

/** A 1600x1000 screenshot as a PNG, about 330 KB: flat panels around a patch of noise standing in for a picture in the page. */
export async function screenshotPng(): Promise<Buffer> {
  const width = 1600, height = 1000, next = noise(7), raw = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 3
    const patch = x >= 200 && x < 520 && y >= 200 && y < 520
    const panel = x >= 800 && x < 1500 && y >= 100 && y < 900
    raw[at] = patch ? next() : panel ? 40 : 48; raw[at + 1] = patch ? next() : panel ? 160 : 48; raw[at + 2] = patch ? next() : panel ? 170 : 52
  }
  return await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer()
}

/** A 1920x1200 photo as a JPEG at quality 85, about 330 KB: gradients with grain over all of it. */
export async function photoJpeg(): Promise<Buffer> {
  const width = 1920, height = 1200, next = noise(11), raw = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 3, grain = next() % 11
    raw[at] = (Math.floor(x * 255 / width) + grain) & 255; raw[at + 1] = (Math.floor(y * 255 / height) + grain) & 255; raw[at + 2] = 128 + grain
  }
  return await sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 85 }).toBuffer()
}

/** A moving GIF of two 640x400 frames, about 400 KB, each with its own noise beside a flat panel. */
export async function movingGif(): Promise<Buffer> {
  const width = 640, height = 400, frames: Buffer[] = []
  for (const seed of [3, 5]) {
    const next = noise(seed), raw = Buffer.alloc(width * height * 4)
    for (let at = 0; at < raw.length; at += 4) {
      const patch = (at / 4) % width < 360
      raw[at] = patch ? next() : 30; raw[at + 1] = patch ? next() : 90; raw[at + 2] = patch ? next() : 120; raw[at + 3] = 255
    }
    frames.push(await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer())
  }
  return await sharp(frames, { join: { animated: true } }).gif({ delay: [100, 100], loop: 0 }).toBuffer()
}

/** A 1200x800 drawing as a PNG whose background shows through: a picture a JPEG would turn black around its middle. */
export async function seeThroughPng(): Promise<Buffer> {
  const width = 1200, height = 800, next = noise(13), raw = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 4
    const middle = x >= 300 && x < 900 && y >= 200 && y < 600
    raw[at] = middle ? next() : 0; raw[at + 1] = middle ? next() : 0; raw[at + 2] = middle ? next() : 0; raw[at + 3] = middle ? 255 : 0
  }
  return await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer()
}

export const dataUrl = (mimeType: string, bytes: Buffer): string => `data:${mimeType};base64,${bytes.toString('base64')}`

/**
 * What the desktop's Electron image tools do with a picture a phone asks for at `edge` (`mediaEdgeMaker`), done with
 * sharp, since a test under Node cannot load Electron: scaled to fit `edge` by `edge`, a PNG when anything shows through
 * and a JPEG at quality 85 otherwise, the picture as it is when it already fits, and null when it cannot be read.
 */
export async function reduceLikeTheDesktop(url: string, edge: number): Promise<string | null> {
  const bytes = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')
  const metadata = await sharp(bytes).metadata().catch(() => null)
  if (!metadata?.width || !metadata.height) return null
  if (metadata.width <= edge && metadata.height <= edge) return url
  const scaled = sharp(bytes).resize({ width: edge, height: edge, fit: 'inside' })
  const { isOpaque } = await sharp(await scaled.clone().png().toBuffer()).stats()
  return isOpaque ? dataUrl('image/jpeg', await scaled.jpeg({ quality: 85 }).toBuffer()) : dataUrl('image/png', await scaled.png().toBuffer())
}
