import type { ProviderId } from '../../shared/agents'
import type { FilesService } from '../files/service'

export interface CheckpointThread {
  /** Stable Sotto thread identity. Native adapters resolve their own exact binding. */
  threadId: string
  providerId: ProviderId
  /** A stable opaque native binding token; never renderer-visible. */
  bindingId: string
  userMessageIds: string[]
  busy: boolean
  running?: boolean
  rollbackSupported: boolean
  unsupportedReason?: string
}
export interface CheckpointDependencies {
  report?: (message: string) => void
  historyEnabled?: () => boolean
  now?: () => number
  maxBytes?: number
  files: FilesService
  directory: string
  /** `historyOnly` asks for the thread's identity, history and running state alone; `busy` is then false unchecked. */
  resolveThread(threadId: string, options?: { mutationHeld?: boolean; historyOnly?: boolean }): Promise<CheckpointThread | null>
  /** Holds the checkout stable while reading a turn snapshot. */
  acquireRead?(threadId: string): Promise<() => void>
  /** Reserves the checkout across native rollback and file restoration, including recovery. */
  acquireMutation?(threadId: string): Promise<() => void>
  /** Must guard exact expected history and preserve the Sotto/provider binding.
   * Throws only for definitive rejection before commitment; unknown delivery returns uncertain. */
  rollback(threadId: string, removedUserMessages: number, expectedUserMessageIds: readonly string[]): Promise<{ accepted: boolean; uncertain?: boolean }>
  /** Read authoritative native history for reconciliation, never resend rollback. */
  refresh(threadId: string): Promise<void>
}
