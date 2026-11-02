// @vitest-environment node
/**
 * A catalog sent to a client that accepted `provider-mode-lists` lists each provider's modes once (ADR-0028, November 1
 * amendment). Devin's 846 models each carried the same modes on the owner's laptop: 814 KB of a 1 MB catalog, sent to the
 * iPhone on every connect.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { SocketFrames } from '../../src/host/socketFrames'
import type { AgentHostSnapshot, AgentModel, AgentProviderMode } from '../../src/shared/agents'
import { rawPeer } from '../fixtures/rawHostPeer'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'

const fixture = useSocketHostFixture()
const raws: SocketFrames[] = []
afterEach(() => { for (const frames of raws.splice(0)) frames.close() })

const modes: AgentProviderMode[] = ['ask', 'edit'].map(mode => ({ id: `mode-${mode}`, name: `Mode ${mode}`, description: `A synthetic ${mode} mode.` }))
const otherModes: AgentProviderMode[] = [{ id: 'mode-plan', name: 'Plan', description: 'A synthetic plan mode.' }]

interface WireModel extends AgentModel { providerModeList?: number }
interface WireHost { models?: WireModel[]; modelsRevision?: number; providerModeLists?: AgentProviderMode[][] }

/** The fake provider's catalog: three models on one list of modes, one on another, and one with none. */
async function catalog(): Promise<void> {
  // The host lists its provider's threads once it has connected to it; a catalog emitted before then is not read.
  await expect.poll(() => fixture.host.service.shell().host.threads.length).toBeGreaterThan(1)
  const native = fixture.native as unknown as { state: AgentHostSnapshot; emit(): void }
  const base = native.state.models[0]!
  native.state.models = [
    ...['a', 'b', 'c'].map(name => ({ ...base, id: `claude:shared-${name}`, name: `Shared ${name}`, providerModes: structuredClone(modes) })),
    { ...base, id: 'claude:other', name: 'Other', providerModes: structuredClone(otherModes) },
    { ...base, id: 'claude:plain', name: 'Plain' },
  ]
  native.emit()
}

async function hello(accepts: string[]) {
  await expect.poll(() => fixture.host.service.shell().host.models.some(model => model.name === 'Plain')).toBe(true)
  const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'iPhone')
  const raw = await rawPeer(fixture.host.descriptor!.port, fixture.host.pairing.signSession(paired.clientId))
  raws.push(raw.frames)
  const answer = await raw.call('hello', { op: 'hello', accepts }) as { result: { shell: { host: WireHost } } }
  return answer.result.shell.host
}

/** The models as a client that accepted the feature puts them back. */
const restored = (host: WireHost): AgentModel[] => host.models!.map(({ providerModeList, ...model }) =>
  providerModeList === undefined ? model : { ...model, providerModes: host.providerModeLists![providerModeList]! })

describe('provider mode lists', () => {
  it('lists each distinct set of modes once, names it on each model, and leaves a model without modes as it is', async () => {
    await catalog()
    const host = await hello(['model-catalog-revision', 'provider-mode-lists'])
    expect(host.providerModeLists).toEqual([modes, otherModes])
    // The host lists the fake provider's catalog under each provider it runs, so every list is named many times.
    const named = (name: string) => host.models!.filter(model => model.name === name)
    for (const name of ['Shared a', 'Shared b', 'Shared c']) expect(new Set(named(name).map(model => model.providerModeList))).toEqual(new Set([0]))
    expect(new Set(named('Other').map(model => model.providerModeList))).toEqual(new Set([1]))
    for (const model of host.models!) expect(model).not.toHaveProperty('providerModes')
    for (const model of named('Plain')) expect(model).not.toHaveProperty('providerModeList')
    // Put back, the catalog is the one a client without the feature is sent.
    const whole = await hello(['model-catalog-revision'])
    expect(whole).not.toHaveProperty('providerModeLists')
    expect(restored(host)).toEqual(whole.models)
  })

  it('lists them once to a client that takes the catalog on every shell, too', async () => {
    await catalog()
    const host = await hello(['provider-mode-lists'])
    expect(host.providerModeLists).toEqual([modes, otherModes])
    expect(restored(host)).toEqual((await hello([])).models)
  })
})
