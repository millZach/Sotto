import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { monthOf } from '../../plugins/spending'
import { SOUND_FAILURES, SOUND_KINDS, SOUND_STATES, SPEECH_CHARACTERS_MAX, type SoundFailure } from '../../../shared/sounds'

/**
 * What became of a sound. `making` while ElevenLabs makes it and Sotto saves it, `made` with its MP3 in the thread's
 * folder, `failed` when ElevenLabs or the folder would not have it.
 */
export { SOUND_STATES }
/**
 * Why a sound was not made, in one word: ElevenLabs' own (`refused`, `no-credits`, `rejected`, `busy`, `unreachable`,
 * `unreadable`), the save's (`folder`, `too-large`, and `unreachable` again for an answer that stopped), the account
 * gone (`no-account`) or its key unreadable (`locked`), or `stopped` when Sotto stopped while it was being made and
 * cannot tell whether ElevenLabs charged for it.
 */
export { SOUND_FAILURES, type SoundFailure }

/** The newest records kept. A record is small; this only stops the file growing without end. */
export const SOUND_RECORDS_KEPT = 2_000

const at = z.iso.datetime()
/** A cost in US dollars, as `soundCost` gives it. */
const dollars = z.number().nonnegative().max(1_000)
const recordSchema = z.object({
  id: z.string().min(1).max(100),
  threadId: z.string().min(1).max(500),
  accountId: z.string().min(1).max(200),
  kind: z.enum(SOUND_KINDS),
  name: z.string().min(1).max(200),
  /** The words sent, kept only while Keep local history is on. */
  words: z.string().max(SPEECH_CHARACTERS_MAX).optional(),
  /** The voice speech was spoken in, by its name in the account. */
  voice: z.string().min(1).max(200).optional(),
  seconds: z.number().positive().max(1_000).optional(),
  /**
   * The real folder inside the thread's folder the MP3 goes into, and its name there once it is saved. The record holds
   * no working folder: the MP3 is read back only from inside the thread's working folder as it is now.
   */
  folder: z.string().min(1),
  fileName: z.string().min(1).max(200).optional(),
  bytes: z.number().int().nonnegative().optional(),
  /** What it cost at ElevenLabs' published prices: its estimate while it is made and once made, nothing once failed. */
  cost: dollars,
  askedAt: at,
  state: z.enum(SOUND_STATES),
  failure: z.enum(SOUND_FAILURES).optional(),
}).strict()
/**
 * What a forgotten thread's sound cost, kept so forgetting a thread never lowers the month's count: the account, when
 * it was asked for and the cost, and nothing else, as a 3D model's forgotten cost is. Kept for two months at most.
 */
const spentSchema = z.object({
  accountId: z.string().min(1).max(200), askedAt: at, cost: dollars.positive(),
  /** A sound still being made when its record went keeps its ID, so a refusal that comes after can take its cost back. */
  id: z.string().min(1).max(100).optional(),
}).strict()
type Spent = z.infer<typeof spentSchema>
const SPENT_KEPT_MS = 62 * 24 * 60 * 60_000
const fileSchema = z.object({ version: z.literal(1), sounds: z.array(z.unknown()), spent: z.array(z.unknown()).optional() })

export type SoundRecord = z.infer<typeof recordSchema>

/**
 * The record of sounds made with ElevenLabs (ADR-0205, slice 12): one small file in Sotto's data folder, newest first,
 * as the record of 3D models is. Forgetting a thread removes its records; the MP3s they name are the user's and stay
 * where they are. The words sent follow Keep local history: with it off no record holds them, in memory or in the
 * file, and turning it off takes out those already kept. The rest of a record stays whichever way it is set: it holds
 * nothing the thread's folder does not already show, and it is what the month's spending is counted from.
 *
 * Every change runs whole, one after another.
 */
export class SoundRecords {
  private readonly path: string
  private records: SoundRecord[] | undefined
  /** What forgotten threads' sounds cost, read with the records. */
  private spent: readonly Spent[] = []
  /** Whether the file may still hold words, so turning Keep local history off knows to write it again. */
  private wordsInFile = false
  /** Changes that could not be written, by record, laid over the records at the next write. */
  private readonly waiting = new Map<string, (record: SoundRecord) => SoundRecord>()
  private queue: Promise<unknown> = Promise.resolve()
  constructor(directory: string, private readonly options: { readonly historyEnabled: () => boolean; readonly kept?: number; readonly now?: () => Date }) {
    this.path = join(directory, 'sounds.json')
  }

