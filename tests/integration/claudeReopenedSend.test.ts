// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { claudeFixture } from '../fixtures/claudeFixture'
import { immediatePublishScheduler } from '../fixtures/publishScheduler'
import { AgentControl } from '../../src/main/agents/control'
import { AgentCredentials } from '../../src/main/agents/credentials'
import { SottoThreadHost, ThreadRegistry } from '../../src/main/agents/threads'
import { e2eAgentReasoner } from '../../src/main/e2e/agentEffects'

// A thread whose session ends while the user looks at another has its messages put away. When it is
// looked at again the window starts over, empty, while the adapter still remembers the user's last
// message. A send has to be judged against that memory, or every send to the thread reads as a race.
type Fixture = Awaited<ReturnType<typeof claudeFixture>>
const fixtures: Fixture[] = []
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  for (const f of fixtures.splice(0)) await f.cleanup()
})
const live = (f: Fixture, id: string) => (f.adapter as unknown as { runtimes: Map<string, unknown> }).runtimes.has(id)
async function fixture(): Promise<Fixture> {
  const f = await claudeFixture(undefined, 15_000); fixtures.push(f)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: 'project', projectId: f.projectId, title: 'Reopen', path: f.root })
  for (const id of ['first', 'second']) {
    await f.host.execute({ type: 'create-thread', commandId: `create-${id}`, threadId: id, projectId: f.projectId, title: id, modelId: f.modelId })
    await f.adapter.refreshThread(id)
  }
  return f
}
/** The user looks at the other thread while this one's session ends, then comes back to it. */
async function endWhileAway(f: Fixture): Promise<void> {
  f.adapter.observeThreads(['second'])
  await f.action('first', { type: 'exit' })
  await expect.poll(() => live(f, 'first')).toBe(false)
  f.adapter.observeThreads(['first'])
}

it('names the user’s last message on a thread whose window was put away and taken back up', async () => {
  const f = await fixture()
  f.adapter.observeThreads(['first'])
  const sent = randomUUID()
  expect(await f.host.execute({ type: 'send', threadId: 'first', commandId: randomUUID(), messageId: sent, text: 'Plan the trip' })).toMatchObject({ accepted: true })
  await f.driver.completeTurn('first', 'Here is the plan.')
  await expect.poll(async () => (await f.host.snapshot()).threads.find(t => t.id === 'first')!.status).toBe('idle')

  await endWhileAway(f)
  const read = (await f.adapter.refreshThread('first')).threads.find(t => t.id === 'first')!
  expect(read.messages.some(message => message.id === sent)).toBe(false)
  expect(read.lastUserMessageId).toBe(sent)
  expect(await f.host.execute({ type: 'send', threadId: 'first', commandId: randomUUID(), messageId: randomUUID(), text: 'One more stop', expectedLastUserMessageId: read.lastUserMessageId ?? null }))
    .toMatchObject({ accepted: true })
})

it('still refuses a send when the user typed in Claude Code after the thread was read', async () => {
  const f = await fixture()
  f.adapter.observeThreads(['first'])
  expect(await f.host.execute({ type: 'send', threadId: 'first', commandId: randomUUID(), messageId: randomUUID(), text: 'Plan the trip' })).toMatchObject({ accepted: true })
  await f.driver.completeTurn('first', 'Here is the plan.')
  await expect.poll(async () => (await f.host.snapshot()).threads.find(t => t.id === 'first')!.status).toBe('idle')

  await endWhileAway(f)
  const read = (await f.adapter.refreshThread('first')).threads.find(t => t.id === 'first')!
  const prompts = async () => (await f.driver.requests()).filter(record => record.method === 'user').length
  const before = await prompts()
  await f.driver.typeInProvider('first', 'Typed in Claude Code instead')
  await expect(f.host.execute({ type: 'send', threadId: 'first', commandId: randomUUID(), messageId: randomUUID(), text: 'Stale reply', expectedLastUserMessageId: read.lastUserMessageId ?? null }))
    .rejects.toThrow('The latest user message changed')
  expect(await prompts()).toBe(before)
})

it('sends from the composer to a thread whose session ended while another thread was open', async () => {
  const f = await fixture()
  const credentials = new AgentCredentials(f.root, { isEncryptionAvailable: () => false, encryptString: value => Buffer.from(value), decryptString: value => value.toString() })
  await credentials.load()
  const registry = new ThreadRegistry(f.root)
  const control = new AgentControl({ schedule: immediatePublishScheduler, directory: f.root, host: new SottoThreadHost('claude', f.adapter, registry), credentials, reasoner: e2eAgentReasoner,
  })
  cleanups.push(async () => { control.dispose(); await control.privacyChanged(); await f.adapter.closed(); await registry.flush() })
  await control.start(); await control.command({ type: 'connect' })
  const threadId = registry.all().find(binding => binding.sessionId === 'first')!.threadId

  expect((await control.command({ type: 'manual-send', threadId, text: 'Plan the trip' })).error).toBeNull()
  await f.driver.completeTurn('first', 'Here is the plan.')
  await expect.poll(() => control.get().host.threads.find(t => t.id === threadId)!.status).toBe('idle')

  await endWhileAway(f)
  const draftId = randomUUID()
  const result = await control.command({ type: 'manual-send', threadId, text: 'One more stop', draftId })
  expect(result.error).toBeNull()
  expect(result.deliveries?.find(delivery => delivery.draftId === draftId)?.status).toBe('accepted')
})
