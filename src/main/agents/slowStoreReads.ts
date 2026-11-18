import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Where main's slow reads of the thread store are noted (`ThreadStore.onSlowRead`), one JSON line each: when, the
 * statement's SQL on one line, and how long it held main. The SQL is Sotto's own, with every value a parameter, so a line
 * carries nothing a person wrote. Main's console reaches no file in a packaged build, and a hang recording cannot see
 * inside a native call, so this file is what names the read behind a freeze (November 17, 2026).
 */
export const SLOW_READS_FILE = 'store-read-diagnostics.jsonl'
/** How many lines one run writes at most, so a store that stays slow cannot grow the file without end. */
export const SLOW_READS_PER_RUN = 200

export type AppendLine = (path: string, line: string) => Promise<void>

const appendLine: AppendLine = (path, line) => appendFile(path, line, { encoding: 'utf8', mode: 0o600 })

/** The listener a store is given: each slow read is appended in the order heard, off main's thread, and a failure is dropped. */
export function slowStoreReads(directory: string, append: AppendLine = appendLine, now: () => Date = () => new Date()): (statement: string, ms: number) => void {
  const path = join(directory, SLOW_READS_FILE)
  let written = 0
  let chain: Promise<void> = Promise.resolve()
  return (statement, ms) => {
    if (written >= SLOW_READS_PER_RUN) return
    written += 1
    const line = `${JSON.stringify({ at: now().toISOString(), statement, ms: Math.round(ms) })}\n`
    chain = chain.then(() => append(path, line)).catch(() => undefined)
  }
}
