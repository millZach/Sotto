// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { owlFeaturesForRun, runningVersion, watcherEnabledForRun } from '../../../src/main/runningVersion'
import { getReleaseTrack } from '../../../src/shared/releaseTrack'
import { OWL_FEATURES } from '../../../src/shared/owlFeatures'
import { updateStatusSchema } from '../../../src/shared/contracts'

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

describe('Owl feature startup answers', () => {
  it.each([
    ['0.1.36', false, 'watcher=1', '0', true],
    ['0.1.37-owl.20261011.1', false, 'watcher=0', '1', false],
    ['0.1.36', true, 'watcher=1', '1', false],
    ['0.1.37-owl.20261011.1', true, 'watcher=0', '0', true],
    ['0.1.36', false, 'unknown=1, watcher=true, watcher=2', undefined, false],
    ['0.1.36', false, ' watcher = 1 ,watcher=0,watcher=bad', undefined, false],
    ['0.1.36', false, undefined, '1', true],
  ] as const)('reads %s once (packaged %s, overrides %s, alias %s)', (version, isPackaged, overrides, watcherOverride, expected) => {
    // The other features follow the track: overrides here name only Watcher.
    const track = getReleaseTrack(version) === 'owl'
    expect(owlFeaturesForRun({ version, isPackaged, overrides, watcherOverride })).toEqual({ watcher: expected, muse: track, usage: track, 'resume-after-restart': track, 'update-all': track, 'streaming-publish-cost': track, 'thread-delegation': track, 'worker-roles': track })
  })

  it.each([
    ['0.1.36', 'watcher=1,muse=1,usage=1,resume-after-restart=1,update-all=1,streaming-publish-cost=1,thread-delegation=1,worker-roles=1', false, true],
    ['0.1.37-owl.20261011.1', 'watcher=0,muse=0,usage=0,resume-after-restart=0,update-all=0,streaming-publish-cost=0,thread-delegation=0,worker-roles=0', true, false],
  ] as const)('keeps all packaged %s answers on their track despite overrides', (version, overrides, packaged, development) => {
    expect(owlFeaturesForRun({ version, isPackaged: true, overrides })).toEqual({ watcher: packaged, muse: packaged, usage: packaged, 'resume-after-restart': packaged, 'update-all': packaged, 'streaming-publish-cost': packaged, 'thread-delegation': packaged, 'worker-roles': packaged })
    expect(owlFeaturesForRun({ version, isPackaged: false, overrides })).toEqual({ watcher: development, muse: development, usage: development, 'resume-after-restart': development, 'update-all': development, 'streaming-publish-cost': development, 'thread-delegation': development, 'worker-roles': development })
  })

  it('passes a snapshot of every answer through update status and keeps the Watcher alias consistent', async () => {
    const { UpdateService } = await import('../../../src/main/updates/updateService')
    const { DEFAULT_SETTINGS } = await import('../../../src/shared/settings')
    const options = { version: '0.1.36', isPackaged: false, overrides: 'watcher=1' }
    const startup = owlFeaturesForRun(options)
    expect(Object.keys(startup)).toEqual(OWL_FEATURES.map(feature => feature.id))
    expect(Object.isFrozen(startup)).toBe(true)
    const service = new UpdateService({ currentVersion: options.version, getSettings: () => DEFAULT_SETTINGS,
      owlFeatures: startup, watcherEnabled: false })
    options.overrides = 'watcher=0'
    const answer = service.status()
    expect(updateStatusSchema.parse(answer)).toMatchObject({ owlFeatures: { watcher: true }, watcherEnabled: true })
    answer.owlFeatures!.watcher = false
    expect((await service.check('manual'))).toMatchObject({ owlFeatures: { watcher: true }, watcherEnabled: true })
    service.dispose()
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
