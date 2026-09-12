// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { codexFixture } from '../fixtures/codexFixture'
import { claudeFixture } from '../fixtures/claudeFixture'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'
import type { AgentHost, AgentHostResult } from '../../src/main/agents/host'

// Gate only the unrelated native history I/O; prompt transport and persistence stay real.
it.each(['codex', 'claude', 'grok'] as const)('%s sends and confirms while another thread history read is blocked', async provider => {
  const f = provider === 'codex' ? await codexFixture() : provider === 'claude' ? await claudeFixture(undefined, 1000) : await grokFixture()
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const reading = new Promise<void>(resolve => { entered = resolve })
  let sending: Promise<AgentHostResult> | undefined
  let background: ReturnType<AgentHost['snapshot']> | undefined
  try {
    await f.host.connect(f.connection)
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    const unrelated = randomUUID(), target = randomUUID()
    for (const id of [unrelated, target]) await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: id, modelId: f.modelId })
    const nativeId = await f.realId(unrelated)
    if (provider === 'codex') {
      const watcher = (f.adapter as unknown as { watcher: { locate(directory: string, id: string, depth?: number): Promise<string | undefined> } }).watcher
      const locate = watcher.locate.bind(watcher)
      vi.spyOn(watcher, 'locate').mockImplementation(async (directory, id, depth) => { if (id === nativeId) { entered(); await gate }; return locate(directory, id, depth) })
    } else if (provider === 'claude') {
      const log = (f.adapter as unknown as { logs: Map<string, { poll(): Promise<void> }> }).logs.get(unrelated)!
      const poll = log.poll.bind(log)
      vi.spyOn(log, 'poll').mockImplementation(async () => { entered(); await gate; return poll() })
    } else {
      const rpc = (f.adapter as unknown as { rpc: { request(method: string, params: Record<string, unknown>, ...args: unknown[]): Promise<void> } }).rpc
      const request = rpc.request.bind(rpc)
      vi.spyOn(rpc, 'request').mockImplementation(async (method, params, ...args) => { if (method === '_x.ai/session/updates' && params.sessionId === nativeId) { entered(); await gate }; return request(method, params, ...args) })
    }
    background = f.host.snapshot()
    await reading
    sending = f.host.execute({ type: 'send', commandId: 'target-command', threadId: target, messageId: 'target-message', text: 'Synthetic selected-thread prompt', expectedLastUserMessageId: null })
    expect(await Promise.race([sending, new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), 250))]), 'unrelated history must not gate target prompt acknowledgement').toEqual({ accepted: true })
    const host = f.host as AgentHost & { refreshThread?(id: string): ReturnType<AgentHost['snapshot']> }
    const snapshot = await (host.refreshThread?.(target) ?? host.snapshot())
    expect(snapshot.threads.find(thread => thread.id === target)?.messages).toContainEqual(expect.objectContaining({ id: 'target-message', commandId: 'target-command' }))
    expect(snapshot.threads).toHaveLength(2)
  } finally { release(); await sending; await background; vi.restoreAllMocks(); await f.cleanup() }
})

it.each(['codex', 'claude', 'grok'] as const)('%s rechecks a permission arriving during its durable origin write', async provider => {
  const f = provider === 'codex' ? await codexFixture() : provider === 'claude' ? await claudeFixture(undefined, 1000) : await grokFixture()
  const id = randomUUID()
  let permission = false
  const unsubscribe = f.host.subscribe(snapshot => { permission = Boolean(snapshot.threads.find(thread => thread.id === id)?.requests.length) })
  try {
    await f.host.connect(f.connection)
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: 'Selected', modelId: f.modelId })
    const seam = f.adapter as unknown as { persist(): Promise<void> }
    const persist = seam.persist.bind(seam)
    let injected = false
    vi.spyOn(seam, 'persist').mockImplementation(async () => {
      await persist()
      if (!injected) { injected = true; await f.driver.raisePermission(id, 'Synthetic permission during origin persistence'); await expect.poll(() => permission).toBe(true) }
    })
    await expect(f.host.execute({ type: 'send', commandId: 'blocked-command', threadId: id, messageId: 'blocked-message', text: 'Must not send', expectedLastUserMessageId: null })).rejects.toThrow(/request|answer|permission/i)
    const promptMethod = provider === 'codex' ? 'turn/start' : provider === 'claude' ? 'user' : 'session/prompt'
    expect((await f.driver.requests()).filter(request => request.method === promptMethod)).toHaveLength(0)
    expect((await f.host.snapshot()).threads.find(thread => thread.id === id)?.requests).toHaveLength(1)
  } finally { unsubscribe(); vi.restoreAllMocks(); await f.cleanup() }
})

