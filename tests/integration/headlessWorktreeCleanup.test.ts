// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startHeadlessHost } from '../../src/host'
import { AgentControl } from '../../src/main/agents/control'
import { desktopWindowClient } from '../../src/main/agents/hostService'
import { ThreadWorktrees, runWorktreeGit as git } from '../../src/main/agents/threadWorktrees'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { SettingsRepository } from '../../src/main/storage/settingsRepository'
import type { AgentCommand } from '../../src/shared/agents'
import { DEFAULT_WORKTREE_CLEANUP } from '../../src/shared/settings'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'

const roots: string[] = []
const hosts: Awaited<ReturnType<typeof startHeadlessHost>>[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const host of hosts.splice(0)) await host.close()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-host-cleanup-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false)

/** A headless host whose own settings turn the on-settle rule on, with a committed project to make worktrees from. */
async function host() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-host-cleanup-')); roots.push(root)
  const data = join(root, 'data'), project = join(root, 'project')
  await mkdir(data); await mkdir(project)
  await git(project, ['init', '-b', 'main'])
  await writeFile(join(project, 'tracked.txt'), 'baseline')
  await git(project, ['add', '.'])
  await git(project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Baseline'])
  // The host reads its rules from its own data folder at start, as the desktop reads them from its settings.
  await new SettingsRepository(join(data, 'settings.json')).update({ worktreeCleanup: { ...DEFAULT_WORKTREE_CLEANUP, onSettle: true } })
  // The fake's stand-in sessions name a folder that does not exist, which would make sole ownership unprovable.
  const codex = new FakeProviderHost()
  codex.state.threads.length = 0
  const events: string[] = []
  const started = await startHeadlessHost({ dataDirectory: data, reasoner: e2eAgentReasoner, log: event => events.push(event),
    providers: { codex, claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost() } })
  hosts.push(started)
  const client = desktopWindowClient('host-cleanup')
  const command = async (value: AgentCommand) => { const state = await started.service.command(value, client); expect(state.error).toBeNull(); return state }
  await command({ type: 'configure', patch: { enabledProviders: ['codex'], provider: 'codex' } })
  await command({ type: 'connect', provider: 'codex' })
  const opened = await command({ type: 'create-project', provider: 'codex', title: 'Project', path: project, useExisting: true })
  const projectId = opened.host.projects.find(item => item.path === project)!.id
  const modelId = opened.host.models.find(model => model.providerId === 'codex')!.id
  const thread = (id: string) => started.service.state().host.threads.find(item => item.id === id)!
  /** A thread with its own worktree, made by its first send, whose turn has finished. */
  const worktreeThread = async (): Promise<string> => {
    const threadId = randomUUID()
    await command({ type: 'create-thread', threadId, projectId, title: 'Worktree thread', modelId, workingCopy: 'independent', managed: false })
    await command({ type: 'manual-send', threadId, text: 'Synthetic prompt' })
    for (const session of codex.state.threads) session.status = 'idle'
    codex.emit()
    await expect.poll(() => thread(threadId).status).toBe('idle')
    await expect.poll(() => thread(threadId).worktree?.status).toBe('ready')
    return threadId
  }
  return { host: started, data, project, projectId, events, command, thread, worktreeThread }
}

describe('worktree cleanup on the headless host', () => {
  it('reclaims a settled thread’s worktree under the host’s own rules and keeps its branch (ADR-0019)', async () => {
    const f = await host()
    const threadId = await f.worktreeThread()
    const { path, branch } = f.thread(threadId).worktree!
    expect(await exists(path!)).toBe(true)
    await f.command({ type: 'settle-thread', threadId })
    await expect.poll(() => f.thread(threadId).worktree?.reclaimedAt).toBeTruthy()
    expect(await exists(path!)).toBe(false)
    await expect(git(f.project, ['rev-parse', '--verify', `refs/heads/${branch!}`])).resolves.toBeTruthy()
    expect(f.events).toContain('worktree-cleanup-reclaimed')
    // Stable event names only; a path or a branch never reaches the log.
    expect(f.events.join('\n')).not.toContain(branch!)
  })

  it('drains a sweep on shutdown: the worktree in hand finishes and is saved, and no other is started', async () => {
    const f = await host()
    const first = await f.worktreeThread(), second = await f.worktreeThread()
    const paths = [first, second].map(id => f.thread(id).worktree!.path!)
    const entered = deferred(), release = deferred()
    const reclaim = ThreadWorktrees.prototype.reclaim
    const reclaiming = vi.spyOn(ThreadWorktrees.prototype, 'reclaim').mockImplementation(async function (this: ThreadWorktrees, ...args) {
      entered.resolve(); await release.promise
      return reclaim.apply(this, args)
    })
    const stopCoordinator = vi.spyOn(AgentControl.prototype, 'dispose')
    const closeWorkspace = vi.spyOn(WorkspaceHost.prototype, 'close')
    // Settling the project settles both threads at once, so one sweep holds the first and has the second to come.
    await f.command({ type: 'settle-project', projectId: f.projectId })
    await entered.promise
    let closed = false
    const closing = f.host.close().then(() => { closed = true })
    try {
      // One event-loop turn with no timer: everything close could do without the sweep has had its chance.
      await new Promise<void>(done => setImmediate(done))
      expect(closed).toBe(false)
      expect(stopCoordinator).not.toHaveBeenCalled()
      expect(closeWorkspace).not.toHaveBeenCalled()
    } finally {
      release.resolve()
      await closing
    }
    expect(reclaiming).toHaveBeenCalledOnce()
    expect(await exists(paths[0]!)).toBe(false)
    expect(await exists(paths[1]!)).toBe(true)
    const saved = JSON.parse(await readFile(join(f.data, 'workspace.json'), 'utf8')) as { snapshot: { threads: { id: string; worktree?: { reclaimedAt?: string } }[] } }
    expect(saved.snapshot.threads.find(item => item.id === first)?.worktree?.reclaimedAt).toBeTruthy()
    expect(saved.snapshot.threads.find(item => item.id === second)?.worktree?.reclaimedAt).toBeFalsy()
  })
})
