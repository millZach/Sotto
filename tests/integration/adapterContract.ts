// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type { AgentHost, ThreadHostEvent } from '../../src/main/agents/host'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import type { AgentActivity } from '../../src/shared/agentActivity'
import type { AgentHostSnapshot } from '../../src/shared/agents'
import type { ThreadEventKind } from '../../src/shared/threadEvents'
import type { RecordedRpc } from '../fixtures/codexFixture'

/** Short reaper settings so a test can watch a session be stopped instead of waiting out a real hour. */
export interface AdapterSessionOptions { reaperSweepMs?: number; sessionIdleMs?: number }

export interface AdapterFixture {
  host: AgentHost; projectId: string; modelId: string; root: string
  driver: {
    typeInProvider(sessionId: string, text: string): Promise<void>
    completeTurn(sessionId: string, text: string): Promise<void>
    raiseQuestion(sessionId: string, text: string): Promise<void>
    raisePermission(sessionId: string, text: string): Promise<void>
    delayNextAck(method: string): Promise<void>
    requests(): Promise<RecordedRpc[]>
    restart(): Promise<AdapterFixture>
    /**
     * Where the provider reports agent work a turn left running: finish the turn so that a subagent it
     * launched is still running afterwards, then report that subagent finished. Absent where it reports none.
     */
    backgroundWork?: {
      completeLeaving(sessionId: string, text: string, description: string): Promise<void>
      end(sessionId: string): Promise<void>
    }
  }
  cleanup(): Promise<void>
  /** Decode recorded native traffic; fixtures must also reject invalid native replies. */
  protocol?: {
    promptMethod: string
    resumeMethod: string
    permissionDecision(record: RecordedRpc): boolean | undefined
  }
  /** A process-owned turn may stop when its adapter process exits. */
  restartStatus?: 'idle' | 'running'
  /** Lazy provider sessions: what this provider saw start, and whether one thread's session has stopped. */
  sessions?: {
    starts(threadId: string): Promise<number>
    stopped(threadId: string): Promise<boolean>
  }
  skips?: Partial<Record<'uncertain' | 'restart' | 'lazy', string>>
}

