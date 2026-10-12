import type { AgentCommand, AgentHostSnapshot } from '../../shared/agents'
import type { AgentHostCommand } from './host'

/** Main-owned capability. This object never crosses IPC or a socket. */
export interface WatcherCommandOrigin {
  readonly operationId?: string
  readonly guard: () => void
}
export type WatcherCommand = Extract<AgentCommand, { type: 'create-thread' | 'manual-send' | 'queue-followup' | 'steer' | 'interrupt' | 'settle-thread' }>
export interface WatcherControlHooks {
  userCommand(command: AgentCommand, threadId: string | undefined, answersQuestion: boolean): void
  beforeDispatch(command: AgentHostCommand, draftId: string | undefined, origin?: WatcherCommandOrigin): AgentHostCommand
  observe(snapshot: AgentHostSnapshot, knownUserMessages: ReadonlySet<string>): void
  guardOperation(operationId: string): void
  preserveUserQueue(threadId: string): boolean
}
