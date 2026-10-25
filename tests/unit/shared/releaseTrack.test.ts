import { describe, expect, it } from 'vitest'
import { getReleaseTrack, releaseTrackName, isWatcherEnabled } from '../../../src/shared/releaseTrack'

describe('release track', () => {
  it.each(['0.1.37-owl.20261011.1', '0.1.37-owl.20261011.10', '1.0.0-owl.20261231.2'])('recognizes %s', version => {
    expect(getReleaseTrack(version)).toBe('owl')
  })
  it.each(['0.1.36', '0.1.37', '0.1.37-beta.1', '0.1.37-owl', '0.1.37-owl.20261011.0',
    '0.1.37-owl.20261011.01', 'v0.1.37-owl.20261011.1', '0.1.37-owl.20261011.1+test', ''])('keeps %s outside Owl', version => {
    expect(getReleaseTrack(version)).toBe('stable')
  })
  it('names each track the way the running build names itself in words', () => {
    expect(releaseTrackName('stable')).toBe('Sotto')
    expect(releaseTrackName('owl')).toBe('Sotto Owl')
  })
})

it('enables Watcher on both release tracks now that it is sent to stable', () => {
  expect(isWatcherEnabled('owl')).toBe(true)
  expect(isWatcherEnabled('stable')).toBe(true)
})
