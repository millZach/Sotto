// @vitest-environment node
// ADR-0088's proof over fake providers: a thread continues on another provider as a new thread linked to it, whose first
// message carries the handover of the source ahead of the user's words, as one message.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { afterEach, expect, it } from 'vitest'
import { ContinueService } from '../../src/main/agents/continueThread'
import { registerContinueIpc } from '../../src/main/agents/continueThreadIpc'
import type { AgentHostCommand } from '../../src/main/agents/host'
import { hostEntityKey } from '../../src/shared/clientIdentity'
import { CONTINUE_HANDOVER_CLOSE, CONTINUE_REFUSALS, type ContinueStart, type ContinueStartRequest } from '../../src/shared/continueThread'
import { HANDOVER_LEAD } from '../../src/shared/handover'
import type { AgentThread, ProviderId } from '../../src/shared/agents'
import { workspaceFixture } from '../fixtures/workspaceFixture'
import { agentControlFixture } from '../fixtures/agentControlFixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

type Workspace = Awaited<ReturnType<typeof workspaceFixture>>

/** One run of Sotto over a workspace folder: the workspace, its coordinator and, unless `service` is false, continuing. */
async function run(options: { readonly root?: string; readonly history?: boolean; readonly service?: boolean } = {}) {
  const history = options.history ?? true
  const workspace = await workspaceFixture(options.root, { history, watcherEnabled: false })
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host, credentialOptions: { mode: 'unavailable' },
    control: { historyEnabled: () => history, watcherEnabled: false } })
  const service = options.service === false ? undefined : new ContinueService({ control: f.control, host: workspace.host })
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    service?.close(); f.control.dispose(); await f.control.closed(); await workspace.stop()
  }
  await f.control.start()
  for (const provider of ['claude', 'codex', 'grok'] as const) await f.control.commandShell({ type: 'connect', provider })
  return { ...f, workspace, service, stop }
}

async function fixture(options: { readonly history?: boolean } = {}) {
  const first = await run(options)
  let current = first
  // The run in use stops before the folder every run shared is removed.
  cleanups.push(async () => { await current.stop(); await first.workspace.remove() })
  const control = () => current.control
  const model = (provider: ProviderId) => control().shell().host.models.find(item => item.providerId === provider)!
  const thread = (threadId: string): AgentThread | undefined => control().shell().host.threads.find(item => item.id === threadId)
  const adapters = (): Workspace['adapters'] => current.workspace.adapters
  const native = (threadId: string): AgentThread => {
    const binding = current.workspace.registry.byThread(threadId)!
    return adapters()[binding.provider as keyof Workspace['adapters']].state.threads.find(item => item.id === binding.sessionId)!
  }
  const emit = async (threadId: string) => {
    const binding = current.workspace.registry.byThread(threadId)!
    adapters()[binding.provider as keyof Workspace['adapters']].emit()
    await control().commandShell({ type: 'refresh', provider: binding.provider as ProviderId })
  }
  const endTurn = async (threadId: string, reply: string, status: 'completed' | 'failed' = 'completed') => {
    const native_ = native(threadId)
    native_.messages.push({ id: randomUUID(), role: 'assistant', text: reply, createdAt: new Date().toISOString() })
    native_.lastTurn = { id: native_.messages.findLast(message => message.role === 'user')!.id, status }
    native_.status = 'idle'
    await emit(threadId)
  }
  /** A Claude Code thread the user opened and that answered once, as the source of a continuation. */
  const source = async (title = 'WAV preview stall', provider: ProviderId = 'claude') => {
    const project = control().shell().host.projects.find(item => item.providerId === provider) ?? control().shell().host.projects[0]!
    const threadId = randomUUID()
    expect((await control().commandShell({ type: 'create-thread', threadId, projectId: project.id, title, titleSource: 'user', modelId: model(provider).id, workingCopy: 'shared' })).error).toBeNull()
    expect((await control().commandShell({ type: 'manual-send', threadId, draftId: randomUUID(), text: 'The WAV preview stalls after two seconds. Find out why.' })).error).toBeNull()
    await endTurn(threadId, 'The length marker was written once, before any audio arrived.')
    return threadId
  }
  const request = (threadId: string, patch: Partial<ContinueStartRequest> = {}): ContinueStartRequest => ({ threadId, newThreadId: randomUUID(), modelId: model('codex').id,
    workingCopy: 'same', draftId: randomUUID(), text: 'Also add a test for a stream that ends mid-chunk.', ...patch })
  const start = (input: ContinueStartRequest): Promise<ContinueStart> => current.service!.start(input)
  const sends = (provider: keyof Workspace['adapters']) => adapters()[provider].commands.filter((command): command is Extract<AgentHostCommand, { type: 'send' }> => command.type === 'send')
  const restart = async (patch: { readonly service?: boolean } = {}) => {
    await current.stop()
    current = await run({ root: first.workspace.root, history: options.history ?? true, ...patch })
  }
  return { get control() { return control() }, get service() { return current.service }, get workspace() { return current.workspace },
    model, thread, native, emit, endTurn, source, request, start, sends, restart }
}

