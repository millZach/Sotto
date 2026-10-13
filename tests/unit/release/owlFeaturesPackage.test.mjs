// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { URL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { assertPackagedFeatureStatus } from '../../../scripts/verify-owl-features-package.mjs'

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
  it.each(['stable', 'owl'])('checks all four real feature answers in %s by default', track => {
    const enabled = track === 'owl'
    expect(() => assertPackagedFeatureStatus({ releaseTrack: track, owlFeatures: { watcher: enabled, muse: enabled, 'resume-after-restart': enabled, 'update-all': enabled }, watcherEnabled: enabled }, track)).not.toThrow()
  })
  it('refuses a Muse leak in the real stable list', () => {
    expect(() => assertPackagedFeatureStatus({ releaseTrack: 'stable', owlFeatures: { watcher: false, muse: true, 'resume-after-restart': false, 'update-all': false }, watcherEnabled: false }, 'stable')).toThrow('Muse provider must be off')
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
