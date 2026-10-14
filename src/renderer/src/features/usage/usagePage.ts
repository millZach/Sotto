import type { UsageBridge, UsageDashboardRead, UsageModelAggregate, UsageProviderId, UsageQuery } from '../../../../shared/usageDashboard'
import type { UsageProviderLimits, UsageSummary } from './usagePresentation'

export type UsageTab = 'overview' | 'subscriptions' | 'models'
export type UsageWhere = 'all' | 'sotto' | 'elsewhere'

/** What every part of the page reads: the combined figures, the filters, names and the ways to move around. */
export interface UsagePage {
  readonly bridge: UsageBridge | undefined
  readonly read: UsageDashboardRead
  readonly summary: UsageSummary
  readonly limits: UsageProviderLimits[]
  readonly query: UsageQuery
  /** The computers the current filters read. */
  readonly hostIds: readonly string[]
  readonly now: number
  readonly today: string
  readonly timeZone: string
  readonly rangeLabel: string
  /** Every calendar day the charts draw, oldest first. */
  readonly days: readonly string[]
  readonly provider: UsageProviderId | 'all'
  readonly where: UsageWhere
  /** Every computer read so far splits its work by place. */
  readonly placesKnown: boolean
  /** What older hosts leave out of the place split, in a sentence, or null when nothing is missing. */
  readonly withoutPlacesNote: string | null
  /** A computer read so far has had its usage cleared, so an empty page means nothing new since. */
  readonly cleared: boolean
  readonly hostName: (hostId: string) => string
  readonly modelName: (row: Pick<UsageModelAggregate, 'modelId' | 'providerId'>) => string
  readonly providerAccount: (providerId: UsageProviderId, hostId: string) => string
  readonly announce: (text: string) => void
  readonly openTab: (tab: UsageTab) => void
  readonly openProvider: (providerId: UsageProviderId) => void
}