it('sends the handover and the user’s request to the new thread as one message, and shows the two apart', async () => {
  const f = await fixture()
  const sourceId = await f.source()
  const input = f.request(sourceId)
  const result = await f.start(input)
  expect(result).toEqual({ status: 'ok', threadId: hostEntityKey(f.control.hostId(), input.newThreadId) })
  // One message, to Codex, in one turn: the handover, then the user's words.
  const [sent, ...more] = f.sends('codex')
  expect(more).toEqual([])
  expect(sent!.text.startsWith(HANDOVER_LEAD)).toBe(true)
  expect(sent!.text).toContain('The WAV preview stalls after two seconds. Find out why.')
  expect(sent!.text).toContain('The length marker was written once, before any audio arrived.')
  expect(sent!.text).toContain(`${CONTINUE_HANDOVER_CLOSE}\n\nAlso add a test for a stream that ends mid-chunk.`)
  expect(sent!.text.endsWith('\n\nAlso add a test for a stream that ends mid-chunk.')).toBe(true)
  // A new thread, with its own Sotto thread ID, on Codex, in the same project and folder, keeping the source's title.
  const continued = f.thread(input.newThreadId)!
  const original = f.thread(sourceId)!
  expect(continued).toMatchObject({ providerId: 'codex', projectId: original.projectId, title: 'WAV preview stall', titleSource: 'user' })
  expect(continued.worktree?.mode).toBe('shared')
  expect(continued.continuedFrom).toMatchObject({ threadId: sourceId, provider: 'claude', handover: { counts: { total: 2, carried: 2, historyKept: true, answered: true } } })
  expect(original.continuedIn).toEqual([{ threadId: input.newThreadId, provider: 'codex', at: continued.continuedFrom!.at }])
  // Every copy shows the user's words, with the handover beside them as Sotto's, by the recorded proof.
  await f.control.commandShell({ type: 'observe-threads', threadIds: [input.newThreadId] })
  const shown = f.control.threadDetail(input.newThreadId)!.messages.find(message => message.role === 'user')!
  expect(shown.text).toBe('Also add a test for a stream that ends mid-chunk.')
  expect(shown.handover).toMatchObject({ provider: 'claude', counts: { carried: 2 } })
  expect(shown.handover!.text.startsWith(HANDOVER_LEAD)).toBe(true)
  // Nothing went to the source, which keeps its own history.
  expect(f.sends('claude')).toHaveLength(1)
  expect(f.native(sourceId).messages).toHaveLength(2)
})

it('keeps the links both ways, the title and the split first message through a restart', async () => {
  const f = await fixture()
  const sourceId = await f.source('Release notes')
  const input = f.request(sourceId)
  expect(await f.start(input)).toMatchObject({ status: 'ok' })
  await f.restart()
  const continued = f.thread(input.newThreadId)!
  expect(continued).toMatchObject({ providerId: 'codex', title: 'Release notes', continuedFrom: { threadId: sourceId, provider: 'claude' } })
  expect(f.thread(sourceId)!.continuedIn).toEqual([expect.objectContaining({ threadId: input.newThreadId, provider: 'codex' })])
  await f.control.commandShell({ type: 'observe-threads', threadIds: [input.newThreadId] })
  expect(f.control.threadDetail(input.newThreadId)!.messages.find(message => message.role === 'user')!.text).toBe('Also add a test for a stream that ends mid-chunk.')
  // The threads' records keep the links and the handover's length and digest, never its words.
  const saved = await readFile(`${f.workspace.root}/workspace.json`, 'utf8')
  const records = (JSON.parse(saved) as { snapshot: { threads: AgentThread[] } }).snapshot.threads
  expect(records.find(item => item.id === input.newThreadId)?.continuedFrom).toMatchObject({ threadId: sourceId, handover: { prefixDigest: expect.stringMatching(/^[0-9a-f]{64}$/u) } })
  expect(records.find(item => item.id === sourceId)?.continuedIn).toEqual([expect.objectContaining({ threadId: input.newThreadId })])
  expect(saved).not.toContain(CONTINUE_HANDOVER_CLOSE)
})

