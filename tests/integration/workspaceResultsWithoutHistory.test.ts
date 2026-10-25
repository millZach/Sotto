// @vitest-environment node
import { afterEach, expect, it } from 'vitest'
import { ConfiguredProviderHost } from '../../src/main/agents/providerSwitch'
import { SottoThreadHost, ThreadRegistry } from '../../src/main/agents/threads'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import type { AgentHostSnapshot } from '../../src/shared/agents'
import { claudeFixture } from '../fixtures/claudeFixture'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'

/**
 * A thread refresh and a settings result through the stack the app composes: the real Claude adapter over the
 * fake CLI, Sotto's thread identities, the provider switch and the workspace (#368). The workspace keeps history
 * from the adapter's events, so what the switch hands it carries no held thread's messages, and what the pane is
 * given, the workspace's own window, is the same afterwards as before. The first half is what fails without
 * #368; the second guards that leaving the messages out changed nothing the pane draws.
 */
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

const WORDS = 'lorem ipsum dolor sit amet '

it('hands the workspace a thread refresh and a settings result without held histories, and the pane keeps the same history', async () => {
  const f = await claudeFixture(undefined, 10_000)
  const registry = new ThreadRegistry(f.root)
  const providers = new ConfiguredProviderHost({ hosts: { codex: new FakeProviderHost(), claude: new SottoThreadHost('claude', f.host, registry),
    grok: new FakeProviderHost(), devin: new FakeProviderHost(), muse: new FakeProviderHost(), opencode: new FakeProviderHost(), cursor: new FakeProviderHost() }, provider: () => 'claude' })
  const workspace = new WorkspaceHost(providers, f.root)
  cleanup.push(async () => { workspace.disconnect(); await f.adapter.closed(); await workspace.close(); await registry.flush(); await f.cleanup() })
  await workspace.connect('claude')
  const model = workspace.workspaceSnapshot().models[0]!
  await workspace.execute({ type: 'create-project', commandId: 'project', projectId: 'project', title: 'Fixture', path: f.root, provider: 'claude' })
  const project = workspace.workspaceSnapshot().projects[0]!
  // Two threads with open CLIs, so both are held. A pane shows the first.
  const ids = ['shown', 'beside']
  for (const id of ids) {
    await workspace.execute({ type: 'create-thread', commandId: `create-${id}`, threadId: id, projectId: project.id, title: 'Fixture', modelId: model.id })
    await workspace.execute({ type: 'send', commandId: `send-${id}`, threadId: id, messageId: `prompt-${id}`, text: 'Fixture task' })
  }
  workspace.observeThreads(['shown'])
  for (const id of ids) {
    const session = registry.byThread(id)!.sessionId
    await f.action(session, { type: 'raw-burst', frames: Array.from({ length: 6 }, (_, index) => index % 2 === 0
      ? { type: 'user', uuid: `${id}-user-${index}`, message: { role: 'user', content: `${WORDS}${index}` } }
      : { type: 'assistant', uuid: `${id}-assistant-${index}`, message: { id: `${id}-reply-${index}`, content: [{ type: 'text', text: `${WORDS}${index}` }] } }) })
    // The fixture reads one action at a time from one file, so the next waits until this one has been heard.
    await expect.poll(() => workspace.workspaceSnapshot().threads.find(thread => thread.id === id)?.summary?.messageCount, { timeout: 30_000 }).toBe(7)
    await f.action(session, { type: 'complete', text: `Finished ${id}` })
  }
  await expect.poll(() => workspace.workspaceSnapshot().threads.filter(thread => ids.includes(thread.id)).map(thread => thread.status), { timeout: 30_000 }).toEqual(['idle', 'idle'])
  const shape = (snapshot: AgentHostSnapshot) => snapshot.threads.find(thread => thread.id === 'shown')!.messages.map(message => ({ id: message.id, role: message.role, text: message.text }))
  const pane = () => shape(workspace.workspaceSnapshot())
  await expect.poll(() => pane().at(-1)?.text).toBe('Finished shown')
  const drawn = pane()
  expect(drawn).toHaveLength(8)
  // Both threads' messages are held: the adapter's own snapshot carries them for any reader that asks for it.
  const held = await f.host.snapshot()
  for (const id of ids) expect(held.threads.find(thread => thread.id === registry.byThread(id)!.sessionId)!.messages.length).toBeGreaterThan(0)

  // What the switch hands the workspace for each.
  const handed: AgentHostSnapshot[] = []
  const refresh = providers.refreshThread.bind(providers)
  providers.refreshThread = async (...args) => { const snapshot = await refresh(...args); handed.push(snapshot); return snapshot }
  const execute = providers.execute.bind(providers)
  providers.execute = async command => { const result = await execute(command); if (result.snapshot) handed.push(result.snapshot); return result }

  const refreshed = await workspace.refreshThread('shown')
  const settings = await workspace.execute({ type: 'configure-thread', commandId: 'settings', threadId: 'shown', runtimeMode: 'full-access' })
  expect(settings).toMatchObject({ accepted: true })
  expect(handed).toHaveLength(2)
  for (const snapshot of handed) {
    for (const id of ids) {
      const thread = snapshot.threads.find(item => item.id === id)!
      expect(thread.messages).toEqual([])
      expect(thread.summary?.lastAssistant?.text).toBe(`Finished ${id}`)
    }
  }
  expect(handed[1]!.threads.find(thread => thread.id === 'shown')!.runtimeMode).toBe('full-access')

  // The pane draws the same history from what the workspace hands back, and from its snapshot afterwards.
  expect(shape(refreshed)).toEqual(drawn)
  expect(shape(settings.snapshot!)).toEqual(drawn)
  expect(pane()).toEqual(drawn)
})
