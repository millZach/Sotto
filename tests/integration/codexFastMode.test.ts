// @vitest-environment node
// Fast mode on a Codex thread (ADR-0143): Codex's `priority` service tier, offered where `model/list` lists it, set on
// `thread/start`, `thread/resume` and `thread/settings/update`, and kept as the thread's choice through a model without it.
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'

import { codexFixture } from '../fixtures/codexFixture'

type Fixture = Awaited<ReturnType<typeof codexFixture>>
const fixtures: Fixture[] = []
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup() })
const efforts = { defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }
const models = [
  { id: 'fast', model: 'fixture-model', displayName: 'Fixture Codex', isDefault: true, ...efforts,
    serviceTiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' }] },
  { id: 'plain', model: 'fixture-plain', displayName: 'Fixture Codex Plain', ...efforts },
]

async function fixture(script: Record<string, unknown> = {}): Promise<Fixture> {
  const f = await codexFixture()
  fixtures.push(f)
  await f.script({ models, ...script })
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Fast', path: f.root })
  return f
}
async function created(f: Fixture, options: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: 'Fast', modelId: 'fixture-model', ...options })
  return id
}
const thread = async (f: Fixture, id: string) => (await f.host.snapshot()).threads.find(value => value.id === id)!
const params = async (f: Fixture, method: string) => (await f.driver.requests()).filter(record => record.method === method).map(record => record.params ?? {})
const configure = (f: Fixture, id: string, options: Record<string, unknown>) => f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, ...options })

it('reads which models offer fast mode from their service tiers, with Codex\'s own line about the cost', async () => {
  const f = await fixture()
  const snapshot = await f.host.snapshot()
  expect(snapshot.models.find(model => model.id === 'fixture-model')?.fastMode).toEqual({ description: '1.5x speed, increased usage' })
  expect(snapshot.models.find(model => model.id === 'fixture-plain')?.fastMode).toBeUndefined()
})

it('starts a new thread at the standard tier, even on a model whose own default is Fast', async () => {
  const f = await fixture({ defaultServiceTier: 'priority' })
  const id = await created(f)
  expect((await params(f, 'thread/start')).at(-1)).toMatchObject({ serviceTier: 'default' })
  expect((await thread(f, id)).fastMode).toBeUndefined()
  // A model without fast mode is left to Codex.
  await created(f, { modelId: 'fixture-plain' })
  expect((await params(f, 'thread/start')).at(-1)).not.toHaveProperty('serviceTier')
})

it('creates a thread on the Fast tier when its first send carries fast mode', async () => {
  const f = await fixture()
  const id = await created(f, { fastMode: true })
  expect((await params(f, 'thread/start')).at(-1)).toMatchObject({ serviceTier: 'priority' })
  expect((await thread(f, id)).fastMode).toBe(true)
})

it('turns fast mode on with a settings update, and resumes on the Fast tier after a restart', async () => {
  const f = await fixture()
  const id = await created(f)
  const result = await configure(f, id, { fastMode: true })
  expect(result.accepted).toBe(true)
  expect(result.snapshot?.threads.find(value => value.id === id)?.fastMode).toBe(true)
  expect((await params(f, 'thread/settings/update')).at(-1)).toMatchObject({ model: 'fixture-model', serviceTier: 'priority' })

  const next = await f.driver.restart() as Fixture
  fixtures.splice(fixtures.indexOf(f), 1, next)
  await next.host.connect()
  expect((await thread(next, id)).fastMode).toBe(true)
  await next.adapter.refreshThread(id)
  expect((await params(next, 'thread/resume')).at(-1)).toMatchObject({ serviceTier: 'priority' })

  expect((await configure(next, id, { fastMode: false })).accepted).toBe(true)
  expect((await params(next, 'thread/settings/update')).at(-1)).toMatchObject({ serviceTier: 'default' })
  expect((await thread(next, id)).fastMode).toBeUndefined()
})

it('keeps the choice through a model without fast mode, at the standard tier, and takes it up again on the way back', async () => {
  const f = await fixture()
  const id = await created(f)
  expect((await configure(f, id, { fastMode: true })).accepted).toBe(true)
  expect((await configure(f, id, { modelId: 'fixture-plain' })).accepted).toBe(true)
  expect((await params(f, 'thread/settings/update')).at(-1)).toMatchObject({ model: 'fixture-plain', serviceTier: 'default' })
  expect(await thread(f, id)).toMatchObject({ modelId: 'fixture-plain', fastMode: true })
  expect((await configure(f, id, { modelId: 'fixture-model' })).accepted).toBe(true)
  expect((await params(f, 'thread/settings/update')).at(-1)).toMatchObject({ model: 'fixture-model', serviceTier: 'priority' })
  expect(await thread(f, id)).toMatchObject({ modelId: 'fixture-model', fastMode: true })
})

