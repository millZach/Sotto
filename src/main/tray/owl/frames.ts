/*
 * The menu bar owl's frames (ADR-0114): scripts/generate-tray-owl.mjs draws every pose at 1x into
 * resources/tray/owl/, one deflated file per body and eye colour. This file reads the manifest, inflates a
 * palette's file, doubles the pixels and encodes PNGs with node:zlib, as the Dock icon does. No Electron here:
 * the caller turns the PNGs into images.
 */

import { crc32, deflateSync, inflateSync } from 'node:zlib'

import { z } from 'zod'

import {
  MENU_BAR_OWL_BODIES,
  MENU_BAR_OWL_EYES,
  type MenuBarOwlBody,
  type MenuBarOwlEyes,
} from '../../../shared/menuBarOwl'
import { OWL_HEIGHT, OWL_WIDTH, allOwlPoses, poseKey } from './poses.mjs'

export interface OwlManifest {
  readonly version: 1
  readonly width: 27
  readonly height: 22
  readonly frames: number
  readonly poseKeys: readonly string[]
  readonly palettes: readonly { body: MenuBarOwlBody; eyes: MenuBarOwlEyes; file: string; bytes: number }[]
}

const FRAME_BYTES = OWL_WIDTH * OWL_HEIGHT * 4

const manifestSchema = z.object({
  version: z.literal(1),
  width: z.literal(27),
  height: z.literal(22),
  frames: z.number().int().positive(),
  poseKeys: z.array(z.string()),
  palettes: z.array(z.object({
    body: z.enum(MENU_BAR_OWL_BODIES),
    eyes: z.enum(MENU_BAR_OWL_EYES),
    file: z.string().regex(/^[a-z]+-[a-z]+\.bin$/),
    bytes: z.number().int().positive(),
  })),
})

/** The generator's manifest, checked against today's poses: a stale one throws rather than showing the wrong frames. */
export function parseOwlManifest(raw: unknown): OwlManifest {
  const manifest = manifestSchema.parse(raw)
  const keys = allOwlPoses().map(poseKey)
  if (manifest.frames !== keys.length || manifest.poseKeys.length !== keys.length || manifest.poseKeys.some((key, i) => key !== keys[i])) {
    throw new Error('The menu bar owl manifest does not match its poses.')
  }
  for (const body of MENU_BAR_OWL_BODIES) {
    for (const eyes of MENU_BAR_OWL_EYES) {
      const palette = manifest.palettes.find(entry => entry.body === body && entry.eyes === eyes)
      if (!palette || palette.bytes !== manifest.frames * FRAME_BYTES) throw new Error('The menu bar owl manifest is missing a palette.')
    }
  }
  return manifest
}

export function owlPaletteFile(manifest: OwlManifest, body: MenuBarOwlBody, eyes: MenuBarOwlEyes): string {
  const palette = manifest.palettes.find(entry => entry.body === body && entry.eyes === eyes)
  if (!palette) throw new Error('The menu bar owl has no such palette.')
  return palette.file
}

/** Nearest neighbour at twice the size: each pixel becomes a crisp 2x2 block. */
export function doublePixels(rgba: Uint8Array, width: number, height: number): Uint8Array {
  if (rgba.length !== width * height * 4) throw new Error('The menu bar owl picture is the wrong size.')
  const out = new Uint8Array(width * height * 16)
  const outRow = width * 8
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const from = (y * width + x) * 4
      const to = y * 2 * outRow + x * 8
      for (let c = 0; c < 4; c += 1) {
        const v = rgba[from + c]!
        out[to + c] = v
        out[to + 4 + c] = v
        out[to + outRow + c] = v
        out[to + outRow + 4 + c] = v
      }
    }
  }
  return out
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(data, crc32(head.subarray(4))), 0)
  return Buffer.concat([head, data, crc])
}

/** An 8-bit straight-alpha RGBA PNG tagged sRGB. */
export function encodePng(rgba: Uint8Array, width: number, height: number): Buffer {
  const rowBytes = 1 + width * 4
  const pixels = Buffer.alloc(rowBytes * height)
  for (let y = 0; y < height; y += 1) {
    // Each row starts with PNG's "no filter" byte, already zero.
    pixels.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * rowBytes + 1)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('sRGB', Buffer.from([0])), // perceptual
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** One palette's frames as PNGs at 1x (27x22) and pixel-doubled 2x (54x44), in frame-number order. */
export function owlFramePngs(deflated: Uint8Array, manifest: OwlManifest): readonly { readonly png1x: Buffer; readonly png2x: Buffer }[] {
  // Capped at the size the manifest promises, so a damaged file fails here instead of filling memory.
  const raw = inflateSync(deflated, { maxOutputLength: manifest.frames * FRAME_BYTES })
  if (raw.length !== manifest.frames * FRAME_BYTES) throw new Error('The menu bar owl frames are the wrong size.')
  const frames: { png1x: Buffer; png2x: Buffer }[] = []
  for (let i = 0; i < manifest.frames; i += 1) {
    const rgba = raw.subarray(i * FRAME_BYTES, (i + 1) * FRAME_BYTES)
    frames.push({
      png1x: encodePng(rgba, OWL_WIDTH, OWL_HEIGHT),
      png2x: encodePng(doublePixels(rgba, OWL_WIDTH, OWL_HEIGHT), OWL_WIDTH * 2, OWL_HEIGHT * 2),
    })
  }
  return frames
}
