import { existsSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

/**
 * What a host sends each phone, ten seconds at a time (#2755): by message kind, by thread, by the shell parts it sent whole,
 * and by the thread-record fields that changed in its list pushes. A byte counter on the tunnel says how much went and
 * nothing of what, so this file is what names the push that fills a phone's link. It holds kinds, Sotto thread IDs, part
 * and field names, counts and bytes, and never a title, a word or a value. It is off unless its switch is on
 * (`phoneSendsFor`), since sizing each part of a push serializes that part again.
 */
export const PHONE_SENDS_FILE = 'phone-send-diagnostics.jsonl'
export const PHONE_SENDS_SWITCH = 'SOTTO_PHONE_SEND_DIAGNOSTICS'
/** The same switch as a file in the host's data folder: its presence turns the notes on. */
export const PHONE_SENDS_SWITCH_FILE = 'phone-send-diagnostics.on'
/** How long one line covers. */
export const PHONE_SENDS_WINDOW_MS = 10_000
/** How many lines one run writes at most: about eleven hours of a phone connected without a quiet window. */
export const PHONE_SENDS_PER_RUN = 4_000

interface Tally { frames: number; bytes: number }
interface Window {
  readonly from: number
  readonly kinds: Map<string, Tally>
  readonly threads: Map<string, Tally>
  readonly parts: Map<string, Tally>
  readonly fields: Map<string, number>
}
/** One phone's window, written as one line. */
export interface PhoneSendsLine {
  readonly at: string
  readonly phone: number
  readonly seconds: number
  readonly kinds: Record<string, Tally>
  readonly threads: Record<string, Tally>
  readonly parts: Record<string, Tally>
  readonly fields: Record<string, number>
}

export interface PhoneSends {
  /** A message written to a phone: its kind (the push's `event`, or `answer`), its bytes, and the thread it is about. */
  sent(phone: object, kind: string, bytes: number, threadId?: string): void
  /**
   * A shell written to a phone: each part it carried whole, at its top and in its `host`, with its bytes, and the thread
   * records that changed, each measured against the record of the same thread this phone was last sent.
   */
  shell(phone: object, sentState: Readonly<Record<string, unknown>>, changed: readonly { readonly id: string }[]): void
  /** The phone's connection closed: its window is written and nothing of it is held. */
  ended(phone: object): void
  /** Writes every window still open. */
  flush(): void
}

const tally = (map: Map<string, Tally>, key: string, bytes: number): void => {
  const held = map.get(key)
  if (held) { held.frames += 1; held.bytes += bytes } else map.set(key, { frames: 1, bytes })
}
const bytesOf = (value: unknown): number => value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value))

/** Notes what each phone is sent and writes a line per phone every `PHONE_SENDS_WINDOW_MS`, off the send path. */
export function phoneSends(write: (line: PhoneSendsLine) => void, now: () => number = Date.now): PhoneSends {
  const phones = new WeakMap<object, { readonly number: number; window: Window; readonly records: Map<string, Readonly<Record<string, unknown>>> }>()
  const open = new Set<object>()
  let numbered = 0, written = 0
  const fresh = (from: number): Window => ({ from, kinds: new Map(), threads: new Map(), parts: new Map(), fields: new Map() })
  const close = (phone: object, at: number): void => {
    const held = phones.get(phone)
    if (!held) return
    const window = held.window
    held.window = fresh(at)
    const empty = !window.kinds.size && !window.threads.size && !window.parts.size && !window.fields.size
    if (empty || written >= PHONE_SENDS_PER_RUN) return
    written += 1
    write({ at: new Date(at).toISOString(), phone: held.number, seconds: Math.round((at - window.from) / 100) / 10,
      kinds: Object.fromEntries(window.kinds), threads: Object.fromEntries(window.threads), parts: Object.fromEntries(window.parts), fields: Object.fromEntries(window.fields) })
  }
  const windowOf = (phone: object): { window: Window; records: Map<string, Readonly<Record<string, unknown>>> } => {
    const at = now()
    let held = phones.get(phone)
    if (!held) { held = { number: ++numbered, window: fresh(at), records: new Map() }; phones.set(phone, held); open.add(phone) }
    else if (at - held.window.from >= PHONE_SENDS_WINDOW_MS) close(phone, at)
    return held
  }
  return {
    sent(phone, kind, bytes, threadId) {
      const { window } = windowOf(phone)
      tally(window.kinds, kind, bytes)
      if (threadId !== undefined) tally(window.threads, threadId, bytes)
    },
    shell(phone, sentState, changed) {
      const { window, records } = windowOf(phone)
      for (const [part, value] of Object.entries(sentState)) {
        if (part === 'kept' || part === 'host') continue
        tally(window.parts, part, bytesOf(value))
      }
      const host = sentState.host
      if (host !== null && typeof host === 'object') {
        for (const [part, value] of Object.entries(host)) if (part !== 'kept' && part !== 'threads') tally(window.parts, 'host.' + part, bytesOf(value))
      }
      for (const record of changed as readonly Readonly<Record<string, unknown>>[]) {
        const id = record.id as string
        tally(window.threads, id, bytesOf(record))
        const before = records.get(id)
        records.set(id, record)
        if (!before) { window.fields.set('(new record)', (window.fields.get('(new record)') ?? 0) + 1); continue }
        for (const field of new Set([...Object.keys(before), ...Object.keys(record)])) {
          if (!isDeepStrictEqual(before[field], record[field])) window.fields.set(field, (window.fields.get(field) ?? 0) + 1)
        }
      }
    },
    ended(phone) {
      if (!open.delete(phone)) return
      close(phone, now())
      phones.delete(phone)
    },
    flush() {
      const at = now()
      for (const phone of open) close(phone, at)
    },
  }
}

/**
 * The recorder a host's phone listener uses, writing to `directory`, or undefined while the switch is off. The switch is
 * `SOTTO_PHONE_SEND_DIAGNOSTICS=1`, or a file named `PHONE_SENDS_SWITCH_FILE` in the data folder, which a desktop started
 * from the Start menu can be given without a shell. Either is read once, as the host starts.
 */
export function phoneSendsFor(directory: string, environment: NodeJS.ProcessEnv = process.env): PhoneSends | undefined {
  if (environment[PHONE_SENDS_SWITCH] !== '1' && !existsSync(join(directory, PHONE_SENDS_SWITCH_FILE))) return undefined
  const path = join(directory, PHONE_SENDS_FILE)
  let chain: Promise<void> = Promise.resolve()
  return phoneSends(line => { chain = chain.then(() => appendFile(path, JSON.stringify(line) + '\n', { encoding: 'utf8', mode: 0o600 })).catch(() => undefined) })
}
