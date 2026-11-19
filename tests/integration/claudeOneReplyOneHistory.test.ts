// @vitest-environment node
// One Claude reply gives one history (#2698). Claude Code reports a reply up to three times: its stream opens the reply at
// the moment Sotto hears it, then the finished message comes on the CLI's output and as a line of its transcript, both
// dated by the CLI. Which of the last two Sotto hears first depended on timing, and when the CLI's date fell in another
// millisecond from the stream's, the history gained a message-replaced event that repeated the words. Here the CLI's
// date is a fixed instant long past, so the two dates always differ, and each order is scripted rather than left to timing.
// The thread's monitoring was the same kind of difference: every CLI frame wrote an empty list and a stop removed it.
import { randomUUID } from 'node:crypto'
import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { AgentHostSnapshot } from '../../src/shared/agents'
import type { ThreadEvent } from '../../src/shared/threadEvents'
import { claudeFixture } from '../fixtures/claudeFixture'

type Fixture = Awaited<ReturnType<typeof claudeFixture>>
const fixtures: Fixture[] = []
afterEach(async () => { for (const f of fixtures.splice(0).reverse()) await f.cleanup() })

/** The instant the CLI dates the finished reply with: never the moment Sotto hears the stream open it. */
const DATED = '2026-01-02T03:04:05.678Z'

/** A thread whose prompt Claude Code took, with every event and published snapshot kept. No timer reads its transcript. */
async function working() {
  const f = await claudeFixture(undefined, 15_000, undefined, { pollIntervalMs: 3_600_000 }); fixtures.push(f)
  const events: ThreadEvent[] = []
  let latest: AgentHostSnapshot | undefined
  f.adapter.subscribeEvents(({ threadId, event }) => { if (threadId === 'thread') events.push(event) })
  f.adapter.subscribe(snapshot => { latest = snapshot })
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: 'project', projectId: f.projectId, title: 'One reply', path: f.root })
  await f.host.execute({ type: 'create-thread', commandId: 'create', threadId: 'thread', projectId: f.projectId, title: 'One reply', modelId: f.modelId })
  expect(await f.host.execute({ type: 'send', commandId: 'prompt', messageId: 'prompt', threadId: 'thread', text: 'Say hello' })).toEqual({ accepted: true })
  const session = await f.realId('thread')
  const published = () => latest?.threads.find(thread => thread.id === 'thread')
  return { f, events, session, published }
}

/** The reply's lines: its stream, the finished message as the CLI prints and saves it, and the turn's result. */
function reply(session: string, text: string) {
  const id = randomUUID()
  const finished = { type: 'assistant', uuid: randomUUID(), session_id: session, timestamp: DATED, message: { id, role: 'assistant', content: [{ type: 'text', text }] } }
  return {
    id,
    stream: [
      { type: 'stream_event', session_id: session, event: { type: 'message_start', message: { id, role: 'assistant' } } },
      { type: 'stream_event', session_id: session, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } },
    ],
    finished,
    line: JSON.stringify({ ...finished, parentUuid: null, isSidechain: false, sessionId: session }) + '\n',
    result: { type: 'result', subtype: 'success', session_id: session, is_error: false, result: text },
  }
}

/** Appends a line to the thread's transcript, where the fake CLI saves it, without the CLI printing it. */
async function save(f: Fixture, session: string, line: string): Promise<void> {
  const cwd = (await f.host.snapshot()).threads.find(thread => thread.id === 'thread')!.workingDirectory!
  await appendFile(join(f.root, 'home', 'projects', cwd.replace(/[^a-zA-Z0-9]/gu, '-'), `${session}.jsonl`), line)
}

const orders = [
  {
    order: 'the CLI prints the finished reply before Sotto reads it from the transcript',
    finish: async ({ f, session, published }: Awaited<ReturnType<typeof working>>, said: ReturnType<typeof reply>) => {
      await f.action('thread', { type: 'raw-burst', frames: [said.finished, said.result] })
      await expect.poll(() => published()?.status).toBe('idle')
      await save(f, session, said.line)
      await f.adapter.pollSessionLogs()
    },
  },
  {
    order: 'Sotto reads the finished reply from the transcript before the CLI prints it',
    finish: async ({ f, session, published }: Awaited<ReturnType<typeof working>>, said: ReturnType<typeof reply>) => {
      await save(f, session, said.line)
      await f.adapter.pollSessionLogs()
      await f.action('thread', { type: 'raw-burst', frames: [said.finished, said.result] })
      await expect.poll(() => published()?.status).toBe('idle')
    },
  },
]

it.each(orders)('records a streamed reply once when $order', async ({ finish }) => {
  const running = await working()
  const { f, events, session } = running
  const said = reply(session, 'Hello from the referee.')
  await f.action('thread', { type: 'raw-burst', frames: said.stream })
  await expect.poll(() => events.some(event => event.kind === 'message-added' && event.message.id === said.id)).toBe(true)
  const opened = events.find(event => event.kind === 'message-added' && event.message.id === said.id)
  await finish(running, said)

  const about = events.filter(event => (event.kind === 'message-added' || event.kind === 'message-replaced') && event.message.id === said.id
    || event.kind === 'message-text-appended' && event.messageId === said.id)
  expect(about.map(event => event.kind)).toEqual(['message-added'])
  // The record keeps the time the reply was first recorded with, which is what the history said of it.
  const message = (await f.host.snapshot()).threads.find(thread => thread.id === 'thread')!.messages.find(value => value.id === said.id)
  expect(message).toMatchObject({ text: 'Hello from the referee.', createdAt: opened?.kind === 'message-added' ? opened.message.createdAt : 'missing' })
  expect(events.filter(event => event.kind === 'message-replaced')).toEqual([])
})

it('carries no monitoring on a thread with nothing watched, through a turn and a stop whose result comes after it', async () => {
  const { f, session, published } = await working()
  await f.driver.completeTurn('thread', 'First reply.')
  await expect.poll(() => published()?.status).toBe('idle')
  expect(published()).not.toHaveProperty('monitoring')
  expect((await f.host.snapshot()).threads.find(thread => thread.id === 'thread')).not.toHaveProperty('monitoring')

  // The stop is answered at once; the stopped turn's result is held, and comes on the CLI's output after the answer.
  await writeFile(join(f.root, 'interrupt-script.json'), JSON.stringify({ holdResult: 'never-released' }))
  expect(await f.host.execute({ type: 'send', commandId: 'second', messageId: 'second', threadId: 'thread', text: 'Keep going' })).toEqual({ accepted: true })
  expect(await f.host.execute({ type: 'interrupt', commandId: 'stop', threadId: 'thread' })).toEqual({ accepted: true })
  const after = reply(session, 'Said after the stop.')
  await f.action('thread', { type: 'raw-burst', frames: [{ type: 'result', subtype: 'success', session_id: session, is_error: false, result: '' }, after.finished] })
  await expect.poll(() => published()?.messages.some(message => message.id === after.id) ?? false).toBe(true)
  expect(published()).not.toHaveProperty('monitoring')
})
