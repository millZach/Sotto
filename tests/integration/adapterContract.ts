// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, type TestContext } from 'vitest'
import type { AgentHostResult, ThreadHostEvent } from '../../src/main/agents/host'
import { lendSendStages, SendStageClock } from '../../src/main/agents/sendStages'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import type { AgentActivity } from '../../src/shared/agentActivity'
import type { AgentHostSnapshot, AgentRuntimeMode, AgentThread } from '../../src/shared/agents'
import { resolveModel } from '../../src/shared/modelCatalog'
import type { ThreadEventKind } from '../../src/shared/threadEvents'
import type { AdapterContractSkips, AdapterFixture, AdapterSessionOptions, RecordedRpc } from '../fixtures/adapterFixture'
import { skipUnsupportedFixture, withFixtureSkip } from '../fixtures/contractSkip'
import { handleOf, PIXEL_PNG } from '../fixtures/stagedImages'

/** New provider adapters must pass these behavioural checks with observable fake effects. */
export function describeAdapterContract(name: string, factory: (session?: AdapterSessionOptions) => Promise<AdapterFixture>, skips: AdapterContractSkips): void {
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
    beforeEach(async context => {
      skipUnsupportedFixture(context)
      f = await factory(); await f.host.connect()
      await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
      sessionId = randomUUID()
      await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: sessionId, projectId: f.projectId, modelId: f.modelId, title: 'Contract thread' })
      // A thread holds its messages while something is looking at it, so every case here opens it first.
      f.host.observeThreads?.([sessionId])
      events = []
      unsubscribeEvents = f.host.subscribeEvents?.(event => events.push(event))
    })
    afterEach(async () => { unsubscribeEvents?.(); unsubscribeEvents = undefined; const previous = f; f = undefined!; await previous?.cleanup() })
    it('keeps ordinary permissions when main supplies no command-center profile', async context => {
      if (!f.host.useLaunchProfiles) { context.skip(); return }
      f.host.useLaunchProfiles({ profileFor: async () => undefined })
      const before = await thread()
      expect(await send()).toEqual({ accepted: true })
      await f.driver.raisePermission(sessionId, 'Ordinary permission')
      await expect.poll(async () => (await thread()).requests.some(request => request.kind === 'permission')).toBe(true)
      const request = (await thread()).requests.find(request => request.kind === 'permission')!
      expect(await f.host.execute({ type: 'answer', threadId: sessionId, commandId: randomUUID(), requestId: request.id,
        answer: 'Allow once', approved: true })).toMatchObject({ accepted: true })
      expect((await thread()).runtimeMode).toBe(before.runtimeMode)
      await expect.poll(async () => (await f.driver.requests()).some(record => permissionDecision(record) === true)).toBe(true)
    })
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
    it('marks the prompt written and its acknowledgement on the stopwatch lent for the send (#763)', withFixtureSkip(skips.sendStages), async () => {
      const commandId = randomUUID()
      const stages = new SendStageClock()
      const endLoan = lendSendStages(commandId, stages)
      try { expect(await f.host.execute({ type: 'send', threadId: sessionId, commandId, messageId: 'own-message', text: 'Synthetic prompt' })).toEqual({ accepted: true }) }
      finally { endLoan() }
      expect([stages.has('written'), stages.has('acknowledged')]).toEqual([true, true])
      expect(stages.durations().acknowledgementMs).toEqual(expect.any(Number))
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
      await expect.poll(() => snapshots.some(s => s.threads.some(t => t.messages.some(m => m.text === 'Completed reply')))).toBe(true)
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
    it('leaves a watched thread\'s messages out of the activity publications of a subscriber that keeps history from events (#322)', withFixtureSkip(skips.activitySnapshots ?? skips.threadEvents), async () => {
      const fromEvents: AgentHostSnapshot[] = []
      const whole: AgentHostSnapshot[] = []
      const offEvents = f.host.subscribeActivitySnapshots!(snapshot => fromEvents.push(snapshot), { historyFromEvents: true })
      const offWhole = f.host.subscribeActivitySnapshots!(snapshot => whole.push(snapshot))
      try {
        await send()
        await f.driver.completeTurn(sessionId, 'Completed reply')
        await expect.poll(async () => (await thread()).status).toBe('idle')
        await expect.poll(() => fromEvents.at(-1)?.threads.find(t => t.id === sessionId)?.summary?.lastAssistant?.text ?? '').toContain('Completed reply')
        // Every message already reached the subscriber as an event, so no publication to it copied one.
        const carried = fromEvents.flatMap(snapshot => snapshot.threads.filter(t => t.id === sessionId))
        expect(carried.length).toBeGreaterThan(0)
        expect(carried.every(t => t.messages.length === 0)).toBe(true)
        expect(added().map(message => message.id)).toContain('own-message')
        // A subscriber that reads messages from its snapshots, and the public snapshot, still get them.
        expect(whole.at(-1)?.threads.find(t => t.id === sessionId)?.messages.map(message => message.id)).toContain('own-message')
        expect((await thread()).messages.map(message => message.id)).toContain('own-message')
      } finally { offEvents(); offWhole() }
    })
    it('hands a thread refresh back without messages to a caller that keeps history from events, and with them to any other (#368)', withFixtureSkip(skips.refreshThread ?? skips.threadEvents), async () => {
      await send()
      await f.driver.completeTurn(sessionId, 'Completed reply')
      await expect.poll(async () => (await thread()).status).toBe('idle')
      const fromEvents = (await f.host.refreshThread!(sessionId, { historyFromEvents: true })).threads.find(t => t.id === sessionId)!
      expect(fromEvents.messages).toEqual([])
      expect(fromEvents.summary?.lastAssistant?.text ?? '').toContain('Completed reply')
      // Every other reader, the read before a send among them, still gets the messages, and nothing was put away.
      for (const purpose of [undefined, { beforeSend: true }]) {
        expect((await f.host.refreshThread!(sessionId, purpose)).threads.find(t => t.id === sessionId)!.messages.map(message => message.id)).toContain('own-message')
      }
      expect((await thread()).messages.map(message => message.id)).toContain('own-message')
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
    it('sends a staged image through the handle contract, reading its bytes only at the provider boundary (ADR-0031)', async () => {
      const snapshot = await f.host.snapshot()
      const supported = resolveModel(snapshot.models, f.modelId)?.supportsImages === true
      const handle = handleOf(PIXEL_PNG, 'contract-image', 'Contract.png')
      let reads = 0
      const image = { ...handle, read: async () => { reads += 1; return PIXEL_PNG } }
      const command = { type: 'send' as const, threadId: sessionId, commandId: randomUUID(), messageId: 'image-message', text: 'Look at this', attachments: [image] }
      const base64 = PIXEL_PNG.toString('base64')
      if (!supported) {
        // A provider that takes no images refuses before it hears anything, and the bytes are never read.
        await expect(f.host.execute(command)).rejects.toThrow(/image support/)
        expect(reads).toBe(0)
        expect(JSON.stringify(await f.driver.requests())).not.toContain(base64)
        return
      }
      expect(await f.host.execute(command)).toEqual({ accepted: true })
      expect(reads).toBeGreaterThan(0)
      // The provider heard the image itself, in its own form, and the thread records the handle's reference, not the bytes.
      await expect.poll(async () => JSON.stringify(await f.driver.requests()).includes(base64)).toBe(true)
      await expect.poll(async () => (await thread()).messages.find(message => message.id === 'image-message')?.attachments)
        .toEqual([{ id: handle.id, name: handle.name, mimeType: handle.mimeType, sizeBytes: handle.sizeBytes }])
      expect(JSON.stringify(await thread())).not.toContain(base64)
    })
    it('cancels a running turn', async () => {
      await send()
      expect(await f.host.execute({ type: 'interrupt', commandId: randomUUID(), threadId: sessionId })).toEqual({ accepted: true })
      await expect.poll(async () => (await thread()).status).toBe('idle')
    })
    it('keeps confirmed background work past the end of its turn until the provider ends it, and never restores it', withFixtureSkip(skips.backgroundWork), async () => {
      const work = f.driver.backgroundWork!
      await send()
      await work.completeLeaving(sessionId, 'Started a background agent', 'Review the diff')
      await expect.poll(async () => (await thread()).backgroundWork?.map(task => [task.label, task.type])).toEqual([['Review the diff', 'subagent']])
      expect((await thread()).status).toBe('idle')
      expect((await thread()).monitoring ?? []).toEqual([])
      await work.end(sessionId)
      await expect.poll(async () => (await thread()).backgroundWork ?? []).toEqual([])
      if (skips.restart) return
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
    it('reconciles an uncertain prompt acknowledgement without resending', withFixtureSkip(skips.uncertain), async () => {
      const method = f.protocol?.promptMethod ?? 'turn/start'
      await f.driver.delayNextAck(method)
      expect(await send()).toEqual({ accepted: false, uncertain: true })
      await expect.poll(async () => (await thread()).messages.filter(m => m.id === 'own-message').length).toBe(1)
      expect((await f.driver.requests()).filter(r => r.method === method)).toHaveLength(1)
    })
    it('resumes the same thread and messages after restart during a run', withFixtureSkip(skips.restart), async () => {
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
    /** Decide known capability skips before constructing a fixture, then open one saved thread. */
    const open = async (context: TestContext, session?: AdapterSessionOptions): Promise<void> => {
      if (skips.lazy) context.skip(skips.lazy)
      f = await factory(session)
      await f.host.connect()
      await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
      sessionId = await create('Lazy thread')
    }
    /** A fresh run over the same saved threads, watching none of them. */
    const reconnect = async (): Promise<void> => { f = await f.driver.restart(); await f.host.connect() }
    /**
     * Whether a thread's session is open as the host last published it. A window sees only what is published, and a
     * snapshot read works the flag out afresh, so a host that never publishes the change passes a read and not this.
     */
    const published = (id: string): { open(): boolean | undefined; wasOpen(): boolean; stop(): void } => {
      const seen: (boolean | undefined)[] = []
      const stop = f.host.subscribe(snapshot => { seen.push(snapshot.threads.find(item => item.id === id)?.providerSessionOpen) })
      return { open: () => seen.at(-1), wasOpen: () => seen.includes(true), stop }
    }
    afterEach(async () => { const previous = f; f = undefined!; await previous?.cleanup() })

    it('connects without starting a session, and starts one when the thread enters the watched set', async context => {
      await open(context)
      const before = await starts(sessionId)
      await reconnect()
      expect(await starts(sessionId)).toBe(before)
      expect(await thread(sessionId)).toMatchObject({ title: 'Lazy thread', status: 'idle' })
      f.host.observeThreads?.([sessionId])
      await expect.poll(async () => starts(sessionId)).toBe(before + 1)
    })

    it('starts a session for an action on a thread nobody is watching', async context => {
      await open(context)
      const before = await starts(sessionId)
      await reconnect()
      expect(await send(sessionId, 'unwatched-send', 'Synthetic prompt')).toEqual({ accepted: true })
      expect(await starts(sessionId)).toBe(before + 1)
    })

    // Early start (#769): the first keystroke in a thread's composer starts its session, so the send does not.
    it('starts a stopped session for an early start, says it is open, and the send that follows starts none', async context => {
      await open(context)
      await reconnect()
      const before = await starts(sessionId)
      expect((await thread(sessionId)).providerSessionOpen).toBeUndefined()
      const shown = published(sessionId)
      await f.host.startThreadSession!(sessionId)
      expect(await starts(sessionId)).toBe(before + 1)
      await expect.poll(async () => (await thread(sessionId)).providerSessionOpen).toBe(true)
      await expect.poll(() => shown.open()).toBe(true)
      shown.stop()
      expect(await send(sessionId, 'after-early-start', 'Synthetic prompt')).toEqual({ accepted: true })
      expect(await starts(sessionId)).toBe(before + 1)
    })

    it('says a session the reaper stopped after an early start is no longer open', async context => {
      await open(context, impatient)
      await reconnect()
      const shown = published(sessionId)
      await f.host.startThreadSession!(sessionId)
      await expect.poll(() => shown.wasOpen()).toBe(true)
      await untilStopped(sessionId).toBe(true)
      await expect.poll(async () => (await thread(sessionId)).providerSessionOpen).toBeUndefined()
      await expect.poll(() => shown.open()).toBeUndefined()
      shown.stop()
    })

    // A draft whose worktree its first send makes names no folder yet (`ThreadSessionDraft`).
    for (const folder of [true, false]) it(`creates no provider session for an early start before a thread’s first send${folder ? '' : ', when its folder does not exist yet'}`, async context => {
      await open(context)
      const created = async () => (await f.driver.requests()).filter(record => ['thread/start', 'session/new'].includes(record.method ?? '')).length
      const before = await created()
      const draft = randomUUID()
      await f.host.startThreadSession!(draft, { modelId: f.modelId, ...(folder ? { workingDirectory: f.root } : {}) })
      expect((await f.host.snapshot()).threads.some(item => item.id === draft)).toBe(false)
      expect(await created()).toBe(before)
      // The send that creates it afterwards is the first thing that does.
      await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: draft, projectId: f.projectId, modelId: f.modelId, title: 'Typed into first' })
      expect(await send(draft, 'first-after-early-start', 'Synthetic prompt')).toEqual({ accepted: true })
    })

    it('stops a session left idle and starts it again on the next send, with its messages', async context => {
      await open(context, impatient)
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
      await open(context, impatient)
      f.host.observeThreads?.([sessionId])
      await send(sessionId, 'running-turn', 'Synthetic prompt')
      await expect.poll(async () => (await thread(sessionId)).status).toBe('running')
      const quiet = await create('Quiet thread')
      f.host.observeThreads?.([])
      await untilStopped(quiet).toBe(true)
      expect(await stopped(sessionId)).toBe(false)
    })

    it('hands the history to the event store, which answers for a thread nobody is watching', async context => {
      if (skips.threadEvents) context.skip(skips.threadEvents)
      await open(context, impatient)
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
      await open(context, impatient)
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
    /** Decide fixture features up front, then open a thread whose session is running. */
    const open = async (context: TestContext): Promise<void> => {
      if (skips.liveSettings ?? skips.lazy) context.skip(skips.liveSettings ?? skips.lazy)
      f = await factory()
      await f.host.connect()
      await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
      sessionId = randomUUID()
      await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: sessionId, projectId: f.projectId, modelId: f.modelId, title: 'Settings thread' })
      f.host.observeThreads?.([sessionId])
      await f.host.refreshThread?.(sessionId)
    }
    afterEach(async () => { const previous = f; f = undefined!; await previous?.cleanup() })

    it('applies each change to the running session without starting another', async context => {
      await open(context)
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
      await open(context)
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
      await open(context)
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
      if (skips.liveSettings ?? skips.lazy ?? skips.backgroundWork) context.skip('The fixture must apply live settings and drive background work.')
      await open(context)
      await f.host.execute({ type: 'send', threadId: sessionId, commandId: randomUUID(), messageId: 'own-message', text: 'Synthetic prompt' })
      await f.driver.backgroundWork!.completeLeaving(sessionId, 'Started a background agent', 'Review the diff')
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
    beforeEach(async context => { skipUnsupportedFixture(context); f = await factory() })
    afterEach(async () => { const previous = f; f = undefined!; await previous?.cleanup() })
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
      if (!requested) { context.skip('The thread model offers no alternative settings.'); return }
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

    it('leaves the messages out of a confirmed change\'s snapshot for a caller that keeps history from events (#368)', withFixtureSkip(skips.threadEvents), async context => {
      const requested = await change()
      if (!requested) { context.skip('The thread model offers no alternative settings.'); return }
      await f.host.execute({ type: 'send', threadId: sessionId, commandId: randomUUID(), messageId: 'own-message', text: 'Synthetic prompt' })
      await f.driver.completeTurn(sessionId, 'Completed reply')
      await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === sessionId)?.status).toBe('idle')
      const result = await f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: sessionId, historyFromEvents: true, ...requested })
      expect(result.accepted).toBe(true)
      if (f.settings?.snapshot) expect(result.snapshot).toBeDefined()
      if (!result.snapshot) return
      const handed = result.snapshot.threads.find(thread => thread.id === sessionId)!
      expect(handed).toMatchObject(requested)
      expect(handed.messages).toEqual([])
      expect(handed.summary?.lastAssistant?.text ?? '').toContain('Completed reply')
      // The thread still holds them for every other reader.
      expect((await f.host.snapshot()).threads.find(thread => thread.id === sessionId)!.messages.map(message => message.id)).toContain('own-message')
    })

    it('carries no snapshot on an uncertain change', withFixtureSkip(skips.settingsConfirmation), async context => {
      const requested = await change()
      if (!requested) { context.skip('The thread model offers no alternative settings.'); return }
      await f.settings!.loseConfirmation!()
      const result = await f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: sessionId, ...requested })
      expect(result).toEqual({ accepted: false, uncertain: true })
    })
  })

  // A client update (ADR-0042, ADR-0038). The installer replaces the client on disk while Sotto stays connected;
  // the adapter reads the new version and moves each thread to the new client as it goes idle. Runs where the
  // adapter takes the news and the fixture can install a newer client.
  describe(`${name} client update`, () => {
    let f: AdapterFixture
    let sessionId: string
    const thread = async () => (await f.host.snapshot()).threads.find(t => t.id === sessionId)!
    const send = (messageId: string, text: string) => f.host.execute({ type: 'send', threadId: sessionId, commandId: randomUUID(), messageId, text })
    afterEach(async () => { const previous = f; f = undefined!; await previous?.cleanup() })

    it('lets a working turn finish across the update, stays connected, and reads the new version from the client', async context => {
      if (skips.clientUpdate) context.skip(skips.clientUpdate)
      f = await factory(); await f.host.connect()
      const update = f.clientUpdate!
      await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
      sessionId = randomUUID()
      await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: sessionId, projectId: f.projectId, modelId: f.modelId, title: 'Update thread' })
      f.host.observeThreads?.([sessionId])
      expect(await send('before-update', 'Synthetic prompt')).toEqual({ accepted: true })
      await expect.poll(async () => (await thread()).status).toBe('running')
      const before = (await f.host.snapshot()).version
      const starts = await f.sessions?.starts(sessionId)

      const installed = await update.install()
      await f.host.clientUpdated!(update.provider)
      const updated = await f.host.snapshot()
      expect(updated.connected).toBe(true)
      expect(updated.error).toBeUndefined()
      expect(updated.version).not.toBe(before)
      expect(updated.version).toContain(installed)
      // The working turn was not cut short, and nothing was asked or answered for it.
      expect((await thread()).status).toBe('running')
      expect((await thread()).requests).toEqual([])
      if (f.sessions) expect(await f.sessions.stopped(sessionId)).toBe(false)

      await f.driver.completeTurn(sessionId, 'Finished across the update')
      await expect.poll(async () => (await thread()).status).toBe('idle')
      expect((await thread()).messages.some(message => message.role === 'assistant' && message.text.includes('Finished across the update'))).toBe(true)
      expect((await thread()).lastTurn?.status ?? 'completed').toBe('completed')
      // Once idle the thread moves to the new client: being watched, its session starts again straight away.
      if (f.sessions && starts !== undefined) await expect.poll(async () => f.sessions!.starts(sessionId)).toBeGreaterThan(starts)
      const settled = await f.host.snapshot()
      expect(settled.connected).toBe(true)
      expect(settled.version).toContain(installed)
      expect(await send('after-update', 'Second prompt')).toEqual({ accepted: true })
    })

    it('does nothing while the provider is not connected', async context => {
      if (skips.clientUpdate) context.skip(skips.clientUpdate)
      f = await factory()
      const update = f.clientUpdate!
      await expect(f.host.clientUpdated!(update.provider)).resolves.toBeUndefined()
      expect((await f.host.snapshot()).connected).toBe(false)
    })
  })
}
