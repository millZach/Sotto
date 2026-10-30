// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClaudeSessionLog } from '../../src/main/agents/claudeSessionLog'
import type { AgentThread } from '../../src/shared/agents'
import { claudeFixture, savedClaudeThreads } from '../fixtures/claudeFixture'
import { SottoThreadHost, ThreadRegistry } from '../../src/main/agents/threads'
import { ThreadStore } from '../../src/main/agents/threadStore'
import { WorkspaceHost } from '../../src/main/agents/workspace'

// A thread's Claude transcript used to be read from its first byte on every connect. Each authored entry
// also published a whole snapshot of its own, so a long transcript cost thousands of snapshot clones and
// queued workspace writes before the window opened, and the main process ran out of heap at startup.
// A connect now publishes once per transcript and seeks to the stored cursor instead of byte zero.
describe('Claude transcript catch-up', () => {
  let f: Awaited<ReturnType<typeof claudeFixture>>
  let id: string
  beforeEach(async () => {
    f = await claudeFixture(); await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    id = randomUUID(); await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: 'Long', modelId: f.modelId })
  })
  afterEach(async () => { await f.cleanup() })

  it('publishes once per poll however many entries a transcript adds', async () => {
    const session = await f.realId(id)
    const folder = join(f.root, 'home', 'projects', f.root.replace(/[^a-zA-Z0-9]/gu, '-'))
    await mkdir(folder, { recursive: true })
    const entries = 1500
    let published = 0
    const unsubscribe = f.host.subscribe(() => { published++ })
    const lines: string[] = []
    for (let index = 0; index < entries; index++) lines.push(JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId: session, timestamp: new Date().toISOString(), message: { role: 'user', content: `Typed in Claude ${index}` } }))
    await appendFile(join(folder, `${session}.jsonl`), `${lines.join('\n')}\n`)
    await f.adapter.pollSessionLogs()
    unsubscribe()
    const thread = (await f.host.snapshot()).threads.find(t => t.id === id)!
    expect(thread.messages.filter(message => message.role === 'user').at(-1)?.text).toBe(`Typed in Claude ${entries - 1}`)
    // The interval poll may see the file before the explicit poll does, so allow a poll or two, never one per entry.
    expect(published).toBeGreaterThanOrEqual(1)
    expect(published).toBeLessThanOrEqual(4)
  })

  it('reads only what was appended since the last run when its history is handed back', async () => {
    const session = await f.realId(id)
    const folder = join(f.root, 'home', 'projects', f.root.replace(/[^a-zA-Z0-9]/gu, '-'))
    await mkdir(folder, { recursive: true })
    const path = join(folder, `${session}.jsonl`)
    const entry = (text: string): string => JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId: session, timestamp: new Date().toISOString(), message: { role: 'user', content: text } })
    const entries = 40
    await appendFile(path, `${Array.from({ length: entries }, (_value, index) => entry(`Typed in Claude ${index}`)).join('\n')}\n`)
    await f.adapter.pollSessionLogs()
    const before = (await f.host.snapshot()).threads.find(thread => thread.id === id)!.messages
    expect(before).toHaveLength(entries)

    // Restart: the same user data folder, a new process's worth of adapter state.
    f.adapter.disconnect(); await f.adapter.closed(); f = await claudeFixture(f.root)
    const cursor = JSON.parse(await readFile(join(f.root, 'claude-threads.json'), 'utf8'))[id].transcriptCursor
    expect(cursor.offset).toBe((await readFile(path)).byteLength)

    // Rewrite an entry the cursor has already passed, keeping the file's length and identity. Only a
    // reader that went back to byte zero would show it, so its absence is the proof nothing was re-read.
    const lines = (await readFile(path, 'utf8')).split('\n')
    lines[0] = lines[0]!.replace('Typed in Claude 0', 'TAMPERED         ')
    await writeFile(path, lines.join('\n'))
    expect((await readFile(path)).byteLength).toBe(cursor.offset)

    await f.adapter.restoreThreadHistory([{ threadId: id, messages: before, activities: [] }])
    await f.host.connect()
    await appendFile(path, `${entry('Typed in Claude after the restart')}\n`)
    await f.adapter.pollSessionLogs()

    const after = (await f.host.snapshot()).threads.find(thread => thread.id === id)!.messages
    expect(after.map(message => message.text)).toEqual([...before.map(message => message.text), 'Typed in Claude after the restart'])
    expect(after.some(message => message.text.includes('TAMPERED'))).toBe(false)
  })

  it('saves no transcript cursor past words the event store has not committed (#991)', async () => {
    const registry = new ThreadRegistry(join(f.root, 'identity'))
    await registry.load()
    const sottoId = randomUUID()
    registry.reserve(sottoId, 'claude', id, f.projectId)
    await registry.flush()
    const workspace = new WorkspaceHost(new SottoThreadHost('claude', f.host, registry), join(f.root, 'workspace'), () => true, undefined, false, false, true)
    await workspace.connect()
    try {
      const failing = vi.spyOn(ThreadStore.prototype, 'appendBatches')
        .mockImplementation(() => { throw new Error('Synthetic unavailable storage') })
      const session = await f.realId(id)
      const folder = join(f.root, 'home', 'projects', f.root.replace(/[^a-zA-Z0-9]/gu, '-'))
      await mkdir(folder, { recursive: true })
      const path = join(folder, `${session}.jsonl`)
      await appendFile(path, `${JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId: session, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Words the store could not take' } })}\n`)
      await f.adapter.pollSessionLogs()
      expect((await f.host.snapshot()).threads.find(thread => thread.id === id)!.messages.at(-1)?.text).toBe('Words the store could not take')

      f.adapter.disconnect(); await f.adapter.closed()
      const heldBack = JSON.parse(await readFile(join(f.root, 'claude-threads.json'), 'utf8'))[id]
      expect(heldBack.transcriptCursor).toBeUndefined()

      failing.mockRestore()
      await f.host.connect()
      await expect.poll(() => workspace.flushEvents(sottoId), { timeout: 10_000 }).toBe(true)
      f.adapter.disconnect(); await f.adapter.closed()
      const saved = JSON.parse(await readFile(join(f.root, 'claude-threads.json'), 'utf8'))[id]
      expect(saved.transcriptCursor.offset).toBe((await readFile(path)).byteLength)
      expect(workspace.threadMessages(sottoId).map(message => message.text)).toContain('Words the store could not take')
    } finally {
      vi.restoreAllMocks()
      workspace.dispose()
    }
  })

  it.each(['same-process', 'legacy', 'event-store'] as const)('retains task classification behind the transcript cursor across %s reconnect', async mode => {
    const registryDirectory = join(f.root, 'identity')
    const workspaceDirectory = join(f.root, 'workspace')
    const registry = new ThreadRegistry(registryDirectory)
    await registry.load()
    const sottoId = randomUUID()
    registry.reserve(sottoId, 'claude', id, f.projectId)
    await registry.flush()
    let workspace: WorkspaceHost | undefined
    if (mode === 'event-store') {
      workspace = new WorkspaceHost(new SottoThreadHost('claude', f.host, registry), workspaceDirectory)
      await workspace.connect()
    }
    try {
      const session = await f.realId(id)
      const folder = join(f.root, 'home', 'projects', f.root.replace(/[^a-zA-Z0-9]/gu, '-'))
      await mkdir(folder, { recursive: true })
      const path = join(folder, `${session}.jsonl`)
      const append = async (frames: Record<string, unknown>[]) => {
        await appendFile(path, frames.map(frame => JSON.stringify({ ...frame, sessionId: session, timestamp: new Date().toISOString() })).join('\n') + '\n')
        await f.adapter.pollSessionLogs()
      }
      await append([
        { type: 'user', uuid: randomUUID(), message: { role: 'user', content: 'Original cursor anchor' } },
        { type: 'system', subtype: 'task_started', task_id: 'retained-task', task_type: 'local_agent', description: 'Retained task' },
        { type: 'system', subtype: 'task_started', task_id: 'reused-task', task_type: 'local_agent', description: 'Earlier task' },
        { type: 'system', subtype: 'task_notification', task_id: 'reused-task', status: 'completed', summary: 'Earlier result' },
        { type: 'system', subtype: 'task_started', task_id: 'reused-task', task_type: 'monitor', description: 'Monitor reusing an old task ID' },
      ])
      const before = (await f.host.snapshot()).threads.find(thread => thread.id === id)!
      expect(before.activities?.find(row => row.id === 'claude-task-retained-task')).toMatchObject({ status: 'running', title: 'Retained task' })
      expect(before.activities?.find(row => row.id === 'claude-task-reused-task')).toMatchObject({ status: 'completed', taskUpdatesExcluded: true })
      if (workspace) await workspace.snapshot()
      f.adapter.disconnect(); await f.adapter.closed()
      const cursor = JSON.parse(await readFile(join(f.root, 'claude-threads.json'), 'utf8'))[id].transcriptCursor
      expect(cursor.offset).toBe((await readFile(path)).byteLength)
      // Equal-length corruption behind the cursor proves task reconstruction did not reread the start.
      await writeFile(path, (await readFile(path, 'utf8')).replace('Original cursor anchor', 'Tampered cursor anchor'))
      expect((await readFile(path)).byteLength).toBe(cursor.offset)
      if (mode !== 'same-process') {
        workspace?.dispose()
        f = await claudeFixture(f.root)
      }
      if (mode === 'legacy') {
        const wrapped = new SottoThreadHost('claude', f.host, new ThreadRegistry(registryDirectory))
        await wrapped.restoreThreadHistory([{ threadId: sottoId, messages: before.messages, activities: before.activities!, ...(before.historyEpoch ? { historyEpoch: before.historyEpoch } : {}) }])
        await wrapped.connect()
      } else if (mode === 'event-store') {
        workspace = new WorkspaceHost(new SottoThreadHost('claude', f.host, new ThreadRegistry(registryDirectory)), workspaceDirectory)
        await workspace.connect()
      } else await f.host.connect()
      const resumed = (await f.host.snapshot()).threads.find(thread => thread.id === id)!
      // The event store's word that it holds the records is enough to resume on; they are read when a line first
      // changes the thread, below (#918).
      if (mode === 'event-store') expect(resumed.activities ?? []).toEqual([])
      else expect(resumed.activities?.find(row => row.id === 'claude-task-retained-task')).toMatchObject({ title: 'Retained task' })
      if (workspace) {
        const retained = (await workspace.subagentPage({ threadId: sottoId })).rows.find(row => row.id === 'claude-agent-task-retained-task')
        expect(retained?.title).toBe('Retained task')
      }
      expect(resumed.monitoring ?? []).toEqual([])
      // Subagents read back from the transcript are history; only the live stream says one is still running.
      expect(resumed.backgroundWork ?? []).toEqual([])
      expect(before.backgroundWork ?? []).toEqual([])
      expect(workspace?.threadMessages(sottoId).some(message => message.text.includes('Tampered')) ?? resumed.messages.some(message => message.text.includes('Tampered'))).toBe(false)
      await append([
        { type: 'system', subtype: 'task_progress', task_id: 'retained-task', summary: 'Fresh progress after reconnect' },
        { type: 'system', subtype: 'task_progress', task_id: 'reused-task', summary: 'Monitor progress must stay hidden' },
      ])
      const progressed = (await f.host.snapshot()).threads.find(thread => thread.id === id)!
      expect(progressed.activities?.find(row => row.id === 'claude-task-retained-task')).toMatchObject({ status: 'running', text: 'Fresh progress after reconnect' })
      expect(progressed.activities?.find(row => row.id === 'claude-task-reused-task')).toMatchObject({ status: 'completed', ...(mode !== 'event-store' ? { text: 'Earlier result' } : {}), taskUpdatesExcluded: true })
      await append([
        { type: 'system', subtype: 'task_notification', task_id: 'retained-task', status: 'completed', summary: 'Fresh completion after reconnect' },
        { type: 'system', subtype: 'task_notification', task_id: 'reused-task', status: 'failed', summary: 'Monitor outcome must stay hidden' },
      ])
      const completed = (await f.host.snapshot()).threads.find(thread => thread.id === id)!
      expect(completed.activities?.find(row => row.id === 'claude-task-retained-task')).toMatchObject({ status: 'completed', text: 'Fresh completion after reconnect' })
      expect(completed.activities?.find(row => row.id === 'claude-task-reused-task')).toMatchObject({ status: 'completed', ...(mode !== 'event-store' ? { text: 'Earlier result' } : {}), taskUpdatesExcluded: true })
      if (workspace) {
        expect(completed.activities?.find(row => row.id === 'claude-task-reused-task')?.text).toBeUndefined()

        const published = (await workspace.snapshot()).threads.find(thread => thread.id === sottoId)!
        expect(published.activities?.find(row => row.id === 'claude-task-retained-task')).toMatchObject({ status: 'completed', text: 'Fresh completion after reconnect' })
      }
    } finally {
      if (workspace) { workspace.disconnect(); await f.adapter.closed(); await workspace.snapshot().catch(() => undefined); workspace.dispose() }
    }
  })

  it('resumes on the store\'s word that it holds the records, and reads them only when a line changes the thread (#918)', async () => {
    const session = await f.realId(id)
    const folder = join(f.root, 'home', 'projects', f.root.replace(/[^a-zA-Z0-9]/gu, '-'))
    await mkdir(folder, { recursive: true })
    const path = join(folder, `${session}.jsonl`)
    const append = async (frames: Record<string, unknown>[]) => {
      await appendFile(path, frames.map(frame => JSON.stringify({ ...frame, sessionId: session, timestamp: new Date().toISOString() })).join('\n') + '\n')
      await f.adapter.pollSessionLogs()
    }
    await append([
      { type: 'user', uuid: randomUUID(), message: { role: 'user', content: 'Cursor anchor' } },
      { type: 'system', subtype: 'task_started', task_id: 'stored-task', task_type: 'local_agent', description: 'Stored task' },
    ])
    const before = (await f.host.snapshot()).threads.find(thread => thread.id === id)!
    f.adapter.disconnect(); await f.adapter.closed(); f = await claudeFixture(f.root)
    // Equal-length corruption behind the cursor: a read from the first byte would show it.
    await writeFile(path, (await readFile(path, 'utf8')).replace('Cursor anchor', 'Tampered xxxx'))
    let reads = 0
    f.adapter.useThreadHistory({
      messageIdentities: () => before.messages.map(({ id: messageId, role }) => ({ id: messageId, role })),
      hasActivities: (_threadId, epoch) => epoch === before.historyEpoch,
      activities: () => { reads++; return structuredClone(before.activities) },
    })
    await f.host.connect()
    expect(reads).toBe(0)
    expect((await f.host.snapshot()).threads.find(thread => thread.id === id)!.activities ?? []).toEqual([])
    await append([{ type: 'system', subtype: 'task_notification', task_id: 'stored-task', status: 'completed', summary: 'Finished after the restart' }])
    expect(reads).toBe(1)
    const after = (await f.host.snapshot()).threads.find(thread => thread.id === id)!
    expect(after.activities?.find(row => row.id === 'claude-task-stored-task')).toMatchObject({ status: 'completed', title: 'Stored task', text: 'Finished after the restart' })
    expect(after.messages.some(message => message.text.includes('Tampered'))).toBe(false)
    await append([{ type: 'user', uuid: randomUUID(), message: { role: 'user', content: 'Another line' } }])
    expect(reads).toBe(1)
  })

  it.each(['messages-only restore', 'messages-only source', 'old history epoch'] as const)('replays task classification when given %s', async mode => {
    const session = await f.realId(id)
    const folder = join(f.root, 'home', 'projects', f.root.replace(/[^a-zA-Z0-9]/gu, '-'))
    await mkdir(folder, { recursive: true })
    const path = join(folder, `${session}.jsonl`)
    const frames = [
      { type: 'user', uuid: randomUUID(), message: { role: 'user', content: 'Replay anchor' } },
      { type: 'system', subtype: 'task_started', task_id: 'replayed-task', task_type: 'local_agent', description: 'Task behind the cursor' },
    ]
    await appendFile(path, frames.map(frame => JSON.stringify({ ...frame, sessionId: session, timestamp: new Date().toISOString() })).join('\n') + '\n')
    await f.adapter.pollSessionLogs()
    const before = (await f.host.snapshot()).threads.find(thread => thread.id === id)!
    f.adapter.disconnect(); await f.adapter.closed(); f = await claudeFixture(f.root)
    if (mode === 'messages-only source') {
      f.adapter.useThreadHistory({ messageIdentities: () => before.messages.map(({ id, role }) => ({ id, role })) })
    } else await f.adapter.restoreThreadHistory([{
      threadId: id, messages: before.messages,
      ...(mode === 'old history epoch' ? { activities: [], historyEpoch: randomUUID() } : {}),
    }])
    await f.host.connect()
    expect((await f.host.snapshot()).threads.find(thread => thread.id === id)?.activities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'claude-task-replayed-task', title: 'Task behind the cursor' }),
    ]))
    await appendFile(path, JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: 'replayed-task', status: 'completed', summary: 'Recovered completion', sessionId: session }) + '\n')
    await f.adapter.pollSessionLogs()
    expect((await f.host.snapshot()).threads.find(thread => thread.id === id)?.activities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'claude-task-replayed-task', status: 'completed', text: 'Recovered completion' }),
    ]))
  })

  it('recognises stored messages and keeps each record in its own turn when no cursor was saved', async () => {
    const session = await f.realId(id)
    const folder = join(f.root, 'home', 'projects', f.root.replace(/[^a-zA-Z0-9]/gu, '-'))
    await mkdir(folder, { recursive: true })
    const path = join(folder, `${session}.jsonl`)
    const [first, second] = [randomUUID(), randomUUID()]
    const turn = (user: string, prompt: string, tool: string) => [
      { type: 'user', uuid: user, message: { role: 'user', content: prompt } },
      { type: 'assistant', uuid: randomUUID(), message: { id: `reply-${tool}`, role: 'assistant', content: [{ type: 'tool_use', id: tool, name: 'Bash', input: { command: 'echo ok' } }] } },
      { type: 'user', uuid: randomUUID(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool, content: 'ok' }] } },
      { type: 'assistant', uuid: randomUUID(), message: { id: `answer-${tool}`, role: 'assistant', content: [{ type: 'text', text: `Done with ${tool}` }] } },
    ]
    const frames = [...turn(first, 'First prompt', 'tool-a'), ...turn(second, 'Second prompt', 'tool-b')]
    await appendFile(path, frames.map(frame => JSON.stringify({ ...frame, sessionId: session, timestamp: new Date().toISOString() })).join('\n') + '\n')
    await f.adapter.pollSessionLogs()
    const before = (await f.host.snapshot()).threads.find(thread => thread.id === id)!
    const placed = (thread: typeof before) => Object.fromEntries((thread.activities ?? []).filter(record => record.id.startsWith('claude-tool-'))
      .map(record => [record.id, { turnId: record.turnId, afterMessageId: record.afterMessageId }]))
    expect(placed(before)).toEqual({
      'claude-tool-tool-a': expect.objectContaining({ turnId: first }),
      'claude-tool-tool-b': expect.objectContaining({ turnId: second }),
    })

    // Restart before any cursor was saved: the transcript is read again from its first byte.
    f.adapter.disconnect(); await f.adapter.closed()
    const aliases = JSON.parse(await readFile(join(f.root, 'claude-threads.json'), 'utf8'))
    delete aliases[id].transcriptCursor
    await writeFile(join(f.root, 'claude-threads.json'), JSON.stringify(aliases))
    f = await claudeFixture(f.root)
    f.adapter.useThreadHistory({ messageIdentities: () => before.messages.map(({ id: messageId, role }) => ({ id: messageId, role })) })
    const kinds: string[] = []
    f.adapter.subscribeEvents(({ event }) => { kinds.push(event.kind) })
    await f.host.connect()

    // Every message the store holds is recognised rather than recorded a second time.
    expect(kinds).not.toContain('message-added')
    // And each replayed record keeps the turn and the anchor the first read gave it, not the newest stored message's.
    expect(placed((await f.host.snapshot()).threads.find(thread => thread.id === id)!)).toEqual(placed(before))

    // A record read after the replay, before any new message says something, follows the message the replay ended on.
    await appendFile(path, JSON.stringify({ type: 'assistant', uuid: randomUUID(), sessionId: session, timestamp: new Date().toISOString(),
      message: { id: 'reply-tool-c', role: 'assistant', content: [{ type: 'tool_use', id: 'tool-c', name: 'Bash', input: { command: 'echo again' } }] } }) + '\n')
    await f.adapter.pollSessionLogs()
    const later = (await f.host.snapshot()).threads.find(thread => thread.id === id)!.activities?.find(record => record.id === 'claude-tool-tool-c')
    expect(later).toEqual(expect.objectContaining({ turnId: second, afterMessageId: before.messages.find(message => message.text === 'Done with tool-b')!.id }))
  })

  it('places replayed records by the read even when the transcript was missing at connect', async () => {
    const session = await f.realId(id)
    const folder = join(f.root, 'home', 'projects', f.root.replace(/[^a-zA-Z0-9]/gu, '-'))
    await mkdir(folder, { recursive: true })
    const path = join(folder, `${session}.jsonl`)
    const [first, second] = [randomUUID(), randomUUID()]
    const turn = (user: string, prompt: string, tool: string) => [
      { type: 'user', uuid: user, message: { role: 'user', content: prompt } },
      { type: 'assistant', uuid: randomUUID(), message: { id: `reply-${tool}`, role: 'assistant', content: [{ type: 'tool_use', id: tool, name: 'Bash', input: { command: 'echo ok' } }] } },
      { type: 'assistant', uuid: randomUUID(), message: { id: `answer-${tool}`, role: 'assistant', content: [{ type: 'text', text: `Done with ${tool}` }] } },
    ]
    const frames = [...turn(first, 'First prompt', 'tool-a'), ...turn(second, 'Second prompt', 'tool-b')]
    await appendFile(path, frames.map(frame => JSON.stringify({ ...frame, sessionId: session, timestamp: new Date().toISOString() })).join('\n') + '\n')
    await f.adapter.pollSessionLogs()
    const before = (await f.host.snapshot()).threads.find(thread => thread.id === id)!
    const placed = (thread: typeof before) => Object.fromEntries((thread.activities ?? []).filter(record => record.id.startsWith('claude-tool-'))
      .map(record => [record.id, { turnId: record.turnId, afterMessageId: record.afterMessageId }]))

    // Restart with no cursor, and with the transcript out of reach while the connect reads.
    f.adapter.disconnect(); await f.adapter.closed()
    const aliases = JSON.parse(await readFile(join(f.root, 'claude-threads.json'), 'utf8'))
    delete aliases[id].transcriptCursor
    await writeFile(join(f.root, 'claude-threads.json'), JSON.stringify(aliases))
    await rename(path, `${path}.away`)
    f = await claudeFixture(f.root)
    f.adapter.useThreadHistory({ messageIdentities: () => before.messages.map(({ id: messageId, role }) => ({ id: messageId, role })) })
    const kinds: string[] = []
    f.adapter.subscribeEvents(({ event }) => { kinds.push(event.kind) })
    await f.host.connect()

    // The read that finds it is still the replay the connect began.
    await rename(`${path}.away`, path)
    await f.adapter.pollSessionLogs()
    expect(kinds).not.toContain('message-added')
    expect(placed((await f.host.snapshot()).threads.find(thread => thread.id === id)!)).toEqual(placed(before))
  })

  it('does not shrink a reply written over several lines while a reconnect reads it again from the first byte', async () => {
    const session = await f.realId(id)
    const folder = join(f.root, 'home', 'projects', f.root.replace(/[^a-zA-Z0-9]/gu, '-'))
    await mkdir(folder, { recursive: true })
    const path = join(folder, `${session}.jsonl`)
    const frames = [
      { type: 'user', uuid: randomUUID(), message: { role: 'user', content: 'Explain it' } },
      { type: 'assistant', uuid: randomUUID(), message: { id: 'answer', role: 'assistant', content: [{ type: 'text', text: 'First block' }] } },
      { type: 'assistant', uuid: randomUUID(), message: { id: 'answer', role: 'assistant', content: [{ type: 'text', text: 'Second block' }] } },
    ]
    await appendFile(path, frames.map(frame => JSON.stringify({ ...frame, sessionId: session, timestamp: new Date().toISOString() })).join('\n') + '\n')
    await f.adapter.pollSessionLogs()
    const words = (await f.host.snapshot()).threads.find(thread => thread.id === id)!.messages.map(message => message.text)
    expect(words.at(-1)).toBe('First block\nSecond block')

    // Reconnect in the same process, which hands the log the messages it held, with the cursor gone.
    f.adapter.disconnect(); await f.adapter.closed()
    const aliases = JSON.parse(await readFile(join(f.root, 'claude-threads.json'), 'utf8'))
    delete aliases[id].transcriptCursor
    await writeFile(join(f.root, 'claude-threads.json'), JSON.stringify(aliases))
    const events: string[] = []
    const unsubscribe = f.adapter.subscribeEvents(({ event }) => { events.push(event.kind) })
    await f.host.connect()
    unsubscribe()

    // The first block alone is not a change to the reply the store holds whole, so nothing is said again.
    expect(events).toEqual([])
    expect((await f.host.snapshot()).threads.find(thread => thread.id === id)!.messages.map(message => message.text)).toEqual(words)
  })
})

