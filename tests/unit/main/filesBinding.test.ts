// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials } from '../../../src/main/agents/credentials'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { resolveFilesBinding } from '../../../src/main/files/binding'
import { FilesService } from '../../../src/main/files/service'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot } from '../../../src/shared/agents'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'

const host = (): AgentHostSnapshot => ({ ...EMPTY_AGENT_HOST,
  projects: [{ id: 'project', title: 'Project', path: 'D:/project' }],
  threads: [{ id: 'thread', projectId: 'project', title: 'Thread', modelId: 'model', status: 'idle', messages: [], requests: [] }],
})
describe('Files working-directory binding integration', () => {
  it('previews source files for an unsent worktree choice without changing its eventual binding', () => {
    const state = host(), thread = state.threads[0]!
    thread.nativeSessionStarted = false
    thread.worktree = { mode: 'independent', status: 'pending' }
    expect(resolveFilesBinding(state, 'thread')?.workingDirectory).toBe('D:/project')
    expect(thread.worktree).toEqual({ mode: 'independent', status: 'pending' })
    thread.worktree = { mode: 'independent', status: 'ready', path: 'D:/worktrees/task' }
    expect(resolveFilesBinding(state, 'thread')?.workingDirectory).toBe('D:/worktrees/task')
  })
  it('uses the existing thread project fallback while keeping Sotto identity', () => {
    expect(resolveFilesBinding(host(), 'thread')).toEqual({ threadId: 'thread', projectId: 'project', workingDirectory: 'D:/project' })
    expect(resolveFilesBinding(host(), 'missing')).toBeNull()
  })
  it('uses native cwd, then recorded worktree path, with no project identity reassignment', () => {
    const state = host(), thread = state.threads[0]!
    thread.worktree = { mode: 'independent', status: 'ready', path: 'D:/worktrees/task' }
    expect(resolveFilesBinding(state, 'thread')).toMatchObject({ projectId: 'project', workingDirectory: 'D:/worktrees/task' })
    thread.workingDirectory = 'D:/native/actual'
    expect(resolveFilesBinding(state, 'thread')).toMatchObject({ projectId: 'project', workingDirectory: 'D:/native/actual' })
  })
  it('does not replace explicit missing cwd or failed/pending setup with the project folder', () => {
    const state = host(), thread = state.threads[0]!
    thread.workingDirectory = 'D:/does-not-exist'
    expect(resolveFilesBinding(state, 'thread')?.workingDirectory).toBe('D:/does-not-exist')
    for (const status of ['pending', 'error'] as const) {
      thread.worktree = { mode: 'independent', status }
      expect(() => resolveFilesBinding(state, 'thread')).toThrow()
    }
  })
})

describe('the coordinator answering Files without copying its state', () => {
  const roots: string[] = []
  const controls: AgentControl[] = []
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const control of controls.splice(0)) { control.dispose(); await control.privacyChanged() }
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  })
  async function connected(): Promise<AgentControl> {
    const root = await mkdtemp(join(tmpdir(), 'sotto-files-binding-')); roots.push(root)
    const credentials = new AgentCredentials(root, { isEncryptionAvailable: () => false, encryptString: t => Buffer.from(t), decryptString: t => t.toString() })
    await credentials.load()
    const host = new E2EAgentHost()
    // The fixture project points at a real folder, so a listing goes all the way through verification.
    ;(host as unknown as { state: AgentHostSnapshot }).state.projects[0]!.path = root
    const control = new AgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials, reasoner: e2eAgentReasoner,
      membership: { status: async () => ({ status: 'beta', label: 'Test', expiresAt: null }), action: async () => ({ status: 'beta', label: 'Test', expiresAt: null }) } })
    controls.push(control)
    await control.start(); await control.command({ type: 'connect' })
    return control
  }

  it('resolves every thread the way the whole state would, and a Files lookup copies nothing', async () => {
    const control = await connected()
    const state = control.get()
    expect(state.host.threads.length).toBeGreaterThan(0)
    for (const thread of state.host.threads) expect(control.filesBinding(thread.id)).toEqual(resolveFilesBinding(state.host, thread.id))
    expect(control.filesBinding('missing')).toBeNull()

    const copies = vi.spyOn(AgentControl.prototype, 'get')
    const files = new FilesService({ resolveBinding: threadId => control.filesBinding(threadId), copyPath: () => undefined, reveal: () => undefined })
    for (const thread of state.host.threads) {
      expect(await files.resolveWorkspace(thread.id)).toMatchObject({ ok: true })
      expect(await files.list({ threadId: thread.id, path: '' })).toMatchObject({ ok: true })
    }
    // Resolving through `get()` copied the whole state, histories included, six times per listing and
    // twice per workspace check: 16 copies here.
    expect(copies).not.toHaveBeenCalled()
  })

  it('hands the terminal a copy of the projects that it cannot change', async () => {
    const control = await connected()
    const projects = control.projects()
    expect(projects).toEqual(control.get().host.projects)
    projects[0]!.path = 'D:/elsewhere'
    expect(control.projects()[0]!.path).not.toBe('D:/elsewhere')
  })
})
