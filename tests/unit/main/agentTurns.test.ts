// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials, type CredentialEncryption } from '../../../src/main/agents/credentials'
import { ConfiguredAgentReasoner, type AgentDecision, type AgentIntent } from '../../../src/main/agents/reasoning'
import { TurnRecorder, turnRecordSchema } from '../../../src/main/agents/turns'
import { AtomicJsonStore } from '../../../src/main/storage/atomicJsonStore'
import { TrayController } from '../../../src/main/tray/trayController'
import { E2EAgentHost } from '../../../src/main/e2e/agentEffects'
import type { AgentConfiguration } from '../../../src/shared/agents'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'

const roots: string[] = []
const controls: AgentControl[] = []
const ROUTER_KEY = 'fixture-openrouter-key'

const encryption: CredentialEncryption = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(Buffer.from(value).map(byte => byte ^ 0xa5)),
  decryptString: value => Buffer.from(value.map(byte => byte ^ 0xa5)).toString('utf8'),
}

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(release => { resolve = release })
  return { promise, resolve }
}

let historyEnabled = true

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-turns-'))
  roots.push(root)
  historyEnabled = true
  const credentialsDirectory = join(root, 'vault')
  const credentials = new AgentCredentials(credentialsDirectory, encryption)
  await credentials.load()
  const service = { offline: false, intent: { type: 'select-project', projectId: 'project' } as AgentIntent,
    decision: { decision: 'followup', text: 'Fix the current failing test within the assigned scope.' } as AgentDecision,
    decisionGate: null as Promise<void> | null }
  vi.stubGlobal('fetch', async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] }
    const message = JSON.parse(body.messages[1]!.content) as { utterance?: string; messages?: { text: string }[] }
    if (service.offline) throw new TypeError('Fixture provider is offline')
    if (message.utterance === undefined) await service.decisionGate
    const result = message.utterance === undefined ? service.decision : service.intent
    return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] })
  })
  const recorder = new TurnRecorder({
    directory: root,
    historyEnabled: () => historyEnabled,
    resolveSession: id => ({ provider: 'codex', sessionId: `session-${id}` }),
  })
  const binding: { control: AgentControl } = {} as { control: AgentControl }
  const reasoner = new ConfiguredAgentReasoner(() => binding.control.get().configuration, credentials)
  const host = new E2EAgentHost()
  binding.control = new AgentControl({ schedule: immediatePublishScheduler,
    directory: root, host, credentials, reasoner, turns: recorder,
    membership: {
      status: async () => ({ status: 'beta', label: 'Fixture beta', expiresAt: null }),
      action: async () => ({ status: 'beta', label: 'Fixture beta', expiresAt: null }),
    },
  })
  const control = binding.control
  controls.push(control)
  await control.start()
  if (!control.get().host.connected) await control.command({ type: 'connect' })
  return {
    root, recorder, service, host, reasoner,
    get control() { return control },
    async account(provider: AgentConfiguration['reasoning'] = 'openrouter', key = ROUTER_KEY) {
      await control.command({ type: 'configure', patch: { reasoning: provider, reasoningModel: 'fixture-model' } })
      await control.command({ type: 'credential', slot: 'reasoning', value: key })
    },
  }
}

async function lastRawRecord(root: string) {
  const raw = await readFile(join(root, 'turns.jsonl'), 'utf8')
  const line = raw.split(/\r?\n/u).filter(entry => entry.length > 0).at(-1)
  if (!line) throw new Error('turns.jsonl has no records')
  return turnRecordSchema.parse(JSON.parse(line))
}

afterEach(async () => {
  for (const control of controls.splice(0)) control.dispose()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-turns-')) throw new Error('Unexpected temporary test directory')
    await rm(root, { recursive: true, force: true })
  }
})

