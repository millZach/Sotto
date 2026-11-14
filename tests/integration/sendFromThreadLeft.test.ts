// @vitest-environment node
// A send that waits behind another action on its thread, while the user opens another thread, is still confirmed by the
// provider's echo when it goes: the window no longer shows its thread, but the send keeps it observed until it settles.
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { desktopWindowClient } from '../../src/main/agents/hostService'
import type { AgentHostCommand, AgentHostResult } from '../../src/main/agents/host'
import { agentControlFixture } from '../fixtures/agentControlFixture'
import { deferred } from '../fixtures/deferred'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'
import { StreamingAdapter } from '../fixtures/streamingAdapter'
import { workspaceFixture } from '../fixtures/workspaceFixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

/**
 * Echoes each prompt through its message log before the send returns, as Claude's adapter does once Claude Code starts its
 * turn, or, with `echoLater`, only when the test calls `echo`, as a provider whose echo comes after it took the prompt.
 */
class EchoingAdapter extends StreamingAdapter {
  echoLater = false
  override async execute(command: AgentHostCommand): Promise<AgentHostResult> {
    const result = await super.execute(command)
    if (command.type === 'send' && !this.echoLater) this.echo(command.threadId)
    return result
  }
  echo(sessionId: string): void { this.log.add(sessionId, this.state.threads.find(thread => thread.id === sessionId)!.messages.at(-1)!); this.emit() }
}

/** Two Claude threads on an echoing fake, the first sent to once and idle again, with the first on screen. */
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-workspace-'))
  const adapters = { codex: new FakeProviderHost(), claude: new EchoingAdapter(), grok: new FakeProviderHost() }
  for (const [id, adapter] of Object.entries(adapters)) {
    adapter.state.projects[0]!.path = join(root, id)
    await mkdir(adapter.state.projects[0]!.path, { recursive: true })
    adapter.state.models[0]!.reasoningEfforts = ['low', 'high']
    adapter.state.models[0]!.defaultReasoningEffort = 'low'
    adapter.state.models[0]!.runtimeModes = ['approval-required']
    adapter.state.capabilities.configureThread = true
  }
  const workspace = await workspaceFixture(root, { adapters })
  cleanups.push(workspace.remove)
  const fixture = await agentControlFixture({ directory: workspace.root, host: workspace.host, credentialOptions: { mode: 'unavailable' },
    control: { historyEnabled: () => true } })
  const control = fixture.control
  cleanups.push(async () => { await fixture.dispose(); await control.closed(); await workspace.stop() })
  await control.start(); await control.commandShell({ type: 'connect', provider: 'claude' })
  const model = control.watcherSnapshot().models.find(item => item.providerId === 'claude')!
  const project = control.watcherSnapshot().projects.find(item => item.providerId === 'claude')!
  const fake = adapters.claude
  const native = (threadId: string) => fake.state.threads.find(thread => thread.id === workspace.registry.byThread(threadId)!.sessionId)!
  const create = async (title: string) => {
    const threadId = randomUUID()
    expect((await control.commandShell({ type: 'create-thread', threadId, projectId: project.id, modelId: model.id, title, runtimeMode: 'approval-required', workingCopy: 'shared' })).error).toBeNull()
    return threadId
  }
  const sending = await create('Synthetic sender'), other = await create('Synthetic other')
  await control.commandShell({ type: 'select-thread', threadId: sending })
  expect((await control.commandShell({ type: 'manual-send', threadId: sending, draftId: randomUUID(), text: 'Synthetic first' })).error).toBeNull()
  native(sending).status = 'idle'; fake.emit(); await control.commandShell({ type: 'refresh', provider: 'claude' })
  return { workspace, control, fake, native, sending, other }
}

it('confirms a send that went out after the user moved to another thread', async () => {
  const { workspace, control, fake, native, sending, other } = await setup()

  // A settings change holds the thread's lane, as starting a Claude session for one does, and the send waits behind it.
  const gate = deferred()
  const execute = fake.execute.bind(fake)
  vi.spyOn(fake, 'execute').mockImplementation(async command => {
    if (command.type !== 'configure-thread') return execute(command)
    await gate.promise
    native(sending).reasoningEffort = command.reasoningEffort
    return execute(command)
  })
  // The window reports what its panes show with the states it is sent, as Threads does. One report lands while the send
  // reads its thread, as one can while Claude's adapter reads its transcript, and names only the thread now on screen.
  const refresh = workspace.host.refreshThread.bind(workspace.host)
  vi.spyOn(workspace.host, 'refreshThread').mockImplementation(async (threadId, purpose) => {
    if (purpose?.beforeSend && threadId === sending) await control.commandShell({ type: 'observe-threads', threadIds: [other] })
    return refresh(threadId, purpose)
  })
  const configuring = control.commandShell({ type: 'configure-thread', threadId: sending, reasoningEffort: 'high' })
  const sent = control.commandShell({ type: 'manual-send', threadId: sending, draftId: randomUUID(), text: 'Synthetic second' })
  // The composer the send left is saved empty, as a new revision, and the user opens another thread while the send waits.
  await control.commandShell({ type: 'save-thread-draft', composer: 'manual', threadId: sending, draftId: randomUUID(), text: '', attachments: [] })
  await control.commandShell({ type: 'select-thread', threadId: other })
  gate.resolve()
  expect((await configuring).error).toBeNull()
  expect((await sent).error).toBeNull()
  expect(native(sending).messages.filter(message => message.role === 'user').map(message => message.text)).toEqual(['Synthetic first', 'Synthetic second'])
})

it.each(['window', 'socket'] as const)('confirms a Send of a saved draft from the %s whose thread the user left while it read', async route => {
  const { workspace, control, native, sending, other } = await setup()
  const refresh = workspace.host.refreshThread.bind(workspace.host)
  vi.spyOn(workspace.host, 'refreshThread').mockImplementation(async (threadId, purpose) => {
    if (purpose?.beforeSend && threadId === sending) {
      await control.commandShell({ type: 'select-thread', threadId: other })
      await control.commandShell({ type: 'observe-threads', threadIds: [other] })
    }
    return refresh(threadId, purpose)
  })
  const client = route === 'socket' ? { clientId: 'paired-client', user: 'User', transport: 'socket' as const, selectedThreadId: sending } : desktopWindowClient()
  expect((await control.commandShell({ type: 'send', draft: { threadId: sending, text: 'Synthetic atomic', attachments: [] } }, client)).error).toBeNull()
  expect(native(sending).messages.at(-1)).toMatchObject({ role: 'user', text: 'Synthetic atomic' })
})

it('takes the unconfirmed banner down once the provider’s late echo confirms the send', async () => {
  const { control, fake, native, sending } = await setup()
  fake.echoLater = true
  const draftId = randomUUID()
  const sent = await control.commandShell({ type: 'manual-send', threadId: sending, draftId, text: 'Synthetic late' })
  expect(sent.error).toBe('The provider has not confirmed this user message in its state. Refresh to reconcile the existing send; it will not be replayed.')
  fake.echo(native(sending).id)
  // Down with the receipt that confirms it, not later when some other action happens to clear the banner.
  await vi.waitFor(() => expect(control.shell().deliveries?.find(item => item.draftId === draftId)?.status).toBe('accepted'))
  expect(control.shell().error).toBeNull()
})
