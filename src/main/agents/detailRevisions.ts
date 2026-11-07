import type { AgentActivity } from '../../shared/agentActivity'
import type { AgentMessage, AgentThread } from '../../shared/agents'
import { agentActivitySignature } from '../../shared/agentThreadDetail'
import { isImmutableActivities, isImmutableActivity } from './activitySnapshots'

/** What detail revisions need from the coordinator. */
export interface DetailRevisionsContext {
  /** Read at each use, as the coordinator reads it. */
  readonly dependencies: { readonly streamingPublishCost?: boolean }
  /** How long a message is as a detail shows it, when that can differ from its text. */
  shownLength(thread: AgentThread): ((message: AgentMessage) => number) | undefined
}

/**
 * The revision each shown thread's detail stands at, which moves exactly when its messages or the activity beside them do,
 * and what it was read from. A delta is measured from the revision a window holds, so this is what tells main whether a
 * thread has anything new to send. Built from identity and length rather than text, and, under the streaming cost gate,
 * from certified records by identity, so a streaming chunk costs one comparison rather than a signature of the history.
 */
export class DetailRevisions {
  /**
   * Per thread: the version of the messages last handed out (see `detailMessageKeys`), the signature of the activity beside
   * them, and the revision that stands for both.
   */
  private readonly activityDetailSignatures = new WeakMap<readonly AgentActivity[], string>()
  private readonly detailRevisions = new Map<string, { messages: number; activities: string; revision: number }>()
  private readonly certifiedDetailSignatures = new WeakMap<AgentActivity, string>()
  private readonly certifiedDetailRevisions = new Map<string, { messages: number; activities: readonly AgentActivity[]; revision: number }>()
  /**
   * Per thread: each message's ID and its text, shown and attachment lengths as the last revision read them, and a version
   * that moves whenever one of them did. A publish hands every message over as a new copy, so they are compared by value,
   * in place, rather than written into a history-sized signature on every broadcast. Kept and dropped with the revisions.
   */
  private readonly detailMessageKeys = new Map<string, { epoch: string; ids: string[]; lengths: number[]; version: number }>()
  private detailMessageVersions = 0
  /** Clients may retain a closed pane's detail. Releasing its words never resets their revision. */
  private readonly certifiedDetailCounters = new Map<string, number>()

  constructor(private readonly context: DetailRevisionsContext) {}

