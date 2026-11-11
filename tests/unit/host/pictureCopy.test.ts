// @vitest-environment node
/**
 * A headless host's copy of a picture for a phone's tile (ADR-0203): fitted and rounded as the desktop's maker fits it,
 * each box of pixels averaged, a PNG only when something shows through, and Sotto's own JPEG writer's output readable by
 * jpeg-js and close to what it was given. Pictures are made in the test, a few pixels each.
 */
import decodeJpeg from 'jpeg-js/lib/decoder'
import { read as readPng, write as writePng } from 'pngjs/lib/png-sync'
import { describe, expect, it } from 'vitest'
import { encodeJpeg } from '../../../src/host/jpegEncoder'
import { fittedSize, PICTURE_COPY_MAX_PIXELS, pictureCopy, scaledDown, type Pixels } from '../../../src/host/pictureCopy'

/** A picture whose pixel at (x, y) is `paint(x, y)`, four bytes each. */
function picture(width: number, height: number, paint: (x: number, y: number) => readonly [number, number, number, number]): Pixels {
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(paint(x, y), (y * width + x) * 4)
  return { width, height, data }
}
const pngUrl = (pixels: Pixels): string => `data:image/png;base64,${writePng(pixels, { colorType: 6 }).toString('base64')}`
const bytesOf = (url: string): Buffer => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')
/** How close two pictures of one size are in their colour, in decibels: past about 30 the difference is hard to see. */
function closeness(a: Pixels, b: Pixels): number {
  let sum = 0, count = 0
  for (let at = 0; at < a.data.length; at++) if (at % 4 !== 3) { sum += (a.data[at]! - b.data[at]!) ** 2; count++ }
  return sum === 0 ? Infinity : 10 * Math.log10(255 ** 2 / (sum / count))
}