describe('coordinator turn records', () => {
  it.each(['completed', 'failed'] as const)('records an immediate interrupt as %s while reasoning still owns the command lane', async outcome => {
    const f = await fixture(); await f.account()
    f.host.event({ type: 'manual', threadId: 'docs', text: 'Independent work', status: 'running' })
    await f.control.command({ type: 'select-thread', threadId: 'workshop' })
    const pendingIntent = gate()
    const intent = vi.spyOn(f.reasoner, 'intent').mockImplementation(async () => {
      await pendingIntent.promise; return { type: 'clarify', text: 'Choose the next action' }
    })
    if (outcome === 'failed') vi.spyOn(f.host, 'execute').mockRejectedValueOnce(new Error('Synthetic interrupt failure'))
    const reasoning = f.control.command({ type: 'utterance', text: 'Think about the next action' })
    try {
      await vi.waitFor(() => expect(intent).toHaveBeenCalled())
      const result = await f.control.command({ type: 'interrupt', threadId: 'docs' })
      expect(result.globalLaneBusy).toBe(true)
      expect(await lastRawRecord(f.root)).toMatchObject({ commandType: 'interrupt', source: 'command', outcome,
        threadId: 'docs', projectId: 'project', providerSessionId: 'session-docs',
        error: outcome === 'failed' ? 'Synthetic interrupt failure' : '' })
      expect((await f.recorder.recent(100)).filter(record => record.commandType === 'interrupt')).toHaveLength(1)
      if (outcome === 'completed') expect(result.host.threads.find(thread => thread.id === 'docs')?.status).toBe('idle')
    } finally { pendingIntent.resolve(); await reasoning }
  })

  it('timestamps the first confirmed-message publication before a delayed command completes', async () => {
    const f = await fixture()
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    await f.control.command({ type: 'compose', text: 'A prompt whose acknowledgement is delayed.' })
    let now = 100_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const acknowledged = gate(); const release = gate()
    const execute = f.host.execute.bind(f.host)
    vi.spyOn(f.host, 'execute').mockImplementation(async command => {
      const result = await execute(command)
      if (command.type === 'send') { acknowledged.resolve(); await release.promise }
      return result
    })
    const sending = f.control.command({ type: 'utterance', text: 'send it', voiceTiming: {
      speechEndedAt: new Date(99_000).toISOString(), phase: 'warm', basis: 'detector-frame-received',
    } })
    try {
      await acknowledged.promise
      expect(f.control.get().host.threads.find(thread => thread.id === 'workshop')?.messages.some(message => message.role === 'user')).toBe(true)
      now = 105_000
    } finally { release.resolve() }
    await sending
    const [record] = await f.recorder.recent(1)
    expect(record?.timings.speechToFirstFeedbackMs).toBe(1_000)
    expect(record?.timings.totalMs).toBe(5_000)
  })

  it('does not record a resolved intent when reasoning fails', async () => {
    const f = await fixture(); await f.account()
    f.service.offline = true
    await f.control.command({ type: 'utterance', text: 'Choose a project', voiceTiming: {
      speechEndedAt: new Date(Date.now() - 800).toISOString(), phase: 'warm', basis: 'detector-frame-received',
    } })
    const [record] = await f.recorder.recent(1)
    expect(record?.outcome).toBe('failed')
    expect(record?.timings.intentMs).toBeGreaterThanOrEqual(0)
    expect(record?.timings.speechToIntentMs).toBeNull()
  })

  it('propagates voice timing and records useful state publication without inventing acoustic timing', async () => {
    const f = await fixture()
    await f.account()
    const speechEndedAt = new Date(Date.now() - 800).toISOString()
    await f.control.command({ type: 'utterance', text: 'Choose a project', voiceTiming: {
      speechEndedAt, phase: 'cold', basis: 'detector-frame-received',
    } })
    const [record] = await f.recorder.recent(1)
    expect(record?.timings).toMatchObject({ speechEndedAt, voicePhase: 'cold', speechEndBasis: 'detector-frame-received', feedbackBasis: 'main-state-published' })
    expect(record?.timings.speechToIntentMs).toBeGreaterThanOrEqual(800)
    expect(record?.timings.speechToFirstFeedbackMs).toBeGreaterThanOrEqual(record!.timings.speechToIntentMs!)
    expect(record?.timings.retrievalCount).toBe(0)
  })

  it('keeps unavailable and invalid milestone durations null', async () => {
    const f = await fixture()
    const turn = f.recorder.begin({ source: 'utterance', commandType: 'utterance', text: '', voiceTiming: {
      speechEndedAt: new Date(Date.now() + 60_000).toISOString(), phase: 'warm', basis: 'detector-frame-received',
    } })!
    turn.intentResolvedAtMs = Date.now()
    turn.firstFeedbackAtMs = Date.now()
    await f.recorder.finish(turn, 'completed')
    const [record] = await f.recorder.recent(1)
    expect(record!.timings.speechToIntentMs).toBeNull()
    expect(record!.timings.speechToFirstFeedbackMs).toBeNull()
  })

  it('writes a completed utterance turn with Sotto thread ID and provider session ID', async () => {
    const f = await fixture()
    await f.account()
    f.service.intent = { type: 'select-thread', threadId: 'workshop' }
    await f.control.command({ type: 'utterance', text: 'Open workshop' })
    const [recent] = await f.recorder.recent(1)
    const parsed = await lastRawRecord(f.root)
    expect(recent).toEqual(parsed)
    expect(parsed).toMatchObject({
      threadId: 'workshop',
      providerSessionId: 'session-workshop',
      projectId: 'project',
      source: 'utterance',
      commandType: 'utterance',
      text: 'Open workshop',
      error: '',
      outcome: 'completed',
      retrievedMemoryIds: [],
      contextTokenEstimate: Math.ceil('Open workshop'.length / 4),
      timings: { retrievalMs: 0 },
    })
    expect(parsed.timings.totalMs).toBeGreaterThan(0)
    expect(parsed.timings.intentMs).toBeGreaterThanOrEqual(0)
  })

  it('records a failed turn with the error text', async () => {
    const f = await fixture()
    await f.control.command({ type: 'select-thread', threadId: 'workshop' })
    await f.control.command({ type: 'compose', text: '' })
    await f.control.command({ type: 'send' })
    const [record] = await f.recorder.recent(1)
    expect(record).toMatchObject({
      commandType: 'send',
      source: 'command',
      outcome: 'failed',
      error: 'There is no prompt to send.',
    })
  })

  it('redacts text and error when history is off', async () => {
    const f = await fixture()
    historyEnabled = false
    await f.control.command({ type: 'select-thread', threadId: 'workshop' })
    await f.control.command({ type: 'compose', text: '' })
    await f.control.command({ type: 'send' })
    const records = (await f.recorder.recent(10)).filter(record => record.commandType !== 'connect')
    expect(records).toHaveLength(2)
    for (const record of records) {
      expect(record.text).toBe('')
      expect(record.error).toBe('')
      expect(record.timings.totalMs).toBeGreaterThan(0)
    }
    const failed = records.find(record => record.commandType === 'send')
    const completed = records.find(record => record.commandType === 'select-thread')
    expect(failed).toMatchObject({
      outcome: 'failed',
      threadId: 'workshop',
      providerSessionId: 'session-workshop',
      projectId: 'project',
    })
    expect(completed).toMatchObject({
      outcome: 'completed',
      threadId: 'workshop',
      providerSessionId: 'session-workshop',
      projectId: 'project',
    })
  })

  it('returns the newest records first', async () => {
    const f = await fixture()
    await f.control.command({ type: 'select-thread', threadId: 'workshop' })
    await f.control.command({ type: 'utterance', text: 'first draft' })
    await f.control.command({ type: 'utterance', text: 'second draft' })
    const recent = await f.recorder.recent(2)
    expect(recent).toHaveLength(2)
    expect(recent.map(record => ({ commandType: record.commandType, text: record.text }))).toEqual([
      { commandType: 'utterance', text: 'second draft' },
      { commandType: 'utterance', text: 'first draft' },
    ])
    expect(Date.parse(recent[0]!.startedAt)).toBeGreaterThanOrEqual(Date.parse(recent[1]!.startedAt))
  })

  it('rewrites the log to its newest records once it exceeds the cap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-turns-'))
    roots.push(root)
    const recorder = new TurnRecorder({
      directory: root,
      historyEnabled: () => true,
      resolveSession: () => undefined,
      maxBytes: 200_000,
      maxLines: 1000,
    })
    for (let index = 1; index <= 1100; index += 1) {
      const turn = recorder.begin({
        source: 'command',
        commandType: 'compose',
        text: `n=${String(index).padStart(4, '0')} ${'a'.repeat(280)}`,
        threadId: null,
        projectId: null,
      })
      await recorder.finish(turn, 'completed')
    }
    const contents = await readFile(recorder.path(), 'utf8')
    const lines = contents.split(/\r?\n/u).filter(line => line.length > 0)
    expect(Buffer.byteLength(contents, 'utf8')).toBeLessThanOrEqual(200_000)
    expect(lines.length).toBeLessThanOrEqual(1000)
    expect(lines.length).toBeGreaterThan(100)
    expect(turnRecordSchema.parse(JSON.parse(lines.at(-1)!)).text).toContain('n=1100')
    expect(contents).not.toContain('n=0001')
  })

  it('records a clarification outcome', async () => {
    const f = await fixture()
    await f.account()
    f.service.intent = { type: 'clarify', text: 'Which thread?' }
    await f.control.command({ type: 'utterance', text: 'Create a project called Lantern.' })
    const [record] = await f.recorder.recent(1)
    expect(record).toMatchObject({
      commandType: 'utterance',
      source: 'utterance',
      outcome: 'clarified',
      text: 'Create a project called Lantern.',
      error: '',
    })
  })

  it('attributes a reasoned selection to its target instead of the previous selection', async () => {
    const f = await fixture()
    await f.account()
    await f.control.command({ type: 'select-thread', threadId: 'workshop' })
    f.service.intent = { type: 'select-thread', threadId: 'docs' }
    await f.control.command({ type: 'utterance', text: 'Switch to the documentation thread' })
    expect(await lastRawRecord(f.root)).toMatchObject({ threadId: 'docs', providerSessionId: 'session-docs' })
  })

  it('attributes a preserved draft submission to its bound thread', async () => {
    const f = await fixture()
    await f.control.command({ type: 'assign', threadId: 'docs' })
    await f.control.command({ type: 'compose', text: 'Update the documentation' })
    await f.control.command({ type: 'select-thread', threadId: 'workshop' })
    await f.control.command({ type: 'send' })
    expect(await lastRawRecord(f.root)).toMatchObject({ threadId: 'docs', providerSessionId: 'session-docs', outcome: 'completed' })
  })

  it('records connect and refresh', async () => {
    const f = await fixture()
    await f.control.command({ type: 'refresh' })
    expect((await f.recorder.recent(2)).map(record => record.commandType)).toEqual(['refresh', 'connect'])
  })

  it('records one typed submission without recording draft edits', async () => {
    const f = await fixture()
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    const before = (await f.recorder.recent(100)).length
    await f.control.command({ type: 'compose', text: 'Edit' })
    await f.control.command({ type: 'compose', text: 'Edit the tests' })
    await f.control.command({ type: 'send' })
    const records = await f.recorder.recent(100)
    expect(records).toHaveLength(before + 1)
    expect(records[0]).toMatchObject({ commandType: 'send', text: 'Edit the tests' })
  })

  it('measures intent time when reasoning rejects', async () => {
    const f = await fixture()
    vi.spyOn(f.reasoner, 'intent').mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 15))
      throw new Error('Intent unavailable')
    })
    await f.control.command({ type: 'utterance', text: 'Choose the right project' })
    const record = await lastRawRecord(f.root)
    expect(record).toMatchObject({ outcome: 'failed', error: 'Intent unavailable' })
    expect(record.timings.intentMs).toBeGreaterThan(0)
  })

  it('finishes only after final persistence and records its failure', async () => {
    const f = await fixture()
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    const write = vi.spyOn(AtomicJsonStore.prototype, 'write').mockRejectedValueOnce(new Error('Disk is full'))
    const state = await f.control.command({ type: 'pause', threadId: 'workshop' })
    expect(write).toHaveBeenCalled()
    expect(state.error).toBe('Could not save agent state. Pause management until storage is available.')
    expect(state.assignments.every(assignment => assignment.paused)).toBe(true)
    expect(await lastRawRecord(f.root)).toMatchObject({ outcome: 'failed', error: expect.stringContaining('Disk is full') })
  })

  it('keeps commands usable when a supplied recorder begin throws', async () => {
    const f = await fixture()
    vi.spyOn(f.recorder, 'begin').mockImplementation(() => { throw new Error('Broken recorder') })
    await expect(f.control.command({ type: 'select-thread', threadId: 'docs' })).resolves.toMatchObject({
      activeThreadId: 'docs', globalLaneBusy: false, error: null,
    })
  })

  it('makes TurnRecorder.begin non-throwing', async () => {
    const f = await fixture()
    vi.spyOn(Date, 'now').mockImplementationOnce(() => { throw new Error('Clock unavailable') })
    expect(() => f.recorder.begin({ source: 'command', commandType: 'send', text: '', threadId: null, projectId: null })).not.toThrow()
  })

  it('estimates all intent and dispatched text with one rounding step', async () => {
    const f = await fixture()
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    const draft = 'a'.repeat(401)
    await f.control.command({ type: 'compose', text: draft })
    await f.control.command({ type: 'utterance', text: 'send it' })
    expect(await lastRawRecord(f.root)).toMatchObject({ contextTokenEstimate: Math.ceil(('send it' + draft).length / 4) })
  })

  it('leaves speech latencies null when the pipeline has no speech-end timestamp', async () => {
    const f = await fixture()
    await f.control.command({ type: 'utterance', text: 'select Docs' })
    expect((await lastRawRecord(f.root)).timings).toMatchObject({
      speechEndedAt: null, speechToIntentMs: null, speechToFirstFeedbackMs: null,
    })
  })

  it.each([false, true])('records managed follow-ups, including failed sends (reject: %s)', async reject => {
    const f = await fixture()
    await f.account()
    await f.control.command({ type: 'assign', threadId: 'workshop', instruction: 'Fix the tests' })
    if (reject) f.host.event({ type: 'reject', threadId: 'workshop', text: 'Host send failed' })
    f.host.event({ type: 'failure', threadId: 'workshop', text: 'A test failed' })
    await vi.waitFor(async () => {
      const record = (await f.recorder.recent(100)).find(record => record.source === 'supervision')
      expect(record).toMatchObject({
        source: 'supervision', commandType: 'send', threadId: 'workshop', providerSessionId: 'session-workshop',
        text: f.service.decision.text, outcome: reject ? 'failed' : 'completed', error: reject ? 'Host send failed' : '',
        contextTokenEstimate: Math.ceil(f.service.decision.text.length / 4),
      })
    })
  })

  it('does not charge a background dispatch to an overlapping foreground turn', async () => {
    const f = await fixture()
    await f.account()
    await f.control.command({ type: 'assign', threadId: 'workshop', instruction: 'Fix the tests' })
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const hostExecute = f.host.execute.bind(f.host)
    const dispatchGate = gate()
    const dispatchStarted = gate()
    vi.spyOn(f.host, 'execute').mockImplementation(async command => {
      dispatchStarted.resolve()
      await dispatchGate.promise
      return hostExecute(command)
    })
    f.host.event({ type: 'failure', threadId: 'workshop', text: 'A test failed' })
    await dispatchStarted.promise
    const intentGate = gate()
    const intentStarted = gate()
    vi.spyOn(f.reasoner, 'intent').mockImplementation(async () => {
      intentStarted.resolve()
      await intentGate.promise
      return { type: 'select-thread', threadId: 'docs' }
    })
    const foreground = f.control.command({ type: 'utterance', text: 'Find the documentation thread' })
    await intentStarted.promise
    now += 100
    dispatchGate.resolve()
    await vi.waitFor(() => expect(f.control.get().host.threads.find(thread => thread.id === 'workshop')?.status).toBe('running'))
    intentGate.resolve()
    await foreground
    const record = (await f.recorder.recent(100)).find(record => record.source === 'utterance')
    expect(record).toMatchObject({ timings: { delegationMs: 0 }, contextTokenEstimate: Math.ceil('Find the documentation thread'.length / 4) })
    await vi.waitFor(async () => {
      expect((await f.recorder.recent(100)).find(record => record.source === 'supervision')).toMatchObject({
        timings: { delegationMs: 100 }, contextTokenEstimate: Math.ceil(f.service.decision.text.length / 4),
      })
    })
  })

  it('attributes project selection and reasoned thread creation to their new targets', async () => {
    const f = await fixture()
    await f.account()
    await f.control.command({ type: 'select-thread', threadId: 'workshop' })
    await f.control.command({ type: 'create-project', title: 'Docs', path: join(f.root, 'docs') })
    const projectId = f.control.get().activeProjectId!
    expect(await lastRawRecord(f.root)).toMatchObject({ threadId: null, projectId, providerSessionId: null })
    await f.control.command({ type: 'select-thread', threadId: 'workshop' })
    await f.control.command({ type: 'select-project', projectId })
    expect(await lastRawRecord(f.root)).toMatchObject({ threadId: null, projectId, providerSessionId: null })
    await f.control.command({ type: 'select-thread', threadId: 'workshop' })
    f.service.intent = { type: 'create-thread', projectId, title: 'New Docs', modelId: 'claude:test' }
    await f.control.command({ type: 'utterance', text: 'Create a documentation thread' })
    const threadId = f.control.get().activeThreadId!
    expect(threadId).not.toBe('workshop')
    expect(await lastRawRecord(f.root)).toMatchObject({ threadId, projectId, providerSessionId: `session-${threadId}`, outcome: 'completed' })
  })

  it('keeps management and answer targets across different project selections', async () => {
    const f = await fixture()
    await f.control.command({ type: 'create-project', title: 'Docs', path: join(f.root, 'docs') })
    const projectId = f.control.get().activeProjectId!
    await f.control.command({ type: 'create-thread', projectId, title: 'New Docs', modelId: 'claude:test' })
    const threadId = f.control.get().activeThreadId!
    for (const type of ['pause', 'resume', 'interrupt', 'unassign', 'assign', 'select-thread'] as const) {
      await f.control.command({ type: 'select-thread', threadId: 'workshop' })
      await f.control.command({ type, threadId })
      expect(await lastRawRecord(f.root)).toMatchObject({ threadId, projectId, providerSessionId: `session-${threadId}`, outcome: 'completed' })
    }
    f.host.event({ type: 'permission', threadId, requestId: 'permission', text: 'May I edit the tests?' })
    await f.control.command({ type: 'select-thread', threadId: 'workshop' })
    const execute = vi.spyOn(f.host, 'execute')
    await f.control.command({ type: 'answer', threadId, requestId: 'permission', answer: 'Allow test edits', approved: true })
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ type: 'answer', approved: true }))
    expect(await lastRawRecord(f.root)).toMatchObject({
      threadId, projectId, outcome: 'completed', text: 'Allow test edits', contextTokenEstimate: Math.ceil('Allow test edits'.length / 4),
    })
  })

  it('counts retained clarification context once when reasoning prepares a draft', async () => {
    const f = await fixture()
    await f.account()
    f.service.intent = { type: 'clarify', text: 'Which thread?' }
    await f.control.command({ type: 'utterance', text: 'Prepare the documentation prompt' })
    const pending = f.control.get().pendingRequest
    f.service.intent = { type: 'compose', threadId: 'docs', text: 'Write documentation' }
    await f.control.command({ type: 'utterance', text: 'The documentation thread' })
    expect(await lastRawRecord(f.root)).toMatchObject({
      outcome: 'completed', threadId: 'docs',
      contextTokenEstimate: Math.ceil(`${pending}\nUser clarification: The documentation thread`.length / 4),
    })
  })

  it('counts spoken permission text and the dispatched answer', async () => {
    const f = await fixture()
    await f.control.command({ type: 'assign', threadId: 'docs' })
    f.host.event({ type: 'permission', threadId: 'docs', requestId: 'permission', text: 'May I edit?' })
    await f.control.command({ type: 'select-thread', threadId: 'docs' })
    await f.control.command({ type: 'utterance', text: 'allow' })
    expect(await lastRawRecord(f.root)).toMatchObject({
      outcome: 'completed', threadId: 'docs', contextTokenEstimate: Math.ceil('allowallow'.length / 4),
    })
  })

  it('records a managed follow-up that fails to persist before dispatch', async () => {
    const f = await fixture()
    await f.account()
    await f.control.command({ type: 'assign', threadId: 'workshop', instruction: 'Fix the tests' })
    const decisionGate = gate()
    f.service.decisionGate = decisionGate.promise
    f.host.event({ type: 'failure', threadId: 'workshop', text: 'A test failed' })
    await f.control.privacyChanged()
    vi.spyOn(AtomicJsonStore.prototype, 'write').mockRejectedValueOnce(new Error('Follow-up storage failed'))
    decisionGate.resolve()
    await vi.waitFor(async () => {
      expect((await f.recorder.recent(100)).find(record => record.source === 'supervision')).toMatchObject({
        outcome: 'failed', error: 'Follow-up storage failed', text: f.service.decision.text,
      })
    })
  })

  it('makes the developer turn-record command reachable through the native tray', () => {
    const setMenu = vi.fn()
    const showTurnRecords = vi.fn()
    const actions = { toggleDictation: vi.fn(), setAutoPaste: vi.fn(), show: vi.fn(), quit: vi.fn(), showTurnRecords }
    new TrayController({ setMenu, destroy: vi.fn() }, actions).update({ dictating: false, autoPaste: true })
    const items = setMenu.mock.calls[0]![0] as { label?: string; click?: () => void }[]
    items.find(item => item.label === 'Show recent turn records')?.click?.()
    expect(showTurnRecords).toHaveBeenCalledOnce()
  })

  it('does not print transcript-bearing turn records to the console', async () => {
    const source = await readFile(resolve('src/main/index.ts'), 'utf8')
    expect(source.includes('console.log(JSON.stringify(record))')).toBe(false)
  })
})
