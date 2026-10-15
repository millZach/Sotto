import type { WatcherPhoneOrigin } from '../../shared/watcherPhone'
import type { AgentCommand, AgentHostSnapshot } from '../../shared/agents'
import type { AgentHostCommand } from './host'
import type { WatcherEvent } from '../../shared/watcherNews'
import type { CheckpointObservation, PullRequestObservation } from './watcherEvidence'

/** Main-owned capability. This object never crosses IPC or a socket. */
export interface WatcherCommandOrigin {
  readonly phoneOrigin?: WatcherPhoneOrigin
  readonly operationId?: string
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
  observe(snapshot: AgentHostSnapshot, knownUserMessages: ReadonlySet<string>): void
  guardOperation(operationId: string): void
  preserveUserQueue(threadId: string): boolean
  watchedThreadIds?(): string[]
  wakeDue?(event: WatcherEvent): boolean
  wakeReady?(): boolean
  /** News whose wake-up was let go with its send unknown: forget it was told, so what is still true is told afresh. */
  forgetWakeEvents?(events: readonly WatcherEvent[]): void
  pullRequestObserved?(read: PullRequestObservation): void
  restoreCheckpoint?(read: CheckpointObservation): void
  checkpointObserved?(read: CheckpointObservation): void
}
