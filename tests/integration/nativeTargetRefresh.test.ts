// @vitest-environment node
import { deferred } from '../fixtures/deferred'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { codexFixture } from '../fixtures/codexFixture'
import { claudeFixture } from '../fixtures/claudeFixture'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'
import type { AgentHost, AgentHostResult } from '../../src/main/agents/host'

// Gate only the unrelated native history I/O; prompt transport and persistence stay real.
it.each(['codex', 'claude', 'grok'] as const)('%s sends and confirms while another thread history read is blocked', async provider => {
  const f = provider === 'codex' ? await codexFixture() : provider === 'claude' ? await claudeFixture() : await grokFixture()

  const { promise: gate, resolve: release } = deferred<void>()
  const { promise: reading, resolve: entered } = deferred<void>()
  let sending: Promise<AgentHostResult> | undefined
  let background: ReturnType<AgentHost['snapshot']> | undefined
  let backgroundSettled = false
  try {
    await f.host.connect()
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
      // Each Grok thread runs its own process, so the history read to hold is on the unrelated thread's own.
      const rpc = (f.adapter as unknown as { processes: Map<string, { rpc: { request(method: string, params: Record<string, unknown>, ...args: unknown[]): Promise<void> } }> }).processes.get(unrelated)!.rpc
      const request = rpc.request.bind(rpc)
      vi.spyOn(rpc, 'request').mockImplementation(async (method, params, ...args) => { if (method === '_x.ai/session/updates' && params.sessionId === nativeId) { entered(); await gate }; return request(method, params, ...args) })
    }
    background = f.host.refreshThread!(unrelated).finally(() => { backgroundSettled = true })
    await reading
    expect(backgroundSettled).toBe(false)
    sending = f.host.execute({ type: 'send', commandId: 'target-command', threadId: target, messageId: 'target-message', text: 'Synthetic selected-thread prompt', expectedLastUserMessageId: null })
    let completion: { result: AgentHostResult } | { error: unknown } | undefined
    void sending.then(result => { completion = { result } }, error => { completion = { error } })
    // The history barrier stays closed through acknowledgement and exact native receipt. The normal
    // test deadline bounds a broken implementation; no short stopwatch stands in for independence.
    await expect.poll(() => completion, { message: 'Target prompt must finish while unrelated history remains held' }).toBeDefined()
    expect(completion).toEqual({ result: { accepted: true } })
    expect(backgroundSettled).toBe(false)
    const promptMethod = provider === 'codex' ? 'turn/start' : provider === 'claude' ? 'user' : 'session/prompt'
    const receipts = (await f.driver.requests()).filter(record => record.method === promptMethod)
    expect(receipts).toHaveLength(1)
    const targetNativeId = await f.realId(target)
    if (provider === 'codex') expect(receipts[0]!.params).toMatchObject({ threadId: targetNativeId,
      clientUserMessageId: 'target-message', input: [{ type: 'text', text: 'Synthetic selected-thread prompt' }] })
    else if (provider === 'claude') expect(receipts[0]!.params).toMatchObject({ frame: { session_id: targetNativeId,
      message: { role: 'user', content: 'Synthetic selected-thread prompt' } } })
    else expect(receipts[0]!.params).toMatchObject({ sessionId: targetNativeId,
      prompt: [{ type: 'text', text: 'Synthetic selected-thread prompt' }] })
    const host = f.host as AgentHost & { refreshThread?(id: string): ReturnType<AgentHost['snapshot']> }
    const snapshot = await (host.refreshThread?.(target) ?? host.snapshot())
    expect(snapshot.threads.find(thread => thread.id === target)?.messages).toContainEqual(expect.objectContaining({ id: 'target-message', commandId: 'target-command', text: 'Synthetic selected-thread prompt' }))
    expect(snapshot.threads).toHaveLength(2)
    expect(backgroundSettled).toBe(false)
  } finally { release(); await Promise.allSettled([sending, background]); vi.restoreAllMocks(); await f.cleanup() }
})

