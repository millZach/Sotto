// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { MemoryStore, memorySchema, type Memory } from '../../../src/main/memory/store'

let root: string | undefined
let path: string
let store: MemoryStore

function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'memory-1', type: 'preference', scope: 'project-a', content: 'Use concise explanations',
    sourceClass: 'explicit', confidence: 1, evidenceCount: 1, importance: 0.8,
    createdAt: '2026-09-01T12:00:00.000Z', lastConfirmedAt: '2026-09-01T12:00:00.000Z',
    lastUsedAt: '2026-09-01T12:00:00.000Z', validFrom: '2026-09-01T12:00:00.000Z',
    validTo: null, supersededBy: null,
    provenance: [],
    tags: ['communication'], state: 'active', authority: 'preference', embedding: null,
    ...overrides,
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sotto-memory-store-test-'))
  path = join(root, 'user-data', 'memory.sqlite')
  store = new MemoryStore(path)
})

afterEach(async () => {
  vi.useRealTimers()
  store?.close()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('MemoryStore', () => {
  it('creates the file, enables WAL and foreign keys, and records migrations 1 and 2 only once', () => {
    store.open()
    expect(existsSync(path)).toBe(true)
    store.insert(memory())
    const db = new DatabaseSync(path)
    try {
      const applied = db.prepare('SELECT * FROM schema_migrations').all()
      expect(applied).toEqual([{ version: 1, appliedAt: expect.any(String) }, { version: 2, appliedAt: expect.any(String) }])
      expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
      store.close()
      store.open()
      store.open()
      expect(db.prepare('SELECT * FROM schema_migrations').all()).toEqual(applied)
      expect(store.get('memory-1')).toEqual(memory())
      expect(() => store.insert(memory({ id: 'invalid-reference', supersededBy: 'missing' })))
        .toThrow(/FOREIGN KEY/)
    } finally {
      db.close()
    }
  })

  it('round trips JSON metadata and embedding bytes, and returns undefined for a missing id', () => {
    store.open()
    const input = memory({ embedding: new Uint8Array([0, 17, 255]) })
    store.insert(input)
    expect(store.get(input.id)).toEqual(input)
    expect(store.get('missing')).toBeUndefined()
    const withoutEmbedding = memory({ id: 'no-embedding' })
    delete withoutEmbedding.embedding
    store.insert(withoutEmbedding)
    expect(store.get('no-embedding')?.embedding).toBeNull()
  })

  it('ranks content matches with bm25, searches tags, limits results and abstains on misses', () => {
    store.open()
    store.insert(memory({ id: 'long', content: `concise ${'other '.repeat(100)}` }))
    store.insert(memory({ id: 'short', content: 'concise concise concise' }))
    expect(store.search('concise', { limit: 1 }).map((row) => row.id)).toEqual(['short'])
    expect(store.search('communication', { limit: 10 })).toHaveLength(2)
    expect(store.search('absent', { limit: 10 })).toEqual([])
  })

  it('filters projects before applying the result limit', () => {
    store.open()
    store.insert(memory({ id: 'other-project', scope: 'project-b', content: 'concise' }))
    store.insert(memory())
    expect(store.search('concise', { limit: 1, projectId: 'project-a' })).toEqual([memory()])
    expect(store.search('concise', { limit: 10, projectId: 'missing' })).toEqual([])
  })

  it('treats query operators, punctuation and quotes as text and ANDs terms', () => {
    store.open()
    store.insert(memory())
    expect(store.search('"concise" explanations', { limit: 10 })).toEqual([memory()])
    expect(store.search('concise OR absent', { limit: 10 })).toEqual([])
    expect(store.search('content:concise', { limit: 10 })).toEqual([])
    expect(store.search('concise*', { limit: 10 })).toEqual([memory()])
    expect(store.search('  ""  ', { limit: 10 })).toEqual([])
  })

  it('filters validity at an explicit time before limiting, including current temporary memories', () => {
    store.open()
    const at = '2026-09-10T12:00:00.000Z'
    store.insert(memory({ id: 'future', validFrom: '2026-09-11T00:00:00.000Z' }))
    store.insert(memory({ id: 'expired', state: 'temporary', validTo: at }))
    store.insert(memory({ id: 'current', state: 'temporary', validFrom: at, validTo: '2026-09-11T00:00:00.000Z' }))
    for (const state of ['superseded', 'disputed', 'archived'] as const) {
      store.insert(memory({ id: state, state }))
    }
    expect(store.search('concise', { limit: 10, at }).map((row) => row.id)).toEqual(['current'])
    expect(store.search('concise', { limit: 1, projectId: 'project-a', at }).map((row) => row.id)).toEqual(['current'])
  })

  it('defaults validity filtering to the current time', () => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-09-10T12:00:00.000Z')
    store.open()
    store.insert(memory({ id: 'future', validFrom: '2026-09-11T00:00:00.000Z' }))
    store.insert(memory({ id: 'current', state: 'temporary' }))
    expect(store.search('concise', { limit: 10 }).map((row) => row.id)).toEqual(['current'])
  })

  it('persists an inferred memory without invented confirmation or use timestamps', () => {
    store.open()
    const input = memory({ sourceClass: 'inferred', lastConfirmedAt: null, lastUsedAt: null })
    store.insert(input)
    store.close()
    store.open()
    expect(store.get(input.id)).toEqual(input)
  })

  it('persists only Sotto thread IDs and references in provenance', () => {
    store.open()
    const input = { ...memory(), provenance: [{ threadId: 'thread-1', ref: 'turn-1', sessionId: 'private', provider: 'codex' }] }
    store.insert(input)
    const db = new DatabaseSync(path)
    try {
      expect(JSON.parse(String(db.prepare('SELECT provenance FROM memories').get()?.provenance)))
        .toEqual([{ threadId: 'thread-1', ref: 'turn-1' }])
    } finally {
      db.close()
    }
  })

  it('keeps FTS synchronized when SQL updates or deletes the external content', () => {
    store.open()
    store.insert(memory())
    const db = new DatabaseSync(path)
    try {
      db.prepare('UPDATE memories SET content = ?, tags = ? WHERE id = ?')
        .run('detailed diagrams', '["visual"]', 'memory-1')
      expect(store.search('concise', { limit: 10 })).toEqual([])
      expect(store.search('communication', { limit: 10 })).toEqual([])
      expect(store.search('visual', { limit: 10 })).toHaveLength(1)
      db.prepare('DELETE FROM memories WHERE id = ?').run('memory-1')
      expect(store.search('diagrams', { limit: 10 })).toEqual([])
    } finally {
      db.close()
    }
  })

  it('rejects invalid input with zod before writing it', () => {
    store.open()
    for (const overrides of [
      { id: '' }, { content: '' }, { confidence: 1.1 }, { importance: -1 },
      { evidenceCount: 0.5 }, { createdAt: 'yesterday' }, { validTo: '2026-09-10' },
    ]) {
      expect(() => store.insert(memory(overrides))).toThrow(z.ZodError)
    }
    expect(() => memorySchema.parse({ ...memory(), sourceClass: 'unknown' })).toThrow(z.ZodError)
    expect(() => memorySchema.parse({ ...memory(), provenance: [{}] })).toThrow(z.ZodError)
    expect(() => store.search('concise', { limit: -1 })).toThrow(z.ZodError)
    expect(store.get('memory-1')).toBeUndefined()
  })

  it('requires open and permits repeated close', () => {
    expect(() => store.get('memory-1')).toThrow(/open/i)
    store.open()
    store.close()
    store.close()
    expect(() => store.insert(memory())).toThrow(/open/i)
  })

  it('runs the real migration and full-text probe with system Node', () => {
    const output = execFileSync(process.execPath, [resolve('scripts/probe-memory-store.mjs')], {
      encoding: 'utf8', windowsHide: true, timeout: 60_000,
    })
    expect(JSON.parse(output.trim())).toEqual({
      sqliteVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      migrationVersion: 2, matchedId: 'memory-probe', fts5: true,
    })
  })
})
