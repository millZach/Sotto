// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { hostReleaseVersion } from '../../../src/main/hosts/hostReleaseVersion'

describe('host release version', () => {
  it('uses the promoted stable version instead of the source manifest for hosts and peers', () => {
    expect(hostReleaseVersion('0.1.37', '0.1.36')).toBe('0.1.37')
  })
  it('keeps Owl on its existing stable host version', () => {
    expect(hostReleaseVersion('0.1.37-owl.20261011.1', '0.1.36')).toBe('0.1.36')
  })
  it('leaves a stable build without an override unchanged', () => {
    expect(hostReleaseVersion('0.1.36', '0.1.36')).toBe('0.1.36')
  })
})
