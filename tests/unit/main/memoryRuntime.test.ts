// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { openRuntimeMemory } from '../../../src/main/memory/runtime'
import { probeMemoryStore } from '../../../src/main/memory/probe'

const roots: string[] = []
async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-memory-runtime-'))
  roots.push(root)
  return root
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('runtime memory', () => {
  it('opens a migrated store in user data and releases the connection on close', async () => {
    const path = join(await createRoot(), 'memory.sqlite')
    const log = vi.fn()
    const store = openRuntimeMemory(path, log)
    expect(store).toBeDefined()
    store?.close()
    expect(() => store?.get('missing')).toThrow(/not open/)
    expect(log).not.toHaveBeenCalled()
    const db = new DatabaseSync(path)
    try {
      expect(db.prepare('SELECT version FROM schema_migrations').all()).toEqual([{ version: 1 }])
    } finally {
      db.close()
    }
  })

  it('reports an unavailable database with a stable event and allows startup to continue', async () => {
    const path = join(await createRoot(), 'memory.sqlite')
    await writeFile(path, 'invalid database')
    const log = vi.fn()
    expect(openRuntimeMemory(path, log)).toBeUndefined()
    expect(log).toHaveBeenCalledExactlyOnceWith('memory-store-open-failed')
  })

  it('probes the real store migration, nullable timestamps and full-text search', async () => {
    expect(probeMemoryStore(join(await createRoot(), 'memory.sqlite'))).toEqual({
      sqliteVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      migrationVersion: 1, matchedId: 'memory-probe', fts5: true,
    })
  })
})