it('Codex rejects a stale history completion after live text and turn completion arrive', async () => {
  const f = await codexFixture()
  const id = randomUUID()
  let completed = false
  const unsubscribe = f.host.subscribe(snapshot => { completed = snapshot.threads.find(thread => thread.id === id)?.messages.some(message => message.text === 'Finished during history read') ?? false })
  try {
    await f.host.connect(f.connection)
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: 'Selected', modelId: f.modelId })
    await f.host.execute({ type: 'send', commandId: 'own-command', threadId: id, messageId: 'own-message', text: 'Synthetic prompt' })
    const before = (await f.driver.requests()).filter(request => request.method === 'thread/read').length
    await f.script({ delay: { method: 'thread/read', ms: 150 } })
    const reading = f.adapter.refreshThread(id)
    await expect.poll(async () => (await f.driver.requests()).filter(request => request.method === 'thread/read').length).toBeGreaterThan(before)
    await f.driver.completeTurn(id, 'Finished during history read')
    await expect.poll(() => completed).toBe(true)
    const thread = (await reading).threads.find(thread => thread.id === id)!
    expect(thread.status).toBe('idle')
    expect(thread.messages.filter(message => message.role === 'user')).toHaveLength(1)
    expect(thread.messages.at(-1)?.text).toBe('Finished during history read')
  } finally { unsubscribe(); await f.cleanup() }
})

it.each(['codex', 'grok'] as const)('%s treats a failed pre-dispatch authority read as an unsent prompt', async provider => {
  const f = provider === 'codex' ? await codexFixture(undefined, false, 200) : await grokFixture(undefined, 200)
  const id = randomUUID()
  try {
    await f.host.connect(f.connection)
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: 'Selected', modelId: f.modelId })
    await f.script(provider === 'codex' ? { delay: { method: 'thread/read', ms: 500 } } : { ignoreHistory: true })
    await expect(f.host.execute({ type: 'send', commandId: 'unsent-command', threadId: id, messageId: 'unsent-message', text: 'Must remain a draft', expectedLastUserMessageId: null })).rejects.toThrow(/verif|read|history/i)
    expect((await f.driver.requests()).filter(request => request.method === (provider === 'codex' ? 'turn/start' : 'session/prompt'))).toHaveLength(0)
  } finally { await f.script({}); await f.cleanup() }
})

it('Codex rechecks native authorship after persisting an undispatched origin', async () => {
  const f = await codexFixture()
  const id = randomUUID()
  try {
    await f.host.connect(f.connection)
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: 'Selected', modelId: f.modelId })
    const seam = f.adapter as unknown as { persist(): Promise<void> }
    const persist = seam.persist.bind(seam)
    let injected = false
    vi.spyOn(seam, 'persist').mockImplementation(async () => {
      await persist()
      if (!injected) { injected = true; await f.driver.typeInProvider(id, 'External input during persistence') }
    })
    await expect(f.host.execute({ type: 'send', commandId: 'stale-command', threadId: id, messageId: 'stale-message', text: 'Must not send', expectedLastUserMessageId: null })).rejects.toThrow('changed')
    expect((await f.driver.requests()).filter(request => request.method === 'turn/start')).toHaveLength(0)
    const thread = (await f.adapter.refreshThread(id)).threads.find(thread => thread.id === id)!
    expect(thread.messages).toContainEqual(expect.objectContaining({ role: 'user', text: 'External input during persistence' }))
    expect(thread.messages.some(message => message.id === 'stale-message')).toBe(false)
  } finally { vi.restoreAllMocks(); await f.cleanup() }
})
