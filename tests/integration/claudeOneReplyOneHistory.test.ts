// @vitest-environment node
// One Claude reply gives one history (#2698). Claude Code reports a reply up to three times: its stream opens the reply at
// the moment Sotto hears it, then the finished message comes on the CLI's output and as a line of its transcript, both
// dated by the CLI. When the CLI's date fell in another millisecond from the stream's, the history gained a
// message-replaced event that repeated the words. A reply keeps the time it was first recorded with, the time it began
// (Zach's pick, November 19, 2026). Here the CLI's date is a fixed instant long past, so the two dates always differ, and
// each order is scripted rather than left to timing. The thread's monitoring was the same kind of difference: every CLI
// frame wrote an empty list when no monitoring task ran, and a stop removed it.
import { randomUUID } from 'node:crypto'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { AgentHostSnapshot } from '../../src/shared/agents'
import type { ThreadEvent } from '../../src/shared/threadEvents'
import { claudeFixture, claudeTranscriptPath } from '../fixtures/claudeFixture'

type Fixture = Awaited<ReturnType<typeof claudeFixture>>
const fixtures: Fixture[] = []
afterEach(async () => { for (const f of fixtures.splice(0).reverse()) await f.cleanup() })

/** The instant the CLI dates a finished reply with: never the moment Sotto hears the stream open it. */
const DATED = '2026-01-02T03:04:05.678Z'

/** Every event the adapter writes for the thread, kept from the moment the adapter is made. */
function eventsOf(f: Fixture): ThreadEvent[] {
  const events: ThreadEvent[] = []
  f.adapter.subscribeEvents(({ threadId, event }) => { if (threadId === 'thread') events.push(event) })
  return events
}

/** A thread whose first prompt Claude Code took, with its events and published snapshots kept. No timer reads its transcript. */
async function threadWithPrompt() {
  const f = await claudeFixture(undefined, 15_000, undefined, { pollIntervalMs: 3_600_000 }); fixtures.push(f)
  const events = eventsOf(f)
  let latest: AgentHostSnapshot | undefined
  f.adapter.subscribe(snapshot => { latest = snapshot })
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: 'project', projectId: f.projectId, title: 'One reply', path: f.root })
  await f.host.execute({ type: 'create-thread', commandId: 'create', threadId: 'thread', projectId: f.projectId, title: 'One reply', modelId: f.modelId })
  expect(await f.host.execute({ type: 'send', commandId: 'prompt', messageId: 'prompt', threadId: 'thread', text: 'Say hello' })).toEqual({ accepted: true })
  const session = await f.realId('thread')
  const published = () => latest?.threads.find(thread => thread.id === 'thread')
  /** Appends a line to the thread's transcript, where the fake CLI saves it, without the CLI printing it. */
  const save = (line: string) => appendFile(claudeTranscriptPath(f.root, session), line)
  return { f, events, session, published, save }
}
type Running = Awaited<ReturnType<typeof threadWithPrompt>>

/** A reply's lines: its stream, the finished message as the CLI prints and saves it, and the turn's result. */
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
type Reply = ReturnType<typeof reply>

/** The stream opens the reply; this waits until the record holds it. */
async function stream({ f, events }: Running, said: Reply): Promise<void> {
  await f.action('thread', { type: 'raw-burst', frames: said.stream })
  await expect.poll(() => events.some(event => event.kind === 'message-added' && event.message.id === said.id)).toBe(true)
}
/** The CLI prints the finished reply and the turn's result; this waits until the thread is idle. */
async function print({ f, published }: Running, said: Reply): Promise<void> {
  await f.action('thread', { type: 'raw-burst', frames: [said.finished, said.result] })
  await expect.poll(() => published()?.status).toBe('idle')
}
/** Sotto reads the transcript lines named. */
async function read({ f, save }: Running, ...said: Reply[]): Promise<void> {
  for (const line of said) await save(line.line)
  await f.adapter.pollSessionLogs()
}

/** The kinds of event written about one message, in order. */
const about = (events: readonly ThreadEvent[], messageId: string): string[] => events.filter(event =>
  (event.kind === 'message-added' || event.kind === 'message-replaced') && event.message.id === messageId
  || event.kind === 'message-text-appended' && event.messageId === messageId).map(event => event.kind)

it.each([
  { order: 'the CLI prints the finished reply before Sotto reads it from the transcript', finish: async (running: Running, said: Reply) => { await print(running, said); await read(running, said) } },
  { order: 'Sotto reads the finished reply from the transcript before the CLI prints it', finish: async (running: Running, said: Reply) => { await read(running, said); await print(running, said) } },
])('records a streamed reply once, at the time it began, when $order', async ({ finish }) => {
  const running = await threadWithPrompt()
  const { f, events, session } = running
  const said = reply(session, 'Hello from the referee.')
  await stream(running, said)
  const opened = events.find(event => event.kind === 'message-added' && event.message.id === said.id)
  await finish(running, said)

  expect(about(events, said.id)).toEqual(['message-added'])
  const message = (await f.host.snapshot()).threads.find(thread => thread.id === 'thread')!.messages.find(value => value.id === said.id)
  expect(message).toMatchObject({ text: 'Hello from the referee.', createdAt: opened?.kind === 'message-added' ? opened.message.createdAt : 'missing' })
  expect(message?.createdAt).not.toBe(DATED)
})

it('records nothing more when an earlier reply\'s transcript line is read after the next reply has begun', async () => {
  const running = await threadWithPrompt()
  const { f, events, session } = running
  const first = reply(session, 'The first reply.')
  await stream(running, first)
  await print(running, first)
  expect(await f.host.execute({ type: 'send', commandId: 'again', messageId: 'again', threadId: 'thread', text: 'And again' })).toEqual({ accepted: true })
  const second = reply(session, 'The second reply.')
  await stream(running, second)
  await read(running, first, second)
  await print(running, second)

  expect(about(events, first.id)).toEqual(['message-added'])
  expect(about(events, second.id)).toEqual(['message-added'])
})

it('records nothing more when the transcript is read again from its first byte after a restart', async () => {
  const running = await threadWithPrompt()
  const said = reply(running.session, 'Hello from before the restart.')
  await stream(running, said)
  await print(running, said)
  await read(running, said)
  const before = (await running.f.host.snapshot()).threads.find(thread => thread.id === 'thread')!
  running.f.adapter.disconnect(); await running.f.adapter.closed()

  // A new process's worth of adapter state, given the words the event store holds, with no cursor to resume from.
  const aliases = JSON.parse(await readFile(join(running.f.root, 'claude-threads.json'), 'utf8')) as Record<string, { transcriptCursor?: unknown }>
  delete aliases.thread!.transcriptCursor
  await writeFile(join(running.f.root, 'claude-threads.json'), JSON.stringify(aliases))
  const f = await claudeFixture(running.f.root, 15_000, undefined, { pollIntervalMs: 3_600_000 }); fixtures.push(f)
  const events = eventsOf(f)
  await f.adapter.restoreThreadHistory([{ threadId: 'thread', messages: before.messages, activities: before.activities ?? [] }])
  await f.host.connect()
  await f.adapter.pollSessionLogs()

  expect(events.filter(event => event.kind !== 'answer-given')).toEqual([])
  expect((await f.host.snapshot()).threads.find(thread => thread.id === 'thread')!.messages.find(message => message.id === said.id)?.createdAt)
    .toBe(before.messages.find(message => message.id === said.id)?.createdAt)
})

it('carries no monitoring on a thread with no monitoring task, through a turn and a stop whose result comes after it', async () => {
  const { f, session, published } = await threadWithPrompt()
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
