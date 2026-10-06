import fs from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { basename } from 'node:path'

/** One fsync, named by the file it makes durable: a store's temporary sibling is named as the store. */
export interface DurableWrite {
  readonly file: string
  /** `performance.now()` when the sync started. */
  readonly at: number
  /** What the handle wrote before this sync. */
  readonly bytes: number
}

export interface DurableWriteRecorder {
  /** Every fsync made since the recorder was installed, in the order they started. */
  readonly writes: DurableWrite[]
  /** The fsyncs that started from `from` to `until` (`performance.now()` readings), counted by file. */
  since(from: number, until?: number): Record<string, number>
  /** The bytes those fsyncs made durable, by file. */
  bytesSince(from: number, until?: number): Record<string, number>
  /**
   * Holds every fsync of `file` until the returned function is called, so a test can show what goes on while a
   * write of it is open.
   */
  hold(file: string): () => void
  /**
   * Resolves once no fsync is running and none has started for `ms`: the writes something set going have landed,
   * however long they took, rather than after a fixed sleep.
   */
  quiet(ms?: number): Promise<void>
  restore(): void
}

const storeName = (path: string): string => basename(path).replace(/\.tmp-\d+-[^.]+$/u, '')

/**
 * Counts the fsyncs this process makes through `node:fs/promises`, which is every durable write Sotto's stores
 * make: an atomic store syncs its temporary file before renaming it over the store, and an append-only file
 * syncs each line. The patch reaches modules that imported `open` already, through Node's builtin export sync.
 */
export function recordDurableWrites(): DurableWriteRecorder {
  const promises = fs.promises as { open: typeof fs.promises.open }
  const original = promises.open
  const writes: DurableWrite[] = []
  const holds = new Map<string, { held: Promise<void>; release: () => void }>()
  let syncing = 0
  const wrap = (handle: FileHandle, path: string): FileHandle => {
    let bytes = 0
    const writeFile = handle.writeFile.bind(handle)
    handle.writeFile = (async (data: string | Uint8Array, options?: unknown) => {
      bytes += typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength
      return writeFile(data as never, options as never)
    }) as FileHandle['writeFile']
    const sync = handle.sync.bind(handle)
    handle.sync = async () => {
      const file = storeName(path)
      writes.push({ file, at: performance.now(), bytes })
      bytes = 0
      syncing += 1
      try {
        await holds.get(file)?.held
        return await sync()
      } finally { syncing -= 1 }
    }
    return handle
  }
  promises.open = (async (path: fs.PathLike, ...rest: unknown[]) => {
    const handle = await (original as (...args: unknown[]) => Promise<FileHandle>)(path, ...rest)
    return wrap(handle, String(path))
  }) as typeof original
  syncBuiltinESMExports()
  const within = (from: number, until: number) => writes.filter(write => write.at >= from && write.at <= until)
  const tally = (from: number, until: number, value: (write: DurableWrite) => number): Record<string, number> => {
    const totals: Record<string, number> = {}
    for (const write of within(from, until)) totals[write.file] = (totals[write.file] ?? 0) + value(write)
    return totals
  }
  return {
    writes,
    since: (from, until = Number.POSITIVE_INFINITY) => tally(from, until, () => 1),
    bytesSince: (from, until = Number.POSITIVE_INFINITY) => tally(from, until, write => write.bytes),
    hold: file => {
      let release!: () => void
      const held = new Promise<void>(done => { release = done })
      holds.set(file, { held, release })
      return () => { if (holds.get(file)?.held === held) holds.delete(file); release() }
    },
    quiet: async (ms = 100) => {
      for (;;) {
        const last = writes.at(-1)?.at ?? Number.NEGATIVE_INFINITY
        if (syncing === 0 && performance.now() - last >= ms) return
        await new Promise(done => setTimeout(done, 10))
      }
    },
    restore: () => {
      promises.open = original
      syncBuiltinESMExports()
      for (const { release } of holds.values()) release()
      holds.clear()
    },
  }
}
