// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { usdzProblem } from '../../../../../src/main/tools/meshy/usdz'
import { usdzBytes } from '../../../../fixtures/usdz'

/** The check that a USDZ is whole before a phone is handed it (the Meshy plan's ticket 7). */
const patched = (bytes: Uint8Array, at: number, value: number, width: 2 | 4 = 4): Uint8Array => {
  const copy = Buffer.from(bytes)
  if (width === 4) copy.writeUInt32LE(value, at); else copy.writeUInt16LE(value, at)
  return new Uint8Array(copy)
}
// One file, `model.usdc`, of 64 bytes: its header and bytes to 104, its directory entry to 160, the end record to 182.
const one = usdzBytes()
const ENTRY = 104, END = 160

describe('a USDZ before it goes to a phone', () => {
  it('is whole with one layer or a layer and its textures', () => {
    expect(one.byteLength).toBe(182)
    expect(usdzProblem(one)).toBeNull()
    expect(usdzProblem(usdzBytes([['scene.usda', new Uint8Array(32)], ['textures/wood.png', new Uint8Array(16)]]))).toBeNull()
  })

  it('is not one when it is not a ZIP, its first file is not a layer, or a file is compressed', () => {
    expect(usdzProblem(new Uint8Array(200))).toBe('not-usdz')
    expect(usdzProblem(usdzBytes([['texture.png', new Uint8Array(8)], ['model.usdc', new Uint8Array(8)]]))).toBe('not-usdz')
    expect(usdzProblem(usdzBytes(undefined, 8))).toBe('not-usdz')
    expect(usdzProblem(patched(one, ENTRY + 10, 8, 2))).toBe('not-usdz')
  })

  it('is refused cut short, even with its end record kept (Sol on ticket 7)', () => {
    // Its end record gone.
    expect(usdzProblem(one.subarray(0, one.byteLength - 4))).toBe('truncated')
    // A file claiming more bytes than are there.
    expect(usdzProblem(patched(one, ENTRY + 20, 4096))).toBe('truncated')
    // A directory said to start past the end, or to be longer than it is.
    expect(usdzProblem(patched(one, END + 16, 4096))).toBe('truncated')
    expect(usdzProblem(patched(one, END + 12, 4096))).toBe('truncated')
    // More entries counted than the directory holds, and a file's header not where its entry says.
    expect(usdzProblem(patched(one, END + 10, 2, 2))).toBe('truncated')
    expect(usdzProblem(patched(one, ENTRY + 42, 50))).toBe('truncated')
    // A header and an end record with no directory between them.
    const bare = Buffer.alloc(30 + 10 + 64 + 22)
    Buffer.from(one.subarray(0, 104)).copy(bare)
    bare.writeUInt32LE(0x06054b50, 104); bare.writeUInt16LE(1, 114); bare.writeUInt16LE(1, 112); bare.writeUInt32LE(0, 116); bare.writeUInt32LE(104, 120)
    expect(usdzProblem(new Uint8Array(bare))).toBe('truncated')
  })

  it('refuses a ZIP64 archive, which one under the cap never needs', () => {
    expect(usdzProblem(patched(one, END + 16, 0xffffffff))).toBe('not-usdz')
  })
})
