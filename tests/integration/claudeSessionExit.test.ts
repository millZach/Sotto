// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { claudeFixture } from '../fixtures/claudeFixture'

// Each Claude thread runs its own CLI, so one of them ending is that thread's problem: the provider stays
// connected, the other threads keep their sessions, and the next message starts this one again.
const fixtures: Awaited<ReturnType<typeof claudeFixture>>[] = []
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup() })
async function fixture() {
  const f = await claudeFixture(undefined, 15_000)
  fixtures.push(f)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: 'project', projectId: f.projectId, title: 'Exit', path: f.root })
  for (const id of ['first', 'second']) {
    await f.host.execute({ type: 'create-thread', commandId: `create-${id}`, threadId: id, projectId: f.projectId, title: id, modelId: f.modelId })
    await f.adapter.refreshThread(id)
  }
  return f
}
type Fixture = Awaited<ReturnType<typeof fixture>>
const thread = async (f: Fixture, id: string) => (await f.host.snapshot()).threads.find(value => value.id === id)!
const send = (f: Fixture, id: string, text: string) => f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: randomUUID(), text })
// The fake's exit action ends the process before it can record its own exit, so `sessions.stopped` never sees it.
const live = (f: Fixture, id: string) => (f.adapter as unknown as { runtimes: Map<string, unknown> }).runtimes.has(id)

it('fails only the reply that was cut short and starts that thread again on its next message', async () => {
  const f = await fixture()
  expect(await send(f, 'first', 'Plan the trip')).toMatchObject({ accepted: true })
  expect(await send(f, 'second', 'Draft the note')).toMatchObject({ accepted: true })
  await expect.poll(async () => (await thread(f, 'first')).status).toBe('running')
  await expect.poll(async () => (await thread(f, 'second')).status).toBe('running')

  await f.action('first', { type: 'exit' })
  await expect.poll(async () => (await thread(f, 'first')).status).toBe('error')
  const snapshot = await f.host.snapshot()
  expect(snapshot.connected).toBe(true)
  expect(snapshot.error).toBeUndefined()
  const cut = await thread(f, 'first')
  expect(cut.lastTurn?.status).toBe('failed')
  expect(cut.activities?.find(row => row.status === 'failed')?.error).toContain('Send a message to carry on')
  expect((await thread(f, 'second')).status).toBe('running')

  // The other thread's reply was never interrupted.
  await f.driver.completeTurn('second', 'Here is the note.')
  await expect.poll(async () => (await thread(f, 'second')).messages.at(-1)?.text).toBe('Here is the note.')
  expect(await f.sessions!.starts('second')).toBe(1)

  expect(await send(f, 'first', 'Try again')).toMatchObject({ accepted: true })
  expect(await f.sessions!.starts('first')).toBe(2)
  await f.driver.completeTurn('first', 'Here is the plan.')
  await expect.poll(async () => (await thread(f, 'first')).messages.at(-1)?.text).toBe('Here is the plan.')
  expect((await thread(f, 'first')).status).toBe('idle')
})

it('says nothing when an idle thread’s session ends, and starts it again on the next message', async () => {
  const f = await fixture()
  expect(await send(f, 'first', 'Plan the trip')).toMatchObject({ accepted: true })
  await f.driver.completeTurn('first', 'Here is the plan.')
  await expect.poll(async () => (await thread(f, 'first')).status).toBe('idle')
  const before = (await thread(f, 'first')).activities

  await f.action('first', { type: 'exit' })
  await expect.poll(() => live(f, 'first')).toBe(false)
  expect((await f.host.snapshot()).connected).toBe(true)
  expect(await thread(f, 'first')).toMatchObject({ status: 'idle', lastTurn: { status: 'completed' } })
  expect((await thread(f, 'first')).activities).toEqual(before)
  expect(live(f, 'second')).toBe(true)

  expect(await send(f, 'first', 'One more stop')).toMatchObject({ accepted: true })
  expect(await f.sessions!.starts('first')).toBe(2)
})