describe('a headless host\'s picture copy', () => {
  it('fits a picture to the edge and rounds its sides as the desktop\'s maker does', () => {
    expect(fittedSize(1600, 1000, 640)).toEqual({ width: 640, height: 400 })
    expect(fittedSize(900, 1200, 640)).toEqual({ width: 480, height: 640 })
    expect(fittedSize(1921, 1201, 640)).toEqual({ width: 640, height: 400 })
    expect(fittedSize(1, 5000, 640)).toEqual({ width: 1, height: 640 })
    expect(fittedSize(640, 300, 640)).toEqual({ width: 640, height: 300 })
  })

  it('averages each box of pixels, sharing a pixel between two boxes by how much of it each covers', () => {
    const grey = (value: number) => [value, value, value, 255] as const
    // Two by two into one: each pixel of the copy is the mean of the four it covers.
    const halved = scaledDown(picture(4, 2, x => grey([10, 20, 30, 40][x]!)), 2, 1)
    expect([...halved.data]).toEqual([15, 15, 15, 255, 35, 35, 35, 255])
    // Three into two: the middle pixel counts a third toward each, by the half of it each covers.
    const thirds = scaledDown(picture(3, 1, x => grey([0, 90, 180][x]!)), 2, 1)
    expect([thirds.data[0], thirds.data[4]]).toEqual([30, 150])
  })

  it('keeps a see-through pixel\'s hidden colour out of its neighbour, and its alpha as their mean', () => {
    // Opaque red beside fully clear green: the copy's pixel is red, half clear, with no green in it.
    const mixed = scaledDown(picture(2, 1, x => x === 0 ? [255, 0, 0, 255] : [0, 255, 0, 0]), 1, 1)
    expect([...mixed.data]).toEqual([255, 0, 0, 128])
  })

  it('writes a PNG when anything shows through and a JPEG otherwise, and makes nothing of a picture that fits', () => {
    const solid = pictureCopy(pngUrl(picture(1600, 1000, (x, y) => [x % 256, y % 256, 90, 255])), 640)!
    expect(solid.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(decodeJpeg(bytesOf(solid), { useTArray: true })).toMatchObject({ width: 640, height: 400 })
    const clear = pictureCopy(pngUrl(picture(1200, 800, x => x < 600 ? [200, 40, 40, 255] : [0, 0, 0, 0])), 640)!
    expect(clear.startsWith('data:image/png;base64,')).toBe(true)
    expect(readPng(bytesOf(clear))).toMatchObject({ width: 640, height: 427 })
    // Already that small: nothing, so the phone is sent the picture as it is.
    expect(pictureCopy(pngUrl(picture(640, 300, () => [1, 2, 3, 255])), 640)).toBeNull()
    // A GIF or a WebP is not read at all.
    expect(pictureCopy('data:image/gif;base64,R0lGODlhAQABAAAAACw=', 640)).toBeNull()
    expect(pictureCopy('data:image/webp;base64,UklGRg==', 640)).toBeNull()
  })

  it('refuses a picture that will not decode, and one with too many pixels from its header alone', () => {
    const whole = writePng(picture(64, 64, () => [9, 9, 9, 255]), { colorType: 6 })
    expect(() => pictureCopy(`data:image/png;base64,${whole.subarray(0, 60).toString('base64')}`, 32)).toThrow()
    expect(() => pictureCopy(`data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0, 3, 0]).toString('base64')}`, 32)).toThrow()
    // A header that says 5000 by 4000 is refused before anything is inflated: there is nothing after it to inflate.
    const header = Buffer.from(whole.subarray(0, 33))
    header.writeUInt32BE(5000, 16); header.writeUInt32BE(4000, 20)
    expect(5000 * 4000).toBeGreaterThan(PICTURE_COPY_MAX_PIXELS)
    expect(() => pictureCopy(`data:image/png;base64,${header.toString('base64')}`, 640)).toThrow('Too many pixels')
  })

  it('sends whole a PNG with a second header, an interlaced PNG and a picture with a colour profile, before decoding (review)', () => {
    const whole = writePng(picture(64, 64, () => [9, 9, 9, 255]), { colorType: 6 })
    const url = (bytes: Buffer, kind = 'png'): string => `data:image/${kind};base64,${bytes.toString('base64')}`
    expect(pictureCopy(url(whole), 32)).not.toBeNull()
    // pngjs takes its size from the last header it reads: a second one after the first, saying 5000 by 4000, is refused.
    const second = Buffer.from(whole.subarray(8, 33))
    second.writeUInt32BE(5000, 8); second.writeUInt32BE(4000, 12)
    expect(() => pictureCopy(url(Buffer.concat([whole.subarray(0, 33), second, whole.subarray(33)])), 32)).toThrow('More than one header')
    // Interlaced: pngjs would inflate it with no limit.
    const interlaced = Buffer.from(whole); interlaced[28] = 1
    expect(() => pictureCopy(url(interlaced), 32)).toThrow('Interlaced')
    // A colour profile, which a copy of the bare pixels would lose.
    const profile = Buffer.from('Display P3\0\0' + 'x'.repeat(20), 'latin1')
    const iccp = Buffer.alloc(12 + profile.length); iccp.writeUInt32BE(profile.length, 0); iccp.write('iCCP', 4, 'latin1'); profile.copy(iccp, 8)
    expect(() => pictureCopy(url(Buffer.concat([whole.subarray(0, 33), iccp, whole.subarray(33)])), 32)).toThrow('Colour profile')
    const jpeg = encodeJpeg(picture(64, 64, () => [200, 40, 90, 255]), 85)
    expect(pictureCopy(url(jpeg, 'jpeg'), 32)).not.toBeNull()
    const app2 = Buffer.concat([Buffer.from([0xff, 0xe2, 0, 2 + 14 + 8]), Buffer.from('ICC_PROFILE\0\x01\x01', 'latin1'), Buffer.alloc(8)])
    expect(() => pictureCopy(url(Buffer.concat([jpeg.subarray(0, 2), app2, jpeg.subarray(2)]), 'jpeg'), 32)).toThrow('Colour profile')
  })

  it('writes JPEGs jpeg-js reads back at their size and close to what they were given, at any size', () => {
    for (const [width, height] of [[1, 1], [17, 9], [15, 33], [640, 400], [641, 401]] as const) {
      const given = picture(width, height, (x, y) => [Math.round(x * 255 / width), Math.round(y * 255 / height), 128, 255])
      const written = encodeJpeg(given, 85)
      // A baseline frame whose luminance is sampled two by two against each colour's one.
      const frame = written.indexOf(Buffer.from([0xff, 0xc0]))
      expect(frame).toBeGreaterThan(0)
      expect([...written.subarray(frame + 10, frame + 19)]).toEqual([1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])
      const read = decodeJpeg(written, { useTArray: true, formatAsRGBA: true, tolerantDecoding: false })
      expect(read).toMatchObject({ width, height })
      // Colour at half resolution costs the steepest of these, a whole gradient across 17 pixels, about what libjpeg's own
      // writer loses on it at 85 (29.6 dB for both on November 10, 2026); the larger ones keep far more.
      expect(closeness(given, read)).toBeGreaterThan(width * height > 1000 ? 40 : 29)
    }
  })
})
