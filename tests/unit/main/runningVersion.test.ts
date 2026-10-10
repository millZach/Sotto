// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { runningVersion } from '../../../src/main/runningVersion'
import { getReleaseTrack } from '../../../src/shared/releaseTrack'

describe('running version', () => {
  it.each([
    ['a packaged stable build', '0.1.34', '0.1.34'],
    ['a packaged Owl build, whose manifest packaging rewrote', '0.1.35-owl.20261009.1', '0.1.35-owl.20261009.1'],
    ['a run on the bare main script, where Electron reports its own version', '43.1.0', '0.1.34'],
  ])('reads %s', (_name, reported, expected) => {
    expect(runningVersion(reported, '43.1.0', '0.1.34')).toBe(expected)
  })

  it('keeps an Owl package on the Owl track and a bare run on stable', () => {
    expect(getReleaseTrack(runningVersion('0.1.35-owl.20261009.1', '43.1.0', '0.1.34'))).toBe('owl')
    expect(getReleaseTrack(runningVersion('43.1.0', '43.1.0', '0.1.34'))).toBe('stable')
  })
})
