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
