// @vitest-environment node
import { performance } from 'node:perf_hooks'
import { afterEach, expect, it } from 'vitest'
import { ConfiguredProviderHost } from '../../src/main/agents/providerSwitch'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import { codexFixture } from '../fixtures/codexFixture'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'
import { expectWithinBudget } from '../fixtures/perfBudget'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

it('keeps the event loop responsive through a three-thread Codex output burst', async () => {
  const f = await codexFixture(undefined, true)
  const providers = new ConfiguredProviderHost({ hosts: { codex: f.host, claude: new FakeProviderHost(), grok: new FakeProviderHost(), devin: new FakeProviderHost() }, provider: () => 'codex' })
  const workspace = new WorkspaceHost(providers, f.root)
  cleanup.push(async () => { workspace.disconnect(); await f.adapter.closed(); await workspace.privacyChanged(); workspace.dispose(); await f.cleanup() })
  await workspace.connect('codex')
  const initial = workspace.workspaceSnapshot()
  await workspace.execute({ type: 'create-project', commandId: 'project', projectId: 'project', title: 'Fixture', path: f.root, provider: 'codex' })
  const project = workspace.workspaceSnapshot().projects[0]!
  const ids = ['one', 'two', 'three']
  for (const id of ids) {
    await workspace.execute({ type: 'create-thread', commandId: `create-${id}`, threadId: id, projectId: project.id, title: 'Fixture', modelId: initial.models[0]!.id })
    await workspace.execute({ type: 'send', commandId: `send-${id}`, threadId: id, messageId: `message-${id}`, text: 'Fixture task' })
  }
  const threads = workspace.workspaceSnapshot().threads
  const nativeIds = await Promise.all(ids.map(id => f.realId(id)))
  const frames = ids.flatMap((id, index) => Array.from({ length: 12 }, (_, item) => ({ method: 'item/started', params: {
    threadId: nativeIds[index], turnId: threads.find(thread => thread.id === id)!.lastTurn!.id,
    item: { type: 'commandExecution', id: `command-${item}`, command: 'fixture', cwd: f.root, status: 'inProgress', aggregatedOutput: 'x'.repeat(8_000) },
  } })))
  await f.action(ids[0]!, { type: 'notify-burst', frames })
  await expect.poll(() => workspace.workspaceSnapshot().threads.every(thread => (thread.activities?.filter(a => a.kind === 'command').length ?? 0) === 12)).toBe(true)

  let publications = 0
  const off = f.adapter.subscribe(() => { publications += 1 })
  const delays: number[] = []
  let previous = performance.now()
  const heartbeat = setInterval(() => { const now = performance.now(); delays.push(now - previous); previous = now }, 5)
  try {
    const burst = Array.from({ length: 600 }, (_, index) => ({ method: 'item/commandExecution/outputDelta', params: {
      threadId: nativeIds[index % 3], turnId: threads.find(thread => thread.id === ids[index % 3])!.lastTurn!.id,
      itemId: 'command-0', delta: '.',
    } }))
    await f.action(ids[0]!, { type: 'notify-burst', frames: burst })
    await expect.poll(() => workspace.workspaceSnapshot().threads.every(thread => thread.activities?.find(a => a.kind === 'command' && a.output?.endsWith('.'.repeat(200))) !== undefined)).toBe(true)
    const worst = Math.max(...delays, performance.now() - previous)
    console.info(`Codex burst: ${publications} snapshots for 600 frames; longest heartbeat gap ${Math.round(worst)} ms`)
    expect(publications).toBeLessThan(60)
    expectWithinBudget(worst, 250, 'main-process heartbeat during three-thread output')

    // Completing a turn flushes its pending display update. The append stream must still
    // preserve every message chunk, and none of the other two threads may lose output.
    const finish = ids.flatMap((id, index) => {
      const threadId = nativeIds[index]!
      const turnId = threads.find(thread => thread.id === id)!.lastTurn!.id
      const itemId = `reply-${id}`
      return [
        { method: 'item/started', params: { threadId, turnId, item: { type: 'agentMessage', id: itemId, text: '' } } },
        ...['First ', 'second ', 'last.'].map(delta => ({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId, delta } })),
        { method: 'item/completed', params: { threadId, turnId, item: { type: 'agentMessage', id: itemId, text: 'First second last.' } } },
        { method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } },
      ]
    })
    await f.action(ids[0]!, { type: 'notify-burst', frames: finish })
    await expect.poll(() => workspace.workspaceSnapshot().threads.every(thread => thread.status === 'idle')).toBe(true)
    for (const id of ids) {
      expect(workspace.threadMessages(id).filter(message => message.role === 'assistant').map(message => message.text)).toEqual(['First second last.'])
      expect(workspace.workspaceSnapshot().threads.find(thread => thread.id === id)?.activities?.find(a => a.kind === 'command')?.output).toBe('x'.repeat(8_000) + '.'.repeat(200))
    }
  } finally { clearInterval(heartbeat); off() }
})
