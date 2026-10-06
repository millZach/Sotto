// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CheckpointReferences } from '../../../src/main/tools/checkpointReferences'
import type { CheckpointRecord, Snapshot } from '../../../src/main/tools/checkpointStore'

const hash = (n: number) => n.toString(16).padStart(64, '0')
let listed = 0
/** A snapshot that counts how often its files are listed. */
const snapshot = (...hashes: number[]): Snapshot => ({ index: '', head: '', files: new Proxy(Object.fromEntries(hashes.map(n => [`file-${n}.txt`, { hash: hash(n), mode: 0o644 }])), {
  ownKeys(target) { listed++; return Reflect.ownKeys(target) },
}) })
const record = (before: Snapshot, after?: Snapshot): CheckpointRecord => ({ id: randomUUID(), threadId: 'thread-a', workspaceId: 'workspace', cwd: '/work', providerId: 'codex', bindingId: 'codex:a',
  createdAt: new Date().toISOString(), beforeUsers: [], before, ...(after ? { after } : {}), status: 'capturing' })

describe('checkpoint backup references', () => {
  it('lists only the files of records added or given a new snapshot since the last count', () => {
    const references = new CheckpointReferences()
    const saved = Array.from({ length: 40 }, (_, n) => record(snapshot(n, 1000), snapshot(n, 1001)))
    references.sync(saved)
    expect(listed).toBe(80)
    listed = 0
    const sent = record(snapshot(5000))
    references.sync([...saved, sent])
    expect(listed).toBe(1)
    listed = 0
    sent.after = snapshot(5001)
    references.sync([...saved, sent])
    expect(listed).toBe(2)
    expect(references.has(hash(5001))).toBe(true)
  })

  it('counts a backup until no kept record refers to it', () => {
    const references = new CheckpointReferences()
    const first = record(snapshot(1, 2), snapshot(2, 3)), second = record(snapshot(3, 4))
    references.sync([first, second])
    expect([...references.hashes()].sort()).toEqual([1, 2, 3, 4].map(hash))
    expect(references.remove(first.id)).toEqual([1, 2].map(hash))
    expect(references.has(hash(3))).toBe(true)
    references.sync([])
    expect([...references.hashes()]).toEqual([])
    expect(references.remove(second.id)).toEqual([])
  })
})
