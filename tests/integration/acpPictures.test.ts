// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ThreadMediaStore } from '../../src/main/agents/threadMedia'
import { deepseekFixture } from '../fixtures/fakeDeepSeekFixture'
import { devinFixture } from '../fixtures/devinFixture'
import { cursorFixture } from '../fixtures/fakeCursorFixture'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'
import type { AgentActivity } from '../../src/shared/agentActivity'
import type { AgentHost } from '../../src/main/agents/host'
import { pngHeader } from '../fixtures/stagedImages'

/** A picture Sotto reads as 5x4. */
const png = (): Buffer => pngHeader(5, 4)
const picture = png().toString('base64')
/** A screenshot tool's result as ACP carries it: its words, then the picture. */
const screenshot = [{ type: 'content', content: { type: 'text', text: 'Took a screenshot.' } }, { type: 'content', content: { type: 'image', data: picture, mimeType: 'image/png' } }]

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function store(): Promise<ThreadMediaStore> {
  const folder = await mkdtemp(join(tmpdir(), 'sotto-acp-pictures-')); cleanups.push(() => rm(folder, { recursive: true, force: true }))
  const made = new ThreadMediaStore(folder); await made.load(); return made
}
async function started(host: AgentHost, root: string, modelId: string): Promise<string> {
  await host.connect()
  await host.execute({ type: 'create-project', commandId: randomUUID(), projectId: 'project', title: 'Project', path: root })
  const id = randomUUID()
  await host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: 'project', modelId, title: 'Look' })
  host.observeThreads?.([id])
  await host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm1', text: 'Take a screenshot' })
  return id
}
const pictured = async (host: AgentHost, id: string): Promise<AgentActivity | undefined> =>
  (await host.snapshot()).threads.find(thread => thread.id === id)?.activities?.find(row => row.media?.length)
/** The step holds the handle alone, and the store answers for it with the bytes. */
async function heldByHandle(media: ThreadMediaStore, row: AgentActivity | undefined): Promise<void> {
  expect(row?.output).toBe('Took a screenshot.')
  expect(row?.media).toEqual([expect.objectContaining({ id: 'm0', mimeType: 'image/png', width: 5, height: 4, source: 'tool' })])
  expect(JSON.stringify(row)).not.toContain(picture)
  expect(await media.read(row!, 'm0')).toBe(`data:image/png;base64,${picture}`)
}

describe('pictures in an ACP tool result (ADR-0170)', () => {
  it('Grok Build: puts them on the step by handle, and a read of its history keeps the same handle', async () => {
    const media = await store()
    let f = await grokFixture(undefined, undefined, undefined, {}, { captureMedia: media.capture }); cleanups.push(() => f.cleanup())
    const id = await started(f.host, f.root, f.modelId)
    await f.action(id, { type: 'activity', update: { sessionUpdate: 'tool_call', toolCallId: 'shot', title: 'screenshot', kind: 'other', status: 'in_progress' } })
    await f.action(id, { type: 'activity', update: { sessionUpdate: 'tool_call_update', toolCallId: 'shot', status: 'completed', content: screenshot } })
    await expect.poll(async () => (await pictured(f.host, id))?.status).toBe('completed')
    const live = await pictured(f.host, id)
    await heldByHandle(media, live)
    // A new process reads the thread from Grok's own history, into a row that has no handle yet.
    f = await f.driver.restart(); cleanups.push(() => f.cleanup())
    f.host.observeThreads?.([id]); await f.host.connect()
    await expect.poll(async () => (await pictured(f.host, id))?.media).toEqual(live!.media)
  })

  it('Devin: puts them on the step by handle', async () => {
    const media = await store()
    const f = await devinFixture(undefined, undefined, undefined, {}, undefined, {}, { captureMedia: media.capture }); cleanups.push(() => f.cleanup())
    const id = await started(f.host, f.root, f.modelId)
    await f.action(id, { type: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 'shot', title: 'screenshot', kind: 'other', status: 'in_progress' } })
    await f.action(id, { type: 'update', update: { sessionUpdate: 'tool_call_update', toolCallId: 'shot', status: 'completed', content: screenshot } })
    await expect.poll(async () => (await pictured(f.host, id))?.status).toBe('completed')
    await heldByHandle(media, await pictured(f.host, id))
  })

  it('DeepSeek Harness: puts them on the step by handle', async () => {
    const media = await store()
    const f = await deepseekFixture(undefined, undefined, {}, { captureMedia: media.capture }); cleanups.push(() => f.cleanup())
    const id = await started(f.host, f.root, f.modelId)
    await f.action(id, { type: 'tool', command: 'screenshot', output: 'Took a screenshot.', image: picture })
    await expect.poll(async () => (await pictured(f.host, id))?.status).toBe('completed')
    await heldByHandle(media, await pictured(f.host, id))
  })

  it('Cursor: puts them on the step by handle, and its replays keep the same handle without hashing it again', async () => {
    const media = await store()
    let captures = 0
    const options = { captureMedia: (pictures: Parameters<ThreadMediaStore['capture']>[0], source: Parameters<ThreadMediaStore['capture']>[1]) => { captures += 1; return media.capture(pictures, source) } }
    // A provider session left idle closes quickly, so the next send opens it again with a replay.
    let f = await cursorFixture(undefined, undefined, { reaperSweepMs: 20, sessionIdleMs: 150 }, options); cleanups.push(() => f.cleanup())
    const id = await started(f.host, f.root, f.modelId)
    const status = async () => (await f.host.snapshot()).threads.find(thread => thread.id === id)?.status
    await f.action(id, { type: 'screenshot', data: picture })
    await expect.poll(async () => (await pictured(f.host, id))?.status).toBe('completed')
    const live = await pictured(f.host, id)
    await heldByHandle(media, live)
    await f.driver.completeTurn(id, 'Here it is.')
    await expect.poll(status).toBe('idle')
    // A send to a closed provider session opens it with a replay of the thread; the step's handle answers, so nothing is hashed again.
    f.host.observeThreads?.([])
    await expect.poll(() => f.sessions.stopped(id), { timeout: 12_000 }).toBe(true)
    const loads = await f.sessions.starts(id)
    await f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm2', text: 'Thanks' })
    await expect.poll(() => f.sessions.starts(id)).toBeGreaterThan(loads)
    await f.driver.completeTurn(id, 'You are welcome.')
    await expect.poll(status).toBe('idle')
    expect(captures).toBe(1)
    expect((await pictured(f.host, id))?.media).toEqual(live!.media)
    // A new Sotto process holds no rows yet: the replay hashes the picture once more and lands on the same handle.
    f = await f.driver.restart(); cleanups.push(() => f.cleanup())
    f.host.observeThreads?.([id]); await f.host.connect()
    await expect.poll(async () => (await pictured(f.host, id))?.media).toEqual(live!.media)
  })

  it('captures nothing without the feature', async () => {
    const f = await deepseekFixture(); cleanups.push(() => f.cleanup())
    const id = await started(f.host, f.root, f.modelId)
    await f.action(id, { type: 'tool', command: 'screenshot', output: 'Took a screenshot.', image: picture })
    await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === id)?.activities?.find(row => row.kind === 'command')?.status).toBe('completed')
    expect((await f.host.snapshot()).threads.find(thread => thread.id === id)?.activities?.some(row => row.media)).toBe(false)
  })
})
