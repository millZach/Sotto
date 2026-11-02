// @vitest-environment node
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { OWL_FEATURES, isOwlFeatureEnabled, owlFeaturesForTrack, type OwlFeature } from '../../../src/shared/owlFeatures'

const SENT_ON_OCTOBER_23 = ['watcher', 'muse', 'usage', 'resume-after-restart', 'update-all', 'streaming-publish-cost', 'thread-delegation',
  'worker-roles', 'continue-on-provider', 'continue-agent-thread', 'opencode', 'dictation-hold-shortcuts', 'main-freeze', 'iphone-pull-request-view',
  'iphone-agents-view', 'dictation-off', 'message-scrubber', 'menu-bar-owl', 'desktop-notifications']
const SENT_LATER = ['quiet-composer']

describe('Owl feature list', () => {
  it('records Watcher as the first feature, points to its owning decision, and keeps every sent feature on in stable', () => {
    expect(OWL_FEATURES[0]).toMatchObject({ id: 'watcher', name: 'Watcher', owlSince: '2026-10-10', sentToStable: true })
    expect(new Set(OWL_FEATURES.map(feature => feature.id)).size).toBe(OWL_FEATURES.length)
    for (const feature of OWL_FEATURES) expect(existsSync(feature.owner)).toBe(true)
    expect(OWL_FEATURES[1]).toMatchObject({ id: 'muse', name: 'Muse provider', owner: 'docs/adr/0079-muse-is-a-thread-provider.md', sentToStable: true })
    expect(OWL_FEATURES[2]).toMatchObject({ id: 'usage', name: 'Usage', owner: 'docs/adr/0078-usage-keeps-numeric-history-on-its-own-host.md', sentToStable: true })
    expect(owlFeaturesForTrack('stable')).toEqual(Object.fromEntries(OWL_FEATURES.map(feature => [feature.id, feature.sentToStable])))
    expect(owlFeaturesForTrack('owl')).toEqual(Object.fromEntries(OWL_FEATURES.map(feature => [feature.id, true])))
    // Zach sent these nineteen to stable on October 23, 2026 (ADR-0072); features added to the list later start held until
    // he sends them, as he sent the quiet composer with his own composer style on October 30 (ADR-0168).
    expect(OWL_FEATURES.filter(feature => feature.sentToStable).map(feature => feature.id)).toEqual([...SENT_ON_OCTOBER_23, ...SENT_LATER])
  })

  it('keeps a second feature in Owl until its single stable flag changes', () => {
    const second: OwlFeature = { id: 'second', name: 'Second feature', owlSince: '2026-10-12', owner: 'test plan', sentToStable: false }
    const features = [...OWL_FEATURES, second]
    expect(isOwlFeatureEnabled('second', 'owl', features)).toBe(true)
    expect(isOwlFeatureEnabled('second', 'stable', features)).toBe(false)
    const third: OwlFeature = { ...second, id: 'third', name: 'Third feature' }
    const graduated = [...OWL_FEATURES, { ...second, sentToStable: true }, third]
    expect(isOwlFeatureEnabled('second', 'owl', graduated)).toBe(true)
    expect(isOwlFeatureEnabled('second', 'stable', graduated)).toBe(true)
    expect(isOwlFeatureEnabled('third', 'stable', graduated)).toBe(false)
  })

  it.each(['stable', 'owl'] as const)('keeps an unknown feature off in %s', track => {
    expect(isOwlFeatureEnabled('unknown', track)).toBe(false)
  })
})
