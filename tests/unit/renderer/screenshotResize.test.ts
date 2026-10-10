// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { dataUrlBlob, fitLongEdge, prepareScreenshot, readImageHeader, SCREENSHOT_MAX_DECODE_PIXELS, SCREENSHOT_MAX_LONG_EDGE, wasResized, type ScreenshotDecoder } from '../../../src/renderer/src/agents/screenshotResize'
import type { AgentImageSize } from '../../../src/shared/agents'

/** A decoder that reports `size` and writes a blob of `encodedBytes` bytes in whatever type it is asked for. */
function fakeDecoder(size: AgentImageSize, encodedBytes = 10) {
  const encode = vi.fn(async (_size: AgentImageSize, mimeType: string) => new Blob([new Uint8Array(encodedBytes)], { type: mimeType }))
  const close = vi.fn()
  const decode: ScreenshotDecoder = async () => ({ size, encode, close })
  return { decode, encode, close }
}
const file = (type: string, bytes = 1000) => new File([new Uint8Array(bytes)], 'shot', { type })

describe('the screenshot bound', () => {
  it('is Claude 4.7 and later models\' long edge, the most any model Sotto sends screenshots to reads', () => {
    expect(SCREENSHOT_MAX_LONG_EDGE).toBe(2576)
  })
  it('scales a 3840x2160 capture to the bound with its aspect ratio kept', () => {
    // Claude's own documentation lists 3840x2160 as becoming 2576x1449 on its high-resolution tier.
    expect(fitLongEdge({ width: 3840, height: 2160 })).toEqual({ width: 2576, height: 1449 })
    expect(fitLongEdge({ width: 2160, height: 3840 })).toEqual({ width: 1449, height: 2576 })
  })
  it('leaves an image at or under the bound as it is and never scales up', () => {
    const small = { width: 1200, height: 800 }
    expect(fitLongEdge(small)).toBe(small)
    const exact = { width: 2576, height: 100 }
    expect(fitLongEdge(exact)).toBe(exact)
  })
  it('keeps a very thin image at least one pixel across', () => {
    expect(fitLongEdge({ width: 60_000, height: 2 })).toEqual({ width: 2576, height: 1 })
  })
})

describe('preparing a screenshot to hand on', () => {
  it('scales a 3840x2160 PNG down to the bound as a PNG and records both sizes', async () => {
    const { decode, encode, close } = fakeDecoder({ width: 3840, height: 2160 })
    const prepared = await prepareScreenshot(file('image/png'), decode)
    expect(encode).toHaveBeenCalledWith({ width: 2576, height: 1449 }, 'image/png')
    expect(prepared.blob.type).toBe('image/png')
    expect(prepared.dimensions).toEqual({ original: { width: 3840, height: 2160 }, sent: { width: 2576, height: 1449 } })
    expect(wasResized(prepared.dimensions)).toBe(true)
    expect(close).toHaveBeenCalledTimes(1)
  })
  it('hands a 1200x800 PNG on untouched', async () => {
    const original = file('image/png')
    const { decode, encode, close } = fakeDecoder({ width: 1200, height: 800 })
    const prepared = await prepareScreenshot(original, decode)
    expect(prepared.blob).toBe(original)
    expect(encode).not.toHaveBeenCalled()
    expect(prepared.dimensions).toEqual({ original: { width: 1200, height: 800 }, sent: { width: 1200, height: 800 } })
    expect(wasResized(prepared.dimensions)).toBe(false)
    expect(close).toHaveBeenCalledTimes(1)
  })
  it('keeps a JPEG a JPEG, and a WebP a WebP', async () => {
    for (const type of ['image/jpeg', 'image/webp']) {
      const { decode, encode } = fakeDecoder({ width: 5120, height: 2880 })
      const prepared = await prepareScreenshot(file(type), decode)
      expect(encode).toHaveBeenCalledWith({ width: 2576, height: 1449 }, type)
      expect(prepared.blob.type).toBe(type)
    }
  })
  it('leaves a GIF as it is, since a canvas cannot write one', async () => {
    const original = file('image/gif')
    const { decode, encode } = fakeDecoder({ width: 3840, height: 2160 })
    const prepared = await prepareScreenshot(original, decode)
    expect(prepared.blob).toBe(original)
    expect(encode).not.toHaveBeenCalled()
    expect(wasResized(prepared.dimensions)).toBe(false)
  })
  it('sends the original when the scaled copy would not be smaller', async () => {
    const original = file('image/jpeg', 1000)
    const { decode } = fakeDecoder({ width: 3840, height: 2160 }, 1000)
    const prepared = await prepareScreenshot(original, decode)
    expect(prepared.blob).toBe(original)
    expect(prepared.dimensions).toEqual({ original: { width: 3840, height: 2160 }, sent: { width: 3840, height: 2160 } })
  })
  it('sends the original when the copy cannot be written in the same format', async () => {
    const original = file('image/webp')
    const close = vi.fn()
    const decode: ScreenshotDecoder = async () => ({ size: { width: 3840, height: 2160 }, encode: async () => null, close })
    expect((await prepareScreenshot(original, decode)).blob).toBe(original)
    expect(close).toHaveBeenCalledTimes(1)
  })
  it('sends the file as before, with no sizes, when it cannot be decoded here', async () => {
    const original = file('image/png')
    expect(await prepareScreenshot(original, async () => null)).toEqual({ blob: original })
    expect(await prepareScreenshot(original, async () => { throw new Error('not an image') })).toEqual({ blob: original })
  })
})

