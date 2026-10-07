// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ThreadHostEvent } from '../../src/main/agents/host'
import type { RecordedRpc } from '../fixtures/codexFixture'
import { devinFixture } from '../fixtures/devinFixture'

// What a send to Devin costs before Devin hears it, what shows Devin took it, and what it shows while Devin answers
// (#770). Unless a test says otherwise, polling and the replay fallback are pushed past every deadline, so whatever
// happens is the send's own doing.
let f: Awaited<ReturnType<typeof devinFixture>> | undefined
afterEach(async () => { await f?.cleanup(); f = undefined })

// No poll and no replay fallback before a deadline: only the thread's own stream can accept a send, unless a test says otherwise.
const streamOnly = () => devinFixture(undefined, 5000, 60_000, {}, undefined, { acceptanceGraceMs: 60_000 })
async function opened(fixture: NonNullable<typeof f>): Promise<string> {
  await fixture.host.connect()
  await fixture.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: fixture.projectId, title: 'Project', path: fixture.root })
  const id = randomUUID()
  expect(await fixture.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: fixture.projectId,
    modelId: fixture.modelId, title: 'Synthetic thread' })).toEqual({ accepted: true })
  fixture.host.observeThreads([id])
  return id
}
const send = (fixture: NonNullable<typeof f>, threadId: string, text = 'Synthetic prompt') =>
  fixture.host.execute({ type: 'send', commandId: randomUUID(), messageId: randomUUID(), threadId, text })
// The records before the first with `method`, which must be there.
const before = (records: RecordedRpc[], method: string): RecordedRpc[] => {
  const index = records.findIndex(record => record.method === method)
  if (index < 0) throw new Error(`No ${method} was recorded`)
  return records.slice(0, index)
}
const loads = async (fixture: NonNullable<typeof f>): Promise<number> => (await fixture.driver.requests()).filter(record => record.method === 'session/load').length

it('starts only the two integration lists between Send and session/prompt on a warm thread', async () => {
  f = await streamOnly()
  const id = await opened(f)
  await f.script({ streamOnPrompt: 'Working on it' })
  expect(await send(f, id, 'First synthetic prompt')).toEqual({ accepted: true })
  // The coordinator's reconciliation read after an accepted prompt.
  await f.host.refreshThread(id)
  await f.driver.completeTurn(id, ' and done')
  await expect.poll(async () => (await f!.host.snapshot()).threads.find(thread => thread.id === id)?.status).toBe('idle')

  const mark = (await f.driver.requests()).length
  // As a send from the Threads page goes: the coordinator's read before the send, the checkpoint's read of the
  // thread, then the send.
  await f.host.refreshThread(id, { beforeSend: true })
  await f.host.refreshThread(id)
  expect(await send(f, id, 'Second synthetic prompt')).toEqual({ accepted: true })
  const records = (await f.driver.requests()).slice(mark)
  const ahead = before(records, 'session/prompt')
  expect(ahead.length).toBeLessThan(records.length)
  // The plugin and MCP lists, side by side, and nothing else: no observer process and no replay (#770 pins 2;
  // origin/main started 19 here, five for each of three observer reads and two for each of two more checks).
  expect(ahead.filter(record => record.method === 'fixture/spawn').map(record => record.params?.kind).sort()).toEqual(['mcp', 'plugins'])
  expect(ahead.some(record => record.method === 'session/load')).toBe(false)
  // The owner's own stream settled the send, so no observer read followed it either.
  expect(records.some(record => record.method === 'session/load')).toBe(false)
})

it('checks the profile once when opening the session is part of the same send', async () => {
  f = await streamOnly()
  const id = await opened(f)
  await f.script({ streamOnPrompt: 'Working on it' })
  expect(await send(f, id)).toEqual({ accepted: true })
  await f.driver.completeTurn(id, ' and done')
  await expect.poll(async () => (await f!.host.snapshot()).threads.find(thread => thread.id === id)?.status).toBe('idle')
  f = await f.driver.restart()
  await f.host.connect()
  const mark = (await f.driver.requests()).length
  expect(await send(f, id, 'After a restart')).toEqual({ accepted: true })
  const ahead = before((await f.driver.requests()).slice(mark), 'session/prompt')
  // Opening starts the owner (two lists and the process itself) and confirms it after loading (two lists).
  // The send does not repeat that confirmation.
  expect(ahead.filter(record => record.method === 'fixture/spawn').map(record => record.params?.kind).sort())
    .toEqual(['acp', 'mcp', 'mcp', 'plugins', 'plugins'])
  expect(ahead.filter(record => record.method === 'session/load')).toHaveLength(1)
})

