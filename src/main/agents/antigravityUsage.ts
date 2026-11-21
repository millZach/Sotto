import { homedir } from 'node:os'
import type { ProviderId } from '../../shared/agents'
import type { UsageQuotaRead } from '../../shared/usageDashboard'
import { antigravityFolders } from './antigravityFolders'
import { AntigravityQuotaReader } from './antigravityQuota'
import { unavailableProviderQuota } from './providerQuota'
import { scanAntigravityHistory } from './usageHistory/antigravityHistory'
import type { UsageHistorySink } from './usageHistory/sink'

/**
 * What Antigravity's adapter offers Usage, as Claude Code's and Codex's offer theirs: a history pass over `agy`'s
 * conversation files and a read of the account's limits. The adapter is the only layer that knows which `agy` session
 * is which thread, so it hands `owned` in; everything else is here.
 */
export interface AntigravityUsageHooks {
  scanUsageHistory(sink: UsageHistorySink, signal: AbortSignal): Promise<void>
  readProviderQuota(providerId: ProviderId, refresh: boolean, background?: boolean): Promise<UsageQuotaRead>
  /** Forgets the account's last reading and any renewed token, as on sign-out. */
  clearQuota(): void
}

export function antigravityUsageHooks(options: {
  /** The runtime's directory: user data on the desktop, the data directory on a headless host. */
  readonly directory: string
  /** Each native session Sotto owns, by `agy` session ID, to the adapter's own thread ID. */
  readonly owned: () => ReadonlyMap<string, string>
  readonly home?: string
  readonly quota?: AntigravityQuotaReader
}): AntigravityUsageHooks {
  const { appData } = antigravityFolders(options.directory)
  const quota = options.quota ?? new AntigravityQuotaReader({ appData })
  return {
    scanUsageHistory: (sink, signal) => scanAntigravityHistory({ own: appData, home: options.home ?? homedir(), owned: options.owned() }, sink, signal),
    readProviderQuota: async (providerId, _refresh, background = false) => providerId === 'antigravity'
      ? await quota.read(background) : unavailableProviderQuota(providerId, 'unsupported'),
    clearQuota: () => quota.clear(),
  }
}
