// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { runningVersion, watcherEnabledForRun } from '../../../src/main/runningVersion'
import { getReleaseTrack } from '../../../src/shared/releaseTrack'

describe('running version', () => {
  it.each([
    ['a packaged stable build', '0.1.36', '0.1.36'],
    ['a packaged Owl build, whose manifest packaging rewrote', '0.1.37-owl.20261011.1', '0.1.37-owl.20261011.1'],
    ['a run on the bare main script, where Electron reports its own version', '43.1.0', '0.1.36'],
  ])('reads %s', (_name, reported, expected) => {
    expect(runningVersion(reported, '43.1.0', '0.1.36')).toBe(expected)
  })

  it('keeps an Owl package on the Owl track and a bare run on stable', () => {
    expect(getReleaseTrack(runningVersion('0.1.37-owl.20261011.1', '43.1.0', '0.1.36'))).toBe('owl')
    expect(getReleaseTrack(runningVersion('43.1.0', '43.1.0', '0.1.36'))).toBe('stable')
  })
})

describe('Watcher startup gate', () => {
  it.each([
    ['0.1.36', true, '1', false],
    ['0.1.37-owl.20261011.1', true, '0', true],
    ['0.1.36', false, '1', true],
    ['0.1.37-owl.20261011.1', false, '0', false],
    ['0.1.36', false, 'true', false],
    ['0.1.37-owl.20261011.1', false, undefined, true],
  ] as const)('reads version %s at startup (packaged %s, override %s)', (version, isPackaged, override, expected) => {
    expect(watcherEnabledForRun({ version, isPackaged, override })).toBe(expected)
  })
  it('exposes the startup result through existing update status even when updates are unsupported', async () => {
    const { UpdateService } = await import('../../../src/main/updates/updateService')
    const { DEFAULT_SETTINGS } = await import('../../../src/shared/settings')
    const options = { version: '0.1.36', isPackaged: false, override: '1' }
    const service = new UpdateService({ currentVersion: options.version, getSettings: () => DEFAULT_SETTINGS,
      watcherEnabled: watcherEnabledForRun(options) })
    options.override = '0'
    expect(service.status().watcherEnabled).toBe(true)
    expect((await service.check('manual')).watcherEnabled).toBe(true)
    service.dispose()
  })
})
