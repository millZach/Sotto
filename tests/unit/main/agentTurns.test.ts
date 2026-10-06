// @vitest-environment node
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials, type CredentialEncryption } from '../../../src/main/agents/credentials'
import { ConfiguredAgentReasoner, type AgentDecision, type AgentIntent } from '../../../src/main/agents/reasoning'
import { TurnRecorder, turnRecordSchema } from '../../../src/main/agents/turns'
import { markSendStage, SEND_STAGE_FIELDS } from '../../../src/main/agents/sendStages'
import { AtomicJsonStore } from '../../../src/main/storage/atomicJsonStore'
import { TrayController } from '../../../src/main/tray/trayController'
import { E2EAgentHost } from '../../../src/main/e2e/agentEffects'
import type { AgentConfiguration } from '../../../src/shared/agents'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile), rename: vi.fn(actual.rename), rm: vi.fn(actual.rm) }
})

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
    directory: root, resolveSession: id => ({ provider: 'codex', sessionId: `session-${id}` }),
  })
  const binding: { control: AgentControl } = {} as { control: AgentControl }
  const reasoner = new ConfiguredAgentReasoner(() => binding.control.get().configuration, credentials)
  const host = new E2EAgentHost()
  binding.control = new AgentControl({ schedule: immediatePublishScheduler,
    directory: root, host, credentials, reasoner, turns: recorder, historyEnabled: () => historyEnabled,

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
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(readFile).mockReset().mockImplementation(actual.readFile)
  vi.mocked(rename).mockReset().mockImplementation(actual.rename)
  vi.mocked(rm).mockReset().mockImplementation(actual.rm)
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
        threadId: 'docs', projectId: 'project', providerSessionId: 'session-docs' })
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
      outcome: 'completed',
      retrievedMemoryIds: [],
      contextTokenEstimate: Math.ceil('Open workshop'.length / 4),
      timings: { retrievalMs: 0 },
    })
    expect(parsed.timings.totalMs).toBeGreaterThan(0)
    expect(parsed.timings.intentMs).toBeGreaterThanOrEqual(0)
  })

  it('records a failed outcome without error text', async () => {
    const f = await fixture()
    await f.control.command({ type: 'select-thread', threadId: 'workshop' })
    await f.control.command({ type: 'compose', text: '' })
    await f.control.command({ type: 'send' })
    expect(await readFile(f.recorder.path(), 'utf8')).not.toContain('There is no prompt to send.')
    const [record] = await f.recorder.recent(1)
    expect(record).toMatchObject({
      commandType: 'send',
      source: 'command',
      outcome: 'failed',
    })
  })

  it('omits text and error when history is off', async () => {
    const f = await fixture()
    historyEnabled = false
    await f.control.command({ type: 'select-thread', threadId: 'workshop' })
    await f.control.command({ type: 'compose', text: '' })
    await f.control.command({ type: 'send' })
    const records = (await f.recorder.recent(10)).filter(record => record.commandType !== 'connect')
    expect(records).toHaveLength(2)
    for (const record of records) {
      expect(record).not.toHaveProperty('text')
      expect(record).not.toHaveProperty('error')
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
    for (const threadId of ['first', 'second']) {
      await f.recorder.finish(f.recorder.begin({ source: 'command', commandType: 'send', text: '', threadId }), 'completed')
    }
    const recent = await f.recorder.recent(2)
    expect(recent.map(record => record.threadId)).toEqual(['second', 'first'])
    expect(Date.parse(recent[0]!.startedAt)).toBeGreaterThanOrEqual(Date.parse(recent[1]!.startedAt))
  })

  it.each([true, false])('scrubs existing records and omits new content with history %s', async enabled => {
    const f = await fixture()
    historyEnabled = enabled
    const record = (await f.recorder.recent(1))[0]!
    await writeFile(f.recorder.path(), `${JSON.stringify({ ...record, text: 'Private prompt and answer', error: 'Private error' })}\n{broken private text\n`)
    const upgraded = new TurnRecorder({ directory: f.root, resolveSession: () => undefined })
    await upgraded.initialize()
    expect(await readFile(upgraded.path(), 'utf8')).not.toContain('Private')
    expect(await readFile(upgraded.path(), 'utf8')).not.toContain('broken')
    await upgraded.finish(upgraded.begin({ source: 'command', commandType: 'answer', text: 'Private answer' }), 'failed')
    const raw = await readFile(upgraded.path(), 'utf8')
    expect(raw).not.toContain('Private')
    expect(raw).not.toContain('"text"')
    expect(raw).not.toContain('"error"')
    expect((await upgraded.recent(1))[0]).toMatchObject({ outcome: 'failed', failureCode: 'action-failed' })
  })

  it.each(['EPERM', 'EBUSY'])('retries a temporarily locked initial read (%s)', async code => {
    const f = await fixture()
    const record = (await f.recorder.recent(1))[0]!
    await writeFile(f.recorder.path(), `${JSON.stringify({ ...record, text: 'Private prompt' })}\n`)
    vi.mocked(readFile).mockRejectedValueOnce(Object.assign(new Error('Locked'), { code }))
    const upgraded = new TurnRecorder({ directory: f.root, resolveSession: () => undefined })
    await upgraded.initialize()
    expect(await readFile(upgraded.path(), 'utf8')).not.toContain('Private prompt')
    expect(await upgraded.recent(1)).toHaveLength(1)
  })

  it.each(['EPERM', 'EACCES'])('deletes diagnostics after a persistent initial read failure (%s)', async code => {
    const f = await fixture()
    await writeFile(f.recorder.path(), 'Private prompt\n')
    vi.mocked(readFile).mockRejectedValue(Object.assign(new Error('Unreadable'), { code }))
    const upgraded = new TurnRecorder({ directory: f.root, resolveSession: () => undefined })
    await expect(upgraded.initialize()).resolves.toBeUndefined()
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    await expect(actual.readFile(upgraded.path(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    vi.mocked(readFile).mockReset().mockImplementation(actual.readFile)
    expect(await upgraded.recent(1)).toEqual([])
  })

  it.each(['EPERM', 'EBUSY'])('retries a temporarily locked scrub (%s)', async code => {
    const f = await fixture()
    const record = (await f.recorder.recent(1))[0]!
    await writeFile(f.recorder.path(), `${JSON.stringify({ ...record, text: 'Private prompt' })}\n`)
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('Locked'), { code }))
    const upgraded = new TurnRecorder({ directory: f.root, resolveSession: () => undefined })
    await upgraded.initialize()
    expect(await readFile(upgraded.path(), 'utf8')).not.toContain('Private prompt')
    expect(await upgraded.recent(1)).toHaveLength(1)
  })

  it('deletes diagnostics when scrub retries cannot replace the file', async () => {
    const f = await fixture()
    await writeFile(f.recorder.path(), 'Private prompt\n')
    vi.mocked(rename).mockRejectedValue(Object.assign(new Error('Locked'), { code: 'EPERM' }))
    const upgraded = new TurnRecorder({ directory: f.root, resolveSession: () => undefined })
    await expect(upgraded.initialize()).resolves.toBeUndefined()
    await expect(readFile(upgraded.path(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await upgraded.recent(1)).toEqual([])
  })

  it('explains how to restart when old diagnostics cannot be deleted', async () => {
    const f = await fixture()
    await writeFile(f.recorder.path(), 'Private prompt\n')
    vi.mocked(rename).mockRejectedValue(Object.assign(new Error('Locked'), { code: 'EBUSY' }))
    vi.mocked(rm).mockImplementation(async (path, options) => {
      if (path === f.recorder.path()) throw new Error('Private error')
      return (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rm(path, options)
    })
    const upgraded = new TurnRecorder({ directory: f.root, resolveSession: () => undefined })
    await expect(upgraded.initialize()).rejects.toThrow('Close other apps using turns.jsonl, then restart Sotto.')
  })

  it('uses only fixed failure codes and migrates old failed records', async () => {
    const f = await fixture()
    for (const failureCode of ['action-failed', 'reasoning-failed', 'provider-failed', 'storage-failed'] as const) {
      const turn = f.recorder.begin({ source: 'command', commandType: 'send', text: 'Private prompt' })!
      turn.failureCode = failureCode
      await f.recorder.finish(turn, 'failed')
      const record = (await f.recorder.recent(1))[0]!
      expect(record.failureCode).toBe(failureCode)
      expect(turnRecordSchema.safeParse({ ...record, failureCode: 'Private error' }).success).toBe(false)
      const legacy: Partial<typeof record> = { ...record }
      delete legacy.failureCode
      await writeFile(f.recorder.path(), `${JSON.stringify(legacy)}\n`)
      const upgraded = new TurnRecorder({ directory: f.root, resolveSession: () => undefined })
      await upgraded.initialize()
      expect((await upgraded.recent(1))[0]?.failureCode).toBe('unknown')
    }
  })

  it('keeps overlapping finishes in order while compacting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-turns-'))
    roots.push(root)
    const recorder = new TurnRecorder({ directory: root, resolveSession: () => undefined, maxBytes: 4000 })
    await Promise.all(Array.from({ length: 40 }, (_, index) => recorder.finish(recorder.begin({
      source: 'command', commandType: 'send', text: '', threadId: `thread-${index}`,
    }), 'completed')))
    const records = await recorder.recent(100)
    expect(records[0]?.threadId).toBe('thread-39')
    expect(records.map(record => Number(record.threadId!.split('-')[1]))).toEqual(
      Array.from({ length: records.length }, (_, index) => 39 - index))
    expect(records.length).toBeGreaterThan(1)
  })

  it('rewrites the log to its newest records once it exceeds the cap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-turns-'))
    roots.push(root)
    const recorder = new TurnRecorder({
      directory: root, resolveSession: () => undefined,
      maxBytes: 200_000,
      maxLines: 1000,
    })
    for (let index = 1; index <= 1100; index += 1) {
      const turn = recorder.begin({
        source: 'command',
        commandType: 'send',
        text: 'Private prompt',
        threadId: `thread-${String(index).padStart(4, '0')}`,
        projectId: null,
      })
      await recorder.finish(turn, 'completed')
    }
    const contents = await readFile(recorder.path(), 'utf8')
    const lines = contents.split(/\r?\n/u).filter(line => line.length > 0)
    expect(Buffer.byteLength(contents, 'utf8')).toBeLessThanOrEqual(200_000)
    expect(lines.length).toBeLessThanOrEqual(1000)
    expect(lines.length).toBeGreaterThan(100)
    expect(turnRecordSchema.parse(JSON.parse(lines.at(-1)!)).threadId).toBe('thread-1100')
    expect(contents).not.toContain('thread-0001')
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
    expect(records[0]).toMatchObject({ commandType: 'send' })
  })

  it('measures intent time when reasoning rejects', async () => {
    const f = await fixture()
    vi.spyOn(f.reasoner, 'intent').mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 15))
      throw new Error('Intent unavailable')
    })
    await f.control.command({ type: 'utterance', text: 'Choose the right project' })
    const record = await lastRawRecord(f.root)
    expect(record).toMatchObject({ outcome: 'failed', failureCode: 'reasoning-failed' })
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
    expect(await lastRawRecord(f.root)).toMatchObject({ outcome: 'failed', failureCode: 'storage-failed' })
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
        outcome: reject ? 'failed' : 'completed',
        failureCode: reject ? 'provider-failed' : null,
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
      threadId, projectId, outcome: 'completed', contextTokenEstimate: Math.ceil('Allow test edits'.length / 4),
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
        outcome: 'failed',
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

  describe('send stages', () => {
    const TIMING_FIELDS = ['speechEndedAt', 'voicePhase', 'speechEndBasis', 'feedbackBasis', 'retrievalCount',
      'speechToIntentMs', 'speechToFirstFeedbackMs', 'intentMs', 'retrievalMs', 'delegationMs', 'totalMs']
    const PROMPT = 'Synthetic prompt for stage timings'
    const REPLY = 'Synthetic first words'
    /** A host whose layers mark their steps as the workspace and the adapters do, and whose client confirms the prompt. */
    function marking(f: Awaited<ReturnType<typeof fixture>>): void {
      const execute = f.host.execute.bind(f.host)
      vi.spyOn(f.host, 'execute').mockImplementation(async command => {
        if (command.type !== 'send') return execute(command)
        markSendStage(command.commandId, 'prepared')
        markSendStage(command.commandId, 'written')
        const result = await execute(command)
        markSendStage(command.commandId, 'acknowledged')
        return result
      })
    }

    it('times each step of a typed send down to its first words, and adds durations and nothing else', async () => {
      const f = await fixture()
      marking(f)
      const before = (await f.recorder.recent(100)).length
      const state = await f.control.command({ type: 'manual-send', threadId: 'workshop', text: PROMPT })
      expect(state.error).toBeNull()
      // The command is answered once the client confirms the prompt; its record waits for the reply.
      expect(await f.recorder.recent(100)).toHaveLength(before)
      f.host.event({ type: 'stream', threadId: 'workshop', messageId: 'reply', text: REPLY, status: 'running' })
      await vi.waitFor(async () => expect(await f.recorder.recent(100)).toHaveLength(before + 1), { timeout: 5_000 })
      const raw = (await readFile(join(f.root, 'turns.jsonl'), 'utf8')).trim().split('\n').at(-1)!
      const record = turnRecordSchema.parse(JSON.parse(raw))
      expect(record).toMatchObject({ commandType: 'manual-send', threadId: 'workshop', outcome: 'completed' })
      // The whole set of timings, so a text-bearing field cannot be added to it unnoticed.
      expect(Object.keys(JSON.parse(raw).timings)).toEqual([...TIMING_FIELDS, ...SEND_STAGE_FIELDS])
      for (const field of SEND_STAGE_FIELDS) expect(Number.isInteger(record.timings[field]) && record.timings[field]! >= 0).toBe(true)
      expect(raw).not.toContain(PROMPT)
      expect(raw).not.toContain(REPLY)
      expect(raw).not.toContain(f.root.replace(/\\/gu, '\\\\'))
    })

    it('keeps the finish and totalMs at the command finishing, however long the first words take', async () => {
      const f = await fixture()
      marking(f)
      let now = 1_000_000
      vi.spyOn(Date, 'now').mockImplementation(() => now)
      await f.control.command({ type: 'manual-send', threadId: 'workshop', text: PROMPT })
      // The first words arrive a minute after the command finished.
      now += 60_000
      f.host.event({ type: 'stream', threadId: 'workshop', messageId: 'reply', text: REPLY, status: 'running' })
      await vi.waitFor(async () => expect((await lastRawRecord(f.root)).commandType).toBe('manual-send'), { timeout: 5_000 })
      const record = await lastRawRecord(f.root)
      expect(record.timings.totalMs).toBe(1)
      expect(Date.parse(record.finishedAt) - Date.parse(record.startedAt)).toBe(0)
      expect(record.timings.firstOutputMs).toEqual(expect.any(Number))
    })

    it('writes a send at once, without later steps, when its host confirms nothing', async () => {
      const f = await fixture()
      await f.control.command({ type: 'manual-send', threadId: 'workshop', text: PROMPT })
      const record = await lastRawRecord(f.root)
      expect(record.commandType).toBe('manual-send')
      expect(record.timings.admissionMs).toEqual(expect.any(Number))
      expect(record.timings.readBeforeSendMs).toEqual(expect.any(Number))
      expect(record.timings).toMatchObject({ preparationMs: null, adapterMs: null, acknowledgementMs: null, firstOutputMs: null })
    })

    it('times the admission and the read of a saved draft sent with Send', async () => {
      const f = await fixture()
      await f.control.command({ type: 'assign', threadId: 'workshop' })
      await f.control.command({ type: 'compose', text: PROMPT })
      expect((await f.control.command({ type: 'send' })).error).toBeNull()
      const record = await lastRawRecord(f.root)
      expect(record.commandType).toBe('send')
      expect(record.timings.admissionMs).toEqual(expect.any(Number))
      expect(record.timings.readBeforeSendMs).toEqual(expect.any(Number))
    })

    it('leaves the send stages out of a turn that sends nothing', async () => {
      const f = await fixture()
      await f.control.command({ type: 'select-thread', threadId: 'workshop' })
      const raw = (await readFile(join(f.root, 'turns.jsonl'), 'utf8')).trim().split('\n').at(-1)!
      expect(JSON.parse(raw)).toMatchObject({ commandType: 'select-thread' })
      expect(Object.keys(JSON.parse(raw).timings)).toEqual(TIMING_FIELDS)
    })

    it('leaves the send stages out of a send refused after its read, before it reached its host', async () => {
      const f = await fixture()
      const snapshot = f.host.snapshot.bind(f.host)
      vi.spyOn(f.host, 'snapshot').mockImplementation(async () => {
        const read = await snapshot()
        return { ...read, threads: read.threads.map(thread => thread.id === 'workshop' ? { ...thread, status: 'running' as const } : thread) }
      })
      const state = await f.control.command({ type: 'manual-send', threadId: 'workshop', text: PROMPT })
      expect(state.error).toMatch(/still working/u)
      const raw = (await readFile(join(f.root, 'turns.jsonl'), 'utf8')).trim().split('\n').at(-1)!
      expect(JSON.parse(raw)).toMatchObject({ commandType: 'manual-send', outcome: 'failed' })
      expect(Object.keys(JSON.parse(raw).timings)).toEqual(TIMING_FIELDS)
    })

    it('writes a send without first words when its turn ends having shown none, or Sotto stops first', async () => {
      const f = await fixture()
      marking(f)
      await f.control.command({ type: 'manual-send', threadId: 'workshop', text: PROMPT })
      const messages = f.control.get().host.threads.find(thread => thread.id === 'workshop')!.messages
      f.host.event({ type: 'history', threadId: 'workshop', text: '', messages: structuredClone(messages), status: 'idle' })
      await vi.waitFor(async () => expect((await lastRawRecord(f.root)).commandType).toBe('manual-send'), { timeout: 5_000 })
      expect((await lastRawRecord(f.root)).timings).toMatchObject({ acknowledgementMs: expect.any(Number), firstOutputMs: null })

      // Closing alone, without dispose, writes a record still waiting rather than waiting out the limit.
      const before = (await f.recorder.recent(100)).length
      await f.control.command({ type: 'manual-send', threadId: 'docs', text: PROMPT })
      await f.control.closed()
      expect(await f.recorder.recent(100)).toHaveLength(before + 1)
      expect((await lastRawRecord(f.root)).timings.firstOutputMs).toBeNull()
    })
  })

  it('does not print transcript-bearing turn records to the console', async () => {
    const source = await readFile(resolve('src/main/index.ts'), 'utf8')
    expect(source.includes('console.log(JSON.stringify(record))')).toBe(false)
  })
})
