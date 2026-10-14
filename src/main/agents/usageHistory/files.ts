import { createReadStream } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { USAGE_HISTORY_BATCH_MAX, type UsageHistoryCursor, type UsageHistoryPrompt, type UsageProviderId, type UsageTokenObservation } from '../../../shared/usageDashboard'
import { usageHistoryCursorKey, yieldToEventLoop, type UsageHistorySink } from './sink'

/** A line longer than this is skipped unread rather than held: no usage frame comes near it. */
const LINE_MAX_BYTES = 64 * 1024 * 1024
const CHUNK_BYTES = 128 * 1024
/** Parsing is done in slices: after this much of a file the reader lets everything else waiting run first. */
const YIELD_BYTES = 1024 * 1024

/** What a reader has read and not yet handed to the sink. */
export class HistoryBatch {
  readonly tokens: UsageTokenObservation[] = []
  readonly prompts: UsageHistoryPrompt[] = []
  get size(): number { return this.tokens.length + this.prompts.length }
}

/**
 * One provider's file format. `line` sees only lines that contain one of `needles`, parses what it needs and keeps
 * numbers, instants, model and client names and identities; it never keeps a line. `settle` hands over anything it
 * was holding, because a cursor is about to be saved past it. `state` is the reader's own numeric resume state.
 */
export interface HistoryFileReader<State> {
  readonly needles: readonly Buffer[]
  start(file: HistoryFile, saved: string | undefined): State
  /** `index` counts every line since this reading began, wanted or not. */
  line(text: string, state: State, batch: HistoryBatch, index: number): void
  settle(state: State, batch: HistoryBatch): void
  /** `lines` is how many lines this reading has consumed so far. */
  save(state: State, lines: number): string | undefined
}

export interface HistoryFile { readonly path: string; readonly relativePath: string }

/** Every file under `root` that `accept` takes, in name order so a parent's rollout is read before its forks. */
export async function historyFiles(root: string, accept: (name: string, relativePath: string) => boolean, signal: AbortSignal): Promise<HistoryFile[]> {
  const found: HistoryFile[] = []
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (signal.aborted || depth > 8) return
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path, depth + 1)
      else if (entry.isFile()) {
        const relativePath = relative(root, path).replaceAll('\\', '/')
        if (accept(entry.name, relativePath)) found.push({ path, relativePath })
      }
    }
  }
  await walk(root, 0)
  const name = (file: HistoryFile): string => file.relativePath.slice(file.relativePath.lastIndexOf('/') + 1)
  return found.sort((a, b) => name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0)
}

/** Where to begin a file: undefined when nothing changed since the saved cursor. */
async function startOffset(path: string, cursor: UsageHistoryCursor | undefined, size: number, mtimeMs: number): Promise<number | undefined> {
  if (!cursor) return 0
  // Shrunk or replaced by an older file: read again from the start. Dedupe makes a second reading count once.
  if (size < cursor.offset || mtimeMs < cursor.mtimeMs) return 0
  if (size === cursor.size && mtimeMs === cursor.mtimeMs && cursor.offset >= size) return undefined
  if (cursor.offset === 0) return 0
  // A cursor always sits just after a line break. Any other byte there means the file was rewritten.
  const handle = await open(path, 'r')
  try {
    const byte = Buffer.alloc(1)
    const { bytesRead } = await handle.read(byte, 0, 1, cursor.offset - 1)
    return bytesRead === 1 && byte[0] === 0x0a ? cursor.offset : 0
  } finally { await handle.close() }
}

/**
 * Reads one file from its cursor to its last complete line, handing rows to the sink in batches of at most
 * `USAGE_HISTORY_BATCH_MAX` and saving the cursor just after the rows it covers. An incomplete last line waits for
 * the next pass. Answers false when the pass was stopped.
 */
