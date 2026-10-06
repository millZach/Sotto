import type { CheckpointRecord, Snapshot } from './checkpointStore'

interface Counted { before: Snapshot; after: Snapshot | undefined; hashes: readonly string[] }

/**
 * How many saved checkpoints refer to each file backup. A record's snapshots are replaced, never changed in place,
 * so a record is counted again only when one of them is a different object: a save after a send counts the new
 * record's files, not every file of every saved checkpoint.
 */
export class CheckpointReferences {
  private readonly records = new Map<string, Counted>()
  private readonly counts = new Map<string, number>()

  /** Count `records` as the ones kept, and forget any other. */
  sync(records: Iterable<CheckpointRecord>): void {
    const kept = new Set<string>()
    for (const record of records) {
      kept.add(record.id)
      const counted = this.records.get(record.id)
      if (counted && counted.before === record.before && counted.after === record.after) continue
      if (counted) this.release(counted.hashes)
      const hashes = [...new Set([record.before, record.after].flatMap(snapshot => snapshot ? Object.values(snapshot.files).map(file => file.hash) : []))]
      for (const hash of hashes) this.counts.set(hash, (this.counts.get(hash) ?? 0) + 1)
      this.records.set(record.id, { before: record.before, after: record.after, hashes })
    }
    for (const [id, counted] of this.records) if (!kept.has(id)) { this.release(counted.hashes); this.records.delete(id) }
  }

  /** Stop counting a record; returns the backups nothing else refers to now. */
  remove(id: string): string[] {
    const counted = this.records.get(id)
    if (!counted) return []
    this.records.delete(id)
    return this.release(counted.hashes)
  }

  /** Every backup a kept record refers to, once each. */
  hashes(): IterableIterator<string> { return this.counts.keys() }

  has(hash: string): boolean { return this.counts.has(hash) }

  private release(hashes: readonly string[]): string[] {
    const unreferenced: string[] = []
    for (const hash of hashes) {
      const remaining = (this.counts.get(hash) ?? 1) - 1
      if (remaining > 0) this.counts.set(hash, remaining)
      else { this.counts.delete(hash); unreferenced.push(hash) }
    }
    return unreferenced
  }
}