  /** One sound's record, or undefined when Sotto holds none by that ID. */
  sound(id: string): Promise<SoundRecord | undefined> {
    return this.inTurn(async () => this.current((await this.load()).find(record => record.id === id)))
  }

  /** Every sound, newest first. */
  list(): Promise<readonly SoundRecord[]> {
    return this.inTurn(async () => (await this.load()).map(record => this.current(record)!))
  }

  /**
   * A record as it stands, with a change that could not yet be written laid over it: a sound saved while its record's
   * write failed reads as made, so its line shows Play and a read again agrees (Bug Bot on #2653, L2).
   */
  private current(record: SoundRecord | undefined): SoundRecord | undefined {
    const change = record ? this.waiting.get(record.id) : undefined
    return record && change ? this.private(recordSchema.parse(change(record))) : record
  }

  /** Keeps a new record. Rejects when it cannot be written, and then nothing should be sent to ElevenLabs. */
  add(record: SoundRecord): Promise<SoundRecord> {
    return this.inTurn(async () => {
      const kept = this.private(recordSchema.parse(record))
      const records = await this.load()
      const most = this.options.kept ?? SOUND_RECORDS_KEPT
      const all = [kept, ...records.filter(other => other.id !== kept.id)]
      // The oldest records past the most kept go, and what each cost stays counted, as a forgotten thread's does.
      await this.write(all.slice(0, most), [...this.spent, ...spentOf(all.slice(most))])
      return kept
    })
  }

  /**
   * Changes one record. Undefined when it is gone, as when its thread was forgotten while it was being made. A change
   * that cannot be written is kept in memory and written with the next change that can be, so a sound known to be
   * refused is not left counted for want of one write (Sol's review); it still rejects, as the change is not yet kept.
   */
  update(id: string, change: (record: SoundRecord) => SoundRecord): Promise<SoundRecord | undefined> {
    return this.inTurn(async () => {
      const records = await this.load()
      const index = records.findIndex(record => record.id === id)
      if (index < 0) return undefined
      const next = this.private(recordSchema.parse(change(records[index]!)))
      const all = records.map((record, other) => other === index ? next : record)
      try { await this.write(all) } catch (error) {
        this.waiting.set(id, change)
        throw error
      }
      return next
    })
  }

  /**
   * Takes back the cost of a sound whose record went while it was made, once it is known not to have been made: its
   * thread was forgotten, and ElevenLabs then refused it. Nothing when it was never held in the ledger.
   */
  refundForgotten(id: string): Promise<void> {
    return this.inTurn(async () => {
      await this.load()
      if (!this.spent.some(entry => entry.id === id)) return
      await this.write(this.records!, this.spent.filter(entry => entry.id !== id))
    })
  }

  /**
   * A sound still `making` when Sotto last stopped was cut off, and ElevenLabs may have charged for it: it ends as
   * `stopped`, and its cost stays counted. Run once at start, before any sound is asked for.
   */
  settleUnfinished(): Promise<void> {
    return this.inTurn(async () => {
      const records = await this.load()
      if (!records.some(record => record.state === 'making')) return
      await this.write(records.map(record => record.state === 'making' ? { ...record, state: 'failed' as const, failure: 'stopped' as const } : record))
    })
  }

  /**
   * Removes forgotten threads' records, all of them in one change. The MP3s stay, and so does what each cost, by its
   * account and when it was asked for alone, so the month's spending is counted the same.
   */
  forgetThreads(threadIds: readonly string[]): Promise<void> {
    const gone = new Set(threadIds)
    return this.inTurn(async () => {
      const records = await this.load()
      const kept = records.filter(record => !gone.has(record.threadId))
      if (kept.length === records.length) return
      await this.write(kept, [...this.spent, ...spentOf(records.filter(record => gone.has(record.threadId)))])
    })
  }