it('shows reply text in the message log as it streams, before any observer read completes', async () => {
  f = await streamOnly()
  const id = await opened(f)
  const events: ThreadHostEvent[] = []
  const off = f.host.subscribeEvents(event => events.push(event))
  try {
    const loaded = await loads(f)
    // The replay will not show the prompt for a minute, so the stream is the only evidence there is.
    await f.script({ streamOnPrompt: 'First streamed words', delayPrompt: 60_000 })
    expect(await send(f, id)).toEqual({ accepted: true })
    const texts = (): string[] => events.filter(event => event.threadId === id).flatMap(event =>
      event.event.kind === 'message-added' ? [`${event.event.message.role}:${event.event.message.text}`]
        : event.event.kind === 'message-text-appended' ? [`append:${event.event.appendText}`] : [])
    await expect.poll(texts).toContain('assistant:First streamed words')
    expect(texts()).toContain('user:Synthetic prompt')
    expect(await loads(f)).toBe(loaded)
  } finally { off() }
})

it('reads the replay once the stream has been silent for the grace period, and accepts from it', async () => {
  f = await devinFixture(undefined, 5000, 60_000, {}, undefined, { acceptanceGraceMs: 200 })
  const id = await opened(f)
  const loaded = await loads(f)
  expect(await send(f, id)).toEqual({ accepted: true })
  expect(await loads(f)).toBeGreaterThan(loaded)
})

it('reads the replay of a held session only to confirm a dispatch no replay has confirmed yet', async () => {
  f = await streamOnly()
  const id = await opened(f)
  await f.script({ streamOnPrompt: 'Working on it' })
  expect(await send(f, id)).toEqual({ accepted: true })
  const loaded = await loads(f)
  // Accepted from the stream, so the reconciliation read after it reads the replay and confirms the dispatch.
  await f.host.refreshThread(id)
  expect(await loads(f)).toBe(loaded + 1)
  expect(JSON.parse(await readFile(join(f.root, 'devin-threads.json'), 'utf8'))[id].origins[0].confirmed).toBe(true)
  // Nothing is left to confirm, and no other client can change the session its owner holds, so a whole read
  // starts no observer.
  await f.host.refreshThread(id)
  expect(await loads(f)).toBe(loaded + 1)
})

it('confirms a turn taken on the stream by one replay read once the turn ends', async () => {
  f = await streamOnly()
  const id = await opened(f)
  await f.script({ streamOnPrompt: 'Working on it' })
  expect(await send(f, id)).toEqual({ accepted: true })
  const loaded = await loads(f)
  const confirmed = async (): Promise<boolean> => JSON.parse(await readFile(join(f!.root, 'devin-threads.json'), 'utf8'))[id].origins[0].confirmed
  expect(await confirmed()).toBe(false)
  await f.driver.completeTurn(id, ' and done')
  await expect.poll(confirmed).toBe(true)
  expect(await loads(f)).toBe(loaded + 1)
})

it('confirms a turn taken on the stream when its prompt ends in an error', async () => {
  f = await streamOnly()
  const id = await opened(f)
  await f.script({ streamOnPrompt: 'Working on it' })
  expect(await send(f, id)).toEqual({ accepted: true })
  const loaded = await loads(f)
  const confirmed = async (): Promise<boolean> => JSON.parse(await readFile(join(f!.root, 'devin-threads.json'), 'utf8'))[id].origins[0].confirmed
  await f.action(id, { type: 'fail' })
  await expect.poll(confirmed).toBe(true)
  expect(await loads(f)).toBe(loaded + 1)
})

