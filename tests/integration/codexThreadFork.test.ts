// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AGENT_FORK_ARCHIVED, AGENT_FORK_GONE, FORK_SOURCE_MISSING, FORKED_THREAD_SOURCE_MISSING } from '../../src/shared/threadStarts'
import { codexFixture } from '../fixtures/codexFixture'
import type { RecordedRpc } from '../fixtures/adapterFixture'

// Continuing a Codex agent as its own thread, and forking a thread at a reply (#1028), against the fake app-server's
// `thread/fork` as the e5-fork spike found Codex 0.162.1's: durable, bound to the new Sotto thread when it is made, and
// read back with `thread/turns/list`. No turn is started for any of it.

type Fixture = Awaited<ReturnType<typeof codexFixture>>
type FakeTurn = { id: string; status: string; startedAt?: number; items: Record<string, unknown>[] }
type FakeThread = { id: string; cwd: string; model: string; historyMode?: string; archived?: boolean; rolloutMissing?: boolean; forkedFromId?: string; turns: FakeTurn[]; status: { type: string } }
type FakeState = { threads: Record<string, FakeThread> }

const fixtures: Fixture[] = []
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup() })

const readState = async (f: Fixture): Promise<FakeState> => JSON.parse(await readFile(join(f.root, 'state.json'), 'utf8')) as FakeState
const writeState = async (f: Fixture, state: FakeState): Promise<void> => { await writeFile(join(f.root, 'state.json'), JSON.stringify(state)) }
const forks = (requests: readonly RecordedRpc[]): RecordedRpc[] => requests.filter(request => request.method === 'thread/fork')

/** A parent thread that ran one agent, `stream_perf`, whose own native thread finished with a reply and two commands. */
async function withFinishedAgent(): Promise<{ f: Fixture; childId: string; agentId: string }> {
  const first = await codexFixture(undefined, true, 4000)
  await first.host.connect()
  await first.host.execute({ type: 'create-project', commandId: 'project', projectId: 'project', title: 'Fork fixture', path: first.root })
  await first.host.execute({ type: 'create-thread', commandId: 'create', threadId: 'parent', projectId: 'project', title: 'Audio pipeline review', modelId: first.modelId })
  await first.script({ reply: 'Two of the agents have finished.' })
  await first.host.execute({ type: 'send', commandId: 'send', threadId: 'parent', messageId: 'review', text: 'Review the audio pipeline. Give each stage its own agent.' })
  await expect.poll(async () => (await first.host.snapshot()).threads.find(thread => thread.id === 'parent')?.status).toBe('idle')
  const parentNative = await first.realId('parent')
  first.host.disconnect(); await first.adapter.closed()
  const state = await readState(first)
  const childId = randomUUID()
  const turn = state.threads[parentNative]!.turns.at(-1)!
  turn.items.splice(1, 0,
    { type: 'subAgentActivity', id: 'call-spawn', kind: 'started', agentThreadId: childId, agentPath: '/root/stream_perf', model: first.modelId },
    { type: 'subAgentActivity', id: 'subagent-completed-1', kind: 'completed', agentThreadId: childId, agentPath: '/root/stream_perf' })
  state.threads[childId] = { id: childId, cwd: first.root, model: first.modelId, historyMode: 'paginated', status: { type: 'idle' }, turns: [{ id: randomUUID(), status: 'completed', startedAt: 1_790_000_000, items: [
    { type: 'commandExecution', id: randomUUID(), status: 'completed', command: 'node bench.mjs', cwd: first.root, aggregatedOutput: 'first sound 410 ms', exitCode: 0 },
    // The agent's report up to the thread that started it, which is not work of its own.
    { type: 'subAgentActivity', id: 'call-report', kind: 'interacted', agentThreadId: parentNative, agentPath: '/root' },
    { type: 'agentMessage', id: randomUUID(), text: 'The player waits on a 64 KB buffer before it starts.' },
  ] }] }
  await writeState(first, state)
  const f = await first.driver.restart(); fixtures.push(f)
  await f.host.connect()
  const parent = (await f.host.refreshThread!('parent')).threads.find(thread => thread.id === 'parent')!
  const agentId = parent.activities!.flatMap(activity => activity.agents ?? [])[0]!.id
  return { f, childId, agentId }
}

