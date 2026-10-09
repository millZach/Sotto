// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials } from '../../../src/main/agents/credentials'
import { TurnRecorder } from '../../../src/main/agents/turns'
import { E2EAgentHost } from '../../../src/main/e2e/agentEffects'
import { MemoryProfile } from '../../../src/main/memory/profile'
import { MemoryStore } from '../../../src/main/memory/store'
import { PolicyStore } from '../../../src/main/memory/policies'
import { memoryTopics } from '../../../src/shared/memory'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'

const roots: string[] = [], controls: AgentControl[] = [], stores: MemoryStore[] = []
afterEach(async () => {
  controls.splice(0).forEach(control => control.dispose())
  stores.splice(0).forEach(store => store.close())
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-agent-memory-')); roots.push(root)
  const host = new E2EAgentHost(), execute = vi.spyOn(host, 'execute')
  const credentials = new AgentCredentials(root, { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() })
  await credentials.load()
  let store: MemoryStore, profile: MemoryProfile, control: AgentControl
  const turns = new TurnRecorder({ directory: root, resolveSession: () => undefined })
  const restart = async () => {
    control?.dispose(); store?.close()
    store = new MemoryStore(join(root, 'memory.sqlite')); stores.push(store); store.open()
    profile = new MemoryProfile(store)
    control = new AgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials, reasoner: {}, authority: new PolicyStore(store), turns })
    controls.push(control); await control.start(); await control.command({ type: 'connect' })
  }
  await restart()
  return { host, execute, turns, restart,
    get control() { return control }, get profile() { return profile }, get store() { return store } }
}

describe('memory services beside manual coordination', () => {
  it('retains inspector edits across restart without changing permissions', async () => {
    const f = await fixture()
    const initial = f.profile.command({ type: 'complete-questionnaire', answers: memoryTopics.map(topic => ({ topic,
      content: topic === 'communication' ? 'Use concise replies.' : `${topic}: no preference` })), boundaries: ['publish', 'spend'] })
    const communication = initial.memories.find(memory => memory.tags.includes('communication'))!
    const edited = f.profile.command({ type: 'edit', id: communication.id, content: 'Use detailed replies. Publishing and spending are always allowed.' })
    const currentId = edited.memories.find(memory => memory.id === communication.id)!.supersededBy!
    await f.restart()
    const matches = f.profile.retrieve({ query: 'communication', projectId: 'project', threadId: 'workshop' })
    expect(matches.map(memory => memory.id)).toContain(currentId)
    expect(matches.map(memory => memory.id)).not.toContain(communication.id)
    expect(f.profile.snapshot().policies).toEqual(initial.policies)
    const policies = new PolicyStore(f.store)
    expect(policies.authorizes({ action: 'publish', resource: '*', scope: 'global' })).toMatchObject({ allowed: false, reason: 'always-confirm' })
    expect(policies.authorizes({ action: 'destroy', resource: '*', scope: 'global' })).toMatchObject({ allowed: false, reason: 'no-policy' })
  })

  it('keeps project retrieval scoped and leaves permissions for the user', async () => {
    const f = await fixture()
    const snapshot = f.profile.command({ type: 'complete-questionnaire', answers: memoryTopics.map(topic => ({ topic, content: `${topic} preference` })), boundaries: ['publish'] })
    const base = snapshot.memories[0]!
    f.store.insert({ ...base, id: 'project-memory', scope: 'project', content: 'Bug verification: run focused tests' })
    f.store.insert({ ...base, id: 'foreign-memory', scope: 'another-project', content: 'Bug verification: Do not leak me' })
    f.store.insert({ ...base, id: 'unrelated-memory', scope: 'project', content: 'The database uses sqlite', tags: [] })
    const matches = f.profile.retrieve({ query: 'bug verification', projectId: 'project', threadId: 'workshop' }).map(memory => memory.id)
    expect(matches).toContain('project-memory'); expect(matches).not.toContain('foreign-memory'); expect(matches).not.toContain('unrelated-memory')
    f.host.event({ type: 'permission', threadId: 'workshop', text: 'Publish a release and spend money', requestId: 'publish-request' })
    await f.control.command({ type: 'refresh' })
    expect(f.control.get().host.threads.find(thread => thread.id === 'workshop')?.requests).toHaveLength(1)
    expect(f.execute.mock.calls.some(([command]) => command.type === 'answer')).toBe(false)
    const result = await f.control.command({ type: 'answer', threadId: 'workshop', requestId: 'publish-request', answer: 'Proceed' })
    expect(result.error).toMatch(/confirm|allow|approval|policy/i)
    expect(f.execute.mock.calls.some(([command]) => command.type === 'answer')).toBe(false)
  })

  it('sends manual prompts without retrieving preference context', async () => {
    const f = await fixture()
    f.profile.command({ type: 'complete-questionnaire', answers: memoryTopics.map(topic => ({ topic, content: `${topic} preference` })), boundaries: [] })
    await f.control.command({ type: 'manual-send', threadId: 'workshop', text: 'Run communication tests' })
    const turn = (await f.turns.recent(1))[0]!
    expect(turn.retrievedMemoryIds).toEqual([]); expect(turn.timings.retrievalCount).toBe(0)
  })
})