it('keeps a generated title too, so naming from the first message never renames the continued thread', async () => {
  const f = await fixture()
  const project = f.control.shell().host.projects.find(item => item.providerId === 'claude')!
  const sourceId = randomUUID()
  await f.control.commandShell({ type: 'create-thread', threadId: sourceId, projectId: project.id, title: 'Footer links', modelId: f.model('claude').id, workingCopy: 'shared' })
  await f.control.commandShell({ type: 'manual-send', threadId: sourceId, draftId: randomUUID(), text: 'Fix the footer links.' })
  await f.endTurn(sourceId, 'Fixed three links.')
  const input = f.request(sourceId)
  expect(await f.start(input)).toMatchObject({ status: 'ok' })
  expect(f.thread(input.newThreadId)).toMatchObject({ title: 'Footer links', titleSource: 'generated' })
})

it('links the source only once the first message went, and a retry uses the same new thread', async () => {
  const f = await fixture()
  const sourceId = await f.source()
  const codex = f.workspace.adapters.codex
  const execute = codex.execute.bind(codex)
  let refuseNext = true
  codex.execute = async command => {
    if (command.type === 'create-thread' && refuseNext) { refuseNext = false; throw new Error('Synthetic refusal') }
    return execute(command)
  }
  const input = f.request(sourceId)
  const refused = await f.start(input)
  expect(refused.status).toBe('refused')
  // Nothing went, so the source names no continuation yet; the new thread waits, unstarted, for the retry.
  expect(f.thread(sourceId)!.continuedIn).toBeUndefined()
  expect(f.thread(input.newThreadId)?.continuedFrom?.threadId).toBe(sourceId)
  expect(f.sends('codex')).toHaveLength(0)
  expect(await f.start({ ...input, draftId: randomUUID() })).toEqual({ status: 'ok', threadId: expect.any(String) })
  expect(f.sends('codex')).toHaveLength(1)
  expect(f.thread(sourceId)!.continuedIn).toEqual([expect.objectContaining({ threadId: input.newThreadId })])
  expect(f.control.shell().host.threads.filter(item => item.continuedFrom?.threadId === sourceId)).toHaveLength(1)
})

it('leaves the source readable and sendable', async () => {
  const f = await fixture()
  const sourceId = await f.source()
  expect(await f.start(f.request(sourceId))).toMatchObject({ status: 'ok' })
  expect((await f.control.commandShell({ type: 'manual-send', threadId: sourceId, draftId: randomUUID(), text: 'One more thing here.' })).error).toBeNull()
  expect(f.sends('claude').at(-1)!.text).toBe('One more thing here.')
})

it('refuses while a turn runs, and makes nothing', async () => {
  const f = await fixture()
  const sourceId = await f.source()
  await f.control.commandShell({ type: 'manual-send', threadId: sourceId, draftId: randomUUID(), text: 'Keep going.' })
  expect(f.thread(sourceId)!.status).toBe('running')
  const input = f.request(sourceId)
  expect(await f.start(input)).toEqual({ status: 'refused', message: CONTINUE_REFUSALS.busy })
  expect(f.thread(input.newThreadId)).toBeUndefined()
  expect(f.sends('codex')).toHaveLength(0)
})

it('refuses a thread with nothing to hand over: one nothing was sent to changes provider from its model chip instead', async () => {
  const f = await fixture()
  const project = f.control.shell().host.projects.find(item => item.providerId === 'claude')!
  const threadId = randomUUID()
  await f.control.commandShell({ type: 'create-thread', threadId, projectId: project.id, title: 'New thread', modelId: f.model('claude').id, workingCopy: 'shared' })
  expect(await f.start(f.request(threadId))).toEqual({ status: 'refused', message: CONTINUE_REFUSALS.unstarted })
  expect(f.service!.read({ threadId })).toEqual({ status: 'refused', message: CONTINUE_REFUSALS.unstarted })
})

it('refuses with history off once Sotto holds none of the thread’s messages', async () => {
  const f = await fixture({ history: false })
  const sourceId = await f.source()
  await f.restart()
  const input = f.request(sourceId)
  expect(await f.start(input)).toEqual({ status: 'refused', message: CONTINUE_REFUSALS.empty })
  expect(f.thread(input.newThreadId)).toBeUndefined()
})

