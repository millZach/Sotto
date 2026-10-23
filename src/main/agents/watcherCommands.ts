import type { WatcherPhoneOrigin } from '../../shared/watcherPhone'
import type { AgentCommand, AgentHostSnapshot } from '../../shared/agents'
import type { AgentHostCommand } from './host'
import type { WatcherEvent } from '../../shared/watcherNews'
import type { CheckpointObservation, PullRequestObservation } from './watcherEvidence'
import type { HiddenWakeUpOutcome } from './hiddenWakeUp'

/** Main-owned capability. This object never crosses IPC or a socket. */
export interface WatcherCommandOrigin {
  readonly phoneOrigin?: WatcherPhoneOrigin
  readonly operationId?: string
  /** The user's explicit phone card answer; its private writer guard is not automation. */
  readonly userAnswer?: true
  /** Setup the user asked for in Watcher's room, such as its model or permissions; it is not automation either. */
  readonly userSetup?: true
  readonly guard: () => void
}
export type WatcherCommand = Extract<AgentCommand, { type: 'create-thread' | 'manual-send' | 'queue-followup' | 'steer' | 'interrupt' | 'settle-thread' }>
export interface WatcherControlHooks {
  userCommand(command: AgentCommand, threadId: string | undefined, answersQuestion: boolean): void
  beforeDispatch(command: AgentHostCommand, draftId: string | undefined, origin?: WatcherCommandOrigin): AgentHostCommand
  /** A provider accepted the persisted action, or could have written it. Never called for an unsaved intent. */
  dispatched?(command: AgentHostCommand): void
  /** Clear unproven native-write candidates when an intent or dispatch definitively fails. */
  dispatchAborted?(command: AgentHostCommand): void
  /** Whether the last message sent to Watcher's thread was one of Sotto's wake-ups; undefined when this run sent it none. */
  lastSendWasWakeUp?(threadId: string): boolean | undefined
  /** `knownUserMessages` holds the messages Sotto itself queued or delivered: only asked of a head that may be a takeover. */
  observe(snapshot: AgentHostSnapshot, knownUserMessages: Pick<ReadonlySet<string>, 'has'>): void
  /** These operations' queued items failed to send. Their items may already be gone, so this is the only word of it. */
  queueFailed?(operationIds: ReadonlySet<string>): void
  guardOperation(operationId: string): void
  preserveUserQueue(threadId: string): boolean
  /** Whether a prompt revision sent to a thread on this computer is one of Watcher's own sends (#1222). */
  ownsDraft?(threadId: string, draftId: string): boolean
  watchedThreadIds?(): string[]
  /** Whether each queued event may still go, answered in one pass that reads the snapshot and the record once. */
  wakeDueAll?(events: readonly WatcherEvent[]): boolean[]
  wakeReady?(): boolean
  /** Watcher's hidden wake-up left its queue with this outcome, holding these events (hiddenWakeUp.ts). */
  wakeUpSettled?(events: readonly WatcherEvent[], outcome: HiddenWakeUpOutcome): void
  pullRequestObserved?(read: PullRequestObservation): void
  /**
   * What Sotto adds to a wake-up's news as it goes (#1190): the start of a finished turn's reply and what a pull request
   * now says, read once for the whole note from the threads as they stand. Never saved with the news.
   */
  newsDetail?(): (event: WatcherEvent) => string | undefined
  /** How long a finish held for its work was held before it went by itself, while its thread sits idle (#1263). */
  newsHeld?(): (event: WatcherEvent) => number | undefined
  /** What a wake-up's note adds after Watcher's conversation was compacted, until Watcher reads its state back (#1189). */
  stateNote?(): string | undefined
  /** Keep local history changed: Watcher's kept words follow it at once (#1189). */
  privacyChanged?(): Promise<void>
  restoreCheckpoint?(read: CheckpointObservation): void
  checkpointObserved?(read: CheckpointObservation): void
}
