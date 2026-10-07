// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ClaudeOriginJournal, type JournaledOrigin } from '../../../src/main/agents/claudeOriginJournal'

type Origin = { readonly uuid: string }
const parse = (value: unknown): JournaledOrigin<Origin> | undefined => {
  const entry = value as { threadId?: unknown; origin?: { uuid?: unknown } }
  return typeof entry?.threadId === 'string' && typeof entry.origin?.uuid === 'string' ? { threadId: entry.threadId, origin: { uuid: entry.origin.uuid } } : undefined
}

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function journal(): Promise<{ path: string; journal: ClaudeOriginJournal<Origin> }> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-origin-journal-')); roots.push(root)
  const path = join(root, 'claude-origins.jsonl')
  return { path, journal: new ClaudeOriginJournal(path, parse) }
}

describe('ClaudeOriginJournal', () => {
  it('reads back what it appended, in order, and nothing once cleared', async () => {
    const { journal: origins } = await journal()
    expect(await origins.read()).toEqual({ entries: [], present: false })
    await origins.append({ threadId: 'one', origin: { uuid: 'a' } })
    await origins.append({ threadId: 'two', origin: { uuid: 'b' } })
    expect(await origins.read()).toEqual({ entries: [{ threadId: 'one', origin: { uuid: 'a' } }, { threadId: 'two', origin: { uuid: 'b' } }], present: true })
    await origins.clear()
    await origins.clear()
    expect(await origins.read()).toEqual({ entries: [], present: false })
  })

  it('skips a last line a crash cut short, and keeps a line appended after it whole', async () => {
    const { path, journal: origins } = await journal()
    await writeFile(path, '\n{"threadId":"one","origin":{"uuid":"a"}}\n\n{"threadId":"two","orig')
    expect(await origins.read()).toEqual({ entries: [{ threadId: 'one', origin: { uuid: 'a' } }], present: true })
    await origins.append({ threadId: 'three', origin: { uuid: 'c' } })
    expect((await origins.read()).entries.map(entry => entry.origin.uuid)).toEqual(['a', 'c'])
    expect(await readFile(path, 'utf8')).toContain('"orig\n{"threadId":"three"')
  })

  it('skips a line its schema rejects, and says the journal held something', async () => {
    const { path, journal: origins } = await journal()
    await writeFile(path, '\n{"threadId":"one"}\n')
    expect(await origins.read()).toEqual({ entries: [], present: true })
  })
})
