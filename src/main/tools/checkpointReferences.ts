import type { CheckpointRecord, Snapshot } from './checkpointStore'

interface Counted { before: Snapshot; after: Snapshot | undefined; hashes: readonly string[] }

/**
 * How many saved checkpoints refer to each file backup, and the backups' bytes. A record's snapshots are replaced,
 * never changed in place, so a record is counted again only when one of them is a different object: a save after a
 * send counts the new record's files, not every file of every saved checkpoint.
 */
export class CheckpointReferences {
  private readonly records = new Map<string, Counted>()
  /** For each backup referred to: how many records refer to it, and the bytes counted for it. */
  private readonly counts = new Map<string, { records: number; bytes: number }>()
  /** The bytes of every backup a kept record refers to, each once, as `sizeOf` gave them when it was first referred to. */
  bytes = 0

  constructor(private readonly sizeOf: (hash: string) => number) {}

  /** Count `records` as the ones kept, and forget any other. */
  sync(records: Iterable<CheckpointRecord>): void {
    const kept = new Set<string>()
    for (const record of records) {
      kept.add(record.id)
      const counted = this.records.get(record.id)
      if (counted && counted.before === record.before && counted.after === record.after) continue
      if (counted) this.release(counted.hashes)
      const hashes = [...new Set([record.before, record.after].flatMap(snapshot => snapshot ? Object.values(snapshot.files).map(file => file.hash) : []))]
      for (const hash of hashes) {
        const count = this.counts.get(hash)
        if (count) { count.records++; continue }
        const bytes = this.sizeOf(hash)
        this.counts.set(hash, { records: 1, bytes }); this.bytes += bytes
      }
      this.records.set(record.id, { before: record.before, after: record.after, hashes })
    }
    for (const [id, counted] of this.records) if (!kept.has(id)) { this.release(counted.hashes); this.records.delete(id) }
  }

  /** Stop counting a record. */
  remove(id: string): void {
    const counted = this.records.get(id)
    if (!counted) return
    this.records.delete(id)
    this.release(counted.hashes)
  }

  has(hash: string): boolean { return this.counts.has(hash) }

  private release(hashes: readonly string[]): void {
    for (const hash of hashes) {
      const count = this.counts.get(hash)
      if (!count) continue
      if (--count.records === 0) { this.counts.delete(hash); this.bytes -= count.bytes }
    }
  }
}
