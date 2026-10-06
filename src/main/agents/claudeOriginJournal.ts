import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { retryWindowsFileOperation } from '../storage/windowsFileRetry'

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

/** One origin as the journal holds it: the Sotto thread it belongs to, and the record itself. */
export interface JournaledOrigin<Origin> {
  readonly threadId: string
  readonly origin: Origin
}

/**
 * The origins the Claude adapter recorded since it last wrote `claude-threads.json` whole, one JSON line each.
 *
 * An origin has to be on disk before its prompt is written to the CLI, so a crash can never leave a prompt Claude
 * Code took that Sotto has no record of sending. Writing the whole thread store for it rewrote every thread's
 * record to add one; appending a line and syncing it is the same guarantee for one small write. The adapter
 * clears the journal each time it writes the store whole, which then holds every origin in it, and reads it
 * back over the store when it connects.
 *
 * The caller orders appends, reads and clears against its own writes of the store. A line a crash cut short is
 * the last one, and its prompt was never sent, so a line that does not parse is skipped.
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

  async read(): Promise<JournaledOrigin<Origin>[]> {
    let contents: string
    try { contents = await readFile(this.filePath, 'utf8') }
    catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return []
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
    return entries
  }

  async clear(): Promise<void> {
    try { await retryWindowsFileOperation(() => unlink(this.filePath)) }
    catch (error) { if (!hasErrorCode(error, 'ENOENT')) throw error }
  }
}