it.each(['codex', 'claude', 'grok'] as const)('%s rechecks a permission arriving during its durable origin write', async provider => {
  const f = provider === 'codex' ? await codexFixture() : provider === 'claude' ? await claudeFixture() : await grokFixture()
  const id = randomUUID()
  let permission = false
  const unsubscribe = f.host.subscribe(snapshot => { permission = Boolean(snapshot.threads.find(thread => thread.id === id)?.requests.length) })
  try {
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: 'Selected', modelId: f.modelId })
    // Claude makes an origin durable on its own, as a line of its origin journal (#767); the others write the thread store.
    const seamName = provider === 'claude' ? 'recordOrigin' : 'persist'
    const seam = f.adapter as unknown as Record<typeof seamName, (...args: unknown[]) => Promise<void>>
    const persist = seam[seamName].bind(seam)
    let injected = false
    vi.spyOn(seam, seamName).mockImplementation(async (...args: unknown[]) => {
      await persist(...args)
      if (provider === 'codex') {
        const aliases = JSON.parse(await readFile(join(f.root, 'codex-threads.json'), 'utf8')) as Record<string, { origins: Array<{ messageId: string }> }>
        // History identity writes also use this seam. Inject at the durable
        // prompt-origin write promised by this test, after history RPC handling.
        if (!aliases[id]?.origins.some(origin => origin.messageId === 'blocked-message')) return
      }
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
  let reading: ReturnType<typeof f.adapter.refreshThread> | undefined
  const unsubscribe = f.host.subscribe(snapshot => {
    const thread = snapshot.threads.find(thread => thread.id === id)
    completed = thread?.status === 'idle' && thread.messages.some(message => message.text === 'Finished during history read')
  })
  try {
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: 'Selected', modelId: f.modelId })
    await f.host.execute({ type: 'send', commandId: 'own-command', threadId: id, messageId: 'own-message', text: 'Synthetic prompt' })
    const before = (await f.driver.requests()).filter(request => request.method === 'thread/read').length
    await f.script({ holdReply: 'thread/read' })
    reading = f.adapter.refreshThread(id)
    await expect.poll(async () => (await f.driver.requests()).filter(request => request.method === 'thread/read').length).toBeGreaterThan(before)
    await f.driver.completeTurn(id, 'Finished during history read')
    await expect.poll(() => completed).toBe(true)
    // The frozen running-state response must arrive after both live text and
    // completion, regardless of how the runner schedules the two processes.
    await f.action(id, { type: 'release-reply', method: 'thread/read' })
    const thread = (await reading).threads.find(thread => thread.id === id)!
    expect((await f.driver.requests()).filter(request => request.method === 'thread/read')).toHaveLength(before + 2)
    expect(thread.status).toBe('idle')
    expect(thread.messages.filter(message => message.role === 'user')).toHaveLength(1)
    expect(thread.messages.at(-1)?.text).toBe('Finished during history read')
  } finally {
    if (reading) { await f.action(id, { type: 'release-reply', method: 'thread/read' }); await reading.catch(() => undefined) }
    unsubscribe(); await f.cleanup()
  }
})

it.each(['codex', 'grok'] as const)('%s treats a failed pre-dispatch authority read as an unsent prompt', async provider => {
  const f = provider === 'codex' ? await codexFixture() : await grokFixture()
  const id = randomUUID()
  try {
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: 'Selected', modelId: f.modelId })
    await f.script(provider === 'codex' ? { delay: { method: 'thread/read', ms: 3000 } } : { ignoreHistory: true })
    await expect(f.host.execute({ type: 'send', commandId: 'unsent-command', threadId: id, messageId: 'unsent-message', text: 'Must remain a draft', expectedLastUserMessageId: null })).rejects.toThrow(/verif|read|history/i)
    expect((await f.driver.requests()).filter(request => request.method === (provider === 'codex' ? 'turn/start' : 'session/prompt'))).toHaveLength(0)
  } finally { await f.script({}); await f.cleanup() }
})

it('Codex rechecks native authorship after persisting an undispatched origin', async () => {
  const f = await codexFixture()
  const id = randomUUID()
  try {
    await f.host.connect()
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
