import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { SPENDING_CREDITS_MAX, type SpendingReport } from '../../shared/pluginAccountCopies'

/**
 * Shared spending for a Meshy or ElevenLabs account (ADR-0205): one monthly limit wherever the account is. Each
 * computer counts its own 3D models or sounds and adds what the others last said, so a host that cannot reach its
 * desktop keeps to what was left when it last heard, and no more. Used by the desktop and by a paired host alike;
 * neither imports Electron.
 *
 * A count is a whole number in the plugin's own unit: Meshy's credits, or US cents for ElevenLabs.
 */

/** A month by this computer's own clock, as `YYYY-MM`: the month starts on the 1st (Zach's pick for ticket 3). */
export function monthOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

/** The longest a timer waits in one go; a month is longer, so the wait is made of several. */
const TIMER_MAX_MS = 2 ** 31 - 1

/**
 * Calls `turned` each time a month starts by this computer's clock, until it is stopped. The wait is measured afresh
 * after each part of it, so a clock moved meanwhile is followed.
 */
export function everyMonthStart(turned: () => void, now: () => Date = () => new Date()): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const arm = (): void => {
    if (stopped) return
    const at = now()
    const next = new Date(at.getFullYear(), at.getMonth() + 1, 1)
    const wait = Math.max(1_000, Math.min(TIMER_MAX_MS, next.getTime() - at.getTime()))
    const month = monthOf(at)
    timer = setTimeout(() => {
      if (stopped) return
      if (monthOf(now()) !== month) turned()
      arm()
    }, wait)
    timer.unref?.()
  }
  arm()
  return () => { stopped = true; if (timer) clearTimeout(timer) }
}

/**
 * Numbers each report this computer makes in one run, so a reader can tell a newer report from an older one that
 * arrived after it: a push and an answer read from the socket together reach the reader in either order. A new run
 * starts a new session, which supersedes the one before it, since nothing of an earlier run can still be on its way.
 */
export class ReportRevisions {
  readonly session = randomUUID()
  private last = 0
  next(): number { return ++this.last }
}

const heardSchema = z.object({
  version: z.literal(1),
  /** By who said it: a desktop's client ID on a host, a host's identity on the desktop. Then by the account's ID. */
  heard: z.record(z.string().min(1).max(512), z.record(z.uuid(), z.object({
    month: z.string().regex(/^\d{4}-\d{2}$/u), credits: z.number().int().min(0).max(SPENDING_CREDITS_MAX), heardAt: z.iso.datetime(),
    session: z.uuid().optional(), revision: z.number().int().nonnegative().optional(),
  }).strict())),
}).strict()
type Heard = z.infer<typeof heardSchema>

/**
 * Where a computer's report for another month than its newest is kept: beside it, under its own sender key, so the
 * file stays one an older build reads and counts rightly, by the reader's month alone (Bug Bot on #2656, L1).
 */
const EARLIER = '#earlier'
const senderOf = (key: string): string => key.endsWith(EARLIER) ? key.slice(0, -EARLIER.length) : key

/** What one computer last said an account spent, and when it said it. */
export interface HeardReport { readonly from: string; readonly credits: number; readonly heardAt: string }

/** The record of what was heard cannot be read, or what was last heard could not be written down: nothing may be spent on it. */
export class SpendingUnknown extends Error {
  constructor() { super('PLUGIN_SPENDING_UNKNOWN') }
}

/**
 * What the other computers last said each account of one plugin spent, kept in a small file of this computer's data folder so
 * it lasts while they are away and across a restart. It holds counts and IDs, never a secret. Each computer's newest
 * report for an account is kept, and beside it its report for the month before. Computers' clocks turn the month at
 * different hours, so a computer already in the new month says 0 while this one is still in the old: what it said
 * for the old month still counts here until this one turns too (Bug Bot on #2656, L1). A report for any other month
 * than this computer's counts for nothing.
 *
 * A report is written down before it counts, and before whoever sent it is told it was taken: a write that fails says
 * so, and until a later one succeeds nothing is counted, so a restart can never find less than was acknowledged. Only
 * a file that is not there yet is an empty record. One that cannot be read is left as it is, and nothing is counted
 * or written over it until it can be read.
 */
