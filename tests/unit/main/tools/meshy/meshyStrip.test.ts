// @vitest-environment node
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkPhoto, photoToSend } from '../../../../../src/main/tools/meshy/photo'
import { stripJpeg, stripPhoto, stripPng } from '../../../../../src/main/tools/meshy/strip'

/** A photo on a paired host loses its metadata sections in the file itself, its pixels untouched (#2497). All bytes are made up. */
let root: string
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'sotto-meshy-strip-'))) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const GPS = 'GPS 51.5007 N 0.1246 W'
const segment = (marker: number, body: Buffer): Buffer => Buffer.concat([Buffer.from([0xff, marker]), Buffer.from([(body.byteLength + 2) >> 8, (body.byteLength + 2) & 0xff]), body])
const SOI = Buffer.from([0xff, 0xd8]), EOI = Buffer.from([0xff, 0xd9])
const APP0 = segment(0xe0, Buffer.concat([Buffer.from('JFIF\0', 'latin1'), Buffer.from([1, 2, 0, 0, 1, 0, 1, 0, 0])]))
const ICC = segment(0xe2, Buffer.concat([Buffer.from('ICC_PROFILE\0', 'latin1'), Buffer.from([1, 1]), Buffer.from('made-up colour profile')]))
const EXIF = segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from(`made-up camera ${GPS}`, 'latin1')]))
const XMP = segment(0xe1, Buffer.from(`http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>${GPS}</x:xmpmeta>`, 'latin1'))
const COM = segment(0xfe, Buffer.from('Taken by the made-up camera', 'latin1'))
const DQT = segment(0xdb, Buffer.alloc(65, 1))
const SOF = segment(0xc0, Buffer.from([0x08, 0x00, 0x10, 0x00, 0x10, 0x01, 1, 0x11, 0]))
const DHT = segment(0xc4, Buffer.alloc(20, 2))
const SOS = segment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0]))
// Compressed picture with a stuffed 0xFF and a restart marker in it, which belong to the picture.
const SCAN = Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, 0x9a])
const PICTURE = [DQT, SOF, DHT, SOS, SCAN]

const chunk = (type: string, data: Buffer): Buffer => {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.byteLength)
  // The check bytes are made up too: a chunk is kept or dropped whole, so they are never read.
  return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.from([1, 2, 3, 4])])
}
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const IHDR = chunk('IHDR', Buffer.from([0, 0, 0, 16, 0, 0, 0, 16, 8, 6, 0, 0, 0]))
const IDAT = chunk('IDAT', Buffer.from('made-up compressed pixels', 'latin1'))
const IEND = chunk('IEND', Buffer.alloc(0))

describe('taking a photo’s metadata out of its file', () => {
  it('takes a JPEG’s Exif and XMP, with the location in them, and its comment, and keeps its picture byte for byte', () => {
    const photo = Buffer.concat([SOI, APP0, EXIF, XMP, ICC, COM, ...PICTURE, EOI])
    const stripped = stripJpeg(photo)!
    expect(stripped.equals(Buffer.concat([SOI, APP0, ICC, ...PICTURE, EOI]))).toBe(true)
    expect(stripped.includes(GPS)).toBe(false)
    expect(stripped.includes('made-up camera')).toBe(false)
  })

  it('takes a PNG’s eXIf, tEXt and tIME chunks, and keeps its pixels byte for byte', () => {
    const photo = Buffer.concat([SIGNATURE, IHDR, chunk('eXIf', Buffer.from(`MM\0*${GPS}`, 'latin1')), chunk('tEXt', Buffer.from(`Comment\0${GPS}`, 'latin1')),
      chunk('iTXt', Buffer.from('Author\0\0\0\0\0made-up', 'latin1')), chunk('zTXt', Buffer.from('Software\0\0made-up', 'latin1')), IDAT, chunk('tIME', Buffer.from([7, 234, 11, 15, 9, 0, 0])), IEND])
    const stripped = stripPng(photo)!
    expect(stripped.equals(Buffer.concat([SIGNATURE, IHDR, IDAT, IEND]))).toBe(true)
    expect(stripped.includes(GPS)).toBe(false)
  })

  it('leaves a photo with no metadata as it is', () => {
    const jpeg = Buffer.concat([SOI, APP0, ...PICTURE, EOI])
    const png = Buffer.concat([SIGNATURE, IHDR, IDAT, IEND])
    expect(stripJpeg(jpeg)!.equals(jpeg)).toBe(true)
    expect(stripPng(png)!.equals(png)).toBe(true)
  })

  it('leaves out what comes after the picture’s end, as a motion photo’s video does', () => {
    expect(stripJpeg(Buffer.concat([SOI, APP0, ...PICTURE, EOI, Buffer.from(`made-up video ${GPS}`, 'latin1')]))!.includes(GPS)).toBe(false)
    expect(stripPng(Buffer.concat([SIGNATURE, IHDR, IDAT, IEND, Buffer.from(GPS, 'latin1')]))!.includes(GPS)).toBe(false)
  })

  it('sends nothing of a file it cannot read through', async () => {
    expect(stripJpeg(Buffer.concat([SOI, APP0, EXIF.subarray(0, 10)]))).toBeNull()
    expect(stripJpeg(Buffer.concat([SOI, APP0, ...PICTURE]))).toBeNull()
    expect(stripPng(Buffer.concat([SIGNATURE, IHDR, IDAT]))).toBeNull()
    await expect(stripPhoto(Buffer.from('not a photo'), 'image/png')).resolves.toBeNull()
  })

  it('sends a photo stripped after the same checks of its pixels and its fingerprint', async () => {
    const photo = Buffer.concat([SOI, APP0, EXIF, COM, ...PICTURE, EOI])
    await writeFile(join(root, 'barrel.jpg'), photo)
    const checked = await checkPhoto(root, 'barrel.jpg')
    if (typeof checked === 'string') throw new Error(checked)
    const sent = await photoToSend(root, checked, 'barrel.jpg', stripPhoto)
    if (typeof sent === 'string') throw new Error(sent)
    expect(Buffer.from(sent.photo.replace('data:image/jpeg;base64,', ''), 'base64').equals(Buffer.concat([SOI, APP0, ...PICTURE, EOI]))).toBe(true)
    // Changed since it was checked: not sent.
    await writeFile(join(root, 'barrel.jpg'), Buffer.concat([photo, Buffer.from('more')]))
    await expect(photoToSend(root, checked, 'barrel.jpg', stripPhoto)).resolves.toBe('changed')
    // Too many pixels to be sent, by its header.
    const huge = Buffer.concat([SOI, segment(0xc0, Buffer.from([0x08, 0x27, 0x11, 0x27, 0x11, 0x01, 1, 0x11, 0])), SOS, SCAN, EOI])
    await writeFile(join(root, 'huge.jpg'), huge)
    await expect(checkPhoto(root, 'huge.jpg')).resolves.toBe('too-many-pixels')
  })
})
