/**
 * The thread `tests/e2e/thread-pictures-cost.spec.ts` measures (`docs/perf/2026-11-04-thread-pictures-cost.md`): the shape
 * of the longest picture thread we know of, 4 turns, 1,322 steps and 275 agent pictures, made up here and owing nothing
 * to that thread's words. Every picture has its own pixels and its own digest, so nothing is shared by accident.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { deflateSync, inflateSync } from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const crcTable = Int32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value
})
function crc32(bytes: Buffer): number {
  let value = -1
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff]! ^ (value >>> 8)
  return (value ^ -1) >>> 0
}
function chunk(type: string, data: Buffer): Buffer {
  const tagged = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
  const check = Buffer.alloc(4); check.writeUInt32BE(crc32(tagged))
  return Buffer.concat([length, tagged, check])
}

/** The pixels of an 8-bit RGB, non-interlaced PNG, as Sotto's own screenshots are saved. */
export function readRgbPng(file: Buffer): { width: number; height: number; pixels: Buffer } {
  let at = 8, width = 0, height = 0
  const data: Buffer[] = []
  while (at < file.length) {
    const length = file.readUInt32BE(at)
    const type = file.toString('latin1', at + 4, at + 8)
    const body = file.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4)
      if (body[8] !== 8 || body[9] !== 2 || body[12] !== 0) throw new Error('The base picture must be 8-bit RGB and not interlaced.')
    }
    if (type === 'IDAT') data.push(body)
    at += 12 + length
  }
  const raw = inflateSync(Buffer.concat(data))
  const stride = width * 3
  const pixels = Buffer.alloc(stride * height)
  for (let row = 0; row < height; row++) {
    const filter = raw[row * (stride + 1)]!
    const line = row * (stride + 1) + 1
    for (let x = 0; x < stride; x++) {
      const left = x >= 3 ? pixels[row * stride + x - 3]! : 0
      const up = row ? pixels[(row - 1) * stride + x]! : 0
      const corner = row && x >= 3 ? pixels[(row - 1) * stride + x - 3]! : 0
      const paeth = () => { const p = left + up - corner, a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - corner); return a <= b && a <= c ? left : b <= c ? up : corner }
      const predicted = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : paeth()
      pixels[row * stride + x] = (raw[line + x]! + predicted) & 0xff
    }
  }
  return { width, height, pixels }
}

function writeRgbPng(width: number, height: number, pixels: Buffer): Buffer {
  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  for (let row = 0; row < height; row++) {
    // Up-filtered, as a screenshot encoder's output mostly is; plain enough to keep generation quick.
    raw[row * (stride + 1)] = 2
    for (let x = 0; x < stride; x++) raw[row * (stride + 1) + 1 + x] = (pixels[row * stride + x]! - (row ? pixels[(row - 1) * stride + x]! : 0)) & 0xff
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))])
}

/** A small repeatable generator, so a picture number always means the same picture. */
function randomFrom(seed: number): () => number {
  let state = (seed * 2654435761 + 1) >>> 0
  return () => { state = (state ^ (state << 13)) >>> 0; state = (state ^ (state >>> 17)) >>> 0; state = (state ^ (state << 5)) >>> 0; return state / 2 ** 32 }
}

/**
 * Picture `number`: a screenshot of Sotto scaled to `width` by `height`, with blocks of text-like marks over it, so no
 * two are alike. Its file comes to about the size a real screenshot of the same size does (`artifacts/` holds them).
 */
