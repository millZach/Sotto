// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { describeAdapterContract } from './adapterContract'
import { piFixture, piFixtureSkips } from '../fixtures/fakePiFixture'

describeAdapterContract('Pi RPC', session => piFixture(undefined, undefined, session), piFixtureSkips)

describe('Pi native events', () => {
  let fixture: Awaited<ReturnType<typeof piFixture>> | undefined
  afterEach(async () => { await fixture?.cleanup(); fixture = undefined })
  const open = async () => {
    fixture = await piFixture()
    await fixture.host.connect()
    await fixture.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: fixture.projectId, title: 'Test', path: fixture.root })
    const id = randomUUID()
    await fixture.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: fixture.projectId, modelId: fixture.modelId, title: 'Pi' })
    fixture.host.observeThreads([id])
    return id
  }
  it('waits past agent_end until agent_settled, preserving Unicode separators in streamed text', async () => {
    const id = await open()
    await fixture!.host.execute({ type: 'send', commandId: randomUUID(), messageId: randomUUID(), threadId: id, text: 'Test' })
    await fixture!.action(id, { type: 'event', event: { type: 'agent_end', willRetry: true } })
    expect((await fixture!.host.snapshot()).threads[0]!.status).toBe('running')
    const text = 'First\u2028second\u2029third'
    await fixture!.driver.completeTurn(id, text)
    await expect.poll(async () => (await fixture!.host.snapshot()).threads[0]!.status).toBe('idle')
    expect((await fixture!.host.snapshot()).threads[0]!.messages.at(-1)?.text).toBe(text)
    await expect.poll(async () => (await fixture!.host.snapshot()).threads[0]!.usage?.latest?.output).toBe(20)
  })
  it('keeps a settled turn’s tokens when its stats response arrives during the next turn', async () => {
    const id = await open()
    await fixture!.script({ holdStats: true })
    await fixture!.host.execute({ type: 'send', commandId: randomUUID(), messageId: 'first', threadId: id, text: 'First' })
    await fixture!.driver.completeTurn(id, 'First reply')
    await expect.poll(async () => (await fixture!.host.snapshot()).threads[0]!.status).toBe('idle')
    await fixture!.host.execute({ type: 'send', commandId: randomUUID(), messageId: 'second', threadId: id, text: 'Second' })
    await fixture!.action(id, { type: 'release-stats' })
    await expect.poll(async () => (await fixture!.host.snapshot()).threads[0]!.usage?.latest?.output).toBe(20)
  })
  it('offers only full access and refuses a narrower mode before starting a thread', async () => {
    await open()
    expect((await fixture!.host.snapshot()).models.every(model => JSON.stringify(model.runtimeModes) === '["full-access"]')).toBe(true)
    await expect(fixture!.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: (await fixture!.host.snapshot()).threads[0]!.id, runtimeMode: 'approval-required' })).rejects.toThrow('permission mode')
  })
})