  /**
   * What each ElevenLabs account's sounds cost in the month `now` falls in, by this computer's clock: from the 1st, as
   * a Meshy account's credits are counted. A sound counts from when it was asked for, while it is made too, at its
   * estimate; one that failed counts nothing, unless Sotto stopped before it could tell. A forgotten thread's count the
   * same.
   */
  monthSpent(now: Date = this.options.now?.() ?? new Date()): Promise<ReadonlyMap<string, number>> {
    return this.inTurn(async () => {
      const records = await this.load()
      const month = monthOf(now)
      const spent = new Map<string, number>()
      for (const entry of [...records.map(record => this.current(record)!), ...this.spent]) {
        if (entry.cost <= 0 || monthOf(new Date(entry.askedAt)) !== month) continue
        spent.set(entry.accountId, (spent.get(entry.accountId) ?? 0) + entry.cost)
      }
      return spent
    })
  }

  /** Keep local history changed: with it off, the words kept with each record are taken out of memory and the file. */
  privacyChanged(): Promise<void> {
    return this.inTurn(async () => {
      if (this.options.historyEnabled()) return
      // Memory first, so the words are gone from what Sotto holds even when the file cannot be written.
      const records = (await this.load()).map(record => this.private(record))
      this.records = records
      if (this.wordsInFile) await this.write(records)
    })
  }

  /** A record as it may be kept now: without its words while Keep local history is off. */
  private private(record: SoundRecord): SoundRecord {
    if (this.options.historyEnabled() || record.words === undefined) return record
    const kept: Partial<SoundRecord> = { ...record }
    delete kept.words
    return kept as SoundRecord
  }

  private inTurn<Result>(change: () => Promise<Result>): Promise<Result> {
    const run = this.queue.catch(() => undefined).then(change)
    this.queue = run
    return run
  }

  private async load(): Promise<SoundRecord[]> {
    if (this.records) return this.records
    let text: string
    try { text = await readFile(this.path, 'utf8') } catch (error) {
      // No file yet: no records. One that is there and could not be read now fails this change and is read again by
      // the next, so it is never written over with nothing.
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') { this.records = []; return this.records }
      throw error
    }
    let parsed: ReturnType<typeof fileSchema.safeParse> | undefined
    try { parsed = fileSchema.safeParse(JSON.parse(text)) } catch { parsed = undefined }
    // A file that does not parse is not read as no sounds, which would count the month from nothing and let the next
    // write replace what it held: every change refuses until it can be read (Sol's review). A record this version
    // cannot read is left out rather than failing the rest.
    if (!parsed?.success) throw new Error('sound-records-unreadable')
    const records = parsed.data.sounds.flatMap(entry => {
      const record = recordSchema.safeParse(entry)
      if (!record.success || record.data.words !== undefined) this.wordsInFile = true
      return record.success ? [this.private(record.data)] : []
    })
    this.spent = (parsed.data.spent ?? []).flatMap(entry => { const spent = spentSchema.safeParse(entry); return spent.success ? [spent.data] : [] })
    this.records = records
    return records
  }

  /**
   * Writes the record whole and only then takes it as kept, so a failed write leaves what was kept as it was. What
   * forgotten sounds cost is kept for two months, which covers any month's count.
   */
  private async write(given: SoundRecord[], spent: readonly Spent[] = this.spent): Promise<void> {
    // Changes that could not be written before go with this one.
    const records = this.waiting.size === 0 ? given : given.map(record => {
      const change = this.waiting.get(record.id)
      return change ? this.private(recordSchema.parse(change(record))) : record
    })
    const since = (this.options.now?.() ?? new Date()).getTime() - SPENT_KEPT_MS
    const keptSpent = spent.filter(entry => Date.parse(entry.askedAt) >= since)
    const next = `${this.path}.next`
    await mkdir(dirname(this.path), { recursive: true })
    try {
      await writeFile(next, JSON.stringify({ version: 1, sounds: records, ...(keptSpent.length > 0 ? { spent: keptSpent } : {}) }), { mode: 0o600 })
      await rename(next, this.path)
    } catch (error) {
      await rm(next, { force: true })
      throw error
    }
    this.records = records
    this.spent = keptSpent
    this.waiting.clear()
    this.wordsInFile = records.some(record => record.words !== undefined)
  }
}

/** What records that go cost, by account and when each was asked for alone. */
function spentOf(records: readonly SoundRecord[]): Spent[] {
  return records.filter(record => record.cost > 0)
    .map(record => ({ accountId: record.accountId, askedAt: record.askedAt, cost: record.cost, ...(record.state === 'making' ? { id: record.id } : {}) }))
}