const bytes = (...parts: (number[] | string | Uint8Array)[]): Uint8Array<ArrayBuffer> => new Uint8Array(parts.flatMap(part =>
  typeof part === 'string' ? [...part].map(char => char.charCodeAt(0)) : [...part]))
const be32 = (value: number) => [value >>> 24 & 255, value >>> 16 & 255, value >>> 8 & 255, value & 255]
const le16 = (value: number) => [value & 255, value >>> 8 & 255]
const le24 = (value: number) => [value & 255, value >>> 8 & 255, value >>> 16 & 255]
const le32 = (value: number) => [...le16(value & 0xffff), ...le16(value >>> 16)]
/** A PNG's signature, header and the chunks named before its image data, which is left empty. */
const png = (width: number, height: number, ...before: string[]) => bytes([137, 80, 78, 71, 13, 10, 26, 10],
  be32(13), 'IHDR', be32(width), be32(height), [8, 6, 0, 0, 0], be32(0),
  ...before.flatMap(type => [be32(8), type, new Array<number>(8).fill(0), be32(0)]), be32(0), 'IDAT', be32(0))
/** A JPEG with a JFIF segment, an EXIF orientation when given, and then a baseline frame header. */
const jpeg = (width: number, height: number, orientation?: number) => {
  const tiff = orientation === undefined ? null : bytes('II', le16(42), le32(8), le16(1), le16(0x0112), le16(3), le32(1), le16(orientation), [0, 0], le32(0))
  const app1 = tiff ? bytes([0xff, 0xe1], [(tiff.length + 8) >> 8, (tiff.length + 8) & 255], 'Exif', [0, 0], tiff) : bytes()
  return bytes([0xff, 0xd8], [0xff, 0xe0, 0, 16], 'JFIF', new Array<number>(10).fill(0), app1,
    [0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3], new Array<number>(9).fill(0), [0xff, 0xda, 0, 2])
}
const webp = (chunk: string, body: number[]) => bytes('RIFF', le32(4 + 8 + body.length), 'WEBP', chunk, le32(body.length), body)

