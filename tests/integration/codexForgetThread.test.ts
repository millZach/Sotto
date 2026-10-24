// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { codexFixture } from '../fixtures/codexFixture'

// ADR-0126: a cleared thread's own app-server is stopped, its alias is removed from disk, and its next snapshot
// leaves it out, while another thread's own alias and session are untouched.

const fixtures: Awaited<ReturnType<typeof codexFixture>>[] = []
afterEach(async () => { for (const f of fixtures.splice(0).reverse()) await f.cleanup() })

async function fixture() {
  const f = await codexFixture(); fixtures.push(f)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
  const create = async (title: string): Promise<string> => {
    const threadId = randomUUID()
    expect(await f.host.execute({ type: 'create-thread', threadId, commandId: randomUUID(), projectId: f.projectId, modelId: f.modelId, title })).toEqual({ accepted: true })
    return threadId
  }
  return { f, create }
}

describe('Codex forgetThread (ADR-0126)', () => {
  it('stops the thread’s own app-server, drops its alias and leaves it out of the next snapshot, keeping the other thread', async () => {
    const { f, create } = await fixture()
    const gone = await create('Gone'), kept = await create('Kept')
    await f.host.execute({ type: 'send', threadId: gone, commandId: randomUUID(), messageId: randomUUID(), text: 'Hello' })
    await expect.poll(async () => f.adapter.resumedThreads().includes(gone)).toBe(true)

    await f.adapter.forgetThread!(gone)

    expect(f.adapter.resumedThreads()).not.toContain(gone)
    const snapshot = await f.host.snapshot()
    expect(snapshot.threads.some(thread => thread.id === gone)).toBe(false)
    expect(snapshot.threads.some(thread => thread.id === kept)).toBe(true)
    const aliases = JSON.parse(await readFile(join(f.root, 'codex-threads.json'), 'utf8')) as Record<string, unknown>
    expect(Object.keys(aliases).sort()).toEqual([kept].sort())

    // Reconnecting never brings it back: a stale alias cannot resurrect what forgetThread already removed.
    const snapshotAfterConnect = await f.host.connect()
    expect(snapshotAfterConnect.threads.some(thread => thread.id === gone)).toBe(false)
  })
})
