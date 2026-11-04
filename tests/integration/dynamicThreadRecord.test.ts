// @vitest-environment node
// ADR-0191: Dynamic is a mark Sotto keeps on a thread at rest. Setting it asks no provider, and a provider's own updates and
// a restart keep it. With the Owl feature off, nothing sets it and a saved mark stays whole.
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { workspaceFixture } from '../fixtures/workspaceFixture'
import { agentControlFixture } from '../fixtures/agentControlFixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture(enabled = true) {
  const workspace = await workspaceFixture(undefined, { history: true, watcherEnabled: false })
  cleanups.push(workspace.remove)
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host, credentialOptions: { mode: 'unavailable' },
    control: { historyEnabled: () => true, watcherEnabled: false, dynamicThreadsEnabled: enabled } })
  cleanups.push(async () => { f.control.dispose(); await f.control.closed(); await workspace.stop() })
  await f.control.start()
  for (const provider of ['claude', 'codex', 'grok'] as const) await f.control.commandShell({ type: 'connect', provider })
  const thread = async (provider: 'claude' | 'codex' | 'grok') => {
    const shell = f.control.shell().host, threadId = randomUUID()
    const project = shell.projects.find(item => item.providerId === provider)!, model = shell.models.find(item => item.providerId === provider)!
    expect((await f.control.commandShell({ type: 'create-thread', threadId, projectId: project.id, title: 'Synthetic thread', modelId: model.id })).error).toBeNull()
    return threadId
  }
  const set = (threadId: string, dynamic: boolean) => f.control.commandShell({ type: 'set-thread-dynamic', threadId, dynamic })
  const mark = (threadId: string) => f.control.shell().host.threads.find(item => item.id === threadId)?.dynamic
  return { ...f, workspace, thread, set, mark }
}

it('sets and clears the mark on a thread at rest, asking the provider nothing', async () => {
  const f = await fixture(), id = await f.thread('claude')
  const before = f.workspace.adapters.claude.commands.length
  expect((await f.set(id, true)).error).toBeNull()
  expect(f.mark(id)).toBe(true)
  expect(f.workspace.adapters.claude.commands).toHaveLength(before)
  // A provider's own update keeps Sotto's record.
  f.workspace.adapters.claude.emit()
  await f.control.commandShell({ type: 'refresh', provider: 'claude' })
  expect(f.mark(id)).toBe(true)
  expect((await f.set(id, false)).error).toBeNull()
  expect(f.mark(id)).toBeUndefined()
})

it('refuses a provider that cannot oversee yet, in plain words, and sets nothing', async () => {
  const f = await fixture(), id = await f.thread('grok')
  const answer = await f.set(id, true)
  expect(answer.error).toContain('Only a Claude Code or Codex thread can be Dynamic for now.')
  expect(f.mark(id)).toBeUndefined()
})

it('refuses a change while a turn runs', async () => {
  const f = await fixture(), id = await f.thread('codex')
  expect((await f.control.commandShell({ type: 'manual-send', threadId: id, draftId: randomUUID(), text: 'Synthetic request' })).error).toBeNull()
  const answer = await f.set(id, true)
  expect(answer.error).toContain('Wait for this thread to finish')
  expect(f.mark(id)).toBeUndefined()
})

it('sets nothing with the Owl feature off', async () => {
  const f = await fixture(false), id = await f.thread('claude')
  expect((await f.set(id, true)).error).toContain('Dynamic threads are available in Sotto Owl.')
  expect(f.mark(id)).toBeUndefined()
})

it('keeps the mark through a restart', async () => {
  const f = await fixture(), id = await f.thread('claude')
  expect((await f.set(id, true)).error).toBeNull()
  f.control.dispose(); await f.control.closed(); await f.workspace.stop()
  const workspace = await workspaceFixture(f.workspace.root, { history: true, watcherEnabled: false, adapters: f.workspace.adapters })
  const again = await agentControlFixture({ directory: workspace.root, host: workspace.host, credentialOptions: { mode: 'unavailable' },
    control: { historyEnabled: () => true, watcherEnabled: false, dynamicThreadsEnabled: true } })
  cleanups.push(async () => { again.control.dispose(); await again.control.closed(); await workspace.stop() })
  await again.control.start()
  await again.control.commandShell({ type: 'connect', provider: 'claude' })
  expect(again.control.shell().host.threads.find(item => item.id === id)?.dynamic).toBe(true)
})