describe('reading the size an image names in its first bytes', () => {
  it('reads a PNG, and knows an animated one by its animation chunk', () => {
    expect(readImageHeader(png(3840, 2160))).toEqual({ size: { width: 3840, height: 2160 }, animated: false })
    expect(readImageHeader(png(3840, 2160, 'iCCP', 'acTL'))).toEqual({ size: { width: 3840, height: 2160 }, animated: true })
  })
  it('counts a PNG whose bytes end before its image data as one that may be animated', () => {
    expect(readImageHeader(png(3840, 2160, 'iCCP', 'acTL').subarray(0, 40))).toEqual({ size: { width: 3840, height: 2160 }, animated: true })
    expect(readImageHeader(png(3840, 2160, 'iCCP').subarray(0, 40))).toEqual({ size: { width: 3840, height: 2160 }, animated: true })
  })
  it('reads a JPEG past its metadata, with a quarter-turned orientation swapping its sides as the decoder shows it', () => {
    expect(readImageHeader(jpeg(4032, 3024))).toEqual({ size: { width: 4032, height: 3024 }, animated: false })
    expect(readImageHeader(jpeg(4032, 3024, 1))).toEqual({ size: { width: 4032, height: 3024 }, animated: false })
    expect(readImageHeader(jpeg(4032, 3024, 6))).toEqual({ size: { width: 3024, height: 4032 }, animated: false })
  })
  it('reads a WebP of each kind, and knows an animated one by its flag', () => {
    expect(readImageHeader(webp('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(3000), ...le16(2000), 0, 0]))).toEqual({ size: { width: 3000, height: 2000 }, animated: false })
    expect(readImageHeader(webp('VP8L', [0x2f, ...le32((3000 - 1) | (2000 - 1) << 14), 0, 0, 0, 0, 0]))).toEqual({ size: { width: 3000, height: 2000 }, animated: false })
    expect(readImageHeader(webp('VP8X', [0, 0, 0, 0, ...le24(2999), ...le24(1999)]))).toEqual({ size: { width: 3000, height: 2000 }, animated: false })
    expect(readImageHeader(webp('VP8X', [0x02, 0, 0, 0, ...le24(2999), ...le24(1999)]))).toEqual({ size: { width: 3000, height: 2000 }, animated: true })
  })
  it('reads a GIF', () => {
    expect(readImageHeader(bytes('GIF89a', le16(640), le16(480), [0, 0, 0]))).toEqual({ size: { width: 640, height: 480 }, animated: false })
  })
  it('reads nothing from bytes that are not an image, are cut short, or name no plausible size', () => {
    expect(readImageHeader(bytes('not an image at all, just some text'))).toBeNull()
    expect(readImageHeader(png(3840, 2160).subarray(0, 20))).toBeNull()
    expect(readImageHeader(jpeg(4032, 3024).subarray(0, 24))).toBeNull()
    expect(readImageHeader(png(0, 2160))).toBeNull()
    expect(readImageHeader(png(70_000, 2160))).toBeNull()
  })
})

describe('preparing a screenshot whose first bytes name its size', () => {
  const never: ScreenshotDecoder = async () => { throw new Error('decoded a screenshot that fits') }
  it('hands on one that fits without decoding it', async () => {
    const decode = vi.fn(never)
    const original = new File([png(1920, 1080)], 'shot.png', { type: 'image/png' })
    expect(await prepareScreenshot(original, decode)).toEqual({ blob: original, dimensions: { original: { width: 1920, height: 1080 }, sent: { width: 1920, height: 1080 } } })
    expect(decode).not.toHaveBeenCalled()
  })
  it('never scales an animated PNG or WebP, which would keep only its first frame', async () => {
    for (const [data, type] of [[png(3840, 2160, 'acTL'), 'image/png'], [webp('VP8X', [0x02, 0, 0, 0, ...le24(3839), ...le24(2159)]), 'image/webp']] as const) {
      const decode = vi.fn(never)
      const original = new File([data], 'moving', { type })
      expect(await prepareScreenshot(original, decode)).toEqual({ blob: original, dimensions: { original: { width: 3840, height: 2160 }, sent: { width: 3840, height: 2160 } } })
      expect(decode).not.toHaveBeenCalled()
    }
  })
  it('never scales a PNG whose metadata pushes its image data past the bytes read, since it may be animated', async () => {
    const decode = vi.fn(never)
    const profile = new Uint8Array(300 * 1024)
    const data = bytes(png(3840, 2160).subarray(0, 33), be32(profile.length), 'iCCP', profile, be32(0), be32(8), 'acTL', new Array<number>(8).fill(0), be32(0), be32(0), 'IDAT', be32(0))
    const original = new File([data], 'moving.png', { type: 'image/png' })
    expect(await prepareScreenshot(original, decode)).toEqual({ blob: original, dimensions: { original: { width: 3840, height: 2160 }, sent: { width: 3840, height: 2160 } } })
    expect(decode).not.toHaveBeenCalled()
  })
  it('never decodes one whose pixels would not fit in a canvas, and hands it on as attached', async () => {
    const decode = vi.fn(never)
    // 20000 x 20000 is 400 million pixels, 1.6 GB decoded, and past the largest canvas Chromium draws.
    const original = new File([png(20_000, 20_000)], 'huge.png', { type: 'image/png' })
    expect(20_000 * 20_000).toBeGreaterThan(SCREENSHOT_MAX_DECODE_PIXELS)
    expect(await prepareScreenshot(original, decode)).toEqual({ blob: original, dimensions: { original: { width: 20_000, height: 20_000 }, sent: { width: 20_000, height: 20_000 } } })
    expect(decode).not.toHaveBeenCalled()
  })
  it('decodes one past the bound and scales it down', async () => {
    const { decode, encode } = fakeDecoder({ width: 3840, height: 2160 })
    const prepared = await prepareScreenshot(new File([png(3840, 2160), new Uint8Array(1000)], 'big.png', { type: 'image/png' }), decode)
    expect(encode).toHaveBeenCalledWith({ width: 2576, height: 1449 }, 'image/png')
    expect(prepared.dimensions?.sent).toEqual({ width: 2576, height: 1449 })
  })
})

describe('reading a screenshot held as a data URL', () => {
  const dataUrl = (data: Uint8Array, type = 'image/png') => `data:${type};base64,${btoa(String.fromCharCode(...data))}`
  it('decodes its bytes once, for the header and for staging', async () => {
    const data = png(1280, 800)
    const blob = dataUrlBlob(dataUrl(data), 'image/png')!
    expect(blob.type).toBe('image/png')
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(data)
  })
  it('refuses a data URL of another type, or one that is not base64', () => {
    expect(dataUrlBlob(dataUrl(png(10, 10), 'image/jpeg'), 'image/png')).toBeNull()
    expect(dataUrlBlob('not a data URL', 'image/png')).toBeNull()
    expect(dataUrlBlob('data:image/png;base64,***', 'image/png')).toBeNull()
  })
})
