import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { ThreadSwitchTiming } from '../../shared/mainActivity'

/**
 * Where the window's thread switches are noted (#2733), one JSON line each: when, and the milliseconds from the press to
 * main's answer drawn, the history held and the first frame painted with it, beside how much the window held. A CPU profile shows
 * what the window spent its time on but not when a thread appeared, so this file is what puts a number on a slow switch,
 * and on each change made to speed it up. It holds no thread's ID, title or words.
 */
export const THREAD_SWITCHES_FILE = 'thread-switch-diagnostics.jsonl'
/** How many lines one run writes at most: several busy days' switches (221 on November 19), and never a file without end. */
export const THREAD_SWITCHES_PER_RUN = 2_000

export type AppendLine = (path: string, line: string) => Promise<void>

const appendLine: AppendLine = (path, line) => appendFile(path, line, { encoding: 'utf8', mode: 0o600 })

/** Notes each switch the window reports, in the order heard, off main's thread; a failure is dropped. */
export function threadSwitchTimings(directory: string, append: AppendLine = appendLine, now: () => Date = () => new Date()): (timing: ThreadSwitchTiming) => void {
  const path = join(directory, THREAD_SWITCHES_FILE)
  let written = 0
  let chain: Promise<void> = Promise.resolve()
  return timing => {
    if (written >= THREAD_SWITCHES_PER_RUN) return
    written += 1
    const line = `${JSON.stringify({ at: now().toISOString(), ...timing })}\n`
    chain = chain.then(() => append(path, line)).catch(() => undefined)
  }
}
