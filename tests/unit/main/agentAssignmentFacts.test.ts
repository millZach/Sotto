// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials, type CredentialEncryption } from '../../../src/main/agents/credentials'
import type { AgentReasoner } from '../../../src/main/agents/reasoning'
import { TurnRecorder } from '../../../src/main/agents/turns'
import { E2EAgentHost } from '../../../src/main/e2e/agentEffects'
import { defaultAgentConfiguration } from '../../../src/shared/agents'
import { designThreadsFixture } from '../../../src/shared/e2e'

const roots: string[] = []
const controls: AgentControl[] = []
const encryption: CredentialEncryption = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(Buffer.from(value).map(byte => byte ^ 0xa5)),
  decryptString: value => Buffer.from(value.map(byte => byte ^ 0xa5)).toString('utf8'),
}

async function fixture(saved?: object) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-assignment-facts-'))
  roots.push(root)
  if (saved) await writeFile(join(root, 'agents.json'), JSON.stringify(saved), 'utf8')
  const credentials = new AgentCredentials(join(root, 'vault'), encryption)
  await credentials.load()
  const host = new E2EAgentHost()
  const decide = vi.fn<AgentReasoner['decide']>().mockResolvedValue({ decision: 'followup', text: 'Fix the failing test within the assigned scope.' })
  const reasoner: AgentReasoner = {
    intent: async () => ({ type: 'clarify', text: 'Choose a thread.' }),
    decide,
  }
  const control = new AgentControl({ directory: root, host, credentials, reasoner,
    turns: new TurnRecorder({ directory: root, historyEnabled: () => true, resolveSession: () => undefined }),
    membership: {
      status: async () => ({ status: 'beta', label: 'Fixture beta', expiresAt: null }),
      action: async () => ({ status: 'beta', label: 'Fixture beta', expiresAt: null }),
    } })
  controls.push(control)
  await control.start()
  return {
    root, host, control, decide,
    async connect() { expect((await control.command({ type: 'connect' })).error).toBeNull() },
    async supervise(followupLimit = 5) {
      await this.connect()
      await control.command({ type: 'configure', patch: { reasoning: 'openrouter', reasoningModel: 'fixture-model', followupLimit } })
      await control.command({ type: 'assign', threadId: 'workshop', instruction: 'Fix the existing failing tests.' })
    },
    async savedAssignment() {
      const saved = JSON.parse(await readFile(join(root, 'agents.json'), 'utf8'))
      return saved.assignments[0]
    },
  }
}

function expectIso(value: string): void {
  expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  expect(new Date(value).toISOString()).toBe(value)
}

afterEach(async () => {
  for (const control of controls.splice(0)) {
    control.dispose()
    await control.privacyChanged()
  }
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-assignment-facts-')) throw new Error('Unexpected fixture directory')
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
  }
})

