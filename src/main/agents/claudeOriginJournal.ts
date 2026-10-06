import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { hasErrorCode } from '../storage/atomicJsonStore'
import { retryWindowsFileOperation } from '../storage/windowsFileRetry'

/** One origin as the journal holds it: the Sotto thread it belongs to, and the record itself. */
export interface JournaledOrigin<Origin> {
  readonly threadId: string
  readonly origin: Origin
}

/** What the journal held when it was read. */
export interface JournalContents<Origin> {
  readonly entries: JournaledOrigin<Origin>[]
  /** Whether the file held anything at all, a line that did not parse included. */
  readonly present: boolean
}

/**
 * The origins the Claude adapter recorded since it last wrote `claude-threads.json` whole, one JSON line each.
 *
 * An origin has to be on disk before its prompt is written to the CLI, so a crash can never leave a prompt Claude
 * Code took that Sotto has no record of sending. Writing the whole thread store for it rewrote every thread's
 * record to add one; appending a line and syncing it is the same guarantee for one small write. The adapter
 * clears the journal each time it writes the store whole, which then holds every origin in it, and folds it into
 * the store and clears it when it connects, so a new connection never appends after an old line.
 *
 * The caller orders appends, reads and clears against its own writes of the store. A line a crash cut short is
 * therefore the last one, and its prompt was never sent, so a line that does not parse is skipped. The origin
 * schema is the thread store's own, so a line it rejects is one the store would reject too. An append that fails
 * after its line was written (the sync or the close) may still leave the line, for a prompt the adapter then
 * refuses to send: a record of a send that never happened, which no reconciliation matches. The other way, a sent
 * prompt with no record, cannot happen.
 */
export class ClaudeOriginJournal<Origin> {
  constructor(
    private readonly filePath: string,
    private readonly parse: (value: unknown) => JournaledOrigin<Origin> | undefined,
  ) {}

  async append(entry: JournaledOrigin<Origin>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const handle = await open(this.filePath, 'a', 0o600)
    try {
      // A line cut short by a crash may lack its newline; starting each entry on its own line keeps the next whole.
      await handle.writeFile(`\n${JSON.stringify(entry)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  async read(): Promise<JournalContents<Origin>> {
    let contents: string
    try { contents = await readFile(this.filePath, 'utf8') }
    catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return { entries: [], present: false }
      throw error
    }
    const entries: JournaledOrigin<Origin>[] = []
    for (const line of contents.split('\n')) {
      if (!line.trim()) continue
      let value: unknown
      try { value = JSON.parse(line) } catch { continue }
      const entry = this.parse(value)
      if (entry) entries.push(entry)
    }
    return { entries, present: contents.trim() !== '' }
  }

  async clear(): Promise<void> {
    try { await retryWindowsFileOperation(() => unlink(this.filePath)) }
    catch (error) { if (!hasErrorCode(error, 'ENOENT')) throw error }
  }
}
