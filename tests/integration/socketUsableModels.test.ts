// @vitest-environment node
/**
 * A phone that accepts `usable-models` is sent only the models it can use: ready ones, and any that is not ready but a
 * thread still names (ADR-0028, November 1 part 2). The desktop keeps a model its provider no longer lists, marked not
 * ready, so an old thread's model still resolves; on the owner's laptop those were 853 of 942 models.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { SocketFrames } from '../../src/host/socketFrames'
import type { AgentHostSnapshot, AgentModel } from '../../src/shared/agents'
import { rawPeer } from '../fixtures/rawHostPeer'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'

const fixture = useSocketHostFixture()
const raws: SocketFrames[] = []
afterEach(() => { for (const frames of raws.splice(0)) frames.close() })

/** Every provider the fixture runs, so a phone is sent each one's threads and models. */
const PROVIDERS = ['provider-opencode', 'provider-cursor']

/** The fake provider's catalog now: one ready model and one it reports not ready. The models it listed before stay, not ready. */
async function catalog(): Promise<void> {
  await expect.poll(() => fixture.host.service.shell().host.threads.length).toBeGreaterThan(1)
  const native = fixture.native as unknown as { state: AgentHostSnapshot; emit(): void }
  const base = native.state.models[0]!
  native.state.models = [{ ...base, id: 'claude:ready-now', name: 'Ready now', ready: true }, { ...base, id: 'claude:gone', name: 'Gone', ready: false }]
  native.emit()
  await expect.poll(() => fixture.host.service.shell().host.models.some(model => model.name === 'Gone')).toBe(true)
}

async function hello(accepts: string[]): Promise<AgentModel[]> {
  const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'iPhone')
  const raw = await rawPeer(fixture.host.descriptor!.port, fixture.host.pairing.signSession(paired.clientId))
  raws.push(raw.frames)
  const answer = await raw.call('hello', { op: 'hello', accepts }) as { result: { shell: { host: { models: AgentModel[] } } } }
  return answer.result.shell.host.models
}

describe('usable models', () => {
  it('sends a phone that accepts it ready models and those a thread still names, and an older one every model', async () => {
    await catalog()
    const whole = fixture.host.service.shell().host
    const named = new Set(whole.threads.map(thread => thread.modelId))
    // The threads run on the models the provider listed first, which are no longer ready: the case this keeps.
    expect(whole.models.some(model => !model.ready && named.has(model.id))).toBe(true)

    const usable = await hello([...PROVIDERS, 'usable-models'])
    expect(usable.map(model => model.name)).toContain('Ready now')
    expect(usable.map(model => model.name)).not.toContain('Gone')
    for (const model of usable) expect(model.ready || named.has(model.id)).toBe(true)
    for (const id of named) if (whole.models.some(model => model.id === id)) expect(usable.some(model => model.id === id)).toBe(true)

    const older = await hello(PROVIDERS)
    expect(older.map(model => model.name)).toContain('Gone')
    expect(older.length).toBeGreaterThan(usable.length)
  })
})
