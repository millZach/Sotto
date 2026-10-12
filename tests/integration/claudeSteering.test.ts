// @vitest-environment node
// Steering a Claude turn. Claude Code queues a prompt sent while a turn runs and says so at once. Sent now, as every
// steer is, it cuts the turn and runs as the next (ADR-0075). A CLI that reads it into the turn at its next model step
// instead keeps it in that turn; one the turn ends before reading, a stop included, starts the next turn.
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

/** A running turn. `script` is the fake CLI's: by default it cuts the turn for a steer sent now, as 2.1.296 does. */
async function running(script: { steering: true | 'queue'; cutAfterTools?: true } = { steering: true }): Promise<Fixture> {
  const f = await claudeFixture(undefined, 15_000)
  fixtures.push(f)
  await writeFile(join(f.root, 'script.json'), JSON.stringify(script))
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: 'project', projectId: f.projectId, title: 'Steering', path: f.root })
  await f.host.execute({ type: 'create-thread', commandId: 'create', threadId: 'thread', projectId: f.projectId, title: 'Steer', modelId: f.modelId })
  await f.host.execute({ type: 'send', commandId: 'send', messageId: 'first', threadId: 'thread', text: 'First' })
  return f
}
/** A Claude Code that reads a steer into the running turn at its next model step, as 2.1.295 did. */
const readingAtNextStep = () => running({ steering: 'queue' })
const thread = async (f: Fixture) => (await f.host.snapshot()).threads.find(candidate => candidate.id === 'thread')!
const users = async (f: Fixture) => (await thread(f)).messages.filter(message => message.role === 'user').map(message => message.text)
const turnRecords = async (f: Fixture) => (await thread(f)).activities?.filter(activity => activity.kind === 'turn') ?? []
const turns = async (f: Fixture) => (await turnRecords(f)).map(activity => activity.status)
const steered = async (f: Fixture) => (await turnRecords(f)).map(activity => activity.steered === true)
const steer = (f: Fixture, text: string) => f.host.execute({ type: 'steer', commandId: randomUUID(), messageId: randomUUID(), threadId: 'thread', text })

it('offers steering for Claude threads', async () => {
  const f = await running()
  expect((await f.host.snapshot()).capabilities.steer).toBe(true)
})

it.each([
  ['mid-reply', { steering: true }],
  ['after a command', { steering: true, cutAfterTools: true }],
] as const)('cuts the turn for a steer %s, and the steer runs as the next turn', async (_, script) => {
  const f = await running(script)
  expect(await steer(f, 'Also this')).toEqual({ accepted: true })
  await expect.poll(() => turns(f)).toEqual(['interrupted', 'running'])
  // The cut turn reads as steered, not stopped or failed, and the thread goes straight on to the steer.
  expect(await steered(f)).toEqual([true, false])
  expect((await thread(f)).status).toBe('running')
  expect((await f.host.snapshot()).error).toBeUndefined()
  expect(await users(f)).toEqual(['First', 'Also this'])
  await f.driver.completeTurn('thread', 'Done')
  await expect.poll(async () => (await thread(f)).status).toBe('idle')
  expect(await turns(f)).toEqual(['interrupted', 'completed'])
})

it('cuts a turn mid-thought, and the reply Claude was thinking toward never lands', async () => {
  const f = await running()
  await f.action('thread', { type: 'complete', text: 'The essay', thinking: 'Planning a long essay', holdInThinking: 'thinking-released' })
  await expect.poll(async () => (await thread(f)).activities?.some(activity => activity.kind === 'reasoning' && activity.status === 'running')).toBe(true)
  await steer(f, 'Stop and answer this')
  await expect.poll(() => turns(f)).toEqual(['interrupted', 'running'])
  // The cut step's thinking settles with its turn rather than reading as still running.
  expect((await thread(f)).activities?.filter(activity => activity.kind === 'reasoning').map(activity => activity.status)).toEqual(['interrupted'])
  await writeFile(join(f.root, 'thinking-released'), '')
  await f.driver.completeTurn('thread', 'Answered')
  await expect.poll(async () => (await thread(f)).status).toBe('idle')
  expect(await turns(f)).toEqual(['interrupted', 'completed'])
  expect((await thread(f)).messages.filter(message => message.role === 'assistant').map(message => message.text)).toEqual(['Answered'])
})

