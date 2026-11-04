import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dictationTimingNow, setDictationTimingSink, type DictationTimingMark } from '../../shared/dictationTiming'

/** Opt-in, local timing numbers. One hotkey event starts each serial measurement; no identity is persisted. */
export class DictationTiming {
  private startedAt: number | undefined
  private writes: Promise<void> = Promise.resolve()

  constructor(private readonly write: (line: string) => Promise<void>) {}

  begin(atMs = dictationTimingNow()): void {
    this.startedAt = atMs
    this.mark({ event: 'hotkey-received', atMs: this.startedAt })
  }

  mark(mark: DictationTimingMark): void {
    if (this.startedAt === undefined || mark.atMs < this.startedAt) return
    const line = JSON.stringify({ event: mark.event, elapsedMs: Math.round((mark.atMs - this.startedAt) * 1000) / 1000 }) + '\n'
    // File I/O never holds up microphone capture, transcription or delivery.
    this.writes = this.writes.then(() => this.write(line)).catch(() => { console.warn('dictation-timing-not-saved') })
  }

  flush(): Promise<void> { return this.writes }
}

export function createDictationTiming(directory: string): DictationTiming {
  const path = join(directory, 'dictation-timings.jsonl')
  const timing = new DictationTiming(line => appendFile(path, line, { encoding: 'utf8', mode: 0o600 }))
  setDictationTimingSink(mark => timing.mark(mark))
  return timing
}
