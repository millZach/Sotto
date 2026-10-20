// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { museFixture } from '../fixtures/museFixture'

// The compaction recommendation waits 70 minutes from when the context figure was reported (ADR-0095). Token counts
// that arrive after it leave the figure as it was, so they must leave its time as it was too.
it("keeps when Muse reported a thread's context across the token counts that follow it", async () => {
  const f = await museFixture()
  const id = randomUUID()
  const thread = async () => (await f.host.snapshot()).threads.find(candidate => candidate.id === id)!
  try {
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Muse thread' })
    await f.host.execute({ type: 'send', commandId: randomUUID(), messageId: 'opening-message', threadId: id, text: 'Synthetic prompt' })
    await f.action(id, { type: 'usage', context: 120_000 })
    await expect.poll(async () => (await thread()).usage?.total?.input).toBe(10)
    const usage = (await thread()).usage!
    expect(usage.contextUsed).toBe(120_000)
    expect(usage.contextUpdatedAt).toEqual(expect.any(String))
  } finally { await f.cleanup() }
})
// Muse's new size comes only with its next session/contextUsage, so a compaction clears the figure from before it,
// with a new time: the recommendation must not ask again for a context just compacted, wherever it was started.
it('clears the context figure a compaction leaves out of date until Muse reports it again', async () => {
  const f = await museFixture()
  const id = randomUUID()
  const thread = async () => (await f.host.snapshot()).threads.find(candidate => candidate.id === id)!
  try {
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Muse thread' })
    await f.host.execute({ type: 'send', commandId: randomUUID(), messageId: 'opening-message', threadId: id, text: 'Synthetic prompt' })
    await f.action(id, { type: 'usage', context: 120_000 })
    await expect.poll(async () => (await thread()).usage?.contextUsed).toBe(120_000)
    const reported = (await thread()).usage!.contextUpdatedAt
    expect(await f.host.execute({ type: 'compact-thread', commandId: randomUUID(), threadId: id })).toMatchObject({ accepted: true })
    const usage = (await thread()).usage!
    expect(usage.contextUsed).toBeUndefined()
    expect(usage.contextUpdatedAt).not.toBe(reported)
    expect(usage.total?.input).toBe(10)
    await f.action(id, { type: 'usage', context: 30_000 })
    await expect.poll(async () => (await thread()).usage?.contextUsed).toBe(30_000)
  } finally { await f.cleanup() }
})
