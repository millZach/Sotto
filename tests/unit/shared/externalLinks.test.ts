// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { externalLinkSchema } from '../../../src/shared/externalLinks'
import { safeBrowserUrl } from '../../../src/shared/browser'

describe('URL display safety', () => {
  it.each([0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0, 32, 127, 92])('rejects character %s at both URL boundaries', code => {
    const url = `https://example.com/a${String.fromCharCode(code)}b`
    expect(externalLinkSchema.safeParse(url).success).toBe(false)
    expect(safeBrowserUrl(url)).toBeNull()
    expect(externalLinkSchema.safeParse(`mailto:a${String.fromCharCode(code)}b@example.com`).success).toBe(false)
  })
  it('allows ordinary links and mail addresses', () => {
    expect(externalLinkSchema.safeParse('https://example.com/path?q=hello').success).toBe(true)
    expect(safeBrowserUrl('https://example.com/path?q=hello')).toBe('https://example.com/path?q=hello')
    expect(externalLinkSchema.safeParse('mailto:user@example.com').success).toBe(true)
  })
})
