// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { codexFixture } from '../fixtures/codexFixture'
import type { CodexAdapterEvent } from '../../src/main/agents/codex'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

/** Text only the unreadable frames carry: it must reach neither the log nor a thread. */
const BODY = 'unreadable-notification-body'

it('skips unreadable Codex notifications and keeps the app-server and its threads working (#680)', async () => {
  const log = vi.fn<(event: CodexAdapterEvent) => void>()
  const f = await codexFixture(undefined, false, 10_000, { logEvent: log }); cleanups.push(f.cleanup)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
  const first = randomUUID(); const second = randomUUID()
  for (const threadId of [first, second]) {
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: f.projectId, modelId: f.modelId, title: 'Test' })
    await f.host.execute({ type: 'send', commandId: randomUUID(), messageId: randomUUID(), threadId, text: 'Synthetic prompt' })
  }
  const pid = await f.serverOf(first)
  const nativeId = await f.realId(first)
  const turnId = (await f.host.snapshot()).threads.find(thread => thread.id === first)!.lastTurn!.id
  const frames = [
    // A thread in a shape Sotto does not read.
    { method: 'thread/started', params: { thread: { id: nativeId, turns: BODY } } },
    // A readable thread whose user message is not: it used to apply part of the thread and then throw.
    { method: 'thread/started', params: { thread: { id: nativeId, turns: [{ id: 'unreadable-turn', status: 'completed',
      items: [{ type: 'agentMessage', id: 'unreadable-reply', text: BODY }, { type: 'userMessage', id: 'unreadable-input', content: BODY }] }] } } },
    // An item without its identity, and a user message whose content is not a list.
    { method: 'item/completed', params: { threadId: nativeId, turnId, item: { type: 'agentMessage', text: BODY } } },
    { method: 'item/completed', params: { threadId: nativeId, turnId, item: { type: 'userMessage', id: 'unreadable-item', content: BODY } } },
  ]
  const burst = await f.action(first, { type: 'notify-burst', frames })
  await expect.poll(() => f.acted(burst)).toBe(true)
  await expect.poll(() => log.mock.calls.filter(([event]) => event === 'codex-notification-unreadable').length).toBe(frames.length)

  // The next notification still applies on the same app-server, and the turn finishes.
  await f.action(first, { type: 'say', text: 'Still reading' })
  await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === first)?.messages.some(message => message.text === 'Still reading')).toBe(true)
  await f.driver.completeTurn(first, 'Finished')
  await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === first)?.status).toBe('idle')
  await f.driver.completeTurn(second, 'Finished too')
  await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === second)?.status).toBe('idle')

  const snapshot = await f.host.snapshot()
  expect(snapshot.connected).toBe(true)
  expect(snapshot.error).toBeUndefined()
  expect(await f.serverOf(first)).toBe(pid)
  // Nothing of a skipped frame was applied or logged.
  expect(JSON.stringify(snapshot)).not.toContain(BODY)
  expect(JSON.stringify(log.mock.calls)).not.toContain(BODY)
})