export function fixturePicture(basePath: string, number: number, width = 1600, height = 1000): Buffer {
  const base = baseOf(basePath)
  const pixels = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) {
    const fromY = Math.floor(y * base.height / height)
    for (let x = 0; x < width; x++) {
      const from = (fromY * base.width + Math.floor(x * base.width / width)) * 3
      const to = (y * width + x) * 3
      pixels[to] = base.pixels[from]!; pixels[to + 1] = base.pixels[from + 1]!; pixels[to + 2] = base.pixels[from + 2]!
    }
  }
  const random = randomFrom(number + 1)
  for (let block = 0; block < 14; block++) {
    const left = Math.floor(random() * width * 0.8), top = Math.floor(random() * height * 0.85)
    const across = Math.floor(width * (0.12 + random() * 0.25)), lines = 3 + Math.floor(random() * 9)
    const ink = [120 + random() * 135, 120 + random() * 135, 120 + random() * 135]
    for (let line = 0; line < lines; line++) {
      const y = top + line * 18
      for (let x = left; x < Math.min(width, left + across);) {
        const glyph = 3 + Math.floor(random() * 7)
        if (random() > 0.18) for (let row = 0; row < 10 && y + row < height; row++) for (let column = 0; column < glyph && x + column < width; column++) {
          if (random() < 0.45) continue
          const to = ((y + row) * width + x + column) * 3
          pixels[to] = ink[0]!; pixels[to + 1] = ink[1]!; pixels[to + 2] = ink[2]!
        }
        x += glyph + 2
      }
    }
  }
  return writeRgbPng(width, height, pixels)
}
let baseHeld: { path: string; picture: ReturnType<typeof readRgbPng> } | undefined
function baseOf(path: string): ReturnType<typeof readRgbPng> {
  if (baseHeld?.path !== path) baseHeld = { path, picture: readRgbPng(readFileSync(path)) }
  return baseHeld.picture
}

export const FIXTURE_STEPS = 1_322
export const FIXTURE_TILES = 275
/**
 * The runs of pictures, by turn. The first five sizes are the thread's own (76, 34, 29, 27, 23); the other seven are made
 * up to reach 275. Which turn holds which run is made up too: the desktop draws one list of tiles per turn, so the newest
 * turn's list here is 111 tiles.
 */
const RUNS_BY_TURN: readonly (readonly number[])[] = [[34, 20, 4], [29, 16, 6], [27, 18, 10], [76, 23, 12]]
const STEPS_BY_TURN = [280, 300, 320, 422] as const

/** A run of pictures scaled to `tiles` of 275, largest remainder first, so each scale keeps the thread's proportions. */
function scaledRuns(tiles: number): readonly (readonly number[])[] {
  const all = RUNS_BY_TURN.flat()
  const shares = all.map(size => size * tiles / FIXTURE_TILES)
  const sizes = shares.map(Math.floor)
  const leftOver = tiles - sizes.reduce((sum, size) => sum + size, 0)
  ;[...shares.keys()].sort((a, b) => (shares[b]! % 1) - (shares[a]! % 1)).slice(0, leftOver).forEach(index => { sizes[index]! += 1 })
  let next = 0
  return RUNS_BY_TURN.map(runs => runs.map(() => sizes[next++]!))
}

export interface FixtureStep { readonly picture: boolean }
/** One turn's steps in order, with each run of pictures together and spaced through the turn. */
export function fixtureTurns(tiles: number): readonly (readonly FixtureStep[])[] {
  return scaledRuns(tiles).map((runs, turn) => {
    const steps: FixtureStep[] = Array.from({ length: STEPS_BY_TURN[turn]! }, () => ({ picture: false }))
    runs.forEach((size, run) => {
      const start = Math.floor((run + 0.5) * steps.length / runs.length - size / 2)
      for (let index = 0; index < size; index++) steps[start + index] = { picture: true }
    })
    return steps
  })
}

const PLAIN_WORDS = 'Checked the layout of the page against the spacing rules and found nothing to change here. '

/** A step as Claude Code streams and records it: the tool's call and its result, with a picture when `picture` is given. */
export function stepFrames(session: string, picture: Buffer | undefined): object[] {
  const tool = randomUUID()
  const call = picture
    ? { type: 'tool_use', id: tool, name: 'mcp__sotto_browser__screenshot', input: {} }
    : { type: 'tool_use', id: tool, name: 'Bash', input: { command: 'echo fixture step', description: 'Run one fixture step' } }
  const content = picture
    ? [{ type: 'text', text: 'Took a screenshot of the page.' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: picture.toString('base64') } }]
    : [{ type: 'text', text: PLAIN_WORDS.repeat(2) }]
  return [
    { type: 'assistant', uuid: randomUUID(), session_id: session, message: { id: randomUUID(), role: 'assistant', content: [call] } },
    { type: 'user', uuid: randomUUID(), session_id: session, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool, content }] } },
  ]
}

/** A streamed piece of a reply, as Claude Code sends it while it writes. */
export function chunkFrame(session: string, text: string): object {
  return { type: 'stream_event', session_id: session, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } }
}
export function replyStartFrame(session: string): object {
  return { type: 'stream_event', session_id: session, event: { type: 'message_start', message: { id: randomUUID(), role: 'assistant' } } }
}
