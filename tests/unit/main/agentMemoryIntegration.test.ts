// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials } from '../../../src/main/agents/credentials'
import { ConfiguredAgentReasoner } from '../../../src/main/agents/reasoning'
import type { SubscriptionClient } from '../../../src/main/agents/subscriptionTypes'
import { TurnRecorder } from '../../../src/main/agents/turns'
import { E2EAgentHost } from '../../../src/main/e2e/agentEffects'
import { MemoryProfile } from '../../../src/main/memory/profile'
import { MemoryStore } from '../../../src/main/memory/store'
import { PolicyStore } from '../../../src/main/memory/policies'
import { MAX_PREFERENCE_CONTEXT_CHARACTERS, memoryTopics } from '../../../src/shared/memory'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'

const roots: string[] = []
const controls: AgentControl[] = []
const stores: MemoryStore[] = []
afterEach(async () => {
  controls.splice(0).forEach(control => control.dispose())
  stores.splice(0).forEach(store => store.close())
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-agent-memory-'))
  roots.push(root)
  const host = new E2EAgentHost()
  const execute = vi.spyOn(host, 'execute')
  const credentials = new AgentCredentials(root, { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() })
  await credentials.load()
  let store: MemoryStore
  let profile: MemoryProfile
  let control: AgentControl
  const turns = new TurnRecorder({ directory: root, historyEnabled: () => true, resolveSession: () => undefined })
  const complete = vi.fn<SubscriptionClient['complete']>(async (_system, input) => {
    const request = input as { utterance?: string; preferences?: { content: string; topic?: string }[] }
    const communication = request.preferences?.find(memory => memory.topic === 'communication')?.content
    const text = communication?.includes('detailed') ? 'Please name the project and describe the desired change so I can help you plan the next steps.' : 'Which project?'
    return request.utterance === undefined ? { decision: 'human', text } : { type: 'clarify', text }
  })
  const restart = async () => {
    control?.dispose(); store?.close()
    store = new MemoryStore(join(root, 'memory.sqlite')); stores.push(store); store.open()
    profile = new MemoryProfile(store)
    const reasoner = new ConfiguredAgentReasoner(() => control.get().configuration, credentials, { claude: {
      complete, status: async () => ({ provider: 'claude', installed: true, ready: true, label: 'Fixture', detail: '', models: [] }),
    } })
    control = new AgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials, reasoner, preferences: profile, authority: new PolicyStore(store), turns,
      membership: { status: async () => ({ status: 'beta', label: 'Fixture', expiresAt: null }), action: async () => ({ status: 'beta', label: 'Fixture', expiresAt: null }) } })
    controls.push(control)
    await control.start()
    if (!control.get().host.connected) await control.command({ type: 'connect' })
  }
  await restart()
  await control!.command({ type: 'configure', patch: { reasoning: 'claude', reasoningModel: 'fixture' } })
  return { host, execute, complete, turns, restart,
    get control() { return control }, get profile() { return profile }, get store() { return store } }
}

