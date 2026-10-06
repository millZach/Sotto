// @vitest-environment node
/**
 * A send reads its thread once (#765). Each of Claude, Codex and Grok runs its real adapter under the whole host
 * stack against its fake client (`tests/fixtures/sendStack.ts`), and a send from the Threads page is counted at each
 * boundary it crosses. On the success path the coordinator's read before the send is the one read: it reaches the
 * adapter once, and it stands for the adapter's own read at the start of the send. Claude and Grok keep their
 * recheck at the point the send is about to go out, after their last await, and Codex its session-log poll there,
 * so a reply written against an old last message is still refused when someone typed into the session in between.
 * Counts only; the times are the benchmark's (`tests/perf/sendReads.perf.test.ts`).
 */
import { randomUUID } from 'node:crypto'
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeSessionLog } from '../../src/main/agents/claudeSessionLog'
import { claudeFixture } from '../fixtures/claudeFixture'
import { codexFixture } from '../fixtures/codexFixture'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'
import { sendStack, type SendStackProvider } from '../fixtures/sendStack'

/** No poll timer reads a thread during a case, so what is counted is what the send itself read. */
const QUIET_POLL_MS = 600_000
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })

describe('a send from the Threads page reads its thread once', () => {
  it.each([
    // The read before the send, and the recheck of the transcript just before the prompt is written.
    ['claude', { before: 2, after: 0 }],
    // The read before the send's newest-turn check. The session log is polled again before turn/start, in process.
    ['codex', { before: 1, after: 0 }],
    // The read before the send, and the recheck just before the prompt. After the prompt, the adapter reads its echo.
    ['grok', { before: 2, after: 1 }],
  ] as const)('%s', async (provider: SendStackProvider, history) => {
    const native = provider === 'claude' ? await claudeFixture(undefined, undefined, undefined, { pollIntervalMs: QUIET_POLL_MS })
      : provider === 'codex' ? await codexFixture(undefined, false, undefined, { pollIntervalMs: QUIET_POLL_MS })
        : await grokFixture(undefined, undefined, QUIET_POLL_MS)
    const stack = await sendStack(provider, native)
    cleanup.push(stack.cleanup)
    for (let index = 0; index < 2; index++) {
      const cost = await stack.send()
      expect(cost.error).toBeNull()
      // One read reaches the adapter, the coordinator's, and none after the provider accepted: the workspace held the echo.
      expect(cost.reads).toEqual(['beforeSend'])
      expect(cost.history).toEqual(history)
    }
  }, 60_000)
})

describe('a send whose thread moved after the read before it', () => {
  it('Claude refuses a reply to an old last message typed after the read, whether or not it was seen before the send', async () => {
    const f = await claudeFixture(undefined, undefined, undefined, { pollIntervalMs: QUIET_POLL_MS })
    cleanup.push(f.cleanup)
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    const id = randomUUID()
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Moved' })
    f.host.observeThreads?.([id])
    await expect(f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'own-1', text: 'First' })).resolves.toEqual({ accepted: true })
    await f.driver.completeTurn(id, 'Reply')
    await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === id)?.status).toBe('idle')
    const polls = vi.spyOn(ClaudeSessionLog.prototype, 'poll')

    // Unmoved: the read before the send stands for the send's first read, and the recheck is the only other poll.
    await f.host.refreshThread!(id, { beforeSend: true })
    polls.mockClear()
    await expect(f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'own-2', text: 'Second', expectedLastUserMessageId: 'own-1' })).resolves.toEqual({ accepted: true })
    expect(polls).toHaveBeenCalledTimes(1)
    await f.driver.completeTurn(id, 'Reply')
    await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === id)?.status).toBe('idle')

    // Typed into the session after the read and not yet seen: the send's first read is skipped, and the recheck
    // before the prompt finds it and refuses the reply. Nothing reaches Claude Code.
    await f.host.refreshThread!(id, { beforeSend: true })
    const session = await f.realId(id)
    await appendFile(join(f.root, 'home', 'projects', f.root.replace(/[^a-zA-Z0-9]/gu, '-'), `${session}.jsonl`),
      JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId: session, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Typed after the read' } }) + '\n')
    polls.mockClear()
    const from = (await f.driver.requests()).length
    await expect(f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'stale', text: 'Stale', expectedLastUserMessageId: 'own-2' })).rejects.toThrow('changed')
    expect(polls).toHaveBeenCalledTimes(1)
    expect((await f.driver.requests()).slice(from).some(request => request.method === 'user')).toBe(false)

    // Seen after the read: the thread moved, so the send reads at its start again and refuses there.
    await f.host.refreshThread!(id, { beforeSend: true })
    await f.driver.typeInProvider(id, 'Typed and seen after the read')
    polls.mockClear()
    await expect(f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'stale-2', text: 'Stale', expectedLastUserMessageId: 'own-2' })).rejects.toThrow('changed')
    expect(polls).toHaveBeenCalledTimes(1)
  }, 60_000)

  it('Grok refuses a reply to an old last message typed after the read, on the recheck before the prompt', async () => {
    const f = await grokFixture(undefined, undefined, QUIET_POLL_MS)
    cleanup.push(f.cleanup)
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    const id = randomUUID()
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Moved' })
    f.host.observeThreads?.([id])
    await expect(f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'own-1', text: 'First' })).resolves.toEqual({ accepted: true })
    await f.driver.completeTurn(id, 'Reply')
    await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === id)?.status).toBe('idle')

    await f.host.refreshThread!(id, { beforeSend: true })
    // Typed in the Grok CLI after the read, written to the session's history with no notification: only a read finds it.
    await f.driver.typeInProvider(id, 'Typed after the read')
    const native = await f.realId(id)
    await expect.poll(async () => (await readFile(join(f.root, 'native-sessions.json'), 'utf8')).includes('Typed after the read') && native).toBeTruthy()
    const from = (await f.driver.requests()).length
    await expect(f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'stale', text: 'Stale', expectedLastUserMessageId: 'own-1' })).rejects.toThrow('changed')
    const methods = (await f.driver.requests()).slice(from).map(request => request.method)
    // The send's first read was the one made before it; the recheck found the typed message, and no prompt went out.
    expect(methods.filter(method => method === '_x.ai/session/updates')).toHaveLength(1)
    expect(methods).not.toContain('session/prompt')
  }, 60_000)
})
