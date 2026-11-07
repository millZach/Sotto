import type { AgentActivity } from '../../shared/agentActivity'
import type { AgentHostSnapshot, AgentMessage, AgentState, AgentThread, AgentThreadDetail, AgentThreadDetailDelta, AgentThreadDetailUpdate } from '../../shared/agents'
import { applyAgentThreadDetailDelta, diffAgentThreadDetail, isAgentThreadDetailDelta, withAppendsWhole } from '../../shared/agentThreadDetail'
import { immutableActivities, isImmutableActivities } from './activitySnapshots'

/** What detail sends need from the coordinator, which owns the threads and how their messages are presented. */
export interface DetailSendsContext {
  state(): Pick<AgentState, 'host'>
  threadById(threadId: string): AgentThread | undefined
  /** The activity a detail carries beside a thread's messages, as the host decides it. */
  paneActivities(thread: AgentThread): readonly AgentActivity[] | undefined
  /** A thread's messages as a window shows them. */
  presentedMessages(thread: AgentThread): readonly AgentMessage[]
  /** The revision a thread's detail stands at (`DetailRevisions`). */
  revision(thread: AgentThread, activities: readonly AgentActivity[] | undefined): number
  /** Read at each diff, so a signature swapped in later is the one used. */
  certifiedActivitySignature(): (record: AgentActivity) => string
  /** Puts the preview markers on a history's images. */
  decorate(snapshot: AgentHostSnapshot): void
  /** Read at each use, as the coordinator reads it. */
  readonly dependencies: { readonly streamingPublishCost?: boolean }
}

/**
 * The thread details main sends its listeners, the window and each socket server, and what each was last sent: the
 * snapshot a delta is measured from and the revision it stands at. A listener is sent a delta from what it holds while a
 * thread changes, and the whole detail when no delta can say it. Which threads are shown, and how their messages read,
 * stay the coordinator's.
 */
export class DetailSends {
  /** Each detail listener, and whether it is sent appends (`AgentActivityAppend`) or every changed record whole. */
  private readonly detailListeners = new Map<(update: AgentThreadDetailUpdate) => void, { readonly appends: boolean }>()
  private readonly publishedDetail = new Map<string, number>()
  /**
   * The history each detail target was last sent, undecorated, to diff the next one against. Bounded by
   * the targets themselves: a thread that leaves the viewed set frees its snapshot on the next broadcast.
   */
  private readonly detailSnapshots = new Map<string, AgentThreadDetail>()

  constructor(private readonly context: DetailSendsContext) {}

  private get state(): ReturnType<DetailSendsContext['state']> { return this.context.state() }

