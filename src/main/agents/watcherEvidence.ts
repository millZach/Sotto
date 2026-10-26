import { createHash } from 'node:crypto'
import type { AgentThread } from '../../shared/agents'
import { GIT_PULL_REQUEST_LINKS_MAX, pullRequestKey } from '../../shared/gitPullRequests'
import { watcherEvidenceSchema, type WatcherEvidence, type WatcherThreadTarget } from '../../shared/watcher'

/**
 * Digests already made of short JSON, by that JSON. Every pass asks again for the same IDs and scopes of every watched
 * thread (#1331); a digest is a function of the JSON alone, so a known one is the same digest. Long JSON is hashed each time.
 */
const digests = new Map<string, string>()
const DIGESTS_MAX = 4_096
const DIGEST_JSON_MAX = 1_024
export function observationDigest(value: unknown): string {
  const json = JSON.stringify(value)
  if (typeof json !== 'string' || json.length > DIGEST_JSON_MAX) return createHash('sha256').update(json).digest('hex')
  const known = digests.get(json)
  if (known !== undefined) return known
  const digest = createHash('sha256').update(json).digest('hex')
  digests.set(json, digest)
  if (digests.size > DIGESTS_MAX) digests.delete(digests.keys().next().value!)
  return digest
}
const evidenceIdentity = (slot: string, input: Omit<WatcherEvidence, 'id'>): string =>
  observationDigest([slot, input.target, { ...input, url: input.source === 'github' && input.url ? pullRequestKey(input.url) : input.url, observedAt: undefined, fetchedAt: undefined }])
/**
 * Target keys already built, by host and thread ID. Watcher asks for the same few keys thousands of times a second while
 * threads stream (#1331), and each is JSON of two strings, so the key is the same string whenever it is asked.
 */
const targetKeys = new Map<string, Map<string, string>>()
let targetKeyCount = 0
const TARGET_KEYS_MAX = 10_000
export function targetKey(target: WatcherThreadTarget): string {
  const hostId: unknown = target.hostId, threadId: unknown = target.threadId
  if (typeof hostId !== 'string' || typeof threadId !== 'string') return JSON.stringify([hostId, threadId])
  let byThread = targetKeys.get(hostId)
  const known = byThread?.get(threadId)
  if (known !== undefined) return known
  if (targetKeyCount >= TARGET_KEYS_MAX) { targetKeys.clear(); targetKeyCount = 0; byThread = undefined }
  const key = JSON.stringify([hostId, threadId])
  if (!byThread) targetKeys.set(hostId, byThread = new Map())
  byThread.set(threadId, key); targetKeyCount++
  return key
}
export interface PullRequestObservation {
  url: string; observedAt: string; head: string | null; state?: 'open' | 'closed' | 'merged'
  availability: 'available' | 'unavailable'; reason?: 'read-failed' | 'rate-limited'
  checks?: 'passed' | 'failed' | 'pending' | 'unknown'; checksObservedAt?: string; checkCount?: number; reviewApproved?: boolean
  autoMerge?: boolean
  /** Whether GitHub says the branch conflicts with its base; absent when it has not worked that out. */
  conflicting?: boolean
  /** Whether the review decision asks for changes. */
  changesRequested?: boolean
  /** Babysitting's text-free fingerprint of the comment, review and review-thread counts and newest edits (ADR-0061). */
  remarks?: string
  /** Whether every check the base branch requires passed on `head`, as babysitting reads it (ADR-0061). */
  requiredPassed?: boolean
}
/**
 * What a pull request says that needs Watcher (#1190), beyond the evidence it keeps: a conflict, a review asking for
 * changes, its required checks passing on a head, and how many times its comments or reviews moved since Sotto first read
 * them. In memory only, like evidence; `observedAt` keeps a late read from undoing a newer one.
 */
