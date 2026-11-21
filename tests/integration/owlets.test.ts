// @vitest-environment node
// ADR-0211: an owlet is one project-bound thread in a folder Sotto makes in its data folder, marked with its name and role.
// Making one moves no selection; a provider's own update and a restart keep the mark; with the Owl feature off nothing
// makes or changes one, and a saved owlet is kept whole and shown nowhere.
import { randomUUID } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { workspaceFixture } from '../fixtures/workspaceFixture'
import { agentControlFixture } from '../fixtures/agentControlFixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function control(workspace: Awaited<ReturnType<typeof workspaceFixture>>, owletsEnabled: boolean) {
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host, credentialOptions: { mode: 'unavailable' },
    control: { historyEnabled: () => true, watcherEnabled: false, owletsEnabled } })
  cleanups.push(async () => { f.control.dispose(); await f.control.closed(); await workspace.stop() })
  await f.control.start()
  for (const provider of ['claude', 'codex', 'grok'] as const) await f.control.commandShell({ type: 'connect', provider })
  return f
}

async function fixture(owletsEnabled = true) {
  const workspace = await workspaceFixture(undefined, { history: true, watcherEnabled: false, owletsEnabled })
  cleanups.push(workspace.remove)
  const f = await control(workspace, owletsEnabled)
  const model = (provider: 'claude' | 'codex' | 'grok') => f.control.shell().host.models.find(item => item.providerId === provider)!.id
  const make = (name: string, provider: 'claude' | 'codex' | 'grok' = 'claude', threadId = randomUUID()) =>
    f.control.commandShell({ type: 'create-owlet', threadId, name, role: 'Keeps my inbox', modelId: model(provider) }).then(shell => ({ shell, threadId }))
  const thread = (id: string) => f.control.shell().host.threads.find(item => item.id === id)
  return { ...f, workspace, make, thread }
}

it('makes its folder, the project there and its one thread, and moves no selection', async () => {
  const f = await fixture()
  const before = f.control.shell()
  const { shell, threadId } = await f.make('Tawny')
  expect(shell.error).toBeNull()
  const folder = join(f.workspace.root, 'owlets', 'Tawny')
  expect((await stat(folder)).isDirectory()).toBe(true)
  const thread = f.thread(threadId)!
  expect(thread.owlet).toEqual({ name: 'Tawny', role: 'Keeps my inbox' })
  expect(thread).toMatchObject({ title: 'Tawny', titleSource: 'user', providerId: 'claude' })
  expect(thread.worktree).toMatchObject({ mode: 'shared', path: folder })
  expect(f.control.shell().host.projects.find(project => project.id === thread.projectId)?.path).toBe(folder)
  const after = f.control.shell()
  expect([after.activeThreadId, after.activeProjectId]).toEqual([before.activeThreadId, before.activeProjectId])
  // Nothing reaches the provider before the user's first message.
  expect(f.workspace.adapters.claude.commands.some(command => command.type === 'send')).toBe(false)
})

it('refuses a second owlet of the same name, a provider whose memory it cannot turn off, and a name no folder takes', async () => {
  const f = await fixture()
  expect((await f.make('Tawny')).shell.error).toBeNull()
  expect((await f.make('tawny')).shell.error).toContain('has that name, or a folder by that name')
  const grok = await f.make('Scops', 'grok')
  expect(grok.shell.error).toContain('An owlet runs on Claude Code or Codex,')
  expect(f.thread(grok.threadId)).toBeUndefined()
  expect((await f.make('Elf/../../x')).shell.error).toContain('Use letters, numbers, spaces and hyphens')
  expect((await f.make('Codex owl', 'codex')).shell.error).toBeNull()
  expect(f.control.shell().host.threads.filter(thread => thread.owlet).map(thread => thread.owlet!.name).sort()).toEqual(['Codex owl', 'Tawny'])
})

it('changes its name and role, keeping its folder, and refuses a name another owlet has', async () => {
  const f = await fixture()
  const { threadId } = await f.make('Tawny')
  const projectId = f.thread(threadId)!.projectId
  await f.make('Scops')
  expect((await f.control.commandShell({ type: 'set-owlet', threadId, name: 'Tawny Owl', role: 'Keeps the receipts' })).error).toBeNull()
  expect(f.thread(threadId)).toMatchObject({ owlet: { name: 'Tawny Owl', role: 'Keeps the receipts' }, title: 'Tawny Owl', titleSource: 'user', projectId })
  expect((await f.control.commandShell({ type: 'set-owlet', threadId, name: 'Scops' })).error).toContain('has that name')
  expect(f.thread(threadId)?.owlet?.name).toBe('Tawny Owl')
  // A provider's own update keeps Sotto's record.
  f.workspace.adapters.claude.emit()
  await f.control.commandShell({ type: 'refresh', provider: 'claude' })
  expect(f.thread(threadId)?.owlet?.name).toBe('Tawny Owl')
})

