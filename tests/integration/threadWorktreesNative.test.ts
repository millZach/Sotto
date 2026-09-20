// @vitest-environment node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfiguredProviderHost } from '../../src/main/agents/providerSwitch'
import { SottoThreadHost, ThreadRegistry } from '../../src/main/agents/threads'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import { runWorktreeGit as git } from '../../src/main/agents/threadWorktrees'
import { codexFixture } from '../fixtures/codexFixture'
import { claudeFixture } from '../fixtures/claudeFixture'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'
import { devinFixture } from '../fixtures/devinFixture'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const factories = { codex: () => codexFixture(), claude: () => claudeFixture(), grok: () => grokFixture(), devin: () => devinFixture() }
async function fixture(provider: keyof typeof factories, committed = true, nested = false) {
  const f = await factories[provider]()
  let project = join(f.root, 'project'); await mkdir(project)
  await git(project, ['init'])
  if (committed) {
    await writeFile(join(project, 'tracked.txt'), 'baseline')
    await git(project, ['add', '.'])
    await git(project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Baseline'])
  }
  if (nested) {
    const app = join(project, 'packages', 'app'); await mkdir(app, { recursive: true })
    await writeFile(join(app, 'tracked.txt'), 'nested project baseline')
    await git(project, ['add', '.'])
    await git(project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Nested project'])
    project = app
  }
  const registry = new ThreadRegistry(f.root)
  const native = new ConfiguredProviderHost({ directory: f.root, provider: () => provider,
    threadProvider: id => registry.byThread(id)?.provider,
    hosts: { codex: new FakeProviderHost(), claude: new FakeProviderHost(), grok: new FakeProviderHost(), devin: new FakeProviderHost(), [provider]: new SottoThreadHost(provider, f.host, registry) } })
  const workspace = new WorkspaceHost(native, f.root)
  cleanup.push(async () => { workspace.disconnect(); await f.adapter.closed(); await workspace.privacyChanged(); workspace.dispose(); await registry.flush(); await f.cleanup() })
  await workspace.connect(provider)
  await workspace.execute({ type: 'create-project', provider, commandId: 'project', projectId: 'original-scope', title: 'Project', path: project })
  const model = workspace.workspaceSnapshot().models.find(model => model.providerId === provider)!
  const create = (threadId: string, workingCopy?: 'shared' | 'independent') => workspace.execute({ type: 'create-thread', commandId: threadId, threadId, projectId: 'original-scope', title: threadId, modelId: model.id, ...(workingCopy ? { workingCopy } : {}) })
  return { f, registry, workspace, project, native, create }
}
const prompt = (id: string) => ({ type: 'send' as const, commandId: `send-${id}`, threadId: id, messageId: `message-${id}`, text: `Synthetic changes for ${id}` })
/** Creation returns before the checkout; asking for the folder waits for the setup it started. */
const prepared = (workspace: WorkspaceHost, ...ids: string[]): Promise<unknown> =>
  Promise.all(ids.map(id => workspace.threadWorkingDirectory(id).catch(() => undefined)))

describe('native thread working copies', () => {
  for (const provider of ['codex', 'claude', 'grok', 'devin'] as const) it(`${provider}: concurrent native adapters write separate working files with unchanged project scope`, async () => {
    const { f, registry, workspace, project, create } = await fixture(provider, true, true)
    await writeFile(join(project, 'tracked.txt'), 'original dirty edits')
    await writeFile(join(f.root, 'script.json'), JSON.stringify({ writeCwd: true }))
    await Promise.all([create('first', 'independent'), create('second', 'independent')])
    await prepared(workspace, 'first', 'second')
    const before = workspace.workspaceSnapshot().threads.filter(thread => ['first', 'second'].includes(thread.id))
    expect(before.every(thread => thread.worktree?.status === 'pending' && !thread.worktree.path)).toBe(true)
    const results = await Promise.all([workspace.execute(prompt('first')), workspace.execute(prompt('second'))])
    expect(results).toEqual([{ accepted: true }, { accepted: true }])
    for (const id of ['first', 'second']) {
      const thread = workspace.workspaceSnapshot().threads.find(thread => thread.id === id)!
      expect(thread.projectId).toBe('original-scope')
      expect(thread.workingDirectory).toBe(join(thread.worktree!.path!, 'packages', 'app'))
      expect(registry.byThread(id)?.projectId).toBe('original-scope')
      expect(await readFile(join(thread.workingDirectory!, 'native-cwd-proof.txt'), 'utf8')).toBe(prompt(id).text)
      expect((await workspace.updateThreadWorktree(id, false)).threads.find(thread => thread.id === id)?.worktree?.dirty).toBe(true)
      expect(await workspace.threadWorkingDirectory(id)).toBe(thread.workingDirectory)
      await workspace.setWorkspaceSettled('thread', id, true)
    }
    expect(await readFile(join(project, 'tracked.txt'), 'utf8')).toBe('original dirty edits')
    await expect(readFile(join(project, 'native-cwd-proof.txt'))).rejects.toThrow()
    const aliases = JSON.parse(await readFile(join(f.root, `${provider}-threads.json`), 'utf8')) as Record<string, { cwd: string }>
    expect(new Set(Object.values(aliases).map(alias => alias.cwd)).size).toBe(2)
    const restored = new WorkspaceHost(new FakeProviderHost(), f.root)
    await restored.initialize()
    expect(restored.workspaceSnapshot().threads.filter(thread => ['first', 'second'].includes(thread.id)).map(thread => thread.workingDirectory)).toEqual(workspace.workspaceSnapshot().threads.filter(thread => ['first', 'second'].includes(thread.id)).map(thread => thread.workingDirectory))
    await restored.privacyChanged()
    restored.dispose()
  }, 20000)

  for (const provider of ['codex', 'claude', 'grok', 'devin'] as const) it(`${provider}: default threads share the live project without creating a worktree`, async () => {
    const { f, workspace, project, create, registry } = await fixture(provider)
    await writeFile(join(project, 'tracked.txt'), 'uncommitted project edit')
    await writeFile(join(f.root, 'script.json'), JSON.stringify({ writeCwd: true }))
    await create('shared-one'); await create('shared-two')
    expect((await git(project, ['worktree', 'list', '--porcelain'])).match(/worktree /gu)).toHaveLength(1)
    for (const id of ['shared-one', 'shared-two']) {
      expect(await workspace.threadWorkingDirectory(id)).toBe(project)
      await workspace.execute(prompt(id))
      expect(registry.byThread(id)?.projectId).toBe('original-scope')
      expect(await readFile(join(project, 'native-cwd-proof.txt'), 'utf8')).toBe(prompt(id).text)
    }
    expect(await readFile(join(project, 'tracked.txt'), 'utf8')).toBe('uncommitted project edit')
    expect((await git(project, ['worktree', 'list', '--porcelain'])).match(/worktree /gu)).toHaveLength(1)
  })

  it('keeps a failed local thread recoverable across restart, then retries exactly one allocation without native replay', async () => {
    const { workspace, f, project, native, create } = await fixture('codex', false)
    expect(await create('recoverable', 'independent')).toEqual({ accepted: true })
    await expect(workspace.execute(prompt('recoverable'))).rejects.toThrow('no commit')
    const failed = workspace.workspaceSnapshot().threads.find(thread => thread.id === 'recoverable')!
    expect(failed).toMatchObject({ nativeSessionStarted: false, projectId: 'original-scope', worktree: { status: 'error' } })
    await expect(workspace.execute(prompt('recoverable'))).rejects.toThrow('no commit')
    expect((await f.driver.requests()).filter(frame => frame.method === 'thread/start')).toHaveLength(0)
    await workspace.privacyChanged()
    const restored = new WorkspaceHost(native, f.root); await restored.initialize(); await restored.connect('codex')
    expect(restored.workspaceSnapshot().threads.find(thread => thread.id === 'recoverable')?.worktree?.status).toBe('error')
    await writeFile(join(project, 'tracked.txt'), 'first commit')
    await git(project, ['add', '.'])
    await git(project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'First'])
    const retried = await restored.updateThreadWorktree('recoverable', true)
    const allocation = retried.threads.find(thread => thread.id === 'recoverable')!.worktree!
    expect(allocation.status).toBe('ready')
    await restored.updateThreadWorktree('recoverable', true)
    expect(restored.workspaceSnapshot().threads.find(thread => thread.id === 'recoverable')?.worktree?.path).toBe(allocation.path)
    await restored.execute(prompt('recoverable'))
    expect((await f.driver.requests()).filter(frame => frame.method === 'thread/start')).toHaveLength(1)
    await restored.privacyChanged()
    restored.dispose()
  }, 20000)

  it('uses an explicitly shared project folder without creating a branch', async () => {
    const { workspace, project, create } = await fixture('codex')
    await create('shared', 'shared')
    await prepared(workspace, 'shared')
    const thread = workspace.workspaceSnapshot().threads.find(thread => thread.id === 'shared')!
    expect(thread).toMatchObject({ workingDirectory: project, worktree: { mode: 'shared', status: 'ready' } })
    await workspace.execute(prompt('shared'))
    expect((await git(project, ['worktree', 'list', '--porcelain'])).match(/worktree /gu)).toHaveLength(1)
  })

  for (const provider of ['codex', 'devin'] as const) it(`${provider}: reuses an existing worktree after a restart without checking its branch out again`, async () => {
    const { workspace, project, f, native, create } = await fixture(provider)
    await create('owner', 'independent')
    await workspace.execute(prompt('owner'))
    const owner = workspace.workspaceSnapshot().threads.find(thread => thread.id === 'owner')!
    await writeFile(join(owner.workingDirectory!, 'tracked.txt'), 'shared unfinished edits')
    const snapshot = workspace.workspaceSnapshot()
    await workspace.execute({ type: 'create-thread', commandId: 'reuse', threadId: 'reuse', projectId: 'original-scope', title: 'Reuse', modelId: snapshot.models.find(model => model.providerId === provider)!.id,
      workingCopy: 'independent', existingWorktreePath: owner.worktree!.path! })
    await workspace.privacyChanged()
    const restored = new WorkspaceHost(native, f.root); await restored.initialize(); await restored.connect(provider)
    try {
      await restored.execute(prompt('reuse'))
      const reused = restored.workspaceSnapshot().threads.find(thread => thread.id === 'reuse')!
      expect(reused).toMatchObject({ workingDirectory: owner.workingDirectory, worktree: { reused: true, mode: 'independent' } })
      expect(await readFile(join(reused.workingDirectory!, 'tracked.txt'), 'utf8')).toBe('shared unfinished edits')
      expect((await git(project, ['worktree', 'list', '--porcelain'])).match(/worktree /gu)).toHaveLength(2)
    } finally { await restored.privacyChanged(); restored.dispose() }
  })

  it('devin: refuses a locked working copy before another native prompt without changing its files', async () => {
    const { workspace, project, f, create } = await fixture('devin')
    await create('locked', 'independent')
    await workspace.execute(prompt('locked'))
    await workspace.execute({ type: 'interrupt', commandId: 'stop-locked', threadId: 'locked' })
    await expect.poll(() => workspace.workspaceSnapshot().threads.find(thread => thread.id === 'locked')?.status).toBe('idle')
    const path = workspace.workspaceSnapshot().threads.find(thread => thread.id === 'locked')!.worktree!.path!
    await writeFile(join(path, 'tracked.txt'), 'unfinished work')
    await git(project, ['worktree', 'lock', '--reason', 'Synthetic lock', path])
    try {
      await expect(workspace.execute({ ...prompt('locked'), commandId: 'blocked-send', messageId: 'blocked-message' })).rejects.toThrow('locked')
      expect((await f.driver.requests()).filter(frame => frame.method === 'session/prompt')).toHaveLength(1)
      expect(workspace.workspaceSnapshot().threads.find(thread => thread.id === 'locked')?.workingDirectory).toBe(path)
      expect(await readFile(join(path, 'tracked.txt'), 'utf8')).toBe('unfinished work')
    } finally { await git(project, ['worktree', 'unlock', path]) }
  })

  it('retains the reserved working copy after lost native creation acknowledgement and refuses replay after workspace restart', async () => {
    const { f, workspace, native, create, project } = await fixture('codex')
    await create('uncertain', 'independent')
    await prepared(workspace, 'uncertain')
    await writeFile(join(f.root, 'script.json'), JSON.stringify({ delay: { method: 'thread/start', ms: 3000 }, suppressNotifications: true }))
    await expect(workspace.execute(prompt('uncertain'))).rejects.toThrow('not confirmed')
    const path = workspace.workspaceSnapshot().threads.find(thread => thread.id === 'uncertain')!.workingDirectory
    const restored = new WorkspaceHost(native, f.root); await restored.initialize()
    await expect(restored.execute(prompt('uncertain'))).rejects.toThrow('will not create it twice')
    expect(restored.workspaceSnapshot().threads.find(thread => thread.id === 'uncertain')?.workingDirectory).toBe(path)
    expect((await f.driver.requests()).filter(frame => frame.method === 'thread/start')).toHaveLength(1)
    expect((await f.driver.requests()).filter(frame => frame.method === 'turn/start')).toHaveLength(0)
    expect((await git(project, ['worktree', 'list', '--porcelain'])).match(/worktree /gu)).toHaveLength(2)
    await restored.privacyChanged()
    restored.dispose()
  }, 20000)
})
