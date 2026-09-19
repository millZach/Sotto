// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeFixture } from '../fixtures/claudeFixture'

// A thread's Claude transcript used to be read from its first byte on every connect. Each authored entry
// also published a whole snapshot of its own, so a long transcript cost thousands of snapshot clones and
// queued workspace writes before the window opened, and the main process ran out of heap at startup.
// A connect now publishes once per transcript and seeks to the stored cursor instead of byte zero.
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

  it('reads only what was appended since the last run when its history is handed back', async () => {
    const session = await f.realId(id)
    const folder = join(f.root, 'home', 'projects', f.root.replace(/[^a-zA-Z0-9]/gu, '-'))
    await mkdir(folder, { recursive: true })
    const path = join(folder, `${session}.jsonl`)
    const entry = (text: string): string => JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId: session, timestamp: new Date().toISOString(), message: { role: 'user', content: text } })
    const entries = 40
    await appendFile(path, `${Array.from({ length: entries }, (_value, index) => entry(`Typed in Claude ${index}`)).join('\n')}\n`)
    await f.adapter.pollSessionLogs()
    const before = (await f.host.snapshot()).threads.find(thread => thread.id === id)!.messages
    expect(before).toHaveLength(entries)

    // Restart: the same user data folder, a new process's worth of adapter state.
    f.adapter.disconnect(); await f.adapter.closed(); f = await claudeFixture(f.root)
    const cursor = JSON.parse(await readFile(join(f.root, 'claude-threads.json'), 'utf8'))[id].transcriptCursor
    expect(cursor.offset).toBe((await readFile(path)).byteLength)

    // Rewrite an entry the cursor has already passed, keeping the file's length and identity. Only a
    // reader that went back to byte zero would show it, so its absence is the proof nothing was re-read.
    const lines = (await readFile(path, 'utf8')).split('\n')
    lines[0] = lines[0]!.replace('Typed in Claude 0', 'TAMPERED         ')
    await writeFile(path, lines.join('\n'))
    expect((await readFile(path)).byteLength).toBe(cursor.offset)

    await f.adapter.restoreThreadHistory([{ threadId: id, messages: before }])
    await f.host.connect()
    await appendFile(path, `${entry('Typed in Claude after the restart')}\n`)
    await f.adapter.pollSessionLogs()

    const after = (await f.host.snapshot()).threads.find(thread => thread.id === id)!.messages
    expect(after.map(message => message.text)).toEqual([...before.map(message => message.text), 'Typed in Claude after the restart'])
    expect(after.some(message => message.text.includes('TAMPERED'))).toBe(false)
  })
})