describe('assignment facts', () => {
  it('stamps a new assignment with its start time and unknown origin', async () => {
    const f = await fixture()
    await f.connect()
    const before = Date.now()
    const state = await f.control.command({ type: 'assign', threadId: 'workshop', instruction: 'Fix the tests.' })
    expect(state.error).toBeNull()
    const assignment = state.assignments[0]!
    expectIso(assignment.startedAt)
    expect(Date.parse(assignment.startedAt)).toBeGreaterThanOrEqual(before)
    expect(Date.parse(assignment.startedAt)).toBeLessThanOrEqual(Date.now())
    expect(assignment).toMatchObject({ origin: 'unknown', stopReason: 'none', stoppedAt: '' })
    expect(await f.savedAssignment()).toEqual(assignment)
  })

  it.each(['typed', 'voice'] as const)('records a %s send as the current instruction origin', async origin => {
    const f = await fixture()
    await f.connect()
    await f.control.command({ type: 'select-thread', threadId: 'workshop' })
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    const startedAt = f.control.get().assignments[0]!.startedAt
    await f.control.command({ type: 'compose', text: 'Keep the existing colors.' })
    const sent = await f.control.command(origin === 'typed' ? { type: 'send' } : { type: 'utterance', text: 'send it' })
    expect(sent.error).toBeNull()
    expect(sent.assignments[0]).toMatchObject({ instruction: 'Keep the existing colors.', origin, startedAt, stopReason: 'none', stoppedAt: '' })
    expect(sent.host.threads[0]?.messages).toMatchObject([{ role: 'user', text: 'Keep the existing colors.' }])
    expect(await f.savedAssignment()).toEqual(sent.assignments[0])
  })

  it('records a follow-up limit stop and clears it on resume', async () => {
    const f = await fixture()
    await f.supervise(1)
    f.host.event({ type: 'ready', threadId: 'workshop', text: 'First test failed.', status: 'idle' })
    await expect.poll(() => f.control.get().host.threads[0]?.status).toBe('running')
    expect(f.control.get().assignments[0]?.followups).toBe(1)
    f.host.event({ type: 'ready', threadId: 'workshop', text: 'Second test failed.', status: 'idle' })
    await expect.poll(() => f.control.get().assignments[0]?.paused).toBe(true)
    const stopped = f.control.get().assignments[0]!
    expect(stopped.stopReason).toBe('limit')
    expectIso(stopped.stoppedAt)
    expect(f.control.get().queue).toContainEqual(expect.objectContaining({ threadId: 'workshop', kind: 'blocked', text: expect.stringContaining('follow-up limit') }))
    await expect.poll(() => f.savedAssignment()).toEqual(stopped)
    // Resuming reconsiders the latest observation; this decision needs no new send.
    f.decide.mockResolvedValue({ decision: 'done', text: 'Ready for a new prompt.' })
    const resumed = await f.control.command({ type: 'resume', threadId: 'workshop' })
    expect(resumed.assignments[0]).toMatchObject({ mode: 'managed', paused: false, followups: 0, lastFailure: '', stopReason: 'none', stoppedAt: '' })
    expect(resumed.queue.some(item => item.kind === 'blocked')).toBe(false)
    await expect.poll(() => f.savedAssignment()).toMatchObject({ paused: false, followups: 0, stopReason: 'none', stoppedAt: '' })
  })

  it('records a repeated identical failure as a repeat stop', async () => {
    const f = await fixture()
    await f.supervise()
    f.host.event({ type: 'failure', threadId: 'workshop', text: 'The same test failed.' })
    await expect.poll(() => f.control.get().host.threads[0]?.status).toBe('running')
    f.host.event({ type: 'failure', threadId: 'workshop', text: 'The same test failed.' })
    await expect.poll(() => f.control.get().assignments[0]?.paused).toBe(true)
    const stopped = f.control.get().assignments[0]!
    expect(stopped).toMatchObject({ stopReason: 'repeat', followups: 1 })
    expectIso(stopped.stoppedAt)
    expect(f.control.get().queue).toContainEqual(expect.objectContaining({ kind: 'blocked', text: expect.stringContaining('repeating a failure') }))
    await expect.poll(() => f.savedAssignment()).toEqual(stopped)
  })

  it('records a supervision error and clears stop facts when a new prompt is sent', async () => {
    const f = await fixture()
    await f.supervise()
    f.decide.mockRejectedValueOnce(new Error('Fixture reasoning failed.'))
    f.host.event({ type: 'ready', threadId: 'workshop', text: 'A test failed.', status: 'idle' })
    await expect.poll(() => f.control.get().assignments[0]?.paused).toBe(true)
    const stopped = f.control.get().assignments[0]!
    expect(stopped.stopReason).toBe('error')
    expectIso(stopped.stoppedAt)
    await expect.poll(() => f.savedAssignment()).toEqual(stopped)
    await f.control.command({ type: 'compose', text: 'Try the corrected instruction.' })
    const sent = await f.control.command({ type: 'send' })
    expect(sent.error).toBeNull()
    expect(sent.assignments[0]).toMatchObject({ origin: 'typed', stopReason: 'none', stoppedAt: '', followups: 0, lastFailure: '' })
  })

  it.each(['pause', 'interrupt'] as const)('does not classify the user command %s as an automatic stop', async type => {
    const f = await fixture()
    await f.connect()
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    const paused = await f.control.command({ type, threadId: 'workshop' })
    expect(paused.error).toBeNull()
    expect(paused.assignments[0]).toMatchObject({ paused: true, stopReason: 'none', stoppedAt: '' })
  })

  it('loads legacy assignments intact and persists all four defaulted facts after a command', async () => {
    const assignment = {
      threadId: 'workshop', mode: 'manual', instruction: 'Preserve the existing colors.', followups: 2, paused: true,
      contextUpdatedAt: Date.now(), seenMessageIds: ['seen'], ownMessageIds: ['own'], handledRequestIds: ['answered'], lastFailure: 'a'.repeat(64),
    }
    // Handwritten saved data deliberately bypasses the current assignment schema.
    const f = await fixture({
      configuration: defaultAgentConfiguration(), assignments: [assignment], queue: [],
      activeThreadId: 'workshop', activeProjectId: 'project', draft: '', draftThreadId: null,
      composing: false, outbox: [], contextSavedAt: Date.now(),
    })
    const expected = { ...assignment, startedAt: '', origin: 'unknown', stopReason: 'none', stoppedAt: '' }
    expect(f.control.get().assignments).toEqual([expected])
    await f.control.command({ type: 'cancel-draft' })
    expect(await f.savedAssignment()).toEqual(expected)
  })
})

describe('Threads design host fixtures', () => {
  it('preserves all nine fixture threads, message identities, times and the visual-gate permission', async () => {
    const fixture = designThreadsFixture()
    const host = new E2EAgentHost('design-threads')
    await host.connect()
    const snapshot = await host.snapshot()
    expect(snapshot.threads).toHaveLength(9)
    expect(snapshot.threads.map(thread => thread.id)).toEqual(fixture.threads.map(thread => thread.id))
    expect(snapshot).toMatchObject({ models: fixture.models, projects: fixture.projects, threads: fixture.threads })
    expect(snapshot.threads.find(thread => thread.id === 'visual-gate')?.requests).toEqual(fixture.threads[0]!.requests)
    expect(snapshot.threads[0]?.requests[0]?.kind).toBe('permission')
    snapshot.threads[0]!.messages[0]!.text = 'Mutated snapshot'
    expect((await host.snapshot()).threads).toEqual(fixture.threads)
  })

  it('keeps fixture models and projects with zero threads in the empty scenario', async () => {
    const host = new E2EAgentHost('design-threads-empty')
    await host.connect()
    const fixture = designThreadsFixture()
    expect(await host.snapshot()).toMatchObject({ models: fixture.models, projects: fixture.projects, threads: [] })
  })

  it('keeps the original workshop and docs fixture with no scenario argument', async () => {
    const host = new E2EAgentHost()
    await host.connect()
    expect(await host.snapshot()).toMatchObject({
      models: [{ id: 'claude:test', provider: 'Claude', name: 'Claude Test', ready: true }],
      projects: [{ id: 'project', title: 'Sotto test', path: 'C:/sotto-test' }],
      threads: ['workshop', 'docs'].map(id => ({ id, title: id === 'workshop' ? 'Workshop' : 'Docs', projectId: 'project', modelId: 'claude:test', status: 'idle', messages: [], requests: [] })),
    })
  })
})
