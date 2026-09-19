// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ClaudeSessionLog } from '../../../src/main/agents/claudeSessionLog'
import type { ClaudeFrame } from '../../../src/main/agents/claudeProtocol'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-claude-log-')) throw new Error('Unexpected temporary test directory')
    await rm(root, { recursive: true, force: true })
  }
})

const entry = (session: string, text: string): string =>
  `${JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId: session, timestamp: new Date().toISOString(), message: { role: 'user', content: text } })}\n`

async function transcript(): Promise<{ home: string; cwd: string; session: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-claude-log-')); roots.push(root)
  const home = join(root, 'home'), cwd = join(root, 'work'), session = randomUUID()
  const folder = join(home, 'projects', cwd.replace(/[^a-zA-Z0-9]/gu, '-'))
  await mkdir(folder, { recursive: true })
  const path = join(folder, `${session}.jsonl`)
  await writeFile(path, '')
  return { home, cwd, session, path }
}

describe('Claude session log cursor', () => {
  it('resumes at a stored cursor and reads only what was appended', async () => {
    const { home, cwd, session, path } = await transcript()
    await appendFile(path, entry(session, 'First') + entry(session, 'Second'))
    const first: ClaudeFrame[] = []
    const reader = new ClaudeSessionLog(home, cwd, session, frame => first.push(frame))
    await reader.poll()
    expect(first).toHaveLength(2)
    const cursor = reader.cursor()!
    expect(cursor.offset).toBe(cursor.size)

    await appendFile(path, entry(session, 'Third'))
    const second: ClaudeFrame[] = []
    const resumed = new ClaudeSessionLog(home, cwd, session, frame => second.push(frame))
    resumed.resume(cursor)
    await resumed.poll()
    expect(second.map(frame => (frame.message as { content: string }).content)).toEqual(['Third'])
  })

  it('stores the offset after the last complete line, so a half-written entry is read whole next time', async () => {
    const { home, cwd, session, path } = await transcript()
    const complete = entry(session, 'First')
    const partial = entry(session, 'Second')
    await appendFile(path, complete + partial.slice(0, 20))
    const first: ClaudeFrame[] = []
    const reader = new ClaudeSessionLog(home, cwd, session, frame => first.push(frame))
    await reader.poll()
    expect(first).toHaveLength(1)
    const cursor = reader.cursor()!
    expect(cursor.offset).toBe(Buffer.byteLength(complete))

    await appendFile(path, partial.slice(20))
    const second: ClaudeFrame[] = []
    const resumed = new ClaudeSessionLog(home, cwd, session, frame => second.push(frame))
    resumed.resume(cursor)
    await resumed.poll()
    expect(second.map(frame => (frame.message as { content: string }).content)).toEqual(['Second'])
  })

  it('reads from the first byte again when the file is not the one the cursor names', async () => {
    const { home, cwd, session, path } = await transcript()
    await appendFile(path, entry(session, 'First') + entry(session, 'Second'))
    const first: ClaudeFrame[] = []
    const reader = new ClaudeSessionLog(home, cwd, session, frame => first.push(frame))
    await reader.poll()
    const cursor = reader.cursor()!

    const second: ClaudeFrame[] = []
    const resumed = new ClaudeSessionLog(home, cwd, session, frame => second.push(frame))
    resumed.resume({ ...cursor, ino: '999999999999', birthtimeMs: 1 })
    await resumed.poll()
    expect(second).toHaveLength(2)
  })

  it('reads from the first byte again when the transcript is shorter than the cursor saw', async () => {
    const { home, cwd, session, path } = await transcript()
    await appendFile(path, entry(session, 'First') + entry(session, 'Second'))
    const reader = new ClaudeSessionLog(home, cwd, session, () => undefined)
    await reader.poll()
    const cursor = reader.cursor()!

    await writeFile(path, entry(session, 'Only'))
    const second: ClaudeFrame[] = []
    const resumed = new ClaudeSessionLog(home, cwd, session, frame => second.push(frame))
    resumed.resume(cursor)
    await resumed.poll()
    expect(second.map(frame => (frame.message as { content: string }).content)).toEqual(['Only'])
  })
})
