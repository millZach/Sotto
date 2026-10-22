// @vitest-environment node
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { OWL_FEATURES, isOwlFeatureEnabled, owlFeaturesForTrack, type OwlFeature } from '../../../src/shared/owlFeatures'

describe('Owl feature list', () => {
  it('records Watcher as the first feature and points to its owning decision', () => {
    expect(OWL_FEATURES[0]).toMatchObject({ id: 'watcher', name: 'Watcher', owlSince: '2026-10-10', sentToStable: false })
    expect(new Set(OWL_FEATURES.map(feature => feature.id)).size).toBe(OWL_FEATURES.length)
    for (const feature of OWL_FEATURES) expect(existsSync(feature.owner)).toBe(true)
    expect(OWL_FEATURES[1]).toMatchObject({ id: 'muse', name: 'Muse provider', owner: 'docs/adr/0079-muse-is-a-thread-provider.md', sentToStable: false })
    expect(OWL_FEATURES[2]).toMatchObject({ id: 'usage', name: 'Usage', owner: 'docs/adr/0078-usage-keeps-numeric-history-on-its-own-host.md', sentToStable: false })
    expect(owlFeaturesForTrack('stable')).toEqual({ watcher: false, muse: false, usage: false, 'resume-after-restart': false, 'update-all': false, 'streaming-publish-cost': false, 'thread-delegation': false, 'worker-roles': false, 'continue-on-provider': false, 'continue-agent-thread': false, opencode: false, 'dictation-hold-shortcuts': false, 'main-freeze': false, 'iphone-pull-request-view': false })
    expect(owlFeaturesForTrack('owl')).toEqual({ watcher: true, muse: true, usage: true, 'resume-after-restart': true, 'update-all': true, 'streaming-publish-cost': true, 'thread-delegation': true, 'worker-roles': true, 'continue-on-provider': true, 'continue-agent-thread': true, opencode: true, 'dictation-hold-shortcuts': true, 'main-freeze': true, 'iphone-pull-request-view': true })
  })

  it('keeps a second feature in Owl until its single stable flag changes', () => {
    const second: OwlFeature = { id: 'second', name: 'Second feature', owlSince: '2026-10-12', owner: 'test plan', sentToStable: false }
    const features = [...OWL_FEATURES, second]
    expect(isOwlFeatureEnabled('second', 'owl', features)).toBe(true)
    expect(isOwlFeatureEnabled('second', 'stable', features)).toBe(false)
    const graduated = [...OWL_FEATURES, { ...second, sentToStable: true }]
    expect(isOwlFeatureEnabled('second', 'owl', graduated)).toBe(true)
    expect(isOwlFeatureEnabled('second', 'stable', graduated)).toBe(true)
    expect(isOwlFeatureEnabled('watcher', 'stable', graduated)).toBe(false)
  })

  it.each(['stable', 'owl'] as const)('keeps an unknown feature off in %s', track => {
    expect(isOwlFeatureEnabled('unknown', track)).toBe(false)
  })
})
