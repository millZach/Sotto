// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeStreamJsonHost } from '../../../src/main/agents/claude'
import type { ThreadHistorySource } from '../../../src/main/agents/host'

/**
 * The cursor a Claude alias write carries is the one the record held when the write started: the store
 * serializes before it waits, while a transcript read during that wait advances the live alias again.
 * These cases reach into the host's persist path directly, because the interleaving they pin down — a
 * cursor advancing while its own write is in flight — is the behaviour under test and nothing above it
 * can order it.
 */
const SESSION = '11111111-1111-4111-8111-111111111111'
const THREAD = '22222222-2222-4222-8222-222222222222'
const cursor = (offset: number) => ({ sessionId: SESSION, offset, size: offset, consumedOriginIds: [] })

type CursorState = {
  aliases: Record<string, { transcriptCursor?: ReturnType<typeof cursor> }>
  savedCursors: Map<string, ReturnType<typeof cursor>>
  aliasStore: { write(value: unknown): Promise<void> }
  persist(): Promise<void>
}

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-claude-cursor-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture(flushes: () => boolean) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-claude-cursor-')); roots.push(root)
  const host = new ClaudeStreamJsonHost({ userDataPath: root })
  const state = host as unknown as CursorState
  state.aliases = { [THREAD]: { sessionId: SESSION, projectId: 'project', cwd: root, title: 'Synthetic', modelId: 'model',
    createdAt: '2026-10-13T00:00:00.000Z', origins: [], answeredRequestIds: [], transcriptCursor: cursor(100) } } as typeof state.aliases
  const flushEvents = vi.fn(flushes)
  host.useThreadHistory({ messageIdentities: () => [], flushEvents } satisfies ThreadHistorySource)
  const written = state.aliasStore.write.bind(state.aliasStore)
  return { root, host, state, flushEvents, written }
}

describe('a Claude cursor saved only past committed words (#991)', () => {
  it('does not count a cursor that advanced during its own write as saved when the flush was refused', async () => {
    const f = await fixture(() => false)
    // Advance the live cursor after the store serialized the held-back record, before the write settles.
    vi.spyOn(f.state.aliasStore, 'write').mockImplementation(async value => {
      const done = f.written(value)
      f.state.aliases[THREAD]!.transcriptCursor = cursor(200)
      return done
    })
    await f.state.persist()
    expect(JSON.parse(await readFile(join(f.root, 'claude-threads.json'), 'utf8'))[THREAD].transcriptCursor).toBeUndefined()
    expect(f.state.savedCursors.has(THREAD)).toBe(false)
    // The live cursor keeps its newer value rather than being put back to the held one.
    expect(f.state.aliases[THREAD]!.transcriptCursor?.offset).toBe(200)

    await f.state.persist()
    expect(f.flushEvents).toHaveBeenCalledTimes(2)
    expect(JSON.parse(await readFile(join(f.root, 'claude-threads.json'), 'utf8'))[THREAD].transcriptCursor).toBeUndefined()
  })

  it('records the cursor the write carried, not the newer one a read advanced to while it waited', async () => {
    const f = await fixture(() => true)
    vi.spyOn(f.state.aliasStore, 'write').mockImplementation(async value => {
      const done = f.written(value)
      f.state.aliases[THREAD]!.transcriptCursor = cursor(200)
      return done
    })
    await f.state.persist()
    expect(JSON.parse(await readFile(join(f.root, 'claude-threads.json'), 'utf8'))[THREAD].transcriptCursor.offset).toBe(100)
    expect(f.state.savedCursors.get(THREAD)?.offset).toBe(100)
    expect(f.state.aliases[THREAD]!.transcriptCursor?.offset).toBe(200)

    await f.state.persist()
    expect(f.flushEvents).toHaveBeenCalledTimes(2)
    expect(JSON.parse(await readFile(join(f.root, 'claude-threads.json'), 'utf8'))[THREAD].transcriptCursor.offset).toBe(200)
    expect(f.state.savedCursors.get(THREAD)?.offset).toBe(200)
  })
})
