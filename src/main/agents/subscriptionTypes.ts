/** Provider clients retain their own login credentials; Sotto only receives status and text. */
import type { SubscriptionAccount } from '../../shared/agents'
export type { SubscriptionProvider, SubscriptionAccount } from '../../shared/agents'
export interface SubscriptionClient {
  status(): Promise<SubscriptionAccount>
  complete(system: string, input: unknown, model: string, effort?: string): Promise<unknown>
}
