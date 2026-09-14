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
  files: FilesService
  directory: string
  resolveThread(threadId: string): Promise<CheckpointThread | null>
  /** Must guard exact expected history and preserve the Sotto/provider binding.
   * Throws only for definitive rejection before commitment; unknown delivery returns uncertain. */
  rollback(threadId: string, removedUserMessages: number, expectedUserMessageIds: readonly string[]): Promise<{ accepted: boolean; uncertain?: boolean }>
  /** Read authoritative native history for reconciliation, never resend rollback. */
  refresh(threadId: string): Promise<void>
}