it('refuses a provider that is not connected, the thread’s own provider and a thread on another machine, and makes nothing', async () => {
  const f = await fixture()
  const sourceId = await f.source()
  const grok = f.model('grok').id
  await f.control.commandShell({ type: 'disconnect', provider: 'grok' })
  const offline = await f.start(f.request(sourceId, { modelId: grok }))
  expect(offline.status).toBe('refused')
  expect(offline.status === 'refused' && offline.message).toMatch(/^Grok Build isn’t connected\.|^That model isn’t available now/u)
  expect(await f.start(f.request(sourceId, { modelId: f.model('claude').id }))).toEqual({ status: 'refused',
    message: 'This thread is already on Claude Code. Choose a model from another provider to continue there.' })
  expect(await f.start(f.request(hostEntityKey(randomUUID(), sourceId)))).toEqual({ status: 'refused', message: CONTINUE_REFUSALS.remote })
  expect(f.control.shell().host.threads.filter(item => item.continuedFrom !== undefined)).toEqual([])
})

it('reads what the handover carries, and its words only on request', async () => {
  const f = await fixture()
  const sourceId = await f.source()
  const counts = f.service!.read({ threadId: sourceId })
  expect(counts).toMatchObject({ status: 'ok', counts: { total: 2, carried: 2 } })
  expect(counts).not.toHaveProperty('text')
  const words = f.service!.read({ threadId: sourceId, words: true })
  expect(words.status === 'ok' && words.text?.startsWith(HANDOVER_LEAD)).toBe(true)
  expect(words.status === 'ok' && words.text?.endsWith(CONTINUE_HANDOVER_CLOSE)).toBe(true)
})

it('carries a continued thread’s own words, not its older handover, when it is continued again', async () => {
  const f = await fixture()
  const sourceId = await f.source()
  const first = f.request(sourceId)
  expect(await f.start(first)).toMatchObject({ status: 'ok' })
  await f.endTurn(first.newThreadId, 'Added the mid-chunk test.')
  const again = f.request(first.newThreadId, { modelId: f.model('grok').id, text: 'Review the new test.' })
  expect(await f.start(again)).toMatchObject({ status: 'ok' })
  const [sent] = f.sends('grok')
  expect(sent!.text.split(HANDOVER_LEAD)).toHaveLength(2)
  expect(sent!.text).toContain('Also add a test for a stream that ends mid-chunk.')
  expect(sent!.text).not.toContain('The length marker was written once')
  expect(f.thread(again.newThreadId)!.continuedFrom).toMatchObject({ threadId: first.newThreadId, provider: 'codex' })
})

it('refuses to send to a continued thread twice, and a new worktree starts from the source’s branch only where it has one', async () => {
  const f = await fixture()
  const sourceId = await f.source()
  const input = f.request(sourceId)
  expect(await f.start(input)).toMatchObject({ status: 'ok' })
  expect(await f.start({ ...input, draftId: randomUUID() })).toEqual({ status: 'refused', message: 'That continued thread has started already, so nothing more was sent. Open it to carry on there.' })
  expect(f.sends('codex')).toHaveLength(1)
  // The fake project folder is no Git repository, so there is no branch to start a worktree from.
  expect(await f.start(f.request(sourceId, { workingCopy: 'new-worktree' }))).toEqual({ status: 'refused',
    message: 'This thread’s folder has no branch to start a new worktree from. Continue in the same folder instead.' })
})

it('shows nothing of it without the service, as stable runs: no bridge, and a continued thread’s first message whole', async () => {
  const f = await fixture()
  const sourceId = await f.source()
  const input = f.request(sourceId)
  expect(await f.start(input)).toMatchObject({ status: 'ok' })
  await f.restart({ service: false })
  await f.control.commandShell({ type: 'observe-threads', threadIds: [input.newThreadId] })
  const first = f.control.threadDetail(input.newThreadId)!.messages.find(message => message.role === 'user')!
  expect(first.handover).toBeUndefined()
  expect(first.text.startsWith(HANDOVER_LEAD)).toBe(true)
  // The saved links stay on the records, whole.
  expect(f.thread(input.newThreadId)!.continuedFrom?.threadId).toBe(sourceId)
  const handlers: string[] = []
  registerContinueIpc({ handle: channel => { handlers.push(channel) }, removeHandler: () => undefined }, undefined, () => [])()
  expect(handlers).toEqual([])
})