interface PullRequestAttention { conflicting?: boolean; changesRequested?: boolean; remarks?: string; remarksMoved: number; requiredPassedHead?: string; observedAt: string }
/** One thing a pull request says that needs Watcher, and the key that tells it from what Watcher was told before. */
export type WatcherAttentionKind = 'checks-failed' | 'checks-passed' | 'required-passed' | 'merged' | 'closed' | 'approved' | 'changes-requested' | 'conflicting' | 'remarks'
/** `returns` counts how often the fact came back after it was gone, so checks that fail again on a commit are a new fact. */
export interface WatcherAttentionFact { readonly pr: string; readonly kind: WatcherAttentionKind; readonly key: string; readonly returns: number }
/** The kinds evidence does not hold, which an evidence event compares beside its facts. */
const BESIDE_EVIDENCE: ReadonlySet<WatcherAttentionKind> = new Set(['required-passed', 'changes-requested', 'conflicting', 'remarks'])
export interface CheckpointObservation {
  threadId: string; checkpointId: string; observedAt: string; turnId?: string; changedFiles?: number
  availability: 'available' | 'unavailable' | 'unsupported'; reason?: 'capture-unavailable' | 'shared-checkout' | 'unsupported'
}
const EVIDENCE_CACHE_MAX = 300 // Fifty linked PRs can each supply five independent facts, plus local facts.
const EVIDENCE_PROJECTION_MAX = 100
/** A closed pull request read as open again this soon after Sotto saw it close is an older answer, and is held (#1146). */
export const WATCHER_STATE_FLIP_MS = 10 * 60_000
/** Merged and closed: what a pull request says after either is no news, and either is told once (#1146). */
const ENDED_KINDS: ReadonlySet<WatcherAttentionKind> = new Set(['merged', 'closed'])
/**
 * What Sotto has seen of a pull request's state while it ran, whichever read said it, this host's or a paired one's:
 * whether it first met it as a thread's link already merged or closed, whose merge or close is then no news, whether any
 * read said it merged, the state the latest read left it in, and when it saw it close. In memory only, as attention is.
 */
interface PullRequestLife { linkedEnded?: true; merged?: true; state?: NonNullable<PullRequestObservation['state']>; closedAt?: number }

