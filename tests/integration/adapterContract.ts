// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentHost, AgentHostResult, ThreadHostEvent } from '../../src/main/agents/host'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import type { AgentActivity } from '../../src/shared/agentActivity'
import type { AgentHostSnapshot, AgentRuntimeMode, AgentThread } from '../../src/shared/agents'
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
  /**
   * Sotto's side writing on this provider's own client (ADR-0026): script the next answer, and read back
   * what each side call was given. Absent where the provider writes nothing, whose adapter answers null.
   */
  sideWriting?: {
    answer(text: string): Promise<void>
    calls(): Promise<{ cwd: string; model: string | undefined; material: string }[]>
  }
  /**
   * Where a provider applies thread settings to its running session in place (#317): script how it answers
   * settings requests from now on (refuse them, lose the answer, or answer normally), and read what the running
   * session would use for its next turn and which process that is. Absent where a provider does not.
   */
  liveSettings?: {
    refuse(): Promise<void>
    silence(): Promise<void>
    answer(): Promise<void>
    effective(threadId: string): Promise<{ process: number; modelId: string; reasoningEffort?: string; runtimeMode: string }>
  }
  /**
   * What a thread settings change hands back (#318). `snapshot`: a change the provider confirmed comes back with
   * the snapshot the adapter emitted for it; absent, a result may leave it out and the coordinator reads the
   * thread instead. `loseConfirmation`: script the next settings change's confirmation away, where the fixture can.
   */
  settings?: { snapshot: boolean; loseConfirmation?(): Promise<void> }
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
    it('writes short text on the side, and the thread\'s own session never hears of it (ADR-0026)', async () => {
      await send()
      await f.driver.completeTurn(sessionId, 'Completed reply')
      await expect.poll(async () => (await thread()).status).toBe('idle')
      const messages = (await thread()).messages.map(message => message.id)
      const published = events.length
      const prompt = { instruction: 'Name this coding conversation in a few words.', material: 'First message:\nSide-writing marker 7c1f' }
      if (!f.sideWriting) {
        // A provider with no one-shot path writes nothing, and says so without failing.
        await expect(f.host.writeShortText?.(sessionId, prompt) ?? Promise.resolve(null)).resolves.toBeNull()
        return
      }
      await f.sideWriting.answer('Contract title')
      await expect(f.host.writeShortText!(sessionId, prompt)).resolves.toBe('Contract title')
      const calls = await f.sideWriting.calls()
      expect(calls).toHaveLength(1)
      // The thread's own model, in the thread's own folder, carrying the material it was given.
      expect(calls[0]!.model).toBe(f.modelId)
      expect((await realpath(calls[0]!.cwd)).toLowerCase()).toBe((await realpath(f.root)).toLowerCase())
      expect(calls[0]!.material).toContain('Side-writing marker 7c1f')
      // Nothing of it reached the thread: no traffic on its session, no message, no event.
      expect(JSON.stringify(await f.driver.requests())).not.toContain('Side-writing marker 7c1f')
      expect((await thread()).messages.map(message => message.id)).toEqual(messages)
      expect(events.slice(published).filter(event => event.threadId === sessionId).map(event => event.event.kind)).toEqual([])
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

  // Thread settings on a live session (#317). A change reaches the running session in place; a provider that
  // refuses it falls back to starting the session again; a lost answer is left for the coordinator's saved
  // intent to reconcile. Runs where the fixture offers `liveSettings`.
  describe(`${name} settings on a live session`, () => {
    let f: AdapterFixture
    let sessionId: string
    type Change = { reasoningEffort?: string; runtimeMode?: AgentRuntimeMode }
    const thread = async () => (await f.host.snapshot()).threads.find(t => t.id === sessionId)!
    const configure = (change: Change) => f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: sessionId, ...change })
    /** One chip press each: an effort level and a permission mode the thread is not on, from what its model offers. */
    const changes = async (): Promise<Change[]> => {
      const current = await thread()
      const model = (await f.host.snapshot()).models.find(candidate => candidate.id === current.modelId)!
      const reasoningEffort = model.reasoningEfforts?.find(level => level !== current.reasoningEffort)
      const runtimeMode = (['auto-accept-edits', 'auto', 'approval-required'] as const).find(mode => mode !== current.runtimeMode && model.runtimeModes?.includes(mode))
      return [...(reasoningEffort ? [{ reasoningEffort }] : []), ...(runtimeMode ? [{ runtimeMode }] : [])]
    }
    const shown = (result: AgentHostResult) => result.snapshot?.threads.find(t => t.id === sessionId)
    /** A thread whose session is running. False when this fixture does not apply settings in place. */
    const open = async (): Promise<boolean> => {
      f = await factory(); await f.host.connect()
      if (!f.liveSettings || !f.sessions) return false
      await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
      sessionId = randomUUID()
      await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: sessionId, projectId: f.projectId, modelId: f.modelId, title: 'Settings thread' })
      f.host.observeThreads?.([sessionId])
      await f.host.refreshThread?.(sessionId)
      return true
    }
    afterEach(async () => { await f?.cleanup() })

    it('applies each change to the running session without starting another', async context => {
      if (!await open()) { context.skip(); return }
      const starts = await f.sessions!.starts(sessionId)
      const { process } = await f.liveSettings!.effective(sessionId)
      const presses = await changes()
      expect(presses.length).toBeGreaterThan(0)
      for (const press of presses) {
        const result = await configure(press)
        expect(result.accepted).toBe(true)
        // The snapshot handed back is the one the change produced, so the coordinator need not read again.
        expect(shown(result)).toMatchObject(press)
        expect(await thread()).toMatchObject(press)
      }
      expect(await f.liveSettings!.effective(sessionId)).toMatchObject({ process, ...Object.assign({}, ...presses) })
      expect(await f.sessions!.starts(sessionId)).toBe(starts)
    })

    it('starts the session again when the provider refuses a change, and still ends accepted', async context => {
      if (!await open()) { context.skip(); return }
      const starts = await f.sessions!.starts(sessionId)
      const { process } = await f.liveSettings!.effective(sessionId)
      const [press] = await changes()
      await f.liveSettings!.refuse()
      const result = await configure(press!)
      expect(result.accepted).toBe(true)
      expect(shown(result)).toMatchObject(press!)
      expect(await f.sessions!.starts(sessionId)).toBe(starts + 1)
      const effective = await f.liveSettings!.effective(sessionId)
      expect(effective).toMatchObject(press!)
      expect(effective.process).not.toBe(process)
    })

    it('leaves a change whose answer was lost unconfirmed, until the session that runs it starts', async context => {
      if (!await open()) { context.skip(); return }
      const before = await thread()
      const [press] = await changes()
      await f.liveSettings!.silence()
      // No snapshot: an uncertain result is reconciled from the coordinator's saved intent, never accepted.
      expect(await configure(press!)).toEqual({ accepted: false, uncertain: true })
      expect(await thread()).toMatchObject({ reasoningEffort: before.reasoningEffort, runtimeMode: before.runtimeMode })
      await f.liveSettings!.answer()
      // Nothing is resent: the next session carries the change, and the thread shows it from then on, which is
      // what the saved intent reconciles against.
      await f.host.refreshThread?.(sessionId)
      await expect.poll(async () => thread()).toMatchObject(press!)
      expect(await f.liveSettings!.effective(sessionId)).toMatchObject(press!)
    })

    it('applies a change while background work runs, and the work carries on', async context => {
      if (!await open() || !f.driver.backgroundWork) { context.skip(); return }
      await f.host.execute({ type: 'send', threadId: sessionId, commandId: randomUUID(), messageId: 'own-message', text: 'Synthetic prompt' })
      await f.driver.backgroundWork.completeLeaving(sessionId, 'Started a background agent', 'Review the diff')
      await expect.poll(async () => (await thread()).backgroundWork?.length).toBe(1)
      await expect.poll(async () => (await thread()).status).toBe('idle')
      const starts = await f.sessions!.starts(sessionId)
      const [press] = await changes()
      expect((await configure(press!)).accepted).toBe(true)
      expect(await thread()).toMatchObject(press!)
      expect((await thread()).backgroundWork?.map(task => task.label)).toEqual(['Review the diff'])
      expect(await f.sessions!.starts(sessionId)).toBe(starts)
      // A refused change would need a restart, which would end the work, so it is refused and nothing changes.
      await f.liveSettings!.refuse()
      const settled = await thread()
      const [again] = await changes()
      await expect(configure(again!)).rejects.toThrow('still running')
      expect(await thread()).toMatchObject({ reasoningEffort: settled.reasoningEffort, runtimeMode: settled.runtimeMode })
      expect((await thread()).backgroundWork).toHaveLength(1)
      expect(await f.sessions!.starts(sessionId)).toBe(starts)
    })
  })

  // Thread settings results (#318): what a settings change hands back for the coordinator to reconcile against,
  // on every adapter. The section above covers how a live session takes the change.
  describe(`${name} thread settings result`, () => {
    let f: AdapterFixture
    let sessionId: string
    type Settings = Pick<AgentThread, 'modelId' | 'reasoningEffort' | 'runtimeMode' | 'providerMode'>
    /** Connect and make one watched thread. */
    const open = async (): Promise<void> => {
      await f.host.connect()
      await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
      sessionId = randomUUID()
      await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: sessionId, projectId: f.projectId, modelId: f.modelId, title: 'Settings thread' })
      f.host.observeThreads?.([sessionId])
    }
    beforeEach(async () => { f = await factory() })
    afterEach(async () => { await f?.cleanup() })
    /** A permission setting this thread is not on: the provider's own mode where it names its own, otherwise one of Sotto's. */
    const change = async (): Promise<Partial<Settings> | undefined> => {
      await open()
      const snapshot = await f.host.snapshot()
      const current = snapshot.threads.find(thread => thread.id === sessionId)!
      if (!snapshot.capabilities.configureThread) return undefined
      const model = snapshot.models.find(item => item.id === current.modelId)
      const providerMode = model?.providerModes?.find(mode => mode.id !== current.providerMode)
      if (providerMode) return { providerMode: providerMode.id }
      const runtimeMode = model?.runtimeModes?.find(mode => mode !== current.runtimeMode)
      return runtimeMode ? { runtimeMode } : undefined
    }
    const settingsOf = (thread: AgentThread | undefined): Settings => ({ modelId: thread?.modelId ?? '', reasoningEffort: thread?.reasoningEffort,
      runtimeMode: thread?.runtimeMode, providerMode: thread?.providerMode })

    it('hands back the snapshot of a confirmed change, carrying the settings the adapter reports', async context => {
      const requested = await change()
      if (!requested) { context.skip(); return }
      const result = await f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: sessionId, ...requested })
      expect(result.accepted).toBe(true)
      expect(result.uncertain).toBeFalsy()
      if (f.settings?.snapshot) expect(result.snapshot).toBeDefined()
      if (!result.snapshot) return
      // What came back shows the change, and is what the adapter goes on to report: it can stand in for a read.
      const handed = result.snapshot.threads.find(thread => thread.id === sessionId)
      expect(handed).toMatchObject(requested)
      expect(settingsOf(handed)).toEqual(settingsOf((await f.host.snapshot()).threads.find(thread => thread.id === sessionId)))
    })

    it('carries no snapshot on an uncertain change', async context => {
      if (!f.settings?.loseConfirmation) { context.skip(); return }
      const requested = await change()
      if (!requested) { context.skip(); return }
      await f.settings.loseConfirmation()
      const result = await f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: sessionId, ...requested })
      expect(result).toEqual({ accepted: false, uncertain: true })
    })
  })
}