it('refuses the next send when the replay contradicts a dispatch taken on the stream', async () => {
  f = await streamOnly()
  const id = await opened(f)
  await f.script({ streamOnPrompt: 'Working on it' })
  expect(await send(f, id, 'What Sotto sent')).toEqual({ accepted: true })
  // Devin's own record of the prompt says something else.
  const file = join(f.root, `native-${await f.realId(id)}.json`)
  const native = JSON.parse(await readFile(file, 'utf8')) as { messages: { role: string; text: string }[] }
  native.messages.find(message => message.role === 'user')!.text = 'Something else'
  await writeFile(file, JSON.stringify(native))
  await f.script({})
  await f.driver.completeTurn(id, ' and done')
  await expect.poll(async () => (await f!.host.snapshot()).threads.find(thread => thread.id === id)?.status).toBe('idle')
  await expect(send(f, id, 'A follow-up')).rejects.toThrow('did not match the saved dispatch')
  expect((await f.driver.requests()).filter(record => record.method === 'session/prompt')).toHaveLength(1)
})

// The kinds of streamed work that show Devin took the prompt, each arriving after the prompt went out with the replay
// hidden for a minute and the replay fallback pushed past the deadline, so only the stream can accept it.
const prompted = async (): Promise<boolean> => (await f!.driver.requests()).some(record => record.method === 'session/prompt')
const work: Record<string, Record<string, unknown>> = {
  thought: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Synthetic thought' } },
  'tool call': { sessionUpdate: 'tool_call', toolCallId: 'synthetic-tool', kind: 'read', title: 'Synthetic read', status: 'pending' },
  plan: { sessionUpdate: 'plan', entries: [{ content: 'Synthetic step', priority: 'medium', status: 'pending' }] },
}
it.each(Object.entries(work))('accepts a prompt from a streamed %s, reading no replay', async (_kind, update) => {
  f = await streamOnly()
  const id = await opened(f)
  const loaded = await loads(f)
  await f.script({ delayPrompt: 60_000 })
  const sending = send(f, id)
  await expect.poll(prompted).toBe(true)
  await f.action(id, { type: 'update', update })
  expect(await sending).toEqual({ accepted: true })
  expect(await loads(f)).toBe(loaded)
})

it('accepts a prompt from a question Devin asks on the thread, reading no replay', async () => {
  f = await streamOnly()
  const id = await opened(f)
  const loaded = await loads(f)
  await f.script({ delayPrompt: 60_000 })
  const sending = send(f, id)
  await expect.poll(prompted).toBe(true)
  await f.driver.raiseQuestion(id, 'Synthetic question')
  expect(await sending).toEqual({ accepted: true })
  expect(await loads(f)).toBe(loaded)
})

it('reads the replay at once when the turn ends without streaming any work, and accepts from it', async () => {
  f = await streamOnly()
  const id = await opened(f)
  const loaded = await loads(f)
  const sending = send(f, id)
  await expect.poll(prompted).toBe(true)
  // Devin answers the prompt having streamed nothing; the grace period is a minute, so only the turn's end starts the read.
  await f.driver.completeTurn(id, '')
  expect(await sending).toEqual({ accepted: true })
  expect(await loads(f)).toBe(loaded + 1)
})

it('polls a running turn at the busy pace until the stream shows it taken, then at the idle pace', async () => {
  f = await devinFixture(undefined, 5000, undefined, {}, undefined, { acceptanceGraceMs: 60_000, productionPace: true })
  const id = await opened(f)
  await f.script({ delayPrompt: 60_000 })
  const sending = send(f, id)
  await expect.poll(prompted).toBe(true)
  // Only the clock the poll reads is moved; every timer and process stays real. The poll is due when snapshot() asks.
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() })
  try {
    const loaded = await loads(f)
    vi.setSystemTime(Date.now() + 2_000)
    await f.host.snapshot()
    // Nothing has shown the prompt taken, so two seconds is past the busy pace.
    expect(await loads(f)).toBe(loaded + 1)
    await f.action(id, { type: 'update', update: work.thought })
    expect(await sending).toEqual({ accepted: true })
    vi.setSystemTime(Date.now() + 2_000)
    await f.host.snapshot()
    // Taken on the stream: the thread is read at the idle pace, so not again two seconds on.
    expect(await loads(f)).toBe(loaded + 1)
    vi.setSystemTime(Date.now() + 15_000)
    await f.host.snapshot()
    expect(await loads(f)).toBe(loaded + 2)
  } finally { vi.useRealTimers() }
})
