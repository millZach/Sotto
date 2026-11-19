// @vitest-environment node
// One Claude reply gives one history (#2698). Claude Code reports a reply up to three times: its stream opens the reply at
// the moment Sotto hears it, then the finished message comes on the CLI's output and as a line of its transcript, both
// dated by the CLI. A reply ends with the CLI's own time, so that one read back after a restart matches the saved one
// (docs/research/issue-22-claude-native-verification.md), and moving it there is one message-replaced event, whichever
// of the CLI's output and the transcript comes first; the second report changes nothing. Here the CLI's date is a fixed
// instant long past, so it always differs from the stream's, and each order is scripted rather than left to timing. The
// thread's monitoring was another difference: every CLI frame wrote an empty list when no monitoring task ran, and a stop
// removed it.
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

/**
 * A reply's lines: its stream, the finished message as the CLI prints and saves it, and the turn's result. The saved line
 * carries the CLI's date. The printed one carries it too unless `printed` is `undated`: Anthropic's frame for a printed
 * message names no date, and the fake prints one.
 */
function reply(session: string, text: string, printed: 'dated' | 'undated' = 'dated') {
  const id = randomUUID()
  const finished = { type: 'assistant', uuid: randomUUID(), session_id: session, message: { id, role: 'assistant', content: [{ type: 'text', text }] } }
  return {
    id,
    stream: [
      { type: 'stream_event', session_id: session, event: { type: 'message_start', message: { id, role: 'assistant' } } },
      { type: 'stream_event', session_id: session, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } },
    ],
    finished: printed === 'dated' ? { ...finished, timestamp: DATED } : finished,
    line: JSON.stringify({ ...finished, timestamp: DATED, parentUuid: null, isSidechain: false, sessionId: session }) + '\n',
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
const messageEventKinds = (events: readonly ThreadEvent[], messageId: string): string[] => events.filter(event =>
  (event.kind === 'message-added' || event.kind === 'message-replaced') && event.message.id === messageId
  || event.kind === 'message-text-appended' && event.messageId === messageId).map(event => event.kind)

/**
 * One turn played to its end with the finished reply heard in the order named, as what a client can compare between two
 * runs: every event the thread was given, each message named by its role and dated by whose clock its date came from,
 * and the reply as the record holds it.
 */
async function play(order: 'printed first' | 'saved first', printed: 'dated' | 'undated') {
  const running = await threadWithPrompt()
  const { f, events, session } = running
  const said = reply(session, 'Hello from the referee.', printed)
  await stream(running, said)
  if (order === 'printed first') { await print(running, said); await read(running, said) }
  else {
    await read(running, said)
    // The transcript alone moved the reply, before the CLI printed anything of it.
    expect(messageEventKinds(events, said.id)).toEqual(['message-added', 'message-replaced'])
    await print(running, said)
  }
  const clock = (at: string) => at === DATED ? 'the CLI' : 'Sotto'
  const history = events.map(event => event.kind === 'message-added' || event.kind === 'message-replaced'
    ? { kind: event.kind, role: event.message.role, text: event.message.text, dated: clock(event.message.createdAt), turn: event.message.turnMessageId }
    : { kind: event.kind })
  const message = (await f.host.snapshot()).threads.find(thread => thread.id === 'thread')!.messages.find(value => value.id === said.id)!
  return { history, reply: { text: message.text, dated: clock(message.createdAt), turn: message.turnMessageId } }
}

it.each(['dated', 'undated'] as const)('gives one history whichever finished report comes first, with the printed reply %s', async printed => {
  const printedFirst = await play('printed first', printed)
  const savedFirst = await play('saved first', printed)
  expect(savedFirst).toEqual(printedFirst)
  // The reply ends on the CLI's date and its turn, and moving it there is one replacement with the same words.
  expect(printedFirst).toEqual({
    history: [
      { kind: 'message-added', role: 'user', text: 'Say hello', dated: 'Sotto', turn: undefined },
      { kind: 'message-added', role: 'assistant', text: 'Hello from the referee.', dated: 'Sotto', turn: 'prompt' },
      { kind: 'message-replaced', role: 'assistant', text: 'Hello from the referee.', dated: 'the CLI', turn: 'prompt' },
    ],
    reply: { text: 'Hello from the referee.', dated: 'the CLI', turn: 'prompt' },
  })
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

  expect(messageEventKinds(events, first.id)).toEqual(['message-added', 'message-replaced'])
  expect(messageEventKinds(events, second.id)).toEqual(['message-added', 'message-replaced'])
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
  const snapshot = (await f.host.snapshot()).threads.find(thread => thread.id === 'thread')!
  f.adapter.disconnect(); await f.adapter.closed()

  // The read went through the whole transcript, the reply's line with it, and wrote nothing.
  const length = (await readFile(claudeTranscriptPath(f.root, running.session))).byteLength
  expect((JSON.parse(await readFile(join(f.root, 'claude-threads.json'), 'utf8')) as Record<string, { transcriptCursor?: { offset: number } }>).thread!.transcriptCursor?.offset).toBe(length)
  expect(events.filter(event => event.kind !== 'answer-given')).toEqual([])
  expect(before.messages.find(message => message.id === said.id)?.createdAt).toBe(DATED)
  expect(snapshot.messages.find(message => message.id === said.id)?.createdAt).toBe(DATED)
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
