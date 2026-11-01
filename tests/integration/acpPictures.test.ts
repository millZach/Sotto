// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ThreadMediaStore } from '../../src/main/agents/threadMedia'
import { deepseekFixture } from '../fixtures/fakeDeepSeekFixture'
import { devinFixture } from '../fixtures/devinFixture'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'
import type { AgentActivity } from '../../src/shared/agentActivity'
import type { AgentHost } from '../../src/main/agents/host'

/** A PNG header Sotto reads as a 5x4 picture: the signature, then IHDR. */
function png(): Buffer {
  const bytes = Buffer.alloc(40)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
  bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12, 'ascii'); bytes.writeUInt32BE(5, 16); bytes.writeUInt32BE(4, 20)
  return bytes
}
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

  it('captures nothing without the feature', async () => {
    const f = await deepseekFixture(); cleanups.push(() => f.cleanup())
    const id = await started(f.host, f.root, f.modelId)
    await f.action(id, { type: 'tool', command: 'screenshot', output: 'Took a screenshot.', image: picture })
    await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === id)?.activities?.find(row => row.kind === 'command')?.status).toBe('completed')
    expect((await f.host.snapshot()).threads.find(thread => thread.id === id)?.activities?.some(row => row.media)).toBe(false)
  })
})