/** Bounded in-memory facts only. Never keep raw errors, file paths, tool inputs, output or review bodies. */
export class WatcherEvidenceStore {
  private readonly entries = new Map<string, Map<string, WatcherEvidence>>()
  private readonly attending = new Map<string, Map<string, PullRequestAttention>>()
  /**
   * Each attention fact of a thread, whether it holds now and how often it came back after it was gone (#1190). In memory
   * only: after a restart a fact is first seen again, so what Watcher was told before is not told again for it.
   */
  private readonly returning = new Map<string, Map<string, { returns: number; present: boolean }>>()
  /**
   * When Sotto first saw each pull request's checks pass on the commit they passed on, by its checks slot (#1274): a
   * read only refreshes the time a fact was seen, so the time it began is kept here, for Watcher's merge queue. In memory
   * only: after a restart a pass counts from Sotto's first read of it.
   */
  private readonly passing = new Map<string, Map<string, { head: string | undefined; since: string }>>()
  /** The thread keys written since `removeMissing` last ran, which the next run may have to let go of. */
  private readonly written = new Set<string>()
  /** Each pull request's life by thread and pull request key (#1146): whether its merge or close is news, and its flips. */
  private readonly lives = new Map<string, Map<string, PullRequestLife>>()
  constructor(private readonly now: () => number = Date.now) {}
  put(slot: string, input: Omit<WatcherEvidence, 'id'>): boolean {
    const id = evidenceIdentity(slot, input)
    const parsed = watcherEvidenceSchema.safeParse({ ...input, id })
    if (!parsed.success) return false
    const item = parsed.data
    const key = targetKey(item.target), entries = this.entries.get(key) ?? new Map<string, WatcherEvidence>()
    const previous = entries.get(slot)
    if (slot.endsWith(':checks')) this.notePassing(key, slot, item, previous)
    // Clock-only refreshes preserve ordering; only a real change becomes a recent fact.
    if (previous?.id !== id) entries.delete(slot)
    entries.set(slot, item)
    while (entries.size > EVIDENCE_CACHE_MAX) entries.delete(entries.keys().next().value!)
    this.entries.set(key, entries)
    this.written.add(key)
    return previous?.id !== id
  }
  /** `key` is the target's key, when the caller has already built it: the room reads every target's evidence on every publish. */
  read(target: WatcherThreadTarget, connected = true, now = Date.now(), key = targetKey(target)): WatcherEvidence[] {
    const entries = this.entries.get(key)
    return [...entries?.entries() ?? []].slice(-EVIDENCE_PROJECTION_MAX).map(([slot, item]) => {
      const prefix = slot.startsWith('host:github:') ? 'host:github:' : 'pr:'
      const unread = item.source === 'github' && item.url ? entries?.get(prefix + pullRequestKey(item.url)) : undefined
      return { ...item,
        ...connected ? (['github', 'working-copy'].includes(item.source) && now - Date.parse(item.observedAt) > 5 * 60_000 ? { freshness: 'stale' as const } : {})
          : { freshness: 'stale' as const, availability: 'unavailable' as const, reason: 'disconnected' as const },
        ...connected && unread?.availability === 'unavailable' && (unread.reason === 'read-failed' || unread.reason === 'rate-limited') ? { freshness: 'stale' as const, availability: 'unavailable' as const, ...(unread.reason ? { reason: unread.reason } : {}) } : {},
      }
    })
  }
  private notePassing(key: string, slot: string, item: WatcherEvidence, previous: WatcherEvidence | undefined): void {
    const passing = this.passing.get(key) ?? new Map<string, { head: string | undefined; since: string }>()
    const kept = passing.get(slot)
    if (item.checksState !== 'passed') passing.delete(slot)
    else if (!kept || kept.head !== item.headId || previous?.checksState !== 'passed') passing.set(slot, { head: item.headId, since: item.observedAt })
    while (passing.size > EVIDENCE_CACHE_MAX) passing.delete(passing.keys().next().value!)
    if (passing.size) { this.passing.set(key, passing); this.written.add(key) } else this.passing.delete(key)
  }
  /**
   * Since when a pull request's checks have passed on the commit it is on, as Sotto first saw them pass, or undefined
   * while they have not: what its evidence says now decides, so a pass a newer head or a failing read ended is gone.
   */
  checksPassedSince(target: WatcherThreadTarget, url: string): string | undefined {
    const key = targetKey(target), entries = this.entries.get(key), link = pullRequestKey(url) ?? url
    for (const prefix of ['pr:', 'host:github:']) {
      const slot = `${prefix}${link}:checks`, item = entries?.get(slot), kept = this.passing.get(key)?.get(slot)
      if (item?.checksState === 'passed' && kept && kept.head === item.headId) return kept.since
    }
    return undefined
  }
  knownIdentities(target: WatcherThreadTarget): string[] {
    return [...this.entries.get(targetKey(target))?.values() ?? []]
      .filter(item => !(item.availability === 'unavailable' && item.reason === 'checks-unavailable')).map(item => item.id)
  }
  identities(target: WatcherThreadTarget): ReadonlySet<string> {
    return new Set([...this.entries.get(targetKey(target))?.values() ?? []].map(item => item.id))
  }
  /**
   * A digest of one side of a thread's facts: its pull requests' (link, state, checks, review, auto-merge), which wake
   * Watcher when they change, or its own (working copy, Git, checkpoints), which only ride with a turn's end. The
   * turn's own end is in neither: its news is the turn event.
   */
  digest(target: WatcherThreadTarget, side: 'pull-request' | 'local'): string {
    const facts = [...this.entries.get(targetKey(target))?.values() ?? []]
    if (side === 'local') return observationDigest(facts.filter(item => item.source !== 'github' && item.source !== 'native-turn').map(item => item.id).sort())
    // What a pull request says, not when it was last seen: a Git read that only sees the same link again changes nothing.
    return observationDigest(facts.filter(item => item.source === 'github')
      .map(item => { const { id, observedAt, ...said } = item; void id; void observedAt; return JSON.stringify(said) }).sort())
  }
  /**
   * The pull request facts that need Watcher (#1190): checks failed or passed on a head, its required checks passed on a
   * head, merged or closed, approved or asked for changes, a conflict, and each move of its comments or reviews. A fact here
   * that was not there before wakes Watcher; a pending check, a new head, a check count or auto-merge alone does not, and
   * rides with what does.
   */
  attentionFacts(target: WatcherThreadTarget): WatcherAttentionFact[] {
    const returning = this.returning.get(targetKey(target))
    return this.heldFacts(target).map(fact => {
      const returns = returning?.get(fact.key)?.returns ?? 0
      return returns ? { ...fact, key: JSON.stringify([fact.key, returns]), returns } : fact
    })
  }
  /**
   * Notes which attention facts hold now: one that comes back after it was gone counts a return. A merge or a close never
   * does, so a pull request that flips back to one is not told it twice (#1146).
   */
  private recount(target: WatcherThreadTarget): void {
    const key = targetKey(target), held = new Map(this.heldFacts(target).map(fact => [fact.key, fact.kind]))
    const seen = this.returning.get(key) ?? new Map<string, { returns: number; present: boolean }>()
    for (const [fact, entry] of seen) if (!held.has(fact)) entry.present = false
    for (const [fact, kind] of held) {
      const entry = seen.get(fact)
      if (!entry) seen.set(fact, { returns: 0, present: true })
      else if (!entry.present) { if (!ENDED_KINDS.has(kind)) entry.returns++; entry.present = true }
    }
    while (seen.size > 300) seen.delete(seen.keys().next().value!)
    if (seen.size) { this.returning.set(key, seen); this.written.add(key) } else this.returning.delete(key)
  }
  /**
   * The attention facts that hold now. A merged or closed pull request holds only its merge or close, and not that when
   * Sotto first met it as a link already so: a link to one merged long ago, and whatever its checks or review say after,
   * are no news (#1146).
   */
  private heldFacts(target: WatcherThreadTarget): WatcherAttentionFact[] {
    const facts: WatcherAttentionFact[] = [], key = targetKey(target), entries = this.entries.get(key)
    const add = (pr: string, kind: WatcherAttentionKind, detail = '') => facts.push({ pr, kind, key: JSON.stringify([pr, kind, detail]), returns: 0 })
    // Each pull request's state is its newest reading across this host's slot and a paired host's, a merge in either
    // being final: a slot left closed by an older read never keeps a reopened pull request ended.
    const newest = new Map<string, { state: NonNullable<WatcherEvidence['pullRequestState']>; at: number }>()
    for (const item of entries?.values() ?? []) if (item.source === 'github' && item.url && item.availability === 'available' && item.pullRequestState !== undefined) {
      const pr = pullRequestKey(item.url) ?? item.url, at = Date.parse(item.observedAt), kept = newest.get(pr)
      if (!kept || kept.state !== 'merged' && (item.pullRequestState === 'merged' || at >= kept.at)) newest.set(pr, { state: item.pullRequestState, at })
    }
    const ended = new Map<string, 'merged' | 'closed'>()
    for (const [pr, { state }] of newest) if (state !== 'open') ended.set(pr, state)
    const passed = new Set<string>(), heads = new Map<string, Set<string>>()
    for (const item of entries?.values() ?? []) {
      if (item.source !== 'github' || !item.url || item.availability !== 'available') continue
      const pr = pullRequestKey(item.url) ?? item.url
      if (ended.has(pr)) continue
      if (item.headId) heads.set(pr, (heads.get(pr) ?? new Set()).add(item.headId))
      if (item.checksState === 'failed' || item.checksState === 'passed') add(pr, `checks-${item.checksState}`, item.headId ?? '')
      if (item.checksState === 'passed') passed.add(JSON.stringify([pr, item.headId ?? '']))
      if (item.githubReviewApproved === true) add(pr, 'approved')
    }
    for (const [pr, state] of ended) if (!this.lives.get(key)?.get(pr)?.linkedEnded) add(pr, state)
    for (const [pr, said] of this.attending.get(key) ?? []) {
      if (ended.has(pr)) continue
      // Every check passing already says the required ones did.
      // Only on the commit the pull request is on now, as evidence last read it.
      const onHead = said.requiredPassedHead !== undefined && (!heads.get(pr)?.size || heads.get(pr)!.has(said.requiredPassedHead))
      if (onHead && !passed.has(JSON.stringify([pr, said.requiredPassedHead]))) add(pr, 'required-passed', said.requiredPassedHead!)
      if (said.conflicting) add(pr, 'conflicting')
      if (said.changesRequested) add(pr, 'changes-requested')
      if (said.remarksMoved) add(pr, 'remarks', String(said.remarksMoved))
    }
    return facts
  }
  /** Whether Sotto holds any read of this thread's pull requests: without one, what they say is unknown, not nothing. */
  readsPullRequests(target: WatcherThreadTarget): boolean {
    for (const item of this.entries.get(targetKey(target))?.values() ?? []) if (item.source === 'github') return true
    return false
  }
  attention(target: WatcherThreadTarget): Set<string> { return new Set(this.attentionFacts(target).map(fact => fact.key)) }
  /** Each linked pull request's attention facts, by pull request, for the words a wake-up carries. */
  attentionByPullRequest(target: WatcherThreadTarget): Map<string, Set<WatcherAttentionKind>> {
    const byPr = new Map<string, Set<WatcherAttentionKind>>()
    for (const fact of this.attentionFacts(target)) byPr.set(fact.pr, (byPr.get(fact.pr) ?? new Set()).add(fact.kind))
    return byPr
  }
  /** The facts evidence does not hold, so a change to them is a change too. */
  attentionIdentity(target: WatcherThreadTarget): string[] {
    return this.attentionFacts(target).filter(fact => BESIDE_EVIDENCE.has(fact.kind) || fact.returns > 0).map(fact => fact.key).sort()
  }
  removeMissing(targets: ReadonlySet<string>): void {
    for (const key of this.entries.keys()) if (!targets.has(key)) this.entries.delete(key)
    for (const key of this.attending.keys()) if (!targets.has(key)) this.attending.delete(key)
    for (const key of this.returning.keys()) if (!targets.has(key)) this.returning.delete(key)
    for (const key of this.passing.keys()) if (!targets.has(key)) this.passing.delete(key)
    for (const key of this.lives.keys()) if (!targets.has(key)) this.lives.delete(key)
    this.written.clear()
  }
  /**
   * What `removeMissing` would let go of, read only where it could find any (#925 step 5): the facts of each thread written
   * since it last ran, and of each of `moved`, the threads that have left the list since. Every other thread's facts were
   * kept by that last run, so its thread was listed then, and it still is.
   */
  removeMissingOf(moved: Iterable<string>, listed: (key: string) => boolean): void {
    for (const key of [...this.written, ...moved]) {
      if (listed(key)) continue
      this.entries.delete(key); this.attending.delete(key); this.returning.delete(key); this.passing.delete(key); this.lives.delete(key)
    }
    this.written.clear()
  }
  /** Every thread key the store holds anything for, for verifying mode. */
  heldKeys(): Set<string> { return new Set([...this.entries.keys(), ...this.attending.keys(), ...this.returning.keys(), ...this.passing.keys(), ...this.lives.keys()]) }
  observeThread(thread: AgentThread, target: WatcherThreadTarget, observedAt: string): boolean {
    let changed = false
    const turn = thread.lastTurn
    if (thread.status !== 'running' && turn && (turn.status === 'completed' || turn.status === 'failed')) {
      changed = this.put('turn', { target, source: 'native-turn', observedAt, freshness: 'fresh', availability: 'available',
        turnId: turn.id, fact: turn.status === 'failed' ? 'turn-failed' : 'turn-finished',
        ...(turn.status === 'failed' ? { failureCategory: 'provider-turn-failed' as const } : {}) }) || changed
    }
    const git = thread.worktree?.git
    if (git) changed = this.put('working-copy', { target, source: 'working-copy', observedAt: git.readAt,
      freshness: 'fresh', availability: 'available', fact: 'files-changed', branch: git.branch,
      changedFiles: git.changedFiles, insertions: git.insertions, deletions: git.deletions, ahead: git.ahead, behind: git.behind, fetchedAt: git.fetchedAt }) || changed
    // The branch's own pull request is the Git read's. A stored link's state is only what GitHub said when it was last
    // asked, so it never stands in for that read: read as one, a link left open flipped a merged branch's (#1146).
    const branch = git?.pullRequest ?? undefined, branchKey = branch ? pullRequestKey(branch.url) : undefined
    const prs = [...(thread.pullRequests ?? []).filter(pr => !branchKey || pullRequestKey(pr.url) !== branchKey), ...branch ? [branch] : []]
    const links = new Set(prs.map(pr => pullRequestKey(pr.url)))
    const entries = this.entries.get(targetKey(target))
    // Only a connected owning roster calls this. A bounded fact projection alone never removes a link.
    for (const slot of entries?.keys() ?? []) {
      const prefix = slot.startsWith('host:github:') ? 'host:github:' : slot.startsWith('pr:') ? 'pr:' : undefined
      if (prefix && ![...links].some(link => slot === prefix + link || slot.startsWith(prefix + link + ':'))) { entries!.delete(slot); changed = true }
    }
    const attending = this.attending.get(targetKey(target))
    for (const pr of attending?.keys() ?? []) if (!links.has(pr)) attending!.delete(pr)
    const lives = this.lives.get(targetKey(target))
    for (const pr of lives?.keys() ?? []) if (!links.has(pr)) lives!.delete(pr)
    for (const pr of prs) {
      const slot = `pr:${pullRequestKey(pr.url)}`
      const branchObserved = pr === branch
      // A link made to a pull request already merged or closed, as a coordinator links its earlier work, is no news.
      if (!branchObserved && pr.state !== 'open' && !lives?.has(pullRequestKey(pr.url) ?? pr.url)) this.life(target, pr.url).linkedEnded = true
      // A link or Git state read observes association/state, not checks, approval or auto-merge.
      const state = entries?.get(slot + ':state')
      // A newer Git read refreshes what it can see: a state that differs from GitHub's, or a link GitHub has not read. A
      // stored link only introduces itself, and never replaces GitHub's own read of it.
      const refreshes = branchObserved && (state ? state.pullRequestState !== pr.state : entries?.get(slot)?.availability !== 'available')
      if (!entries?.has(slot) || refreshes && Date.parse(git?.readAt ?? '') > (state ? Date.parse(state.observedAt) : -Infinity)) {
        changed = this.pullRequest(target, { url: pr.url, head: entries?.get(slot)?.headId ?? null,
          observedAt: git?.readAt ?? ('linkedAt' in pr && typeof pr.linkedAt === 'string' ? pr.linkedAt : observedAt),
          availability: branchObserved ? 'available' : 'unavailable', state: pr.state }) || changed
      }
    }
    if (changed) this.recount(target)
    return changed
  }
  pullRequest(target: WatcherThreadTarget, read: PullRequestObservation): boolean {
    const attended = read.availability === 'available' && this.attend(target, read)
    const changed = this.observePullRequest(target, read, 'pr:') || attended
    if (changed) this.recount(target)
    return changed
  }
  /**
   * Keeps what a read says of a conflict, a review asking for changes, its required checks and its remarks. Whether any of
   * that changed. A read older than the one kept says nothing new, as evidence ignores a late answer for an earlier head.
   */
  private attend(target: WatcherThreadTarget, read: PullRequestObservation): boolean {
    if (read.conflicting === undefined && read.changesRequested === undefined && read.remarks === undefined && read.requiredPassed === undefined) return false
    const key = targetKey(target), pr = pullRequestKey(read.url) ?? read.url
    const byPr = this.attending.get(key) ?? new Map<string, PullRequestAttention>()
    const before = byPr.get(pr) ?? { remarksMoved: 0, observedAt: read.observedAt }, after = { ...before, observedAt: read.observedAt }
    if (Date.parse(read.observedAt) < Date.parse(before.observedAt)) return false
    if (read.conflicting !== undefined) after.conflicting = read.conflicting
    if (read.changesRequested !== undefined) after.changesRequested = read.changesRequested
    if (read.requiredPassed !== undefined) { if (read.requiredPassed && read.head) after.requiredPassedHead = read.head; else delete after.requiredPassedHead }
    // A read of another commit, whatever it says of its checks, ends the pass of the one before.
    else if (read.head && after.requiredPassedHead !== undefined && after.requiredPassedHead !== read.head) delete after.requiredPassedHead
    // The first read of its remarks is where they stand, not news; each move after it is.
    if (read.remarks !== undefined) { if (before.remarks !== undefined && before.remarks !== read.remarks) after.remarksMoved++; after.remarks = read.remarks }
    byPr.set(pr, after)
    while (byPr.size > 50) byPr.delete(byPr.keys().next().value!)
    this.attending.set(key, byPr)
    this.written.add(key)
    return after.conflicting !== before.conflicting || after.changesRequested !== before.changesRequested || after.remarksMoved !== before.remarksMoved
      || after.requiredPassedHead !== before.requiredPassedHead
  }
  /** Paired observations share fact replacement rules, but shell link summaries cannot erase owning-host facts. */
  paired(fact: WatcherEvidence): boolean {
    const changed = this.pairedFact(fact)
    if (changed && fact.source === 'github') this.recount(fact.target)
    return changed
  }
  private pairedFact(fact: WatcherEvidence): boolean {
    if (fact.source === 'github' && fact.url) return this.observePullRequest(fact.target, {
      url: fact.url, head: fact.headId ?? null, observedAt: fact.observedAt,
      availability: fact.availability === 'available' ? 'available' : 'unavailable',
      ...(fact.reason === 'read-failed' || fact.reason === 'rate-limited' ? { reason: fact.reason } : {}),
      ...(fact.pullRequestState !== undefined ? { state: fact.pullRequestState } : {}),
      ...(fact.checksState !== undefined ? { checks: fact.checksState } : {}),
      ...(fact.checkCount !== undefined ? { checkCount: fact.checkCount } : {}),
      ...(fact.githubReviewApproved !== undefined ? { reviewApproved: fact.githubReviewApproved } : {}),
      ...(fact.githubAutoMergeEnabled !== undefined ? { autoMerge: fact.githubAutoMergeEnabled } : {}),
    }, 'host:github:')
    const { id: _id, ...input } = fact; void _id
    return this.put(`host:${fact.source}:${fact.referenceId ?? fact.url ?? ''}`, input)
  }
  private observePullRequest(target: WatcherThreadTarget, read: PullRequestObservation, prefix: string): boolean {
    const slot = prefix + pullRequestKey(read.url), entries = this.entries.get(targetKey(target))
    const previous = entries?.get(slot), available = read.availability === 'available'
    // Read before a new head clears the pull request's facts: a new commit never unmerges it.
    const stateBefore = entries?.get(slot + ':state')?.pullRequestState
    const head = available ? read.head ?? undefined : previous?.headId ?? read.head ?? undefined
    // A late answer for an earlier head cannot replace the head a newer read established.
    if (previous && previous.headId !== head && Date.parse(previous.observedAt) > Date.parse(read.observedAt)) return false
    let changed = false
    if (available && previous?.headId !== head) {
      for (const key of entries?.keys() ?? []) if (key.startsWith(slot + ':')) { entries!.delete(key); changed = true }
    }
    const put = (key: string, input: Omit<WatcherEvidence, 'id'>) => {
      const prior = this.entries.get(targetKey(target))?.get(key)
      if (prior && prior.headId === input.headId && Date.parse(prior.observedAt) > Date.parse(input.observedAt)) return
      changed = this.put(key, input) || changed
    }
    const common = { target, source: 'github' as const, observedAt: read.observedAt, freshness: 'fresh' as const,
      availability: read.availability, url: read.url, ...(head ? { headId: head } : {}) }
    if (available) {
      if (read.checks !== undefined) put(slot + ':checks', { ...common, observedAt: read.checksObservedAt ?? read.observedAt,
        fact: read.checks === 'failed' ? 'checks-failed' : read.checks === 'passed' ? 'checks-passed' : 'pull-request-observed',
        checksState: read.checks, ...(read.checks === 'unknown' ? { reason: 'checks-unavailable' as const } : {}),
        ...(read.checkCount !== undefined ? { checkCount: read.checkCount } : {}) })
      const said = this.stateRead(target, read, stateBefore, !this.entries.get(targetKey(target))?.has(slot + ':state'))
      if (said !== undefined) put(slot + ':state', { ...common,
        fact: said === 'merged' ? 'merge-observed' : 'pull-request-observed', pullRequestState: said })
      if (head && read.reviewApproved !== undefined) put(slot + ':review', { ...common,
        fact: read.reviewApproved ? 'review-approved' : 'pull-request-observed', githubReviewApproved: read.reviewApproved })
      if (head && read.autoMerge !== undefined) put(slot + ':auto-merge', { ...common,
        fact: read.autoMerge ? 'auto-merge-observed' : 'pull-request-observed', githubAutoMergeEnabled: read.autoMerge })
    }
    put(slot, { ...common, fact: 'pull-request-observed', freshness: available ? 'fresh' : read.reason ? 'stale' : 'unknown',
      ...(read.reason ? { reason: read.reason } : !available ? { reason: 'checks-unavailable' as const } : {}) })
    return changed
  }
  /**
   * The state a read leaves a pull request in (#1146). Merged is final, since GitHub never unmerges, so a read that says
   * otherwise is an older answer, from this host or a paired one, and a new commit's read that says nothing of its state
   * keeps it merged (`lost`: the new head cleared the state). A read that says open within WATCHER_STATE_FLIP_MS of Sotto
   * seeing it close, through either slot, is an older answer too.
   */
  private stateRead(target: WatcherThreadTarget, read: PullRequestObservation, before: WatcherEvidence['pullRequestState'], lost: boolean): PullRequestObservation['state'] {
    const life = this.life(target, read.url), now = this.now()
    if (read.state === undefined) return life.merged && lost ? 'merged' : undefined
    const state = before === 'merged' || life.merged ? 'merged'
      : (before === 'closed' || life.state === 'closed') && read.state === 'open' && life.closedAt !== undefined && now - life.closedAt < WATCHER_STATE_FLIP_MS ? 'closed' : read.state
    if (state === 'merged') life.merged = true
    if (state === 'closed' && before !== 'closed' && life.state !== 'closed') life.closedAt = now
    life.state = state
    return state
  }
  private life(target: WatcherThreadTarget, url: string): PullRequestLife {
    const key = targetKey(target), pr = pullRequestKey(url) ?? url, lives = this.lives.get(key) ?? new Map<string, PullRequestLife>()
    let life = lives.get(pr)
    // Every link a thread keeps, and its branch's own.
    if (!life) { lives.set(pr, life = {}); while (lives.size > GIT_PULL_REQUEST_LINKS_MAX + 1) lives.delete(lives.keys().next().value!) }
    // A new thread's lives are written as its facts are, so `removeMissingOf` lets go of them with the thread.
    if (!this.lives.has(key)) { this.lives.set(key, lives); this.written.add(key) }
    return life
  }
  checkpointIdentity(target: WatcherThreadTarget, read: CheckpointObservation): string {
    return evidenceIdentity('checkpoint', this.checkpointFact(target, read))
  }
  checkpoint(target: WatcherThreadTarget, read: CheckpointObservation): boolean {
    return this.put('checkpoint', this.checkpointFact(target, read))
  }
  private checkpointFact(target: WatcherThreadTarget, read: CheckpointObservation): Omit<WatcherEvidence, 'id'> {
    return { target, source: 'checkpoint', observedAt: read.observedAt, freshness: 'fresh',
      availability: read.availability, fact: 'files-changed', checkpointId: read.checkpointId,
      ...(read.turnId ? { turnId: read.turnId } : {}), ...(read.changedFiles !== undefined && read.availability === 'available' ? { changedFiles: read.changedFiles } : {}),
      ...(read.reason ? { reason: read.reason } : {}) }
  }
}
