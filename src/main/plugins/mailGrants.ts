import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'

const grantSchema = z.object({ threadId: z.string().min(1).max(200), accountId: z.uuid(), at: z.iso.datetime() }).strict()
const fileSchema = z.object({ version: z.literal(1), grants: z.array(z.unknown()) })
/** One thread's leave to read one mail account, and when the user gave it. */
export type MailGrant = z.infer<typeof grantSchema>

/** More than anyone gives. Past it the oldest grant goes, and its thread asks again. */
const GRANTS_MAX = 500
/** How often, at most, the grants look at their threads while threads are changing. */
const CHECK_EVERY_MS = 2_000

/**
 * Mail grants (ADR-0205, decision 8): which threads the user has let read which mail accounts. A thread's first read
 * of a mail account waits on a card, and the user's yes is kept here, for that thread and that account, until the
 * user stops it, the thread is settled, archived or deleted, or the account is removed. It covers searching and
 * reading and nothing else. Only the user's answer on that card makes one.
 *
 * One small file in Sotto's data folder, so a thread does not ask again after Sotto restarts. It holds no mail and
 * no address: a thread's ID, an account's ID and a time. A file that cannot be read is no grants, so every thread
 * asks again; that errs towards asking.
 *
 * A grant that ends is gone from memory at once, whether or not the file could be written, and the file is written
 * again later. The one end that waits for the file is the user's own Stop, so it is never told a grant has ended
 * that a restart would bring back.
 */
export class MailGrants {
  private readonly path: string
  private grants: MailGrant[] | undefined
  private queue: Promise<unknown> = Promise.resolve()
  /** The file is behind what is held here. */
  private behind = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private closed = false
  constructor(directory: string, private readonly options: {
    /** Whether a thread is still open: not settled, archived or gone. */
    readonly open: (threadId: string) => boolean
    readonly now?: () => Date
    readonly checkEveryMs?: number
  }) {
    this.path = join(directory, 'plugin-mail-grants.json')
  }

  /** Whether the thread may read the account without asking. A thread that is no longer open holds no grant. */
  has(threadId: string, accountId: string): Promise<boolean> {
    return this.inTurn(async () => {
      const grants = await this.load()
      if (!grants.some(grant => grant.threadId === threadId && grant.accountId === accountId)) return false
      if (this.isOpen(threadId)) return true
      await this.keep(grants.filter(grant => grant.threadId !== threadId))
      return false
    })
  }

  /** Keeps the user's yes. It holds for this run of Sotto even where the file could not be written. */
  grant(threadId: string, accountId: string): Promise<void> {
    return this.inTurn(async () => {
      const grants = await this.load()
      if (grants.some(grant => grant.threadId === threadId && grant.accountId === accountId)) return
      await this.keep([...grants, { threadId, accountId, at: (this.options.now?.() ?? new Date()).toISOString() }].slice(-GRANTS_MAX))
    })
  }

  /**
   * The user's Stop: the thread asks again before it next reads the account. False when the file could not be
   * written; the grant then stands, so what the user is told is true after a restart too.
   */
  stop(threadId: string, accountId: string): Promise<boolean> {
    return this.inTurn(async () => {
      const grants = await this.load()
      const next = grants.filter(grant => grant.threadId !== threadId || grant.accountId !== accountId)
      if (next.length === grants.length) return true
      try { await this.write(next) } catch { return false }
      return true
    })
  }

  /** Deleted threads take their grants with them. */
  forgetThreads(threadIds: readonly string[]): Promise<void> {
    const gone = new Set(threadIds)
    return this.drop(grant => gone.has(grant.threadId))
  }

  /** A removed account takes its grants with it. */
  forgetAccount(accountId: string): Promise<void> {
    return this.drop(grant => grant.accountId === accountId)
  }

  list(): Promise<MailGrant[]> {
    return this.inTurn(async () => [...await this.load()])
  }

  /**
   * Told that some thread may have changed, which the coordinator's every publication is. With no grant held this
   * costs a comparison. With some, the grants look at their threads a moment later, and no more often than that: a
   * settled thread's grant ends, so a thread reopened later asks again.
   */
  noticed(): void {
    if (this.closed || this.timer || (this.grants !== undefined && this.grants.length === 0 && !this.behind)) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.endClosed().catch(() => undefined)
    }, this.options.checkEveryMs ?? CHECK_EVERY_MS)
    this.timer.unref?.()
  }

  /** Ends the grants of threads that are no longer open, and writes the file where it is behind. */
  endClosed(): Promise<void> {
    return this.inTurn(async () => {
      const grants = await this.load()
      const open = grants.filter(grant => this.isOpen(grant.threadId))
      if (open.length !== grants.length || this.behind) await this.keep(open)
    })
  }

  close(): void {
    this.closed = true
    clearTimeout(this.timer)
    this.timer = undefined
  }

  /** A thread that cannot be read is not taken for open. */
  private isOpen(threadId: string): boolean {
    try { return this.options.open(threadId) } catch { return false }
  }

  private drop(gone: (grant: MailGrant) => boolean): Promise<void> {
    return this.inTurn(async () => {
      const grants = await this.load()
      const next = grants.filter(grant => !gone(grant))
      if (next.length !== grants.length) await this.keep(next)
    })
  }

  /** Takes the grants as they now are, and writes them. A write that fails is tried again when threads next change. */
  private async keep(grants: MailGrant[]): Promise<void> {
    this.grants = grants
    try { await this.write(grants) } catch { this.behind = true }
  }

  private inTurn<Result>(change: () => Promise<Result>): Promise<Result> {
    const run = this.queue.catch(() => undefined).then(change)
    this.queue = run
    return run
  }

  private async load(): Promise<MailGrant[]> {
    if (this.grants) return this.grants
    let grants: MailGrant[] = []
    try {
      const parsed = fileSchema.safeParse(JSON.parse(await readFile(this.path, 'utf8')))
      if (parsed.success) grants = parsed.data.grants.flatMap(entry => { const grant = grantSchema.safeParse(entry); return grant.success ? [grant.data] : [] })
    } catch { /* No file, or one that cannot be read: no grants, and every thread asks again. */ }
    this.grants = grants
    return grants
  }

  private async write(grants: MailGrant[]): Promise<void> {
    const next = `${this.path}.next`
    await mkdir(dirname(this.path), { recursive: true })
    try {
      await writeFile(next, JSON.stringify({ version: 1, grants }), { mode: 0o600 })
      await rename(next, this.path)
    } catch (error) {
      await rm(next, { force: true })
      throw error
    }
    this.grants = grants
    this.behind = false
  }
}
