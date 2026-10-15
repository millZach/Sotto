// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { hostReleaseVersion, updateHostReleaseVersion } from '../../../src/main/hosts/hostReleaseVersion'

describe('host release version', () => {
  it('uses the packaged stable version instead of the source manifest for hosts and peers', () => {
    expect(hostReleaseVersion('0.1.37', '0.1.36')).toBe('0.1.37')
  })
  it.each([false, true])('uses an explicit packaged stable version when an Owl host is required: %s', requiresOwlHost => {
    expect(hostReleaseVersion('0.2.0', '0.1.36', requiresOwlHost)).toBe('0.2.0')
  })
  it('keeps Owl on the source stable host version when Muse and Usage are held', () => {
    const owl = '0.1.38-owl.20261012.10'
    expect(hostReleaseVersion(owl, '0.1.37')).toBe('0.1.37')
    expect(hostReleaseVersion(owl, '0.1.37', false)).toBe('0.1.37')
  })
  it('leaves a stable build without an override unchanged', () => {
    expect(hostReleaseVersion('0.1.36', '0.1.36')).toBe('0.1.36')
  })
  it.each([{ muse: true, usage: false }, { muse: false, usage: true }, { muse: true, usage: true }])(
    'targets the matching Owl archive for Muse=$muse and Usage=$usage', ({ muse, usage }) => {
      const owl = '0.1.38-owl.20261012.10'
      expect(hostReleaseVersion(owl, '0.1.37', muse || usage)).toBe(owl)
    })
  it('maps an update to its own host release, never to this computer’s (Sotto Bug Bot, review)', () => {
    // Owl with Muse and Usage held: the stable release the waiting build is built on, not the running source version.
    expect(updateHostReleaseVersion('0.1.25-owl.20261015.1')).toBe('0.1.25')
    expect(updateHostReleaseVersion('0.1.25-owl.20261015.1', false)).toBe('0.1.25')
    // With either on: the waiting Owl build itself.
    expect(updateHostReleaseVersion('0.1.25-owl.20261015.1', true)).toBe('0.1.25-owl.20261015.1')
    // Stable: the version itself.
    expect(updateHostReleaseVersion('0.1.25')).toBe('0.1.25')
    expect(updateHostReleaseVersion('0.1.25', true)).toBe('0.1.25')
  })
})
