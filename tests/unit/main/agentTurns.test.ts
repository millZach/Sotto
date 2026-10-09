// @vitest-environment node
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials, type CredentialEncryption } from '../../../src/main/agents/credentials'
import { ConfiguredAgentReasoner } from '../../../src/main/agents/reasoning'
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
  const recorder = new TurnRecorder({
    directory: root, resolveSession: id => ({ provider: 'codex', sessionId: `session-${id}` }),
  })
  const binding: { control: AgentControl } = {} as { control: AgentControl }
  const reasoner = new ConfiguredAgentReasoner()
  const host = new E2EAgentHost()
  binding.control = new AgentControl({ schedule: immediatePublishScheduler,
    directory: root, host, credentials, reasoner, turns: recorder, historyEnabled: () => historyEnabled,

  })
  const control = binding.control
  controls.push(control)
  await control.start()
  if (!control.get().host.connected) await control.command({ type: 'connect' })
  return {
    root, recorder, host, reasoner,
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
  it.each(['completed', 'failed'] as const)('records an immediate interrupt as %s while another thread owns a lane', async outcome => {
    const f = await fixture()
    f.host.event({ type: 'manual', threadId: 'docs', text: 'Independent work', status: 'running' })
    const pending = gate(), entered = gate(), execute = f.host.execute.bind(f.host)
    vi.spyOn(f.host, 'execute').mockImplementation(async command => {
      if (command.type === 'send') { entered.resolve(); await pending.promise }
      if (command.type === 'interrupt' && outcome === 'failed') throw new Error('Synthetic interrupt failure')
      return execute(command)
    })
    const sending = f.control.command({ type: 'manual-send', threadId: 'workshop', text: 'Work' })
    try {
      await entered.promise
      const result = await f.control.command({ type: 'interrupt', threadId: 'docs' })
      expect(result.busyThreadIds).toContain('workshop')
      expect(await lastRawRecord(f.root)).toMatchObject({ commandType: 'interrupt', source: 'command', outcome,
        threadId: 'docs', projectId: 'project', providerSessionId: 'session-docs' })
      expect((await f.recorder.recent(100)).filter(record => record.commandType === 'interrupt')).toHaveLength(1)
    } finally { pending.resolve(); await sending }
  })

  it('records total time through a delayed manual-send acknowledgement', async () => {
    const f = await fixture()
    await f.control.command({ type: 'select-thread', threadId: 'workshop' })
    let now = 100_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const acknowledged = gate(); const release = gate()
    const execute = f.host.execute.bind(f.host)
    vi.spyOn(f.host, 'execute').mockImplementation(async command => {
      const result = await execute(command)
      if (command.type === 'send') { acknowledged.resolve(); await release.promise }
      return result
    })
    const sending = f.control.command({ type: 'manual-send', threadId: 'workshop', text: 'A prompt whose acknowledgement is delayed.' })
    try {
      await acknowledged.promise
      expect(f.control.get().host.threads.find(thread => thread.id === 'workshop')?.messages.some(message => message.role === 'user')).toBe(true)
      now = 105_000
    } finally { release.resolve() }
    await sending
    const [record] = await f.recorder.recent(1)
    expect(record?.timings.totalMs).toBe(5_000)
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

  it('attributes a preserved draft submission to its bound thread', async () => {
    const f = await fixture()
    await f.control.command({ type: 'select-thread', threadId: 'docs' })
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
    const before = (await f.recorder.recent(100)).length
    await f.control.command({ type: 'compose', text: 'Edit' })
    await f.control.command({ type: 'compose', text: 'Edit the tests' })
    await f.control.command({ type: 'send' })
    const records = await f.recorder.recent(100)
    expect(records).toHaveLength(before + 1)
    expect(records[0]).toMatchObject({ commandType: 'send' })
  })

  it('finishes only after final persistence and records its failure', async () => {
    const f = await fixture()
    await f.control.command({ type: 'select-thread', threadId: 'workshop' })
    await f.control.command({ type: 'compose', text: 'Saved draft' })
    const write = vi.spyOn(AtomicJsonStore.prototype, 'write').mockRejectedValueOnce(new Error('Disk is full'))
    const state = await f.control.command({ type: 'cancel-draft' })
    expect(write).toHaveBeenCalled()
    expect(state.error).toBe('Could not save agent state. Your drafts are kept in this session. Restore access to local storage and retry.')
    expect(state).not.toHaveProperty('assignments')
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

  it('reads historical voice timings without adding them to new command records', async () => {
    const f = await fixture()
    await f.control.command({ type: 'select-thread', threadId: 'docs' })
    const current = await lastRawRecord(f.root)
    for (const key of ['speechEndedAt', 'voicePhase', 'speechEndBasis', 'feedbackBasis', 'speechToIntentMs', 'speechToFirstFeedbackMs']) {
      expect(current.timings).not.toHaveProperty(key)
    }
    const historical = ['utterance', 'supervision'].map(source => ({ ...current, source,
      timings: { ...current.timings, speechEndedAt: current.startedAt, voicePhase: 'warm',
        speechEndBasis: 'detector-frame-received', feedbackBasis: 'main-state-published',
        speechToIntentMs: 10, speechToFirstFeedbackMs: 20 }, transcript: 'Private historical words' }))
    await writeFile(f.recorder.path(), [...historical, current].map(record => JSON.stringify(record)).join('\n') + '\n', 'utf8')
    const reader = new TurnRecorder({ directory: f.root, resolveSession: () => undefined })
    const records = await reader.recent(3)
    expect(records.map(record => record.source)).toEqual(['command', 'supervision', 'utterance'])
    expect(records[1]?.timings).not.toHaveProperty('voicePhase')
    expect(records[1]?.timings.speechToIntentMs).toBe(10)
    expect(records[0]?.timings).not.toHaveProperty('speechToIntentMs')
    expect(await readFile(reader.path(), 'utf8')).not.toContain('Private historical words')
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
    const TIMING_FIELDS = ['retrievalCount', 'intentMs', 'retrievalMs', 'delegationMs', 'totalMs']
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
      await f.control.command({ type: 'select-thread', threadId: 'workshop' })
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