describe('continuing a Codex agent as its own thread', () => {
  it('forks the agent durably into a new thread bound at creation, in the folder chosen, without reading its task', async () => {
    const { f, childId, agentId } = await withFinishedAgent()
    const folder = join(f.root, 'fork-worktree'); await mkdir(folder)
    const startsBefore = (await f.driver.requests()).filter(request => request.method === 'turn/start').length
    expect(await f.host.forkThread!({ commandId: 'fork', threadId: 'continued', title: 'stream_perf', modelId: f.modelId, workingDirectory: folder,
      source: { threadId: 'parent', agentId } })).toEqual({ accepted: true })
    const [request] = forks(await f.driver.requests())
    expect(request!.params).toMatchObject({ threadId: childId, cwd: folder, ephemeral: false, excludeTurns: true, model: f.modelId })
    expect(request!.params).not.toHaveProperty('lastTurnId')
    const thread = (await f.host.snapshot()).threads.find(item => item.id === 'continued')!
    // The agent's own work and reply, read back from the copy; it carries no visible brief.
    expect(thread.messages.map(message => [message.role, message.text])).toEqual([['assistant', 'The player waits on a 64 KB buffer before it starts.']])
    expect(thread.activities?.some(activity => activity.kind === 'command')).toBe(true)
    expect(thread.workingDirectory).toBe(folder)
    const forkNative = await f.realId('continued')
    expect(forkNative).not.toBe(childId)
    const state = await readState(f)
    expect(state.threads[forkNative]).toMatchObject({ forkedFromId: childId, cwd: folder })
    // The agent's own thread is left as it was, and so is its row in the parent.
    expect(state.threads[childId]!.turns).toHaveLength(1)
    expect((await f.host.snapshot()).threads.find(item => item.id === 'parent')!.activities!.flatMap(activity => activity.agents ?? [])[0]!.id).toBe(agentId)
    // A paginated thread's turns come from thread/turns/list, which a whole read would have left out.
    expect((await f.driver.requests()).some(request => request.method === 'thread/turns/list' && request.params?.threadId === forkNative)).toBe(true)
    // Nothing was asked of the model.
    expect((await f.driver.requests()).filter(request => request.method === 'turn/start')).toHaveLength(startsBefore)
  })

  it('keeps the binding through a restart and reads the copy back from Codex', async () => {
    const { f, agentId } = await withFinishedAgent()
    await f.host.forkThread!({ commandId: 'fork', threadId: 'continued', title: 'stream_perf', modelId: f.modelId, source: { threadId: 'parent', agentId } })
    const nativeBefore = await f.realId('continued')
    const restarted = await f.driver.restart()
    try {
      await restarted.host.connect()
      const thread = (await restarted.host.refreshThread!('continued')).threads.find(item => item.id === 'continued')!
      expect(thread.messages.map(message => message.text)).toEqual(['The player waits on a 64 KB buffer before it starts.'])
      expect(await restarted.realId('continued')).toBe(nativeBefore)
      expect(forks(await restarted.driver.requests())).toHaveLength(1)
    } finally { restarted.host.disconnect(); await restarted.adapter.closed() }
  })

  it('refuses plainly when Codex no longer has the agent, keeps its archive, and makes nothing', async () => {
    const { f, childId, agentId } = await withFinishedAgent()
    const state = await readState(f)
    state.threads[childId]!.archived = true
    await writeState(f, state)
    await expect(f.host.forkThread!({ commandId: 'archived', threadId: 'archived', title: 'stream_perf', modelId: f.modelId, source: { threadId: 'parent', agentId } })).rejects.toThrow(AGENT_FORK_ARCHIVED)
    // Sotto never unarchives the user's Codex state for them.
    expect((await f.driver.requests()).some(request => /archive/u.test(request.method ?? ''))).toBe(false)
    expect((await readState(f)).threads[childId]!.archived).toBe(true)
    delete state.threads[childId]
    await writeState(f, state)
    await expect(f.host.forkThread!({ commandId: 'gone', threadId: 'gone', title: 'stream_perf', modelId: f.modelId, source: { threadId: 'parent', agentId } })).rejects.toThrow(AGENT_FORK_GONE)
    // An agent its parent's history does not name is gone too, and Codex is not asked.
    const asked = forks(await f.driver.requests()).length
    await expect(f.host.forkThread!({ commandId: 'unknown', threadId: 'unknown', title: 'x', modelId: f.modelId, source: { threadId: 'parent', agentId: 'codex-agent-unknown' } })).rejects.toThrow(AGENT_FORK_GONE)
    expect(forks(await f.driver.requests())).toHaveLength(asked)
    const threads = (await f.host.snapshot()).threads.map(thread => thread.id)
    expect(threads).not.toContain('archived'); expect(threads).not.toContain('gone'); expect(threads).not.toContain('unknown')
  })

  it('binds nothing when Codex does not confirm the fork in time, and leaves the copy it made alone', async () => {
    const { f, childId, agentId } = await withFinishedAgent()
    await f.script({ holdReply: 'thread/fork' })
    expect(await f.host.forkThread!({ commandId: 'late', threadId: 'late', title: 'stream_perf', modelId: f.modelId, source: { threadId: 'parent', agentId } }))
      .toEqual({ accepted: false, uncertain: true })
    // The app-server the fork was asked of is let go, so its answer, if it ever comes, binds no thread.
    expect(Object.values((await readState(f)).threads).filter(thread => thread.forkedFromId === childId)).toHaveLength(1)
    expect((await f.host.snapshot()).threads.map(thread => thread.id)).toEqual(['parent'])
  })

  it('says plainly when Codex no longer has the conversation a fork came from', async () => {
    const { f, childId, agentId } = await withFinishedAgent()
    await f.host.forkThread!({ commandId: 'fork', threadId: 'continued', title: 'stream_perf', modelId: f.modelId, source: { threadId: 'parent', agentId } })
    const restarted = await f.driver.restart()
    try {
      const state = await readState(restarted)
      state.threads[childId]!.rolloutMissing = true
      await writeState(restarted, state)
      await restarted.host.connect()
      await expect(restarted.host.refreshThread!('continued')).rejects.toThrow(FORKED_THREAD_SOURCE_MISSING)
      const thread = (await restarted.host.snapshot()).threads.find(item => item.id === 'continued')!
      expect(thread.historyError).toBe(FORKED_THREAD_SOURCE_MISSING)
      // A fork of the fork is refused for the same reason, and nothing is made.
      await expect(restarted.host.forkThread!({ commandId: 'again', threadId: 'again', title: 'x', modelId: restarted.modelId, source: { threadId: 'continued', messageId: thread.messages[0]?.id ?? 'none' } }))
        .rejects.toThrow()
    } finally { restarted.host.disconnect(); await restarted.adapter.closed() }
    void FORK_SOURCE_MISSING
  })
})