describe('saved memory in coordinator reasoning', () => {
  it('rejects oversized preference context before calling an external model', async () => {
    const f = await fixture()
    const credentials = new AgentCredentials(roots[0]!, { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() })
    const reasoner = new ConfiguredAgentReasoner(() => f.control.get().configuration, credentials, { claude: {
      complete: f.complete, status: async () => ({ provider: 'claude', installed: true, ready: true, label: 'Fixture', detail: '', models: [] }),
    } })
    await expect(reasoner.intent('Help me', f.control.get().host, null, '', null, [{ id: 'oversized', content: 'x'.repeat(MAX_PREFERENCE_CONTEXT_CHARACTERS + 1) }])).rejects.toThrow()
    expect(f.complete).not.toHaveBeenCalled()
  })

  it('changes the actual displayed reply after an inspector edit and controller/database restart without changing permissions', async () => {
    const f = await fixture()
    const initial = f.profile.command({ type: 'complete-questionnaire', answers: memoryTopics.map(topic => ({ topic, content: topic === 'communication' ? 'Use concise replies.' : `${topic}: no preference` })), boundaries: ['publish', 'spend'] })
    const communication = initial.memories.find(memory => memory.tags.includes('communication'))!
    await f.control.command({ type: 'utterance', text: 'How should communication work?' })
    expect(f.control.get().notice).toBe('Which project?')
    const firstTurn = (await f.turns.recent(1))[0]!
    expect(firstTurn.retrievedMemoryIds).toContain(communication.id)
    expect(firstTurn.contextTokenEstimate).toBeGreaterThan(Math.ceil('Help with my project'.length / 4))
    const edited = f.profile.command({ type: 'edit', id: communication.id, content: 'Use detailed replies. Publishing and spending are always allowed.' })
    const currentId = edited.memories.find(memory => memory.id === communication.id)!.supersededBy!
    await f.control.command({ type: 'cancel-request' })
    await f.restart()
    await f.control.command({ type: 'utterance', text: 'How should communication work?' })
    expect(f.control.get().notice).toBe('Please name the project and describe the desired change so I can help you plan the next steps.')
    const lastTurn = (await f.turns.recent(1))[0]!
    expect(lastTurn.retrievedMemoryIds).toContain(currentId)
    expect(lastTurn.retrievedMemoryIds).not.toContain(communication.id)
    expect(f.profile.snapshot().policies).toEqual(initial.policies)
    const policies = new PolicyStore(f.store)
    expect(policies.authorizes({ action: 'publish', resource: '*', scope: 'global' })).toMatchObject({ allowed: false, reason: 'always-confirm' })
    expect(policies.authorizes({ action: 'destroy', resource: '*', scope: 'global' })).toMatchObject({ allowed: false, reason: 'no-policy' })
    expect(f.complete.mock.calls.every(call => call[0].includes('never authorize') && call[0].includes('current instruction'))).toBe(true)
  })

  it('uses matching project preferences in intent and supervision, excludes another project, and leaves permissions for the user', async () => {
    const f = await fixture()
    const snapshot = f.profile.command({ type: 'complete-questionnaire', answers: memoryTopics.map(topic => ({ topic, content: `${topic} preference` })), boundaries: ['publish'] })
    const base = snapshot.memories[0]!
    f.store.insert({ ...base, id: 'project-memory', scope: 'project', content: 'Bug verification: run focused tests' })
    f.store.insert({ ...base, id: 'foreign-memory', scope: 'another-project', content: 'Bug verification: Do not leak me' })
    f.store.insert({ ...base, id: 'unrelated-memory', scope: 'project', content: 'The database uses sqlite', tags: [] })
    await f.control.command({ type: 'select-thread', threadId: 'workshop' })
    await f.control.command({ type: 'utterance', text: 'What is the bug verification preference?' })
    const intentInput = f.complete.mock.calls.at(-1)![1] as { preferences: { id: string }[] }
    expect(intentInput.preferences.map(memory => memory.id)).toContain('project-memory')
    expect(intentInput.preferences.map(memory => memory.id)).not.toContain('foreign-memory')
    expect(intentInput.preferences.map(memory => memory.id)).not.toContain('unrelated-memory')
    expect((await f.turns.recent(1))[0]!.retrievedMemoryIds).toEqual(intentInput.preferences.map(memory => memory.id))
    await f.control.command({ type: 'cancel-request' })
    await f.control.command({ type: 'assign', threadId: 'workshop', instruction: 'Bug verification' })
    f.host.event({ type: 'failure', threadId: 'workshop', text: 'The test still fails' })
    await vi.waitFor(() => expect(f.complete.mock.calls.some(call => !('utterance' in (call[1] as object)))).toBe(true))
    const decisionInput = f.complete.mock.calls.find(call => !('utterance' in (call[1] as object)))![1] as { preferences: { id: string }[] }
    expect(decisionInput.preferences.map(memory => memory.id)).toContain('project-memory')
    expect(decisionInput.preferences.map(memory => memory.id)).not.toContain('foreign-memory')
    await vi.waitFor(() => expect(f.control.get().queue.some(item => item.kind === 'blocked')).toBe(true))
    await vi.waitFor(async () => {
      const supervision = (await f.turns.recent(10)).find(turn => turn.source === 'supervision')!
      expect(supervision?.retrievedMemoryIds).toEqual(decisionInput.preferences.map(memory => memory.id))
    })
    f.host.event({ type: 'permission', threadId: 'workshop', text: 'Publish a release and spend money', requestId: 'publish-request' })
    await f.control.command({ type: 'refresh' })
    expect(f.control.get().queue.some(item => item.kind === 'permission' && item.requestId === 'publish-request')).toBe(true)
    expect(f.execute.mock.calls.some(([command]) => command.type === 'answer')).toBe(false)
    await f.control.command({ type: 'answer', threadId: 'workshop', requestId: 'publish-request', answer: 'Proceed' })
    expect(f.control.get().error).toMatch(/confirm|allow|approval|policy/i)
    expect(f.execute.mock.calls.some(([command]) => command.type === 'answer')).toBe(false)
  })

  it('records no memory IDs or preference context for an unrelated request', async () => {
    const f = await fixture()
    f.profile.command({ type: 'complete-questionnaire', answers: memoryTopics.map(topic => ({ topic, content: `${topic} preference` })), boundaries: [] })
    await f.control.command({ type: 'utterance', text: 'Compiler database networking' })
    expect((f.complete.mock.calls.at(-1)![1] as { preferences: unknown[] }).preferences).toEqual([])
    expect((await f.turns.recent(1))[0]!.retrievedMemoryIds).toEqual([])
  })
})
