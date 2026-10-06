import { join } from 'node:path'
import { z } from 'zod'
import { AtomicJsonStore } from '../../storage/atomicJsonStore'

const sessionEntrySchema = z.object({
  id: z.string(), threadId: z.string(), threadTitle: z.string(),
  startedAt: z.number(), endedAt: z.number().nullable(), minutes: z.number().int().nonnegative(),
}).strict()
export type CloudUsageEntry = z.infer<typeof sessionEntrySchema>
/** A release or a deletion that did not finish; retried on service start and every minute until it does (ADR-0047). */
const cleanupEntrySchema = z.object({ kind: z.enum(['session', 'asset']), handle: z.string(), since: z.number() }).strict()
export type CloudCleanupEntry = z.infer<typeof cleanupEntrySchema>
const usageDocSchema = z.object({
  version: z.literal(1),
  sessions: z.array(sessionEntrySchema),
  /** Closed minutes per `YYYY-MM`, kept so eviction below never loses the month's count. Missing on an old doc. */
  months: z.record(z.string(), z.number().int().nonnegative()).optional(),
  cleanup: z.array(cleanupEntrySchema).optional(),
}).strict()
type UsageDoc = z.infer<typeof usageDocSchema>
/** Recent sessions are bounded for the settings list only; a closed session's minutes live on in `months` first. */
const MAX_SESSIONS = 200

/** `YYYY-MM` in the computer's own time zone, as `cloudIphoneStatusSchema.month` documents. */
export function monthKey(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

/** `cloud-iphone-usage.json` (ADR-0047): every billed cloud iPhone session, so the monthly cap can be read back cold. */
export class CloudUsageLedger {
  private readonly store: AtomicJsonStore<UsageDoc>
  private doc: UsageDoc = { version: 1, sessions: [], months: {}, cleanup: [] }
  constructor(directory: string) {
    this.store = new AtomicJsonStore(join(directory, 'cloud-iphone-usage.json'), usageDocSchema.parse, () => ({ version: 1, sessions: [], months: {}, cleanup: [] }))
  }
  async load(): Promise<void> {
    this.doc = await this.store.read()
    if (!this.doc.months) {
      // An old doc has no per-month total; the best it can give back is what its retained sessions still show.
      const months: Record<string, number> = {}
      for (const entry of this.doc.sessions) {
        if (entry.endedAt === null) continue
        const month = monthKey(entry.startedAt)
        months[month] = (months[month] ?? 0) + entry.minutes
      }
      this.doc.months = months
      await this.store.write(this.doc)
    }
  }
  /** Keeps every still-open session and, beyond that, only the most recent `MAX_SESSIONS` closed ones. */
  private evictSessions(): void {
    if (this.doc.sessions.length <= MAX_SESSIONS) return
    const open = this.doc.sessions.filter(entry => entry.endedAt === null)
    const closed = [...this.doc.sessions.filter(entry => entry.endedAt !== null)].sort((a, b) => a.startedAt - b.startedAt)
    const kept = closed.slice(-Math.max(0, MAX_SESSIONS - open.length))
    this.doc.sessions = [...kept, ...open].sort((a, b) => a.startedAt - b.startedAt)
  }
  async start(id: string, threadId: string, threadTitle: string, startedAt: number): Promise<void> {
    this.doc.sessions = [...this.doc.sessions, { id, threadId, threadTitle, startedAt, endedAt: null, minutes: 0 }]
    this.evictSessions()
    await this.store.write(this.doc)
  }
  async updateMinutes(id: string, minutes: number): Promise<void> {
    const entry = this.doc.sessions.find(entry => entry.id === id)
    if (!entry || entry.minutes === minutes) return
    entry.minutes = minutes
    await this.store.write(this.doc)
  }
  async end(id: string, endedAt: number, minutes: number): Promise<void> {
    const entry = this.doc.sessions.find(entry => entry.id === id)
    if (!entry) return
    entry.endedAt = endedAt; entry.minutes = minutes
    const month = monthKey(entry.startedAt)
    this.doc.months = { ...this.doc.months, [month]: (this.doc.months?.[month] ?? 0) + minutes }
    this.evictSessions()
    await this.store.write(this.doc)
  }
  /** Settings' recent list: newest first, from the retained session entries only. */
  recent(limit = 20): CloudUsageEntry[] { return [...this.doc.sessions].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit) }
  /** This local month's billed minutes: closed months' totals, which eviction never touches, plus any open session's elapsed time. */
  monthMinutes(now: number): number {
    const month = monthKey(now)
    const closed = this.doc.months?.[month] ?? 0
    const open = this.doc.sessions.filter(entry => entry.endedAt === null && monthKey(entry.startedAt) === month)
      .reduce((sum, entry) => sum + Math.max(entry.minutes, Math.ceil((now - entry.startedAt) / 60_000)), 0)
    return closed + open
  }
  /** A release or deletion `teardown` could not finish; retried by `CloudIphoneService.resumeCleanup`. */
  pendingCleanup(): CloudCleanupEntry[] { return [...(this.doc.cleanup ?? [])] }
  async addCleanup(kind: CloudCleanupEntry['kind'], handle: string, since: number): Promise<void> {
    const existing = this.doc.cleanup ?? []
    if (existing.some(entry => entry.kind === kind && entry.handle === handle)) return
    this.doc.cleanup = [...existing, { kind, handle, since }]
    await this.store.write(this.doc)
  }
  async removeCleanup(kind: CloudCleanupEntry['kind'], handle: string): Promise<void> {
    const existing = this.doc.cleanup ?? []
    if (!existing.some(entry => entry.kind === kind && entry.handle === handle)) return
    this.doc.cleanup = existing.filter(entry => !(entry.kind === kind && entry.handle === handle))
    await this.store.write(this.doc)
  }
}
