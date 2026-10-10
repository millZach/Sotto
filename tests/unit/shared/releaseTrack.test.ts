import { describe, expect, it } from 'vitest'
import { getReleaseTrack } from '../../../src/shared/releaseTrack'

describe('release track', () => {
  it.each(['0.1.35-owl.20261009.1', '0.1.35-owl.20261009.10', '1.0.0-owl.20261231.2'])('recognizes %s', version => {
    expect(getReleaseTrack(version)).toBe('owl')
  })
  it.each(['0.1.34', '0.1.35', '0.1.35-beta.1', '0.1.35-owl', '0.1.35-owl.20261009.0',
    '0.1.35-owl.20261009.01', 'v0.1.35-owl.20261009.1', '0.1.35-owl.20261009.1+test', ''])('keeps %s outside Owl', version => {
    expect(getReleaseTrack(version)).toBe('stable')
  })
})
