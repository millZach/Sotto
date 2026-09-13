// @vitest-environment node
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { workspaceFixture } from '../fixtures/workspaceFixture'
import { AgentControl } from '../../src/main/agents/control'
import { AgentCredentials } from '../../src/main/agents/credentials'
import type { AgentState } from '../../src/shared/agents'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const f = await workspaceFixture()
  const credentials = new AgentCredentials(join(f.root, 'vault'), { isEncryptionAvailable: () => false, encryptString: value => Buffer.from(value), decryptString: value => value.toString() })
  await credentials.load()
  const control = new AgentControl({ directory: f.root, host: f.host, credentials,
    reasoner: { intent: async () => ({ type: 'clarify', text: 'Choose a thread' }), decide: async () => ({ decision: 'human', text: 'Review' }) },
    membership: { status: async () => ({ status: 'beta', label: 'Test', expiresAt: null }), action: async () => ({ status: 'beta', label: 'Test', expiresAt: null }) } })
  cleanup.push(async () => { control.dispose(); await control.privacyChanged(); await f.stop(); await f.remove() })
  await control.start(); await control.command({ type: 'connect' })
  return { ...f, control }
}
function thread(state: AgentState) { return state.host.threads.find(thread => thread.id === state.activeThreadId)! }

describe('workspace controller integration', () => {
  it('allows an explicit retry after definitive native creation rejection without changing its binding', async () => {
    const f = await fixture()
    const initial = f.control.get()
    const model = initial.host.models.find(model => model.providerId === 'codex')!
    const created = await f.control.command({ type: 'create-thread', projectId: initial.host.projects[0]!.id, modelId: model.id, title: 'Retry', managed: false })
    const id = created.activeThreadId!
    const execute = f.adapters.codex.execute.bind(f.adapters.codex)
    const spy = vi.spyOn(f.adapters.codex, 'execute').mockImplementationOnce(async () => ({ accepted: false }))
    const prompt = { type: 'manual-send' as const, threadId: id, text: 'Try this work' }
    expect((await f.control.command(prompt)).error).toContain('rejected thread creation')
    const binding = f.registry.byThread(id)
    spy.mockImplementation(execute)
    expect((await f.control.command(prompt)).error).toBeNull()
    expect(f.registry.byThread(id)).toEqual(binding)
    expect(f.adapters.codex.commands.map(command => command.type)).toEqual(['create-thread', 'send'])
  })
  it('opens existing projects without changing scope, creates multiple manual threads, and keeps coordinator settings independent', async () => {
    const f = await fixture()
    let state = await f.control.command({ type: 'configure', patch: { reasoning: 'openrouter', reasoningModel: 'independent-coordinator' } })
    const project = state.host.projects.find(project => project.providerId === 'codex')!
    await mkdir(project.path, { recursive: true })
    state = await f.control.command({ type: 'create-project', provider: 'codex', title: 'Open folder', path: project.path, useExisting: true })
    expect(state.error).toBeNull()
    expect(state.activeProjectId).toBe(project.id)
    expect(state.host.projects).toHaveLength(3)
    expect(f.adapters.codex.commands).toHaveLength(0)
    const model = state.host.models.find(model => model.providerId === 'codex')!
    state = await f.control.command({ type: 'create-thread', projectId: project.id, modelId: model.id, title: 'First', managed: false })
    expect(state.error).toBeNull(); const first = thread(state)
    state = await f.control.command({ type: 'create-thread', projectId: project.id, modelId: model.id, title: 'Second', managed: false })
    expect(state.error).toBeNull(); const second = thread(state)
    expect(first.id).not.toBe(second.id)
    expect([first.projectId, second.projectId]).toEqual([project.id, project.id])
    expect(state.assignments).toEqual([])
    await f.control.command({ type: 'disconnect', provider: 'codex' })
    const claude = state.host.models.find(model => model.providerId === 'claude')!
    state = await f.control.command({ type: 'configure-thread', threadId: first.id, modelId: claude.id, reasoningEffort: 'high', runtimeMode: 'approval-required' })
    expect(state.error).toBeNull()
    expect(state.configuration).toMatchObject({ provider: 'codex', reasoning: 'openrouter', reasoningModel: 'independent-coordinator' })
    state = await f.control.command({ type: 'manual-send', threadId: first.id, text: 'Work on this project' })
    expect(state.error).toBeNull()
    expect(state.host.threads.find(thread => thread.id === first.id)).toMatchObject({ projectId: project.id, providerId: 'claude', nativeSessionStarted: true, status: 'running' })
    expect(state.assignments).toEqual([])
    expect(JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')).outbox).toEqual([])
  })

  it('settles and restores offline while retaining working requests, attention, IDs and explicit management authority', async () => {
    const f = await fixture()
    const original = f.control.get().host.threads.find(thread => thread.providerId === 'codex')!
    await f.control.command({ type: 'assign', threadId: original.id, instruction: 'Keep watching' })
    const native = f.adapters.codex.state.threads.find(thread => thread.id === f.registry.byThread(original.id)!.sessionId)!
    native.status = 'running'
    native.requests.push({ id: 'permission', kind: 'permission', text: 'Run the build?', options: [] })
    f.adapters.codex.emit()
    const before = f.control.get()
    expect(before.queue.some(item => item.requestId === 'permission')).toBe(true)
    const callCount = f.adapters.codex.commands.length
    let state = await f.control.command({ type: 'settle-thread', threadId: original.id })
    expect(state.error).toBeNull()
    state = await f.control.command({ type: 'settle-project', projectId: original.projectId })
    expect(state.error).toBeNull()
    expect(state.assignments).toEqual(before.assignments)
    expect(state.queue).toEqual(before.queue)
    expect(state.host.threads.find(thread => thread.id === original.id)).toMatchObject({ status: 'running', requests: native.requests, workspaceSettledAt: expect.any(String) })
    expect(f.adapters.codex.commands).toHaveLength(callCount)
    await f.control.command({ type: 'disconnect' })
    state = await f.control.command({ type: 'restore-project', projectId: original.projectId })
    expect(state.error).toBeNull()
    expect(state.host.projects.find(project => project.id === original.projectId)?.workspaceSettledAt).toBeNull()
    expect(state.host.threads.find(thread => thread.id === original.id)?.workspaceSettledAt).toEqual(expect.any(String))
    state = await f.control.command({ type: 'restore-thread', threadId: original.id })
    expect(state.error).toBeNull()
    expect(state.host.threads.find(thread => thread.id === original.id)?.workspaceSettledAt).toBeNull()
    expect(state.queue).toEqual(before.queue)
    expect(f.adapters.codex.commands).toHaveLength(callCount)
  })
})