it('lets a running tool call return, then reads the steer into the same turn', async () => {
  const f = await running()
  await f.action('thread', { type: 'raw', persist: true, frame: { type: 'assistant', uuid: randomUUID(), parent_tool_use_id: null,
    message: { id: randomUUID(), role: 'assistant', content: [{ type: 'tool_use', id: 'tool', name: 'Bash', input: { command: 'npm test' } }] } } })
  await expect.poll(async () => (await thread(f)).activities?.some(activity => activity.kind === 'command' && activity.status === 'running')).toBe(true)
  // Sent now, the steer would cut the turn here, as the fake CLI does; while the call runs it goes as a plain prompt.
  expect(await steer(f, 'Also this')).toEqual({ accepted: true })
  expect(await turns(f)).toEqual(['running'])
  await f.action('thread', { type: 'raw', persist: true, frame: { type: 'user', uuid: randomUUID(), parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'ok' }] } } })
  await f.action('thread', { type: 'say', text: 'Reading it' })
  await f.driver.completeTurn('thread', 'Done')
  await expect.poll(async () => (await thread(f)).status).toBe('idle')
  expect(await turns(f)).toEqual(['completed'])
  expect(await users(f)).toEqual(['First', 'Also this'])
})

it('cuts the next step for a steer once the tool call it waited on has returned', async () => {
  const f = await running()
  await f.action('thread', { type: 'raw', persist: true, frame: { type: 'assistant', uuid: randomUUID(), parent_tool_use_id: null,
    message: { id: randomUUID(), role: 'assistant', content: [{ type: 'tool_use', id: 'tool', name: 'Bash', input: { command: 'npm test' } }] } } })
  await f.action('thread', { type: 'raw', persist: true, frame: { type: 'user', uuid: randomUUID(), parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'ok' }] } } })
  await expect.poll(async () => (await thread(f)).activities?.some(activity => activity.kind === 'command' && activity.status === 'completed')).toBe(true)
  await steer(f, 'Also this')
  await expect.poll(() => turns(f)).toEqual(['interrupted', 'running'])
  expect(await steered(f)).toEqual([true, false])
})

it('stops the turn a steer started as stopped, not steered', async () => {
  const f = await running()
  await steer(f, 'Also this')
  await expect.poll(() => turns(f)).toEqual(['interrupted', 'running'])
  await f.host.execute({ type: 'interrupt', commandId: 'stop', threadId: 'thread' })
  await expect.poll(async () => (await thread(f)).status).toBe('idle')
  expect(await turns(f)).toEqual(['interrupted', 'interrupted'])
  expect(await steered(f)).toEqual([true, false])
})

it('reads a steer into the running turn, which ends once', async () => {
  const f = await readingAtNextStep()
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
  const f = await readingAtNextStep()
  await steer(f, 'After that')
  await f.driver.completeTurn('thread', 'Done first')
  await expect.poll(() => turns(f)).toEqual(['completed', 'running'])
  // A turn that finished as the steer came was not cut for it.
  expect(await steered(f)).toEqual([false, false])
  expect((await thread(f)).status).toBe('running')
  await f.driver.completeTurn('thread', 'Done second')
  await expect.poll(() => turns(f)).toEqual(['completed', 'completed'])
  expect((await thread(f)).status).toBe('idle')
})

it('runs a steer Claude had not read after a stop, as Claude Code does', async () => {
  const f = await readingAtNextStep()
  await steer(f, 'Still wanted')
  await f.host.execute({ type: 'interrupt', commandId: 'stop', threadId: 'thread' })
  await expect.poll(() => turns(f)).toEqual(['interrupted', 'running'])
  expect(await steered(f)).toEqual([false, false])
  await f.driver.completeTurn('thread', 'Done')
  await expect.poll(async () => (await thread(f)).status).toBe('idle')
  expect(await users(f)).toEqual(['First', 'Still wanted'])
})

it('stops a turn a steer was read into as that one turn', async () => {
  const f = await readingAtNextStep()
  await steer(f, 'Also this')
  await f.action('thread', { type: 'say', text: 'Reading it' })
  await expect.poll(async () => (await thread(f)).messages.some(message => message.text === 'Reading it')).toBe(true)
  await f.host.execute({ type: 'interrupt', commandId: 'stop', threadId: 'thread' })
  await expect.poll(async () => (await thread(f)).status).toBe('idle')
  expect(await turns(f)).toEqual(['interrupted'])
})

it('forgets a steer the CLI held when Sotto lets the CLI go, so a later turn still ends', async () => {
  const f = await readingAtNextStep()
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

it('steers a queued follow-up, which runs at once', async () => {
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
    await expect.poll(() => turns(f)).toEqual(['interrupted', 'running'])
    await f.action('thread', { type: 'say', text: 'Reading it' })
    await f.driver.completeTurn('thread', 'Done')
    await expect.poll(() => control.get().host.threads[0]?.status).toBe('idle')
  } finally { control.dispose(); await control.privacyChanged() }
})
