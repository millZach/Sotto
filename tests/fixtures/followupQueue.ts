import type { AgentControl } from '../../src/main/agents/control'
import type { FollowupStore, QueuedFollowup } from '../../src/main/agents/followups'

/**
 * The coordinator's own follow-up store. Sotto's wake-ups for Watcher are published to no window or phone (ADR-0073),
 * so a test that follows one reads the store the coordinator keeps it in.
 */
export const followupStoreOf = (control: AgentControl): FollowupStore => (control as unknown as { followupStore: FollowupStore }).followupStore
/** Every queued item the coordinator holds, the ones it publishes nowhere included. */
export const storedFollowups = (control: AgentControl): readonly QueuedFollowup[] => followupStoreOf(control).peek().items