/** New provider adapters must pass these behavioural checks with observable fake effects. */
export function describeAdapterContract(name: string, factory: (session?: AdapterSessionOptions) => Promise<AdapterFixture>): void {
  describe(`${name} thread interface contract`, () => {
    let f: AdapterFixture
    let sessionId: string
    /** Every thread event this adapter published, when it publishes any (issue #120). */
    let events: ThreadHostEvent[]
    let unsubscribeEvents: (() => void) | undefined
    const kinds = (id = sessionId): ThreadEventKind[] => events.filter(event => event.threadId === id).map(event => event.event.kind)
    const added = (id = sessionId) => events.filter(event => event.threadId === id && event.event.kind === 'message-added')
      .map(event => (event.event as Extract<ThreadHostEvent['event'], { kind: 'message-added' }>).message)
    const thread = async () => (await f.host.snapshot()).threads.find(t => t.id === sessionId)!
    const send = () => f.host.execute({ type: 'send', threadId: sessionId, commandId: randomUUID(), messageId: 'own-message', text: 'Synthetic prompt' })
    const permissionDecision = (record: RecordedRpc): boolean | undefined => {
      if (f.protocol) return f.protocol.permissionDecision(record)
      return record.result?.decision === 'accept' ? true : record.result?.decision === 'decline' ? false : undefined
    }
    beforeEach(async () => {
      f = await factory(); await f.host.connect()
      await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
      sessionId = randomUUID()
      await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: sessionId, projectId: f.projectId, modelId: f.modelId, title: 'Contract thread' })
      // A thread holds its messages while something is looking at it, so every case here opens it first.
      f.host.observeThreads?.([sessionId])
      events = []
      unsubscribeEvents = f.host.subscribeEvents?.(event => events.push(event))
    })
    afterEach(async () => { unsubscribeEvents?.(); unsubscribeEvents = undefined; await f?.cleanup() })
    it('observes provider takeover and rejects a reply based on stale user input', async () => {
      await send()
      await f.driver.typeInProvider(sessionId, 'Typed in the provider')
      await expect.poll(async () => (await thread()).messages.some(m => m.role === 'user' && m.text === 'Typed in the provider' && m.commandId === undefined)).toBe(true)
      // Takeover is an event source like any other: what was typed in the provider is added, unasked.
      if (f.host.subscribeEvents) {
        expect(added().some(message => message.role === 'user' && message.text === 'Typed in the provider' && message.commandId === undefined)).toBe(true)
      }
      await expect(f.host.execute({ type: 'send', threadId: sessionId, commandId: randomUUID(), messageId: 'stale-reply', text: 'Stale reply', expectedLastUserMessageId: 'own-message' })).rejects.toThrow('changed')
    })
    it('creates projects and threads, streams replies, and transitions running to idle', async () => {
      expect((await f.host.snapshot()).projects).toContainEqual({ id: f.projectId, title: 'Project', path: f.root })
      expect(await thread()).toMatchObject({ title: 'Contract thread', status: 'idle', modelId: f.modelId })
      const snapshots: AgentHostSnapshot[] = []
      const unsubscribe = f.host.subscribe(s => snapshots.push(s))
      expect(await send()).toEqual({ accepted: true })
      await expect.poll(async () => (await thread()).status).toBe('running')
      expect((await thread()).messages).toContainEqual(expect.objectContaining({ id: 'own-message', role: 'user', commandId: expect.any(String) }))
      await f.driver.completeTurn(sessionId, 'Completed reply')
      await expect.poll(async () => (await thread()).status).toBe('idle')
      expect(snapshots.some(s => s.threads.some(t => t.messages.some(m => m.text === 'Completed reply')))).toBe(true)
      unsubscribe()
      if (!f.host.subscribeEvents) return
      // The prompt and the reply each reached the record once, through the adapter's own append path.
      expect(added().filter(message => message.id === 'own-message' && message.role === 'user')).toHaveLength(1)
      const reply = added().filter(message => message.role === 'assistant')
      const appended = events.filter(event => event.threadId === sessionId && event.event.kind === 'message-text-appended')
      // A fixture that streams its reply says so in appends; one that answers in a single frame adds it whole.
      expect(reply.length + appended.length).toBeGreaterThan(0)
      const text = [...reply.map(message => message.text), ...appended.map(event => (event.event as Extract<ThreadHostEvent['event'], { kind: 'message-text-appended' }>).appendText)].join('')
      expect(text).toContain('Completed reply')
      expect(kinds()).not.toContain('answer-given')
    })
    it('cancels a running turn', async () => {
      await send()
      expect(await f.host.execute({ type: 'interrupt', commandId: randomUUID(), threadId: sessionId })).toEqual({ accepted: true })
      await expect.poll(async () => (await thread()).status).toBe('idle')
    })
    it('keeps confirmed background work past the end of its turn until the provider ends it, and never restores it', async context => {
      const work = f.driver.backgroundWork
      if (!work) { context.skip(); return }
      await send()
      await work.completeLeaving(sessionId, 'Started a background agent', 'Review the diff')
      await expect.poll(async () => (await thread()).backgroundWork?.map(task => [task.label, task.type])).toEqual([['Review the diff', 'subagent']])
      expect((await thread()).status).toBe('idle')
      expect((await thread()).monitoring ?? []).toEqual([])
      await work.end(sessionId)
      await expect.poll(async () => (await thread()).backgroundWork ?? []).toEqual([])
      if (f.skips?.restart) return
      await send()
      await work.completeLeaving(sessionId, 'Started another', 'Review the tests')
      await expect.poll(async () => (await thread()).backgroundWork?.length).toBe(1)
      // A restart starts a new process: whatever it was running is the provider's to report again, not Sotto's to remember.
      f = await f.driver.restart(); f.host.observeThreads?.([sessionId]); await f.host.connect()
      expect((await thread()).backgroundWork ?? []).toEqual([])
    })
    it('routes a question and delivers its answer', async () => {
      await send(); await f.driver.raiseQuestion(sessionId, 'Which color?')
      await expect.poll(async () => (await thread()).requests.length).toBe(1)
      const request = (await thread()).requests[0]!
      expect(request).toMatchObject({ kind: 'question', text: 'Which color?' })
      await f.host.execute({ type: 'answer', commandId: randomUUID(), threadId: sessionId, requestId: request.id, answer: 'Blue' })
      expect((await thread()).requests).toEqual([])
      await expect.poll(async () => JSON.stringify(await f.driver.requests())).toContain('Blue')
    })
    it.each([true, false])('delivers an explicit permission decision (%s)', async approved => {
      await send(); await f.driver.raisePermission(sessionId, 'Run build?')
      await expect.poll(async () => (await thread()).requests.length).toBe(1)
      const request = (await thread()).requests[0]!
      expect(request.kind).toBe('permission')
      await f.host.execute({ type: 'answer', commandId: randomUUID(), threadId: sessionId, requestId: request.id, answer: '', approved })
      await expect.poll(async () => (await f.driver.requests()).some(r => permissionDecision(r) === approved)).toBe(true)
      expect((await thread()).requests).toEqual([])
    })
    it('never approves a skipped permission when interrupted and disconnected', async () => {
      await send(); await f.driver.raisePermission(sessionId, 'Skipped permission')
      await expect.poll(async () => (await thread()).requests.length).toBe(1)
      await f.host.execute({ type: 'interrupt', commandId: randomUUID(), threadId: sessionId })
      f.host.disconnect()
      expect((await f.driver.requests()).some(r => permissionDecision(r) === true)).toBe(false)
    })
    it('reconciles an uncertain prompt acknowledgement without resending', async context => {
      if (f.skips?.uncertain) { context.skip(); return }
      const method = f.protocol?.promptMethod ?? 'turn/start'
      await f.driver.delayNextAck(method)
      expect(await send()).toEqual({ accepted: false, uncertain: true })
      await expect.poll(async () => (await thread()).messages.filter(m => m.id === 'own-message').length).toBe(1)
      expect((await f.driver.requests()).filter(r => r.method === method)).toHaveLength(1)
    })
    it('resumes the same thread and messages after restart during a run', async context => {
      if (f.skips?.restart) { context.skip(); return }
      await send(); const before = await thread()
      f = await f.driver.restart(); f.host.observeThreads?.([sessionId]); await f.host.connect()
      // Some protocols restore transcript but cannot prove the previous turn outcome.
      // Optional live observation metadata must not be invented to satisfy replay equality:
      // that includes the turn records Sotto writes for providers that report none.
      const watched = (thread: { activities?: AgentActivity[] | undefined }): void => {
        const rows = (thread.activities ?? []).filter(record => record.kind !== 'turn')
        if (rows.length) thread.activities = rows; else delete thread.activities
      }
      const beforeCore = { ...before }; delete beforeCore.lastTurn; watched(beforeCore)
      const restored = await thread(); delete restored.lastTurn; watched(restored)
      expect(restored).toEqual({ ...beforeCore, status: f.restartStatus ?? before.status })
      expect((await f.driver.requests()).some(r => r.method === (f.protocol?.resumeMethod ?? 'thread/resume'))).toBe(true)
    })
  })

  // Lazy provider sessions. Sotto is not managing threads in the beta (ADR-0012), so the watched set is
  // mostly the thread on screen; everything else waits for an action.
  describe(`${name} lazy provider sessions`, () => {
    let f: AdapterFixture
    let sessionId: string
    // Short enough to watch a sweep happen, and asserted on the stop itself rather than on elapsed time.
    // The window still has to outlast the setup between creating a thread and watching it.
    const impatient = { reaperSweepMs: 20, sessionIdleMs: 150 }
    const thread = async (id: string) => (await f.host.snapshot()).threads.find(t => t.id === id)!
    const create = async (title: string): Promise<string> => {
      const id = randomUUID()
      await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title })
      return id
    }
    const send = (id: string, messageId: string, text: string) =>
      f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId, text })
    const starts = (id: string) => f.sessions!.starts(id)
    const stopped = (id: string) => f.sessions!.stopped(id)
    // The sweep is 20 ms and the idle window 150 ms, so a stop is quick on an idle machine. On a
    // loaded runner the history read that precedes it can still be in flight, and the session is not
    // idle until it lands: the assertion is the stop itself, so the deadline is generous and costs
    // nothing when it is never reached (AGENTS.md, "Waiting is not the assertion").
    const untilStopped = (id: string) => expect.poll(async () => stopped(id), { timeout: 12_000 })
    /** Build the fixture and one saved thread. False when this fixture has no provider session to watch. */
    const open = async (session?: AdapterSessionOptions): Promise<boolean> => {
      f = await factory(session); await f.host.connect()
      if (f.skips?.lazy || !f.sessions) return false
      await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
      sessionId = await create('Lazy thread')
      return true
    }
    /** A fresh run over the same saved threads, watching none of them. */
    const reconnect = async (): Promise<void> => { f = await f.driver.restart(); await f.host.connect() }
    afterEach(async () => { await f?.cleanup() })

    it('connects without starting a session, and starts one when the thread enters the watched set', async context => {
      if (!await open()) { context.skip(); return }
      const before = await starts(sessionId)
      await reconnect()
      expect(await starts(sessionId)).toBe(before)
      expect(await thread(sessionId)).toMatchObject({ title: 'Lazy thread', status: 'idle' })
      f.host.observeThreads?.([sessionId])
      await expect.poll(async () => starts(sessionId)).toBe(before + 1)
    })

    it('starts a session for an action on a thread nobody is watching', async context => {
      if (!await open()) { context.skip(); return }
      const before = await starts(sessionId)
      await reconnect()
      expect(await send(sessionId, 'unwatched-send', 'Synthetic prompt')).toEqual({ accepted: true })
      expect(await starts(sessionId)).toBe(before + 1)
    })

    it('stops a session left idle and starts it again on the next send, with its messages', async context => {
      if (!await open(impatient)) { context.skip(); return }
      f.host.observeThreads?.([sessionId])
      await send(sessionId, 'kept-message', 'Synthetic prompt')
      await f.driver.completeTurn(sessionId, 'Completed reply')
      await expect.poll(async () => (await thread(sessionId)).status).toBe('idle')
      const before = await starts(sessionId)
      f.host.observeThreads?.([])
      await untilStopped(sessionId).toBe(true)
      // The thread keeps its place and its idle status. Its messages went back to the event store, so
      // what the adapter still carries for it is its summary (issue #120).
      expect(await thread(sessionId)).toMatchObject({ status: 'idle' })
      if (f.host.subscribeEvents) {
        await expect.poll(async () => (await thread(sessionId)).messages).toEqual([])
        expect((await thread(sessionId)).summary?.messageCount).toBeGreaterThan(0)
      } else expect((await thread(sessionId)).messages.map(m => m.id)).toContain('kept-message')
      expect(await send(sessionId, 'after-stop', 'Second prompt')).toEqual({ accepted: true })
      expect(await starts(sessionId)).toBe(before + 1)
    })

    it('never stops a session with a running turn, while an idle one beside it is stopped', async context => {
      if (!await open(impatient)) { context.skip(); return }
      f.host.observeThreads?.([sessionId])
      await send(sessionId, 'running-turn', 'Synthetic prompt')
      await expect.poll(async () => (await thread(sessionId)).status).toBe('running')
      const quiet = await create('Quiet thread')
      f.host.observeThreads?.([])
      await untilStopped(quiet).toBe(true)
      expect(await stopped(sessionId)).toBe(false)
    })

    it('hands the history to the event store, which answers for a thread nobody is watching', async context => {
      if (!await open(impatient)) { context.skip(); return }
      if (!f.host.subscribeEvents) { context.skip(); return }
      const workspace = new WorkspaceHost(f.host, join(f.root, 'sotto-workspace'))
      try {
        await workspace.initialize()
        workspace.observeThreads([sessionId])
        await send(sessionId, 'stored-message', 'Synthetic prompt')
        await f.driver.completeTurn(sessionId, 'Completed reply')
        await expect.poll(() => workspace.threadMessages(sessionId).map(m => m.id)).toContain('stored-message')
        workspace.observeThreads([])
        await untilStopped(sessionId).toBe(true)
        // The adapter is holding nothing for it, and the store answers for it in full.
        await expect.poll(async () => (await thread(sessionId)).messages).toEqual([])
        expect(workspace.threadMessages(sessionId).map(m => m.id)).toContain('stored-message')
        expect(workspace.threadMessages(sessionId).some(m => m.text.includes('Completed reply'))).toBe(true)
      } finally { workspace.dispose() }
    })

    it('never stops a watched session, while an unwatched one beside it is stopped', async context => {
      if (!await open(impatient)) { context.skip(); return }
      f.host.observeThreads?.([sessionId])
      const quiet = await create('Quiet thread')
      await untilStopped(quiet).toBe(true)
      expect(await stopped(sessionId)).toBe(false)
    })
  })
}
