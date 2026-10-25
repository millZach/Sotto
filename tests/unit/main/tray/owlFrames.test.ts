// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { crc32, deflateSync, inflateSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { MENU_BAR_OWL_BODIES, MENU_BAR_OWL_EYES } from '../../../../src/shared/menuBarOwl'
import {
  doublePixels,
  encodePng,
  owlFramePngs,
  owlPaletteFile,
  parseOwlManifest,
} from '../../../../src/main/tray/owl/frames'
import { allOwlPoses, poseKey } from '../../../../src/main/tray/owl/poses.mjs'

const FRAME_BYTES = 18 * 18 * 4
const OWL_DIR = join(__dirname, '../../../../resources/tray/owl')
const MANIFEST = join(OWL_DIR, 'manifest.json')

function goodManifest() {
  const frames = allOwlPoses().length
  return {
    version: 1,
    width: 18,
    height: 18,
    frames,
    poseKeys: allOwlPoses().map(poseKey),
    palettes: MENU_BAR_OWL_BODIES.flatMap(body => MENU_BAR_OWL_EYES.map(eyes => ({
      body, eyes, file: `${body}-${eyes}.bin`, bytes: frames * FRAME_BYTES,
    }))),
  }
}

/** A test-only PNG reader for what encodePng writes: 8-bit RGBA, unfiltered rows; checks every chunk's CRC. */
function decodePng(png: Buffer): { width: number; height: number; rgba: Buffer; chunks: string[] } {
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  let offset = 8
  let width = 0
  let height = 0
  const idat: Buffer[] = []
  const chunks: string[] = []
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('latin1', offset + 4, offset + 8)
    const data = png.subarray(offset + 8, offset + 8 + length)
    expect(png.readUInt32BE(offset + 8 + length)).toBe(crc32(png.subarray(offset + 4, offset + 8 + length)))
    chunks.push(type)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      expect([...data.subarray(8)]).toEqual([8, 6, 0, 0, 0])
    }
    if (type === 'IDAT') idat.push(data)
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  const rowBytes = 1 + width * 4
  expect(raw.length).toBe(rowBytes * height)
  const rgba = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    expect(raw[y * rowBytes]).toBe(0)
    raw.copy(rgba, y * width * 4, y * rowBytes + 1, (y + 1) * rowBytes)
  }
  return { width, height, rgba, chunks }
}

function patternFrame(seed: number): Uint8Array {
  const rgba = new Uint8Array(FRAME_BYTES)
  for (let i = 0; i < rgba.length; i += 1) rgba[i] = (i * 7 + seed * 31) & 0xff
  return rgba
}

describe('the menu bar owl manifest', () => {
  it('parses a manifest that matches the poses', () => {
    const manifest = parseOwlManifest(goodManifest())
    expect(manifest.frames).toBe(allOwlPoses().length)
    expect(owlPaletteFile(manifest, 'ink', 'amber')).toBe('ink-amber.bin')
  })

  it('throws for stale pose keys, a wrong frame count or a missing palette', () => {
    const swapped = goodManifest()
    swapped.poseKeys = [swapped.poseKeys[1]!, swapped.poseKeys[0]!, ...swapped.poseKeys.slice(2)]
    expect(() => parseOwlManifest(swapped)).toThrow()
    expect(() => parseOwlManifest({ ...goodManifest(), frames: 72 })).toThrow()
    const missing = goodManifest()
    missing.palettes = missing.palettes.filter(p => !(p.body === 'light' && p.eyes === 'ice'))
    expect(() => parseOwlManifest(missing)).toThrow()
    expect(() => parseOwlManifest({ ...goodManifest(), version: 2 })).toThrow()
    expect(() => parseOwlManifest(null)).toThrow()
  })
})

describe('the menu bar owl frames', () => {
  it('doubles each pixel into a 2x2 block', () => {
    const rgba = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    expect([...doublePixels(rgba, 2, 1)]).toEqual([
      1, 2, 3, 4, 1, 2, 3, 4, 5, 6, 7, 8, 5, 6, 7, 8,
      1, 2, 3, 4, 1, 2, 3, 4, 5, 6, 7, 8, 5, 6, 7, 8,
    ])
  })

  it('encodes an sRGB RGBA PNG that decodes to the same pixels', () => {
    const rgba = patternFrame(3)
    const png = decodePng(encodePng(rgba, 18, 18))
    expect(png).toMatchObject({ width: 18, height: 18 })
    expect(png.chunks).toEqual(['IHDR', 'sRGB', 'IDAT', 'IEND'])
    expect([...png.rgba]).toEqual([...rgba])
  })

  it('splits a palette file into 1x and pixel-doubled 2x PNGs in frame order', () => {
    const manifest = parseOwlManifest(goodManifest())
    const raw = Buffer.concat(Array.from({ length: manifest.frames }, (_, i) => patternFrame(i)))
    const frames = owlFramePngs(deflateSync(raw), manifest)
    expect(frames).toHaveLength(manifest.frames)
    for (const i of [0, 1, manifest.frames - 1]) {
      const one = decodePng(frames[i]!.png1x)
      const two = decodePng(frames[i]!.png2x)
      expect(one).toMatchObject({ width: 18, height: 18 })
      expect(two).toMatchObject({ width: 36, height: 36 })
      expect([...one.rgba]).toEqual([...patternFrame(i)])
      expect([...two.rgba]).toEqual([...doublePixels(patternFrame(i), 18, 18)])
    }
  })

  it('throws when the palette file is the wrong size', () => {
    const manifest = parseOwlManifest(goodManifest())
    expect(() => owlFramePngs(deflateSync(Buffer.alloc(FRAME_BYTES)), manifest)).toThrow()
    expect(() => owlFramePngs(Buffer.from('not deflate'), manifest)).toThrow()
  })

  it('refuses a file that inflates past its promised size while inflating it', () => {
    const manifest = parseOwlManifest(goodManifest())
    let error: unknown
    try {
      owlFramePngs(deflateSync(Buffer.alloc(manifest.frames * FRAME_BYTES + 1)), manifest)
    } catch (caught) {
      error = caught
    }
    // The size check that follows would have said "wrong size" with no code: this one comes from the cap on inflating.
    expect((error as NodeJS.ErrnoException).code).toBe('ERR_BUFFER_TOO_LARGE')
  })

  it('throws for a picture that is not width times height pixels', () => {
    expect(() => doublePixels(new Uint8Array(10), 18, 18)).toThrow()
  })
})

describe('the committed menu bar owl frames', () => {
  it.skipIf(!existsSync(MANIFEST))('parses the manifest and inflates the default palette', () => {
    const manifest = parseOwlManifest(JSON.parse(readFileSync(MANIFEST, 'utf8')))
    const frames = owlFramePngs(readFileSync(join(OWL_DIR, owlPaletteFile(manifest, 'slate', 'teal'))), manifest)
    expect(frames).toHaveLength(allOwlPoses().length)
    expect(decodePng(frames[0]!.png2x).rgba.some((byte, i) => i % 4 === 3 && byte > 0)).toBe(true)
  })
})