// Every saved thread's transcript was opened and read every second, whether anyone used the thread or not (#992). The
// poll now reads only the threads a window or Watcher looks at, or that are working, and every other thread catches up
// when it is opened or sent to, from its cursor.
describe('Claude transcript poll', () => {
  let f: Awaited<ReturnType<typeof claudeFixture>> | undefined
  afterEach(async () => { await f?.cleanup(); f = undefined })

  it('reads each tick only the threads looked at or working, once more after, and the rest when opened from their cursor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-claude-poll-'))
    const entry = (session: string, text: string): string => JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId: session, timestamp: new Date().toISOString(), message: { role: 'user', content: text } })
    // Six saved threads, as an earlier run left them.
    const { folder, sessions } = await savedClaudeThreads(root, 6, (session, index) => `${[0, 1, 2, 3].map(line => entry(session, `Saved ${index} line ${line}`)).join('\n')}\n`)
    // The poll's own timer, held here so the test says when it ticks.
    const intervals = vi.spyOn(globalThis, 'setInterval')
    f = await claudeFixture(root, 2000, undefined, { pollIntervalMs: 3_600_000 })
    await f.host.connect()
    const timer = intervals.mock.calls.find(([, ms]) => ms === 3_600_000)![0] as () => void
    intervals.mockRestore()
    const adapter = f.adapter as unknown as { logs: Map<string, ClaudeSessionLog>; threads: Map<string, AgentThread>; polling: Promise<void> | undefined
      messageLog: { summary(id: string): { messageCount: number } }; observeCompaction(id: string, ...rest: unknown[]): void }
    const [shown, working, sent, outside] = [...sessions.keys()] as [string, string, string, string]
    const read: string[] = []
    let failNext: string | undefined, failAlways: string | undefined, unopenedNext: string | undefined
    const nativePoll = ClaudeSessionLog.prototype.poll
    vi.spyOn(ClaudeSessionLog.prototype, 'poll').mockImplementation(function (this: ClaudeSessionLog) {
      const id = [...adapter.logs].find(([, log]) => log === this)![0]
      read.push(id)
      if (failNext === id || failAlways === id) { failNext = undefined; return Promise.reject(new Error('Synthetic unreadable transcript')) }
      // As a read that found the transcript and could not open it, which the reader answers without an error.
      if (unopenedNext === id) { unopenedNext = undefined; return nativePoll.call(this).then(() => { this.unopened = true }) }
      return nativePoll.call(this)
    })
    const tick = async (): Promise<string[]> => { read.length = 0; timer(); await adapter.polling?.catch(() => undefined); return [...read].sort() }
    const count = (id: string): number => adapter.messageLog.summary(id).messageCount
    f.adapter.observeThreads([shown])
    expect(await tick()).toEqual([shown])
    // A thread working out of view is read while it works, and once more after, so its turn's last lines land; a read
    // that fails is tried again on the next tick.
    adapter.threads.get(working)!.status = 'running'
    expect(await tick()).toEqual([shown, working].sort())
    adapter.threads.get(working)!.status = 'idle'
    failNext = working
    expect(await tick()).toEqual([shown, working].sort())
    expect(await tick()).toEqual([shown, working].sort())
    expect(await tick()).toEqual([shown])
    adapter.threads.get(working)!.status = 'running'
    expect(await tick()).toEqual([shown, working].sort())
    adapter.threads.get(working)!.status = 'idle'
    unopenedNext = working
    expect(await tick()).toEqual([shown, working].sort())
    expect(await tick()).toEqual([shown, working].sort())
    expect(await tick()).toEqual([shown])
    // A transcript that fails every time holds up no other thread's read.
    failAlways = shown
    adapter.threads.get(working)!.status = 'running'
    expect(await tick()).toEqual([shown, working].sort())
    expect(await tick()).toEqual([shown, working].sort())
    failAlways = undefined
    adapter.threads.get(working)!.status = 'idle'
    expect(await tick()).toEqual([shown, working].sort())
    expect(await tick()).toEqual([shown])
    // A turn begun and ended between two ticks is read on the next.
    expect(await f.host.execute({ type: 'send', threadId: sent, commandId: randomUUID(), messageId: randomUUID(), text: 'Plan the trip' })).toMatchObject({ accepted: true })
    await f.driver.completeTurn(sent, 'Here is the plan.')
    await vi.waitFor(() => { expect(adapter.threads.get(sent)!.status).toBe('idle') })
    expect(await tick()).toEqual([sent, shown].sort())
    expect(await tick()).toEqual([sent, shown].sort())
    expect(await tick()).toEqual([shown])
    // Work typed in Claude Code outside Sotto on a thread nobody looks at waits for the thread to come into view.
    await appendFile(join(folder, `${sessions.get(outside)}.jsonl`), `${entry(sessions.get(outside)!, 'Typed in Claude while away')}\n`)
    expect(await tick()).toEqual([shown])
    expect(await tick()).toEqual([shown])
    expect(count(outside)).toBe(4)
    // A pane opening it reads the one entry added since its cursor at once, before any tick, not its transcript from the
    // first byte, and nothing is lost. Each entry read from the transcript passes here once, marked as from it.
    const entries = vi.spyOn(adapter, 'observeCompaction')
    f.adapter.observeThreads([shown, outside])
    await vi.waitFor(() => { expect(count(outside)).toBe(5) })
    expect(entries.mock.calls.filter(([id, , fromLog]) => id === outside && fromLog === true)).toHaveLength(1)
  })
})
