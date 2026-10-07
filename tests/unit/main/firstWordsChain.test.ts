// @vitest-environment node
/**
 * A reply's first streamed words cross every layer of main inside the task that brought them (#771): the adapter's
 * snapshot publisher, the workspace host, the coordinator and the desktop's detail lane, wired the way
 * `src/main/index.ts` wires them, with the held shell going just ahead of the detail. Nothing here waits on a timer
 * for the assertion: what reached the bridge is read in the same task as the chunk.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { AgentControl, coalesceAgentStatePublishes, coalesceAgentThreadDetailPublishes } from '../../../src/main/agents/control'
import { AgentCredentials } from '../../../src/main/agents/credentials'
import { adapterItemCount, ProviderSnapshotPublisher } from '../../../src/main/agents/providerSnapshotPublisher'
import { ThreadMessageLog } from '../../../src/main/agents/threadMessageLog'
import { WorkspaceHost } from '../../../src/main/agents/workspace'
import { e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import type { ThreadHostEvent } from '../../../src/main/agents/host'
import type { AgentThreadDetailUpdate } from '../../../src/shared/agents'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'

/** A provider that records through the adapters' own message log and publishes through their own publisher. */
class StreamingProvider extends FakeProviderHost {
  readonly log = new ThreadMessageLog()
  private readonly publisher = new ProviderSnapshotPublisher(() => super.emit(), () => adapterItemCount(this.log, this.state.threads))
  subscribeEvents(listener: (event: ThreadHostEvent) => void): () => void { return this.log.subscribeEvents(listener) }
  publish(streaming: boolean): void { this.publisher.publish(streaming) }
}

const carries = (update: AgentThreadDetailUpdate, id: string): boolean => 'messageDeltas' in update
  ? update.messageDeltas.some(item => ('message' in item ? item.message.id : item.id) === id)
  : update.messages.some(message => message.id === id)

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

it('sends a reply’s first words to the window’s bridge in their own task, with the shell just ahead, and holds the chunks after them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-first-words-chain-'))
  cleanup.push(async () => {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-first-words-chain-')) throw new Error('Unexpected fixture directory')
    await rm(root, { recursive: true, force: true })
  })
  const provider = new StreamingProvider()
  const workspace = new WorkspaceHost(provider, root)
  const credentials = new AgentCredentials(root, { isEncryptionAvailable: () => false, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() })
  await credentials.load()
  const control = new AgentControl({ directory: root, host: workspace, credentials, reasoner: e2eAgentReasoner })
  cleanup.push(() => { control.dispose(); workspace.dispose() })
  await control.start(); await control.command({ type: 'connect' })
  const threadId = provider.state.threads[0]!.id
  await control.command({ type: 'observe-threads', threadIds: [threadId] })

  const bridge: Array<{ kind: 'shell' } | { kind: 'detail'; update: AgentThreadDetailUpdate }> = []
  const shell = coalesceAgentStatePublishes(() => bridge.push({ kind: 'shell' }))
  const detail = coalesceAgentThreadDetailPublishes(update => bridge.push({ kind: 'detail', update }), { beforeOpening: () => shell.flush() })
  cleanup.push(() => { shell.dispose(); detail.dispose() })
  const unsubscribe = [control.subscribe(state => shell.publish(state)), control.subscribeThreadDetail(update => detail.publish(update))]
  cleanup.push(() => { for (const stop of unsubscribe) stop() })
  control.threadDetail(threadId)
  // Setup only: let every layer's window close, so the prompt's echo below starts each one afresh.
  await new Promise<void>(done => { setTimeout(done, 120) })

  const at = new Date().toISOString()
  provider.log.add(threadId, { id: 'prompt', role: 'user', text: 'Which colour?', createdAt: at })
  provider.publish(false)
  const echoed = bridge.length
  expect(bridge.slice(0, echoed).some(item => item.kind === 'detail' && carries(item.update, 'prompt'))).toBe(true)
  // Every layer now holds a window the echo started. The reply's first words arrive inside all of them.
  provider.log.add(threadId, { id: 'reply', role: 'assistant', text: 'Ind', createdAt: at })
  provider.publish(true)
  const opened = bridge.slice(echoed)
  const reply = opened.findIndex(item => item.kind === 'detail' && carries(item.update, 'reply'))
  expect(reply).toBeGreaterThanOrEqual(0)
  // The shell the same broadcast made went just ahead of the detail, so the window paints the two together.
  expect(opened[reply - 1]).toEqual({ kind: 'shell' })

  // Later chunks of the same message wait for the windows, in this task and the next.
  const sent = bridge.length
  for (const chunk of ['igo', ' it', ' is.']) { provider.log.appendText(threadId, 'reply', chunk); provider.publish(true) }
  expect(bridge.length).toBe(sent)
  await expect.poll(() => bridge.slice(sent).some(item => item.kind === 'detail' && carries(item.update, 'reply'))).toBe(true)
})