export class HeardSpending {
  private kept: Heard | undefined
  /**
   * The accounts a write failed for since one for them succeeded: what is held of them may be behind what was said.
   * Only they wait; the rest are counted as they are (Bug Bot on #2656, L2).
   */
  private readonly behind = new Set<string>()
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly path: string, private readonly now: () => Date = () => new Date()) {}

  /**
   * Keeps what one computer said of some accounts; an account it did not name keeps what it said before, and a report
   * older than the one held from the same run is let go. Answers whether anything it said changed. Throws, keeping
   * nothing, when the record cannot be read or written.
   */
  hear(from: string, reports: readonly SpendingReport[]): Promise<boolean> {
    return this.inTurn(async () => {
      const heard = await this.read()
      const mine = { ...heard.heard[from] }
      const earlier = { ...heard.heard[from + EARLIER] }
      let changed = false
      for (const report of reports) {
        const before = mine[report.accountId]
        if (before?.session === report.session && before.revision !== undefined && before.revision >= report.revision) continue
        const entry = { month: report.month, credits: report.credits, heardAt: this.now().toISOString(), session: report.session, revision: report.revision }
        if (before && report.month < before.month) {
          // A report for the month before the newest, as one sent just before the month turned and heard after.
          if ((earlier[report.accountId]?.month ?? '') <= report.month) { earlier[report.accountId] = entry; changed = true }
          continue
        }
        if (before && report.month > before.month) earlier[report.accountId] = before
        if (before?.month !== report.month || before.credits !== report.credits) changed = true
        mine[report.accountId] = entry
      }
      const next: Heard['heard'] = { ...heard.heard, [from]: mine }
      if (Object.keys(earlier).length > 0) next[from + EARLIER] = earlier
      await this.write({ version: 1, heard: next }, reports.map(report => report.accountId))
      return changed
    })
  }

  /**
   * What every computer but `except` said the account spent in this computer's month. Throws `SpendingUnknown` when
   * the record cannot be read or is behind what was said, so nothing is taken for nothing spent.
   */
  total(accountId: string, except?: string): Promise<number> {
    return this.inTurn(async () => this.reports(await this.settled(accountId), accountId).filter(report => report.from !== except).reduce((sum, report) => sum + report.credits, 0))
  }

  /** Whether one computer has said anything of the account, in any month. Throws as `total` does. */
  has(from: string, accountId: string): Promise<boolean> {
    return this.inTurn(async () => (await this.settled(accountId)).heard[from]?.[accountId] !== undefined)
  }

  /**
   * Whether one computer has said what the account spent in this computer's month. A report only for another month
   * says nothing of this one: across the 1st, a computer that has not been heard from since is not taken to have spent
   * nothing (Bug Bot on #2656, N2). Throws as `total` does.
   */
  hasThisMonth(from: string, accountId: string): Promise<boolean> {
    return this.inTurn(async () => this.reports(await this.settled(accountId), accountId).some(report => report.from === from))
  }

  /** The computers that said anything of the account for this month, with what and when. */
  heardFrom(accountId: string): Promise<HeardReport[]> {
    return this.inTurn(async () => this.reports(await this.settled(accountId), accountId))
  }

  /** Each computer's report for this computer's month, its newest or the one before. */
  private reports(heard: Heard, accountId: string): HeardReport[] {
    const month = monthOf(this.now())
    return Object.entries(heard.heard).flatMap(([key, accounts]) => {
      const entry = accounts[accountId]
      return entry && entry.month === month ? [{ from: senderOf(key), credits: entry.credits, heardAt: entry.heardAt }] : []
    })
  }

  private async settled(accountId: string): Promise<Heard> {
    if (this.behind.has(accountId)) throw new SpendingUnknown()
    try { return await this.read() } catch { throw new SpendingUnknown() }
  }

  /** The record, read again on each call until a read succeeds. Only a file that is not there yet is an empty one. */
  private async read(): Promise<Heard> {
    if (this.kept) return this.kept
    let text: string
    try { text = await readFile(this.path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return (this.kept = { version: 1, heard: {} })
      throw error
    }
    return (this.kept = heardSchema.parse(JSON.parse(text)))
  }

  /**
   * Written down first, then held: a write that fails leaves what is held as the file has it, and marks the accounts
   * it was for behind until a write for them succeeds.
   */
  private async write(heard: Heard, accountIds: readonly string[]): Promise<void> {
    const next = `${this.path}.next`
    try {
      await mkdir(dirname(this.path), { recursive: true })
      await writeFile(next, JSON.stringify(heard), { mode: 0o600 })
      await rename(next, this.path)
    } catch (error) {
      for (const id of accountIds) this.behind.add(id)
      await rm(next, { force: true }).catch(() => undefined)
      throw error
    }
    this.kept = heard
    for (const id of accountIds) this.behind.delete(id)
  }

  private inTurn<Result>(run: () => Promise<Result>): Promise<Result> {
    const turn = this.queue.catch(() => undefined).then(run)
    this.queue = turn
    return turn
  }
}
