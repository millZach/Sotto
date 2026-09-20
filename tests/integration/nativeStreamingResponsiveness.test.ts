// @vitest-environment node
import { performance } from 'node:perf_hooks'
import { afterEach, expect, it } from 'vitest'
import { ConfiguredProviderHost } from '../../src/main/agents/providerSwitch'
import { SottoThreadHost, ThreadRegistry } from '../../src/main/agents/threads'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import { claudeFixture } from '../fixtures/claudeFixture'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'
import { expectWithinBudget } from '../fixtures/perfBudget'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

it.each(['claude', 'grok'] as const)('%s keeps three streaming threads responsive without losing replies or permissions', async provider => {
  // The Grok history clock is independent of this test's live notification burst.
  const f = provider === 'claude' ? await claudeFixture() : await grokFixture(undefined, 2000, 60_000)
  const registry = new ThreadRegistry(f.root)
  const host = new SottoThreadHost(provider, f.host, registry)
  const providers = new ConfiguredProviderHost({ hosts: { codex: new FakeProviderHost(), claude: new FakeProviderHost(), grok: new FakeProviderHost(), devin: new FakeProviderHost(), [provider]: host }, provider: () => provider })
  const workspace = new WorkspaceHost(providers, f.root)
  cleanup.push(async () => { workspace.disconnect(); await f.adapter.closed(); await workspace.privacyChanged(); workspace.dispose(); await registry.flush(); await f.cleanup() })
  await workspace.connect(provider)
  const model = workspace.workspaceSnapshot().models[0]!
  await workspace.execute({ type: 'create-project', commandId: 'project', projectId: 'project', title: 'Fixture', path: f.root, provider })
  const project = workspace.workspaceSnapshot().projects[0]!
  const ids = ['one', 'two', 'three']
  for (const id of ids) {
    await workspace.execute({ type: 'create-thread', commandId: `create-${id}`, threadId: id, projectId: project.id, title: 'Fixture', modelId: model.id })
    await workspace.execute({ type: 'send', commandId: `send-${id}`, threadId: id, messageId: `message-${id}`, text: 'Fixture task' })
  }
  const sessionIds = ids.map(id => registry.byThread(id)!.sessionId)
  const nativeIds = await Promise.all(sessionIds.map(id => f.realId(id)))
  const grokFrame = (index: number, update: Record<string, unknown>) => ({ method: 'session/update', params: {
    sessionId: nativeIds[index], update, _meta: { promptId: `prompt-${index}`, streamStartMs: 10 },
  } })
  const transmit = async (batches: Record<string, unknown>[][]): Promise<void> => {
    if (provider === 'claude') await Promise.all(batches.map((frames, index) => f.action(sessionIds[index]!, { type: 'raw-burst', frames })))
    else await f.action(sessionIds[0]!, { type: 'raw-burst', frames: batches.flat() })
  }
  await transmit(ids.map((id, index) => Array.from({ length: 12 }, (_, item) => provider === 'claude'
    ? { type: 'assistant', uuid: `tool-frame-${item}`, message: { id: `tools-${id}`, content: [{ type: 'tool_use', id: `tool-${item}`, name: 'Bash', input: { command: 'x'.repeat(8_000) } }] } }
    : grokFrame(index, { sessionUpdate: 'tool_call', toolCallId: `tool-${item}`, title: 'Fixture', kind: 'execute', status: 'in_progress', rawInput: { command: 'x'.repeat(8_000) } }))))
  await expect.poll(() => workspace.workspaceSnapshot().threads.every(thread => thread.activities?.filter(a => a.kind === 'command').length === 12)).toBe(true)

  let publications = 0
  const off = f.host.subscribe(() => { publications += 1 })
  let previous = performance.now()
  const delays: number[] = []
  const timer = setInterval(() => { const now = performance.now(); delays.push(now - previous); previous = now }, 5)
  try {
    await transmit(ids.map((id, index) => provider === 'claude'
      ? [{ type: 'stream_event', event: { type: 'message_start', message: { id: `reply-${id}` } } },
        ...Array.from({ length: 200 }, () => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '.' } } }))]
      : Array.from({ length: 200 }, () => grokFrame(index, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '.' } }))))
    await expect.poll(() => workspace.workspaceSnapshot().threads.map(thread => thread.messages.filter(message => message.role === 'assistant' && message.text).map(message => message.text.length))).toEqual([[200], [200], [200]])
    const worst = Math.max(...delays, performance.now() - previous)
    console.info(`${provider} burst: ${publications} snapshots for 600 chunks; longest heartbeat gap ${Math.round(worst)} ms`)
    expect(publications).toBeLessThan(60)
    expectWithinBudget(worst, 250, `${provider} three-thread heartbeat`)

    await f.driver.raisePermission(sessionIds[0]!, 'Synthetic permission')
    await expect.poll(() => workspace.workspaceSnapshot().threads.find(thread => thread.id === ids[0])?.requests.length).toBe(1)
    expect((await f.driver.requests()).some(record => f.protocol?.permissionDecision(record) !== undefined)).toBe(false)
    for (const id of ids) expect(workspace.threadMessages(id).filter(message => message.role === 'assistant' && message.text).map(message => message.text)).toEqual(['.'.repeat(200)])
    // A permission on one thread cannot hold up completion of its neighbors.
    await transmit(ids.map((_id, index) => index === 0 ? [] : provider === 'claude'
      ? [{ type: 'result', subtype: 'success', session_id: nativeIds[index], is_error: false }]
      : [grokFrame(index, { sessionUpdate: 'turn_completed', stop_reason: 'end_turn' })]))
    await expect.poll(() => workspace.workspaceSnapshot().threads.filter(thread => thread.id !== ids[0]).map(thread => thread.status)).toEqual(['idle', 'idle'])
    expect(workspace.workspaceSnapshot().threads.find(thread => thread.id === ids[0])?.requests).toHaveLength(1)
  } finally { clearInterval(timer); off() }
})