  /** Keeps the revisions only of the threads a window is shown now, as the detail snapshots are kept. */
  keepOnly(targets: readonly string[]): void {
    if (this.context.dependencies.streamingPublishCost === true) {
      for (const threadId of this.certifiedDetailRevisions.keys()) if (!targets.includes(threadId)) this.certifiedDetailRevisions.delete(threadId)
      for (const threadId of this.detailRevisions.keys()) if (!targets.includes(threadId)) this.detailRevisions.delete(threadId)
      for (const threadId of this.detailMessageKeys.keys()) if (!targets.includes(threadId)) this.detailMessageKeys.delete(threadId)
    }
  }
  /** History privacy changed: every window is sent whole details next, so what they were measured from goes. */
  privacyChanged(): void {
    if (this.context.dependencies.streamingPublishCost === true) { this.certifiedDetailRevisions.clear(); this.detailRevisions.clear(); this.detailMessageKeys.clear() }
  }
  /** Lets go of the certified records on dispose. */
  close(): void {
    this.certifiedDetailRevisions.clear()
    this.certifiedDetailCounters.clear()
  }
  /**
   * A revision that changes exactly when a thread's messages do. Built from identity and length rather
   * than the text itself: a streaming chunk must bump it without the cost of copying every message.
   */
  revision(thread: AgentThread, activities: readonly AgentActivity[] | undefined): number {
    const messages = this.detailMessagesVersion(thread)
    if (this.context.dependencies.streamingPublishCost === true && isImmutableActivities(activities)) {
      const held = this.certifiedDetailRevisions.get(thread.id)
      if (held && held.messages === messages && held.activities === activities) return held.revision
      if (held && held.messages === messages && held.activities.length === activities!.length
        && held.activities.every((record, index) => record === activities![index]
          || (record.id === activities![index]!.id && this.certifiedActivitySignature(record) === this.certifiedActivitySignature(activities![index]!)))) {
        // The same records under new identities, as a store read gives them back: they stand for this revision from now
        // on, or every later publish would compare each of them by signature again, for every long thread on screen.
        this.certifiedDetailRevisions.set(thread.id, { ...held, activities: activities! })
        return held.revision
      }
      // Retain the legacy signature only across a certified/mutable transition. Ordinary certified
      // publishes compare the owned record identities, without building a signature at all.
      const legacy = this.detailRevisions.get(thread.id)
      const unchanged = !held && legacy?.messages === messages && legacy.activities === this.certifiedActivitiesSignature(activities!)
      const revision = (held?.revision ?? legacy?.revision ?? this.certifiedDetailCounters.get(thread.id) ?? 0) + (unchanged ? 0 : 1)
      this.certifiedDetailRevisions.set(thread.id, { messages, activities: activities!, revision })
      this.certifiedDetailCounters.set(thread.id, revision)
      return revision
    }
    const certified = this.certifiedDetailRevisions.get(thread.id)
    if (certified) {
      this.detailRevisions.set(thread.id, { revision: certified.revision, messages: certified.messages, activities: this.certifiedActivitiesSignature(certified.activities) })
      this.certifiedDetailRevisions.delete(thread.id)
    }
    let activitySignature = activities && this.activityDetailSignatures.get(activities)
    if (activitySignature === undefined) {
      activitySignature = (activities ?? []).map(record => `${record.id}:${agentActivitySignature(record)}`).join(',')
      if (activities && isImmutableActivities(activities)) this.activityDetailSignatures.set(activities, activitySignature)
    }
    const held = this.detailRevisions.get(thread.id)
    if (held && held.messages === messages && held.activities === activitySignature) return held.revision
    const revision = (held?.revision ?? (this.context.dependencies.streamingPublishCost === true ? this.certifiedDetailCounters.get(thread.id) : undefined) ?? 0) + 1
    this.detailRevisions.set(thread.id, { messages, activities: activitySignature, revision })
    if (this.context.dependencies.streamingPublishCost === true) this.certifiedDetailCounters.set(thread.id, revision)
    return revision
  }
  private certifiedActivitiesSignature(activities: readonly AgentActivity[]): string {
    return activities.map(record => `${record.id}:${this.certifiedActivitySignature(record)}`).join(',')
  }
  /**
   * The version of a thread's messages as a detail shows them: it moves exactly when a message's ID, text length, shown
   * length or attachment count moves, or the history epoch or message count does. The held key is brought up to date in
   * place, so an unchanged history makes nothing and a streaming chunk rewrites one number.
   */
  private detailMessagesVersion(thread: AgentThread): number {
    const shownLength = this.context.shownLength(thread)
    const messages = thread.messages, epoch = thread.historyEpoch ?? ''
    let key = this.detailMessageKeys.get(thread.id), changed = false
    if (!key || key.epoch !== epoch) { key = { epoch, ids: [], lengths: [], version: 0 }; this.detailMessageKeys.set(thread.id, key); changed = true }
    const { ids, lengths } = key
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index]!, at = index * 3
      const text = message.text.length, shown = shownLength ? shownLength(message) : text, attachments = message.attachments?.length ?? 0
      if (index >= ids.length) { ids.push(message.id); lengths.push(text, shown, attachments); changed = true; continue }
      if (ids[index] !== message.id) { ids[index] = message.id; changed = true }
      if (lengths[at] !== text) { lengths[at] = text; changed = true }
      if (lengths[at + 1] !== shown) { lengths[at + 1] = shown; changed = true }
      if (lengths[at + 2] !== attachments) { lengths[at + 2] = attachments; changed = true }
    }
    if (ids.length !== messages.length) { ids.length = messages.length; lengths.length = messages.length * 3; changed = true }
    if (changed) key.version = ++this.detailMessageVersions
    return key.version
  }
  /** One certified record's signature, kept by record; a diff of a certified pane compares by it. */
  certifiedActivitySignature = (record: AgentActivity): string => {
    if (!isImmutableActivity(record)) return agentActivitySignature(record)
    let signature = this.certifiedDetailSignatures.get(record)
    if (signature === undefined) { signature = agentActivitySignature(record); this.certifiedDetailSignatures.set(record, signature) }
    return signature
  }
}