it('refuses to turn fast mode on for a model without it, and sends nothing', async () => {
  const f = await fixture()
  const id = await created(f, { modelId: 'fixture-plain' })
  const before = (await params(f, 'thread/settings/update')).length
  await expect(configure(f, id, { fastMode: true })).rejects.toThrow('This model does not offer fast mode.')
  expect((await params(f, 'thread/settings/update')).length).toBe(before)
})

/** A thread with one finished turn, to fork at its reply. */
async function withReply(f: Fixture, options: Record<string, unknown> = {}): Promise<{ id: string; reply: string }> {
  const id = await created(f, options)
  await f.script({ models, reply: 'An answer' })
  await f.host.execute({ type: 'send', commandId: randomUUID(), threadId: id, messageId: randomUUID(), text: 'A question' })
  await expect.poll(async () => (await thread(f, id)).status).toBe('idle')
  const read = (await f.host.refreshThread!(id)).threads.find(value => value.id === id)!
  return { id, reply: read.messages.find(message => message.text === 'An answer')!.id }
}

it('forks a fast thread at the standard tier, since a copy is a new thread', async () => {
  const f = await fixture()
  const { id, reply } = await withReply(f, { fastMode: true })
  expect((await thread(f, id)).fastMode).toBe(true)
  expect(await f.adapter.forkThread({ commandId: randomUUID(), threadId: 'fork', title: 'Fork', modelId: 'fixture-model', source: { threadId: id, messageId: reply } })).toEqual({ accepted: true })
  expect((await params(f, 'thread/fork')).at(-1)).toMatchObject({ serviceTier: 'default' })
  expect((await thread(f, 'fork')).fastMode).toBeUndefined()
})

it('shows fast mode only once Codex reports the Fast tier: a lost confirmation waits for a read, another tier never settles', async () => {
  const f = await codexFixture(undefined, false, 600)
  fixtures.push(f)
  await f.script({ models })
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Fast', path: f.root })
  const id = await created(f)
  await f.script({ models, dropSettingsNotification: true })
  expect(await configure(f, id, { fastMode: true })).toEqual({ accepted: false, uncertain: true })
  // Codex took it and never said so; the next read finds the thread on Fast, which is what settles it.
  await f.adapter.refreshThread(id)
  expect((await thread(f, id)).fastMode).toBe(true)

  const other = await created(f)
  await f.script({ models, serviceTierReported: 'default' })
  expect(await configure(f, other, { fastMode: true })).toEqual({ accepted: false, uncertain: true })
  await f.adapter.refreshThread(other)
  expect((await thread(f, other)).fastMode).toBeUndefined()
})

it('names no tier on a change to a thread on a model without Fast', async () => {
  const f = await fixture()
  const id = await created(f, { modelId: 'fixture-plain' })
  expect((await configure(f, id, { reasoningEffort: 'high' })).accepted).toBe(true)
  expect((await params(f, 'thread/settings/update')).at(-1)).not.toHaveProperty('serviceTier')
  // A model change between two models without Fast names none either.
  await created(f)
  expect((await configure(f, id, { modelId: 'fixture-plain', reasoningEffort: 'low' })).accepted).toBe(true)
  expect((await params(f, 'thread/settings/update')).at(-1)).not.toHaveProperty('serviceTier')
})

it('starts and forks a thread on a model without Fast whatever tier Codex reports, having asked for none', async () => {
  // A user's own `service_tier` can make Codex answer Fast where Sotto named no tier.
  const f = await fixture({ defaultServiceTier: 'priority' })
  const { id, reply } = await withReply(f, { modelId: 'fixture-plain' })
  expect((await params(f, 'thread/start')).at(-1)).not.toHaveProperty('serviceTier')
  expect((await thread(f, id)).fastMode).toBeUndefined()
  expect(await f.adapter.forkThread({ commandId: randomUUID(), threadId: 'fork', title: 'Fork', modelId: 'fixture-plain', source: { threadId: id, messageId: reply } })).toEqual({ accepted: true })
  expect((await params(f, 'thread/fork')).at(-1)).not.toHaveProperty('serviceTier')
})
