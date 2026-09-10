// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { normalizeWakeInput } from '../../../src/main/agents/wake'

describe('local wake input level', () => {
  it('raises quiet detector input with one bounded gain without editing microphone audio or timing', () => {
    const original = new Float32Array([0, 0.05, -0.025, 0])
    const normalized = normalizeWakeInput(original)
    expect([...original]).toEqual([0, expect.closeTo(0.05), expect.closeTo(-0.025), 0])
    expect([...normalized]).toEqual([0, expect.closeTo(0.5), expect.closeTo(-0.25), 0])
    expect(normalized.length).toBe(original.length)
  })

  it('preserves normal input and silence and limits gain on very faint background noise', () => {
    const normal = new Float32Array([0.4, -0.8])
    const silence = new Float32Array(128)
    expect(normalizeWakeInput(normal)).toBe(normal)
    expect(normalizeWakeInput(silence)).toBe(silence)
    expect(normalizeWakeInput(new Float32Array([0.001]))[0]).toBeCloseTo(0.012)
  })
})
