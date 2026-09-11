// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials, type CredentialEncryption } from '../../../src/main/agents/credentials'
import { ConfiguredAgentReasoner, type AgentDecision, type AgentIntent } from '../../../src/main/agents/reasoning'
import { TurnRecorder, turnRecordSchema } from '../../../src/main/agents/turns'
import { E2EAgentHost } from '../../../src/main/e2e/agentEffects'
import type { AgentConfiguration } from '../../../src/shared/agents'

const roots: string[] = []
const controls: AgentControl[] = []
const ROUTER_KEY = 'fixture-openrouter-key'

const encryption: CredentialEncryption = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(Buffer.from(value).map(byte => byte ^ 0xa5)),
  decryptString: value => Buffer.from(value.map(byte => byte ^ 0xa5)).toString('utf8'),
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
    resolveSession: id => ({ provider: 't3', sessionId: `session-${id}` }),
  })
  const binding: { control: AgentControl } = {} as { control: AgentControl }
  const reasoner = new ConfiguredAgentReasoner(() => binding.control.get().configuration, credentials)
  binding.control = new AgentControl({
    directory: root, host: new E2EAgentHost(), credentials, reasoner, turns: recorder,
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
    root, recorder, service,
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
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-turns-')) throw new Error('Unexpected temporary test directory')
    await rm(root, { recursive: true, force: true })
  }
})

describe('coordinator turn records', () => {
  it('writes a completed utterance turn with thread and session ids', async () => {
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
    const records = await f.recorder.recent(3)
    expect(records).toHaveLength(3)
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
    await f.control.command({ type: 'compose', text: 'first draft' })
    await f.control.command({ type: 'compose', text: 'second draft' })
    const recent = await f.recorder.recent(2)
    expect(recent).toHaveLength(2)
    expect(recent.map(record => ({ commandType: record.commandType, text: record.text }))).toEqual([
      { commandType: 'compose', text: 'second draft' },
      { commandType: 'compose', text: 'first draft' },
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
})
