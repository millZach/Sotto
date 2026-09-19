// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeFixture } from '../fixtures/claudeFixture'

// A thread's Claude transcript is read from its first byte on every connect. Each authored entry used
// to publish a whole snapshot of its own, so a long transcript cost thousands of snapshot clones and
// queued workspace writes before the window opened, and the main process ran out of heap at startup.
describe('Claude transcript catch-up', () => {
  let f: Awaited<ReturnType<typeof claudeFixture>>
  let id: string
  beforeEach(async () => {
    f = await claudeFixture(); await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    id = randomUUID(); await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: 'Long', modelId: f.modelId })
  })
  afterEach(async () => { await f.cleanup() })

  it('publishes once per poll however many entries a transcript adds', async () => {
    const session = await f.realId(id)
    const folder = join(f.root, 'home', 'projects', f.root.replace(/[^a-zA-Z0-9]/gu, '-'))
    await mkdir(folder, { recursive: true })
    const entries = 1500
    let published = 0
    const unsubscribe = f.host.subscribe(() => { published++ })
    const lines: string[] = []
    for (let index = 0; index < entries; index++) lines.push(JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId: session, timestamp: new Date().toISOString(), message: { role: 'user', content: `Typed in Claude ${index}` } }))
    await appendFile(join(folder, `${session}.jsonl`), `${lines.join('\n')}\n`)
    await f.adapter.pollSessionLogs()
    unsubscribe()
    const thread = (await f.host.snapshot()).threads.find(t => t.id === id)!
    expect(thread.messages.filter(message => message.role === 'user').at(-1)?.text).toBe(`Typed in Claude ${entries - 1}`)
    // The interval poll may see the file before the explicit poll does, so allow a poll or two, never one per entry.
    expect(published).toBeGreaterThanOrEqual(1)
    expect(published).toBeLessThanOrEqual(4)
  })
})
