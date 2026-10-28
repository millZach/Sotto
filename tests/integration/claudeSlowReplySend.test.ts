// @vitest-environment node
// A Claude send whose reply is slow to begin (#1511). Claude Code says at once that it took a prompt and started its
// turn, but echoes the prompt only as the model's reply begins. The first reply after a restart can take longer to begin
// than the acknowledgement waits, so the send has to be confirmed by the start, not by the echo. The fake CLI holds the
// echo until the reply, as Claude Code 2.1.312 does, and the reply comes only once the send has returned.
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { claudeFixture } from '../fixtures/claudeFixture'
import { RESUME_NOTE } from '../../src/shared/restartResume'

type Fixture = Awaited<ReturnType<typeof claudeFixture>>
const fixtures: Fixture[] = []
afterEach(async () => { for (const f of fixtures.splice(0).reverse()) await f.cleanup() })

const thread = async (f: Fixture) => (await f.host.snapshot()).threads.find(candidate => candidate.id === 'thread')!
const users = async (f: Fixture) => (await thread(f)).messages.filter(message => message.role === 'user').map(({ id, text }) => ({ id, text }))
const live = (f: Fixture) => (f.adapter as unknown as { runtimes: Map<string, unknown> }).runtimes.has('thread')

/** A thread with one finished turn. */
async function answered(): Promise<Fixture> {
  const f = await claudeFixture(); fixtures.push(f)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: 'project', projectId: f.projectId, title: 'Slow reply', path: f.root })
  await f.host.execute({ type: 'create-thread', commandId: 'create', threadId: 'thread', projectId: f.projectId, title: 'Slow reply', modelId: f.modelId })
  expect(await f.host.execute({ type: 'send', commandId: 'first', messageId: 'first', threadId: 'thread', text: 'Run the tests' })).toEqual({ accepted: true })
  return f
}
/** Sotto closed while one of the thread's tool calls ran, then started again: the thread's CLI resumes its session. */
async function restartedMidToolCall(): Promise<Fixture> {
  const f = await answered()
  await f.action('thread', { type: 'raw', persist: true, frame: { type: 'assistant', uuid: randomUUID(), parent_tool_use_id: null,
    message: { id: randomUUID(), role: 'assistant', content: [{ type: 'tool_use', id: 'tool', name: 'Bash', input: { command: 'npm test' } }] } } })
  await f.action('thread', { type: 'exit' })
  await expect.poll(() => live(f)).toBe(false)
  f.host.disconnect(); await f.adapter.closed()
  const restarted = await claudeFixture(f.root); fixtures.push(restarted)
  await restarted.host.connect()
  return restarted
}
async function idle(): Promise<Fixture> {
  const f = await answered()
  await f.driver.completeTurn('thread', 'All green.')
  await expect.poll(async () => (await thread(f)).status).toBe('idle')
  return f
}

it.each([
  { when: 'after a restart that cut a tool call', start: restartedMidToolCall, text: RESUME_NOTE },
  { when: 'between turns', start: idle, text: 'Now the lint' },
])('confirms a send $when once Claude Code starts it, though its echo waits for the reply', async ({ start, text }) => {
  const f = await start()
  await writeFile(join(f.root, 'script.json'), JSON.stringify({ echoAtReply: true, interruptedOnResume: true }))
  expect(await f.host.execute({ type: 'send', commandId: 'sent', messageId: 'sent', threadId: 'thread', text })).toEqual({ accepted: true })
  // Shown from Claude Code's word that the prompt's turn started, before Claude has said anything.
  expect((await thread(f)).status).toBe('running')
  expect((await users(f)).at(-1)).toEqual({ id: 'sent', text })

  await f.driver.completeTurn('thread', 'Carrying on.')
  await expect.poll(async () => (await thread(f)).status).toBe('idle')
  // The echo that came with the reply is the same message, not a second one, and the reply follows it.
  expect(await users(f)).toEqual([{ id: 'first', text: 'Run the tests' }, { id: 'sent', text }])
  expect((await thread(f)).messages.at(-1)).toMatchObject({ role: 'assistant', text: 'Carrying on.' })
  // Nothing holds the next send behind an unconfirmed one.
  expect(await f.host.execute({ type: 'send', commandId: 'next', messageId: 'next', threadId: 'thread', text: 'Thanks' })).toEqual({ accepted: true })
})