export async function readHistoryFile<State>(providerId: UsageProviderId, file: HistoryFile, reader: HistoryFileReader<State>,
  sink: UsageHistorySink, signal: AbortSignal): Promise<boolean> {
  const key = usageHistoryCursorKey(providerId, file.relativePath)
  let info
  try { info = await stat(file.path) } catch { return true }
  const size = info.size, mtimeMs = Math.max(0, Math.floor(info.mtimeMs))
  const saved = sink.cursor(key)
  let offset: number | undefined
  try { offset = await startOffset(file.path, saved, size, mtimeMs) } catch { return true }
  if (offset === undefined) return true
  const state = reader.start(file, offset === 0 ? undefined : saved?.state)
  const batch = new HistoryBatch()
  let consumed = offset
  let lines = 0
  const commit = async (): Promise<void> => {
    reader.settle(state, batch)
    for (let index = 0; index < batch.tokens.length; index += USAGE_HISTORY_BATCH_MAX) sink.tokens(batch.tokens.slice(index, index + USAGE_HISTORY_BATCH_MAX))
    for (let index = 0; index < batch.prompts.length; index += USAGE_HISTORY_BATCH_MAX) sink.prompts(batch.prompts.slice(index, index + USAGE_HISTORY_BATCH_MAX))
    batch.tokens.length = 0; batch.prompts.length = 0
    const encoded = reader.save(state, lines)
    sink.setCursors([{ key, cursor: { size, mtimeMs, offset: consumed, ...(encoded === undefined ? {} : { state: encoded }) } }])
    await yieldToEventLoop()
  }
  if (offset >= size) { await commit(); return true }
  const wanted = (line: Buffer): boolean => reader.needles.some(needle => line.includes(needle))
  const take = (line: Buffer): void => {
    if (!wanted(line)) return
    let text = line.toString('utf8')
    if (text.endsWith('\r')) text = text.slice(0, -1)
    reader.line(text, state, batch, lines)
  }
  let carry: Buffer[] = []
  let carried = 0
  let skipping = false
  const stream = createReadStream(file.path, { start: offset, end: size - 1, highWaterMark: CHUNK_BYTES })
  let position = offset
  let sinceYield = 0
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      let start = 0
      while (start < chunk.length) {
        const end = chunk.indexOf(0x0a, start)
        if (end === -1) {
          if (!skipping) {
            carry.push(chunk.subarray(start)); carried += chunk.length - start
            if (carried > LINE_MAX_BYTES) { carry = []; carried = 0; skipping = true }
          }
          break
        }
        if (skipping) skipping = false
        else take(carry.length ? Buffer.concat([...carry, chunk.subarray(start, end)]) : chunk.subarray(start, end))
        carry = []; carried = 0
        lines += 1
        consumed = position + end + 1
        start = end + 1
        if (batch.size >= USAGE_HISTORY_BATCH_MAX) await commit()
      }
      position += chunk.length
      if (signal.aborted) { stream.destroy(); await commit(); return false }
      sinceYield += chunk.length
      if (sinceYield >= YIELD_BYTES) { sinceYield = 0; await yieldToEventLoop() }
    }
  } catch {
    // A file that vanished or could not be read keeps whatever was read before it.
  }
  await commit()
  return !signal.aborted
}

/** Reads every file under the given folders in turn. A missing folder is a client this computer never ran. */
export async function readHistoryFolders<State>(providerId: UsageProviderId, roots: readonly { root: string; accept: (name: string, relativePath: string) => boolean; prefix: string }[],
  reader: HistoryFileReader<State>, sink: UsageHistorySink, signal: AbortSignal): Promise<void> {
  const files: HistoryFile[] = []
  for (const { root, accept, prefix } of roots) {
    for (const file of await historyFiles(root, accept, signal)) files.push({ path: file.path, relativePath: `${prefix}/${file.relativePath}` })
  }
  const name = (file: HistoryFile): string => file.relativePath.slice(file.relativePath.lastIndexOf('/') + 1)
  files.sort((a, b) => name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0)
  for (const file of files) {
    if (signal.aborted) return
    if (!await readHistoryFile(providerId, file, reader, sink, signal)) return
  }
}
