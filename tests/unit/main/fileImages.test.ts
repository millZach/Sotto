// @vitest-environment node
import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { rasterImage } from '../../../src/main/files/imagePreview'

describe('raster preview signatures and dimensions', () => {
  it.each(['png', 'jpeg', 'gif', 'webp'] as const)('sniffs actual %s bytes without trusting a file extension', async format => {
    const buffer = await sharp({ create: { width: 17, height: 11, channels: 3, background: '#004466' } }).toFormat(format).toBuffer()
    expect(rasterImage(buffer)).toEqual({ mime: `image/${format}`, width: 17, height: 11 })
    expect(rasterImage(buffer.subarray(0, 8))).toBeNull()
  })
  it('reads alpha and lossless WebP dimensions', async () => {
    for (const lossless of [true, false]) {
      const buffer = await sharp({ create: { width: 19, height: 7, channels: 4, background: '#00446688' } }).webp({ lossless }).toBuffer()
      expect(rasterImage(buffer)).toEqual({ mime: 'image/webp', width: 19, height: 7 })
    }
  })
  it('rejects executable/vector/text content and malformed JPEG segment lengths', () => {
    for (const bytes of [Buffer.from('<svg onload="bad()"></svg>'), Buffer.from('<!DOCTYPE html>'), Buffer.from('plain text'),
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff]), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), Buffer.alloc(0)]) {
      expect(rasterImage(bytes)).toBeNull()
    }
  })
})