  /** Whether anything listens for detail now. */
  get listening(): boolean { return this.detailListeners.size > 0 }
  /** Keeps what was sent only for the threads shown now. */
  keepOnly(targets: readonly string[]): void {
    for (const threadId of this.publishedDetail.keys()) if (!targets.includes(threadId)) this.publishedDetail.delete(threadId)
    for (const threadId of this.detailSnapshots.keys()) if (!targets.includes(threadId)) this.detailSnapshots.delete(threadId)
  }
  /** One thread goes out whole on the next send, as a message its listeners hold undecorated must. */
  forget(threadId: string): void { this.publishedDetail.delete(threadId); this.detailSnapshots.delete(threadId) }
  /** History privacy changed: every listener is sent whole details next, without the markers. */
  privacyChanged(): void {
    this.publishedDetail.clear()
    this.detailSnapshots.clear()
  }
  /** Lets go of every listener and what was sent, on dispose. */
  close(): void {
    this.detailListeners.clear()
    this.detailSnapshots.clear()
  }
  /**
   * One thread's history — its messages and the activity beside them — for a window looking at it.
   * Handing out a whole detail also resets what the deltas that follow are measured from: a window that
   * asked for this one holds exactly this revision, so the next delta is the one that follows it.
   *
   * Every other listener still holds the revision last broadcast. When the thread has moved on since, a
   * change still waiting in the coalescing window is sent to them first, measured from what they hold,
   * so the reset never leaves them a delta they cannot apply and a read by one client never sets off a
   * whole read by another.
   */
  threadDetail(threadId: string): AgentThreadDetail | null {
    const thread = this.state.host.threads.find(item => item.id === threadId)
    if (!thread) return null
    const pane = this.context.paneActivities(thread)
    const revision = this.context.revision(thread, pane)
    if (this.detailListeners.size && this.detailSnapshots.has(threadId) && this.publishedDetail.get(threadId) !== revision) {
      const update = this.detailUpdate(thread, revision, pane)
      if (update) this.emitDetail(threadId, update)
    }
    return this.wholeDetail(thread, revision, pane)
  }
  /** The whole of a thread's history at a revision, which becomes the base the next delta is measured from. */
  private wholeDetail(thread: AgentThread, revision: number, pane = this.context.paneActivities(thread)): AgentThreadDetail {
    const threadId = thread.id
    const presented = this.context.presentedMessages(thread)
    const messages = structuredClone([...presented])
    // Nothing decorates or edits an activity record on either side of the bridge, so the snapshot and the
    // detail share one copy of it. Messages cannot be shared: decoration rewrites their attachments.
    const activities = pane === undefined ? undefined : structuredClone(pane) as AgentActivity[]
    // The snapshot is the undecorated history: decoration is a fact about the preview store rather than
    // about the thread, and diffing decorated against live would report every image message as changed.
    this.detailSnapshots.set(threadId, { threadId, revision, messages: structuredClone([...presented]),
      ...(activities === undefined ? {} : { activities: this.context.dependencies.streamingPublishCost === true
        ? immutableActivities(pane!) : activities }) })
    this.publishedDetail.set(threadId, revision)
    this.context.decorate({ ...this.state.host, threads: [{ ...thread, messages }] })
    return { threadId, revision, messages, ...(activities === undefined ? {} : { activities }),
      ...(thread.earlierAvailable ? { earlierAvailable: true } : {}) }
  }
  /**
   * Hears every viewed thread's detail as it changes. `appends`: the listener applies `AgentActivityAppend`, so a record
   * whose output or text only grew is sent as the text it grew by. Only the main window's own stream asks for it; every
   * other listener, a socket server's among them, is sent every changed record whole.
   */
  subscribeThreadDetail(listener: (update: AgentThreadDetailUpdate) => void, options: { readonly appends?: boolean } = {}): () => void {
    this.detailListeners.set(listener, { appends: options.appends === true })
    return () => this.detailListeners.delete(listener)
  }
  /** Hands each detail listener `update`, every append in it as the record whole to one that is not sent appends. */
  private emitDetail(threadId: string, update: AgentThreadDetailUpdate): void {
    let whole: AgentThreadDetailUpdate | null | undefined
    for (const [listener, { appends }] of this.detailListeners) {
      if (appends || !isAgentThreadDetailDelta(update)) { listener(update); continue }
      if (whole === undefined) whole = withAppendsWhole(update, this.detailSnapshots.get(threadId)?.activities ?? [])
      // The snapshot the delta was applied to holds every record it appends to. Were one missing, the listener would miss
      // this update, its next delta would not follow, and it would read the thread whole, as after any update it missed.
      if (whole !== null) listener(whole)
    }
  }
  /**
   * Whether a thread whose detail a window holds has had an opening change: a newer message or activity
   * record at its end than the one the window was sent. Only the ends are compared, so a chunk added to a
   * message already sent is not one, and the check costs nothing like the diff the broadcast makes. The
   * workspace ahead of this sends at most two publishes a window, so this cuts a window short no more often.
   */
  watchedThreadOpened(): boolean {
    if (!this.detailListeners.size) return false
    for (const [threadId, held] of this.detailSnapshots) {
      const thread = this.context.threadById(threadId)
      if (!thread) continue
      if (thread.messages.at(-1)?.id !== held.messages.at(-1)?.id) return true
      const activities = this.context.paneActivities(thread)
      if (activities !== undefined && activities.at(-1)?.id !== held.activities?.at(-1)?.id) return true
    }
    return false
  }
  /** The delta from what this thread's window already holds, or the whole detail when no delta can say it. */
  detailUpdate(thread: AgentThread, revision: number, pane = this.context.paneActivities(thread)): AgentThreadDetailUpdate | null {
    const held = this.detailSnapshots.get(thread.id)
    if (held !== undefined) {
      const delta = diffAgentThreadDetail(held, { messages: this.context.presentedMessages(thread), activities: pane }, revision,
        this.context.dependencies.streamingPublishCost === true ? this.context.certifiedActivitySignature() : undefined)
      const advanced = delta === null ? null : applyAgentThreadDetailDelta(held, delta)
      if (delta !== null && advanced !== null) {
        // The pane's own records, when they are certified and in the order the delta reached: frozen, never edited, and the
        // records the next publish hands over, so its diff meets them by identity rather than by signature (#1248).
        if (this.context.dependencies.streamingPublishCost === true && advanced.activities && advanced.activities !== pane) advanced.activities = pane !== undefined
          && isImmutableActivities(pane) && pane.length === advanced.activities.length
          && pane.every((record, index) => record === advanced.activities![index] || record.id === advanced.activities![index]!.id)
          ? pane as AgentActivity[] : immutableActivities(advanced.activities)
        this.detailSnapshots.set(thread.id, advanced)
        this.publishedDetail.set(thread.id, revision)
        return this.decorateDetailDelta(thread, delta)
      }
    }
    return this.wholeDetail(thread, revision, pane)
  }
  /** A delta's whole messages carry the same preview markers a full detail's would; its appends carry text alone. */
  private decorateDetailDelta(thread: AgentThread, delta: AgentThreadDetailDelta): AgentThreadDetailDelta {
    const messageDeltas = delta.messageDeltas.map(item => 'appendText' in item ? item : { message: structuredClone(item.message) })
    const messages = messageDeltas.flatMap(item => 'appendText' in item ? [] : [item.message])
    if (messages.length > 0) this.context.decorate({ ...this.state.host, threads: [{ ...thread, messages }] })
    return { ...delta, messageDeltas }
  }
  /** Sends each target thread whose revision moved what changed since the revision its listeners hold. */
  send(targets: readonly string[]): void {
    for (const threadId of targets) {
      const thread = this.context.threadById(threadId)!
      // The pane's activity is read once and handed on: the host decides it a turn at a time, against every thread.
      const pane = this.context.paneActivities(thread)
      const revision = this.context.revision(thread, pane)
      if (this.publishedDetail.get(threadId) === revision) continue
      const update = this.detailUpdate(thread, revision, pane)
      if (update) this.emitDetail(threadId, update)
    }
  }
}
