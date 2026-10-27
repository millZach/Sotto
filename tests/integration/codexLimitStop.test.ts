// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import { codexFixture } from '../fixtures/codexFixture'

/**
 * Codex's usage-limit stops (ADR-0144): a turn's final error that Codex classifies as its usage limit, or an HTTP 429 it
 * does not retry, says so on the thread's `lastTurn`, with the reset of the window its newest limits reading shows used
 * up. Only while restarting stopped threads is on; any other failure, and stable, carry nothing new.
 */
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture(limitStops: boolean) {
  const f = await codexFixture(undefined, false, 2000, limitStops ? { limitStops: true } : {})
  const workspace = new WorkspaceHost(f.host, f.root, () => true)
  cleanup.push(async () => { workspace.disconnect(); await f.adapter.closed(); await workspace.privacyChanged(); workspace.dispose(); await f.cleanup() })
  await workspace.connect()
  await workspace.execute({ type: 'create-project', commandId: 'project', projectId: 'project', title: 'Fixture', path: f.root })
  await workspace.execute({ type: 'create-thread', commandId: 'create', threadId: 'thread', projectId: 'project', title: 'Fixture', modelId: f.modelId })
  await workspace.execute({ type: 'send', commandId: 'send', threadId: 'thread', messageId: 'own-message', text: 'Fixture task' })
  const turnId = workspace.workspaceSnapshot().threads[0]!.lastTurn!.id
  const thread = () => workspace.workspaceSnapshot().threads[0]!
  const notify = async (method: string, params: Record<string, unknown>, wait = true) => {
    const event = wait ? new Promise<void>(resolve => { const off = f.host.subscribe(() => { off(); resolve() }) }) : undefined
    await f.action('thread', { type: 'notify', method, params: { turnId, ...params } })
    await event
  }
  /** Codex's limits as the adapter keeps them, once it has read the notification. */
  const quota = () => (f.adapter as unknown as { quota?: { windows: unknown[] } }).quota?.windows.length ?? 0
  return { thread, turnId, notify, quota }
}
const resetSeconds = Math.floor(Date.now() / 1000) + 3 * 60 * 60
const limits = { rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: resetSeconds }, secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: resetSeconds + 86_400 } } }

describe('Codex usage-limit stops', () => {
  it('says a turn stopped at the usage limit, with the reset of the used-up window', async () => {
    const f = await fixture(true)
    await f.notify('account/rateLimits/updated', limits, false)
    await expect.poll(f.quota).toBe(2)
    await f.notify('error', { error: { message: 'You have hit your usage limit.', codexErrorInfo: 'usageLimitExceeded' }, willRetry: false })
    expect(f.thread().lastTurn).toEqual({ id: f.turnId, status: 'failed', limitStop: { resetsAt: new Date(resetSeconds * 1000).toISOString() } })
  })

  it('reads an HTTP 429 Codex does not retry as the limit, with no reset when no window is used up', async () => {
    const f = await fixture(true)
    await f.notify('error', { error: { message: 'Too many requests', codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 429 } } }, willRetry: false })
    expect(f.thread().lastTurn).toEqual({ id: f.turnId, status: 'failed', limitStop: {} })
  })

  it('carries nothing for any other failure, nor with the feature off', async () => {
    const other = await fixture(true)
    await other.notify('error', { error: { message: 'Internal error', codexErrorInfo: 'internalServerError' }, willRetry: false })
    expect(other.thread().lastTurn).toEqual({ id: other.turnId, status: 'failed' })
    const off = await fixture(false)
    await off.notify('error', { error: { message: 'You have hit your usage limit.', codexErrorInfo: 'usageLimitExceeded' }, willRetry: false })
    expect(off.thread().lastTurn).toEqual({ id: off.turnId, status: 'failed' })
  })
})
