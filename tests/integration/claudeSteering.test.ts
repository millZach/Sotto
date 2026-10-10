// @vitest-environment node
// Steering a Claude turn. Claude Code queues a prompt sent while a turn runs, says so at once, and reads it into the
// turn at its next model step; one the turn ends before reading, a stop included, starts the next turn.
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createAgentControl } from '../fixtures/agentControlFixture'
import { claudeFixture } from '../fixtures/claudeFixture'
import { immediatePublishScheduler } from '../fixtures/publishScheduler'
import { testCredentials } from '../fixtures/testCredentials'

type Fixture = Awaited<ReturnType<typeof claudeFixture>>
const fixtures: Fixture[] = []
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup() })

async function running(): Promise<Fixture> {
  const f = await claudeFixture(undefined, 15_000)
  fixtures.push(f)
  await writeFile(join(f.root, 'script.json'), JSON.stringify({ steering: true }))
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: 'project', projectId: f.projectId, title: 'Steering', path: f.root })
  await f.host.execute({ type: 'create-thread', commandId: 'create', threadId: 'thread', projectId: f.projectId, title: 'Steer', modelId: f.modelId })
  await f.host.execute({ type: 'send', commandId: 'send', messageId: 'first', threadId: 'thread', text: 'First' })
  return f
}
const thread = async (f: Fixture) => (await f.host.snapshot()).threads.find(candidate => candidate.id === 'thread')!
const users = async (f: Fixture) => (await thread(f)).messages.filter(message => message.role === 'user').map(message => message.text)
const turns = async (f: Fixture) => (await thread(f)).activities?.filter(activity => activity.kind === 'turn').map(activity => activity.status)
const steer = (f: Fixture, text: string) => f.host.execute({ type: 'steer', commandId: randomUUID(), messageId: randomUUID(), threadId: 'thread', text })

it('offers steering for Claude threads', async () => {
  const f = await running()
  expect((await f.host.snapshot()).capabilities.steer).toBe(true)
})

it('reads a steer into the running turn, which ends once', async () => {
  const f = await running()
  expect(await steer(f, 'Also this')).toEqual({ accepted: true })
  // Shown from Claude Code's word that it holds the steer, before Claude has read it.
  expect(await users(f)).toEqual(['First', 'Also this'])
  await f.action('thread', { type: 'say', text: 'Reading it' })
  await f.driver.completeTurn('thread', 'Done')
  await expect.poll(async () => (await thread(f)).status).toBe('idle')
  expect(await users(f)).toEqual(['First', 'Also this'])
  expect(await turns(f)).toEqual(['completed'])
})

it('starts the next turn with a steer the turn ended before reading', async () => {
  const f = await running()
  await steer(f, 'After that')
  await f.driver.completeTurn('thread', 'Done first')
  await expect.poll(() => turns(f)).toEqual(['completed', 'running'])
  expect((await thread(f)).status).toBe('running')
  await f.driver.completeTurn('thread', 'Done second')
  await expect.poll(() => turns(f)).toEqual(['completed', 'completed'])
  expect((await thread(f)).status).toBe('idle')
})

it('runs a steer Claude had not read after a stop, as Claude Code does', async () => {
  const f = await running()
  await steer(f, 'Still wanted')
  await f.host.execute({ type: 'interrupt', commandId: 'stop', threadId: 'thread' })
  await expect.poll(() => turns(f)).toEqual(['interrupted', 'running'])
  await f.driver.completeTurn('thread', 'Done')
  await expect.poll(async () => (await thread(f)).status).toBe('idle')
  expect(await users(f)).toEqual(['First', 'Still wanted'])
})

it('stops a turn a steer was read into as that one turn', async () => {
  const f = await running()
  await steer(f, 'Also this')
  await f.action('thread', { type: 'say', text: 'Reading it' })
  await expect.poll(async () => (await thread(f)).messages.some(message => message.text === 'Reading it')).toBe(true)
  await f.host.execute({ type: 'interrupt', commandId: 'stop', threadId: 'thread' })
  await expect.poll(async () => (await thread(f)).status).toBe('idle')
  expect(await turns(f)).toEqual(['interrupted'])
})

it('forgets a steer the CLI held when Sotto lets the CLI go, so a later turn still ends', async () => {
  const f = await running()
  await steer(f, 'Never read')
  f.adapter.disconnect(); await f.adapter.closed()
  await f.host.connect()
  await f.host.execute({ type: 'send', commandId: 'next', messageId: 'next', threadId: 'thread', text: 'Next' })
  await f.driver.completeTurn('thread', 'Done')
  await expect.poll(async () => (await thread(f)).status).toBe('idle')
})

it('refuses to steer a thread with no running turn', async () => {
  const f = await running()
  await f.driver.completeTurn('thread', 'Done')
  await expect.poll(async () => (await thread(f)).status).toBe('idle')
  await expect(steer(f, 'Too late')).rejects.toThrow(/turn ended before steering/)
})

it('steers a queued follow-up into the running turn', async () => {
  const f = await running()
  const credentials = await testCredentials(f.root, { mode: 'unavailable' })
  const control = createAgentControl({ schedule: immediatePublishScheduler, directory: f.root, host: f.host, credentials })
  try {
    await control.start()
    await control.command({ type: 'refresh' })
    const queued = await control.command({ type: 'manual-send', threadId: 'thread', draftId: randomUUID(), text: 'Steer me' })
    const item = queued.followups![0]!
    await control.command({ type: 'steer-followup', threadId: 'thread', itemId: item.id })
    await expect.poll(() => control.get().followups?.length).toBe(0)
    expect(control.get().host.threads[0]?.messages.filter(m => m.role === 'user').map(m => m.text)).toEqual(['First', 'Steer me'])
    await f.action('thread', { type: 'say', text: 'Reading it' })
    await f.driver.completeTurn('thread', 'Done')
    await expect.poll(() => control.get().host.threads[0]?.status).toBe('idle')
  } finally { control.dispose(); await control.privacyChanged() }
})