describe('forking a Codex thread at a reply', () => {
  async function twoTurns(): Promise<Fixture> {
    const f = await codexFixture(undefined, true, 4000); fixtures.push(f)
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: 'project', projectId: 'project', title: 'Fork fixture', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: 'create', threadId: 'source', projectId: 'project', title: 'WAV preview stall', modelId: f.modelId })
    for (const id of ['first', 'second']) {
      await f.script({ reply: `Answer ${id}` })
      await f.host.execute({ type: 'send', commandId: id, threadId: 'source', messageId: id, text: `Message ${id}` })
      await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === 'source')?.status).toBe('idle')
    }
    await f.host.refreshThread!('source')
    return f
  }

  it('copies the conversation up to the turn that holds the reply, under the source turn IDs, and keeps the two threads apart', async () => {
    const f = await twoTurns()
    const source = (await f.host.snapshot()).threads.find(thread => thread.id === 'source')!
    const reply = source.messages.find(message => message.text === 'Answer first')!
    expect(await f.host.forkThread!({ commandId: 'fork', threadId: 'fork', title: 'Fork of WAV preview stall', modelId: f.modelId, source: { threadId: 'source', messageId: reply.id } })).toEqual({ accepted: true })
    const state = await readState(f)
    const sourceNative = await f.realId('source'), forkNative = await f.realId('fork')
    const request = forks(await f.driver.requests())[0]!
    expect(request.params).toMatchObject({ threadId: sourceNative, lastTurnId: state.threads[sourceNative]!.turns[0]!.id })
    expect(state.threads[forkNative]!.turns.map(turn => turn.id)).toEqual([state.threads[sourceNative]!.turns[0]!.id])
    let fork = (await f.host.refreshThread!('fork')).threads.find(thread => thread.id === 'fork')!
    expect(fork.messages.map(message => message.text)).toEqual(['Message first', 'Answer first'])
    // The fork carries the source's turn IDs; each thread's turns stay its own when both carry on.
    await f.script({ reply: 'Fork answer' })
    await f.host.execute({ type: 'send', commandId: 'fork-send', threadId: 'fork', messageId: 'fork-send', text: 'Carry on here' })
    await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === 'fork')?.status).toBe('idle')
    await f.script({ reply: 'Source answer' })
    await f.host.execute({ type: 'send', commandId: 'source-send', threadId: 'source', messageId: 'source-send', text: 'And here' })
    await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === 'source')?.status).toBe('idle')
    fork = (await f.host.refreshThread!('fork')).threads.find(thread => thread.id === 'fork')!
    const after = (await f.host.refreshThread!('source')).threads.find(thread => thread.id === 'source')!
    expect(fork.messages.map(message => message.text)).toEqual(['Message first', 'Answer first', 'Carry on here', 'Fork answer'])
    expect(after.messages.map(message => message.text)).toEqual(['Message first', 'Answer first', 'Message second', 'Answer second', 'And here', 'Source answer'])
  })

  it('refuses a reply Codex no longer has in the thread, and makes nothing', async () => {
    const f = await twoTurns()
    const source = (await f.host.snapshot()).threads.find(thread => thread.id === 'source')!
    const reply = source.messages.find(message => message.text === 'Answer second')!
    // Another Codex process rewound the shared history; Sotto still holds the turn.
    const acted = await f.action('source', { type: 'native-rewind' })
    await expect.poll(() => f.acted(acted)).toBe(true)
    await expect(f.host.forkThread!({ commandId: 'fork', threadId: 'fork', title: 'Fork', modelId: f.modelId, source: { threadId: 'source', messageId: reply.id } }))
      .rejects.toThrow('Codex doesn’t have that turn in this thread any more')
    await expect(f.host.forkThread!({ commandId: 'fork-2', threadId: 'fork-2', title: 'Fork', modelId: f.modelId, source: { threadId: 'source', messageId: 'not-a-message' } }))
      .rejects.toThrow('Codex doesn’t have that reply in this thread any more')
    expect((await f.host.snapshot()).threads.map(thread => thread.id)).toEqual(['source'])
  })
})
