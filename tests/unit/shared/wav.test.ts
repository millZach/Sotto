import { describe, expect, it } from 'vitest'

import { WAV_HEADER_BYTES, encodeWavPcm16 } from '../../../src/shared/wav'

const SAMPLE_RATE = 16_000

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

describe('encodeWavPcm16', () => {
  it('writes a canonical 16 kHz mono PCM16 header', () => {
    const bytes = encodeWavPcm16(new Float32Array(8), SAMPLE_RATE)
    const header = view(bytes)

    expect(bytes.byteLength).toBe(WAV_HEADER_BYTES + 16)
    expect(ascii(bytes, 0, 4)).toBe('RIFF')
    expect(header.getUint32(4, true)).toBe(bytes.byteLength - 8)
    expect(ascii(bytes, 8, 4)).toBe('WAVE')
    expect(ascii(bytes, 12, 4)).toBe('fmt ')
    expect(header.getUint32(16, true)).toBe(16)
    expect(header.getUint16(20, true)).toBe(1)
    expect(header.getUint16(22, true)).toBe(1)
    expect(header.getUint32(24, true)).toBe(SAMPLE_RATE)
    expect(header.getUint32(28, true)).toBe(SAMPLE_RATE * 2)
    expect(header.getUint16(32, true)).toBe(2)
    expect(header.getUint16(34, true)).toBe(16)
    expect(ascii(bytes, 36, 4)).toBe('data')
    expect(header.getUint32(40, true)).toBe(16)
  })

  it('encodes an empty segment as a header with no sample data', () => {
    const bytes = encodeWavPcm16(new Float32Array(0), SAMPLE_RATE)
    expect(bytes.byteLength).toBe(WAV_HEADER_BYTES)
    expect(view(bytes).getUint32(40, true)).toBe(0)
  })

  it('converts float samples to little-endian PCM16 at both endpoints', () => {
    const bytes = encodeWavPcm16(Float32Array.from([0, 1, -1, 0.5, -0.5]), SAMPLE_RATE)
    const samples = view(bytes)
    const at = (index: number): number => samples.getInt16(WAV_HEADER_BYTES + index * 2, true)

    expect(at(0)).toBe(0)
    expect(at(1)).toBe(32_767)
    expect(at(2)).toBe(-32_768)
    expect(at(3)).toBe(16_384)
    expect(at(4)).toBe(-16_384)
    // Little-endian byte order, checked directly rather than through getInt16.
    expect(bytes[WAV_HEADER_BYTES + 2]).toBe(0xff)
    expect(bytes[WAV_HEADER_BYTES + 3]).toBe(0x7f)
  })

  it('clamps out-of-range and non-finite samples instead of wrapping', () => {
    const bytes = encodeWavPcm16(
      Float32Array.from([4, -4, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]),
      SAMPLE_RATE,
    )
    const samples = view(bytes)
    const at = (index: number): number => samples.getInt16(WAV_HEADER_BYTES + index * 2, true)

    expect(at(0)).toBe(32_767)
    expect(at(1)).toBe(-32_768)
    expect(at(2)).toBe(0)
    expect(at(3)).toBe(32_767)
    expect(at(4)).toBe(-32_768)
  })

  it('encodes a subarray view without leaking the rest of its buffer', () => {
    const source = Float32Array.from([1, -1, 0.5, 0.25])
    const bytes = encodeWavPcm16(source.subarray(2), SAMPLE_RATE)
    const samples = view(bytes)

    expect(bytes.byteLength).toBe(WAV_HEADER_BYTES + 4)
    expect(samples.getInt16(WAV_HEADER_BYTES, true)).toBe(16_384)
    expect(samples.getInt16(WAV_HEADER_BYTES + 2, true)).toBe(8_192)
  })

  it('returns a view that owns its whole buffer so it can be transferred', () => {
    const bytes = encodeWavPcm16(Float32Array.from([0.1, 0.2]), SAMPLE_RATE)
    expect(bytes.byteOffset).toBe(0)
    expect(bytes.buffer.byteLength).toBe(bytes.byteLength)
  })

  it('rejects a sample rate that cannot describe a stream', () => {
    expect(() => encodeWavPcm16(new Float32Array(1), 0)).toThrow(RangeError)
    expect(() => encodeWavPcm16(new Float32Array(1), -16_000)).toThrow(RangeError)
    expect(() => encodeWavPcm16(new Float32Array(1), 16_000.5)).toThrow(RangeError)
  })
})