/** The same provider behavior at the client boundary. Unlike AgentHost, HostService owns message and
 * command IDs and creates a native session only on first send, so its contract uses returned IDs. */
export interface HostServiceFixture {
  client?: import('../../src/main/agents/hostService').ClientIdentity
  service: import('../../src/main/agents/hostService').HostService
  provider: import('../../src/shared/agents').ProviderId
  root: string
  modelId: string
  driver: Omit<AdapterFixture['driver'], 'restart'> & { restart(): Promise<HostServiceFixture> }
  sessions?: AdapterFixture['sessions']
  nativeStarted(threadId: string): Promise<boolean>
  protocol?: AdapterFixture['protocol']
  skips?: AdapterFixture['skips']
  cleanup(): Promise<void>
}

export function describeHostServiceContract(name: string, factory: (session?: AdapterSessionOptions) => Promise<HostServiceFixture>): void {
  describe(name + ' host service contract', () => {
    let f: HostServiceFixture
    let threadId: string
    let projectId: string
    const client = { clientId: 'desktop-window', user: 'host-contract', transport: 'ipc' } as const
    const command = async (value: import('../../src/shared/agents').AgentCommand) => f.service.command(value, client)
    const thread = (id = threadId) => f.service.state().host.threads.find(item => item.id === id)!
    const send = (text = 'Synthetic prompt', id = threadId) => command({ type: 'manual-send', threadId: id, text })
    const create = async (title: string): Promise<string> => {
      const id = randomUUID()
      const state = await command({ type: 'create-thread', threadId: id, projectId, title, modelId: f.modelId, workingCopy: 'shared', managed: false })
      expect(state.error).toBeNull()
      return id
    }
    const permissionDecision = (record: RecordedRpc): boolean | undefined => f.protocol
      ? f.protocol.permissionDecision(record)
      : record.result?.decision === 'accept' ? true : record.result?.decision === 'decline' ? false : undefined
    beforeEach(async () => {
      f = await factory({ reaperSweepMs: 20, sessionIdleMs: 150 })
      expect((await command({ type: 'connect', provider: f.provider })).error).toBeNull()
      const state = await command({ type: 'create-project', provider: f.provider, title: 'Contract project', path: f.root, useExisting: true })
      expect(state.error).toBeNull()
      projectId = state.host.projects.find(project => project.path === f.root)!.id
      threadId = await create('Contract thread')
      await command({ type: 'observe-threads', threadIds: [threadId] })
    })
    afterEach(async () => { await f?.cleanup() })

    it('creates and streams through Sotto identities and exposes the event history', async () => {
      expect(await f.nativeStarted(threadId)).toBe(false)
      expect((await send()).error).toBeNull()
      expect(thread().status).toBe('running')
      await f.driver.completeTurn(threadId, 'Completed reply')
      await expect.poll(() => thread().status).toBe('idle')
      await expect.poll(() => f.service.threadDetail(threadId)?.messages.some(message => message.text.includes('Completed reply'))).toBe(true)
      expect(f.service.events(0, threadId).some(event => event.event.kind === 'message-added')).toBe(true)
      expect(f.service.shell().host.threads.every(item => item.messages.length === 0)).toBe(true)
    })

    it('observes provider takeover without inventing a Sotto command for native user input', async () => {
      await send()
      await f.driver.typeInProvider(threadId, 'Typed in the provider')
      await expect.poll(() => thread().messages.some(message => message.role === 'user' && message.text === 'Typed in the provider' && message.commandId === undefined)).toBe(true)
    })

    it('delivers a question answer', async () => {
      await send(); await f.driver.raiseQuestion(threadId, 'Which color?')
      await expect.poll(() => thread().requests.length).toBe(1)
      const request = thread().requests[0]!
      expect(request.kind).toBe('question')
      expect((await command({ type: 'answer', threadId, requestId: request.id, answer: 'Blue' })).error).toBeNull()
      await expect.poll(async () => JSON.stringify(await f.driver.requests())).toContain('Blue')
      expect(thread().requests).toEqual([])
    })

    it.each([true, false])('records an explicit permission answer (%s) with the client identity', async approved => {
      await send(); await f.driver.raisePermission(threadId, 'Run build?')
      await expect.poll(() => thread().requests.length).toBe(1)
      const request = thread().requests[0]!
      expect((await command({ type: 'answer', threadId, requestId: request.id, answer: '', approved })).error).toBeNull()
      await expect.poll(async () => (await f.driver.requests()).some(record => permissionDecision(record) === approved)).toBe(true)
      expect(f.service.events(0, threadId)).toContainEqual(expect.objectContaining({
        event: expect.objectContaining({ kind: 'answer-given', approved, attribution: f.client ?? client }),
      }))
    })

    it('cancels without approving a skipped permission', async () => {
      await send(); await f.driver.raisePermission(threadId, 'Skipped permission')
      await expect.poll(() => thread().requests.length).toBe(1)
      await command({ type: 'interrupt', threadId })
      await command({ type: 'disconnect', provider: f.provider })
      expect((await f.driver.requests()).some(record => permissionDecision(record) === true)).toBe(false)
    })

    it('reconciles a lost prompt acknowledgement without resending', async context => {
      if (f.skips?.uncertain) { context.skip(); return }
      const method = f.protocol?.promptMethod ?? 'turn/start'
      await f.driver.delayNextAck(method)
      await send()
      await expect.poll(() => thread().messages.filter(message => message.role === 'user' && message.text === 'Synthetic prompt').length).toBe(1)
      expect((await f.driver.requests()).filter(record => record.method === method)).toHaveLength(1)
    })

    it('keeps the same thread and saved messages across host restart during a run', async context => {
      if (f.skips?.restart) { context.skip(); return }
      await send()
      const before = thread().messages
      const identity = f.service.state().hostId
      f = await f.driver.restart()
      await command({ type: 'observe-threads', threadIds: [threadId] })
      await command({ type: 'connect', provider: f.provider })
      await expect.poll(() => thread().messages).toEqual(before)
      expect(f.service.state().hostId).toBe(identity)
      expect(thread().id).toBe(threadId)
    })

    it('reaps an unwatched idle session beside a running one and resumes it on send with its history', async context => {
      if (!f.sessions || f.skips?.lazy) { context.skip(); return }
      await send()
      await expect.poll(() => thread().status).toBe('running')
      const runningStarts = await f.sessions.starts(threadId)
      const quiet = await create('Quiet thread')
      await send('Quiet prompt', quiet)
      await f.driver.completeTurn(quiet, 'Quiet reply')
      await expect.poll(() => thread(quiet).status).toBe('idle')
      await command({ type: 'select-thread', threadId })
      await command({ type: 'observe-threads', threadIds: [threadId] })
      const starts = await f.sessions.starts(quiet)
      await expect.poll(() => f.sessions!.stopped(quiet)).toBe(true)
      expect(thread().status).toBe('running')
      expect(await f.sessions.starts(threadId)).toBe(runningStarts)
      expect(f.service.events(0, quiet).some(event => event.event.kind === 'message-added')).toBe(true)
      expect((await send('After reaping', quiet)).error).toBeNull()
      await expect.poll(() => f.sessions!.starts(quiet)).toBeGreaterThan(starts)
      await command({ type: 'select-thread', threadId: quiet })
      await command({ type: 'observe-threads', threadIds: [quiet] })
      await expect.poll(() => f.service.threadDetail(quiet)?.messages.some(message => message.text === 'Quiet prompt')).toBe(true)
    })
  })
}