it('never gives a new owlet the folder a renamed one still keeps', async () => {
  const f = await fixture()
  const { threadId } = await f.make('Tawny')
  expect((await f.control.commandShell({ type: 'set-owlet', threadId, name: 'Barn' })).error).toBeNull()
  const again = await f.make('Tawny')
  expect(again.shell.error).toContain('or a folder by that name')
  expect(f.thread(again.threadId)).toBeUndefined()
})

it('keeps an owlet on Claude Code or Codex before its first message', async () => {
  const f = await fixture()
  const { threadId } = await f.make('Tawny')
  const grok = f.control.shell().host.models.find(item => item.providerId === 'grok')!.id
  expect((await f.control.commandShell({ type: 'configure-thread', threadId, modelId: grok })).error).toContain('An owlet runs on Claude Code or Codex')
  expect(f.thread(threadId)?.providerId).toBe('claude')
  const codex = f.control.shell().host.models.find(item => item.providerId === 'codex')!.id
  expect((await f.control.commandShell({ type: 'configure-thread', threadId, modelId: codex })).error).toBeNull()
  expect(f.thread(threadId)?.providerId).toBe('codex')
})

it('tells the provider an owlet\'s name and role by its own session, and its new ones after an edit', async () => {
  const f = await fixture()
  const { threadId } = await f.make('Tawny')
  expect((await f.control.commandShell({ type: 'manual-send', threadId, draftId: randomUUID(), text: 'Synthetic request' })).error).toBeNull()
  const session = f.workspace.registry.byThread(threadId)!.sessionId
  expect(f.workspace.adapters.claude.owletInstructions?.(session)).toContain('You are Tawny, an owlet')
  expect(f.workspace.adapters.claude.owletInstructions?.(session)).toContain("Your role, in the user's words: Keeps my inbox")
  expect(f.workspace.adapters.claude.owletInstructions?.('another-session')).toBeUndefined()
})

it('refuses a model that is not ready before it makes the folder, and keeps a folder no owlet holds out of view', async () => {
  const f = await fixture()
  const model = f.control.shell().host.models.find(item => item.providerId === 'claude')!
  const refused = await f.control.commandShell({ type: 'create-owlet', threadId: randomUUID(), name: 'Elf', role: '', modelId: model.id, reasoningEffort: 'ultra' })
  expect(refused.error).toContain('That model or its options are not ready')
  await expect(stat(join(f.workspace.root, 'owlets', 'Elf'))).rejects.toThrow()
  // A folder whose owlet's thread was never made, as a stop part way leaves it, is not offered as a project.
  const path = join(f.workspace.root, 'owlets', 'Barn')
  await mkdir(path, { recursive: true })
  expect((await f.control.commandShell({ type: 'create-project', provider: 'claude', title: 'Barn', path, useExisting: true })).error).toBeNull()
  expect(f.control.shell().host.projects.some(project => project.path === path)).toBe(false)
})

it('makes and changes nothing with the Owl feature off', async () => {
  const f = await fixture(false)
  const { shell, threadId } = await f.make('Tawny')
  expect(shell.error).toBe('Owlets are available in Sotto Owl. Nothing was changed.')
  expect(f.thread(threadId)).toBeUndefined()
  await expect(stat(join(f.workspace.root, 'owlets', 'Tawny'))).rejects.toThrow()
})

it('keeps an owlet through a restart, and keeps it whole but shown nowhere once the Owl feature is off', async () => {
  const f = await fixture()
  const { threadId } = await f.make('Tawny')
  f.control.dispose(); await f.control.closed(); await f.workspace.stop()
  const reopen = async (enabled: boolean) => {
    const workspace = await workspaceFixture(f.workspace.root, { history: true, watcherEnabled: false, owletsEnabled: enabled, adapters: f.workspace.adapters })
    return { workspace, f: await control(workspace, enabled) }
  }
  const off = await reopen(false)
  expect(off.f.control.shell().host.threads.some(thread => thread.id === threadId)).toBe(false)
  expect((await off.f.control.commandShell({ type: 'manual-send', threadId, draftId: randomUUID(), text: 'Synthetic request' })).error).toContain('Owlets are available in Sotto Owl.')
  off.f.control.dispose(); await off.f.control.closed(); await off.workspace.stop()
  const on = (await reopen(true)).f
  expect(on.control.shell().host.threads.find(thread => thread.id === threadId)?.owlet).toEqual({ name: 'Tawny', role: 'Keeps my inbox' })
})
