// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { URL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { assertPackagedFeatureStatus } from '../../../scripts/verify-owl-features-package.mjs'
import { OWL_FEATURES } from '../../../src/shared/owlFeatures'

const features = [
  { id: 'watcher', name: 'Watcher', sentToStable: false },
  { id: 'second', name: 'Second feature', sentToStable: false },
  { id: 'graduated', name: 'Sent to stable', sentToStable: true },
]
const status = (track, overrides = {}) => ({ releaseTrack: track, owlFeatures: { watcher: track === 'owl', second: track === 'owl', graduated: true }, watcherEnabled: track === 'owl', ...overrides })

describe('packaged Owl feature protection', () => {
  it.each(['stable', 'owl'])('accepts the correct %s answers for all entries', track => {
    expect(() => assertPackagedFeatureStatus(status(track), track, features)).not.toThrow()
  })
  it('refuses a stable preview leak and a disabled stable graduation', () => {
    expect(() => assertPackagedFeatureStatus(status('stable', { owlFeatures: { watcher: false, second: true, graduated: true } }), 'stable', features)).toThrow('Second feature must be off')
    expect(() => assertPackagedFeatureStatus(status('stable', { owlFeatures: { watcher: false, second: false, graduated: false } }), 'stable', features)).toThrow('Sent to stable must be on')
  })
  it('refuses any disabled Owl feature, missing answers, a wrong track and a divergent alias', () => {
    expect(() => assertPackagedFeatureStatus(status('owl', { owlFeatures: { watcher: true, second: false, graduated: true } }), 'owl', features)).toThrow('Second feature must be on')
    expect(() => assertPackagedFeatureStatus(status('stable', { owlFeatures: {} }), 'stable', features)).toThrow('Watcher must be off')
    expect(() => assertPackagedFeatureStatus(status('owl'), 'stable', features)).toThrow('stable track')
    expect(() => assertPackagedFeatureStatus(status('owl', { watcherEnabled: false }), 'owl', features)).toThrow('compatibility answer')
  })
  it.each(['stable', 'owl'])('checks every real Owl feature by default in %s', track => {
    const owlFeatures = Object.fromEntries(OWL_FEATURES.map(feature => [feature.id, track === 'owl' || feature.sentToStable]))
    const realStatus = { releaseTrack: track, owlFeatures, watcherEnabled: owlFeatures.watcher }
    expect(() => assertPackagedFeatureStatus(realStatus, track)).not.toThrow()
    for (const feature of OWL_FEATURES) {
      const missing = { ...owlFeatures }
      delete missing[feature.id]
      const incorrect = { ...owlFeatures, [feature.id]: !owlFeatures[feature.id] }
      const problem = `${feature.name} must be ${owlFeatures[feature.id] ? 'on' : 'off'}`
      expect(() => assertPackagedFeatureStatus({ ...realStatus, owlFeatures: missing }, track)).toThrow(problem)
      expect(() => assertPackagedFeatureStatus({ ...realStatus, owlFeatures: incorrect, watcherEnabled: incorrect.watcher }, track)).toThrow(problem)
    }
  })
  it('runs only during stable and Owl release packaging, leaving the directory and Linux commands alone', async () => {
    const stable = await readFile(new URL('../../../scripts/package-stable.mjs', import.meta.url), 'utf8')
    const owl = await readFile(new URL('../../../scripts/package-owl.mjs', import.meta.url), 'utf8')
    expect(stable).toContain("[resolve(root, plan.unpacked), 'stable']")
    expect(owl).toContain("[resolve(root, 'release/win-unpacked'), 'owl']")
    const { scripts } = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'))
    for (const name of ['package:dir', 'package:dir:mac', 'package:linux']) expect(scripts[name]).not.toMatch(/verify-owl-features/u)
  })
})
