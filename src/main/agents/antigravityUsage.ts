import { homedir } from 'node:os'
import { antigravityFolders } from './antigravityFolders'
import { scanAntigravityHistory } from './usageHistory/antigravityHistory'
import type { UsageHistorySink } from './usageHistory/sink'

/**
 * What Antigravity's adapter offers Usage: a history pass over `agy`'s conversation files, as Claude Code's and Codex's
 * offer theirs. No account limits: reading them meant taking `agy`'s sign-in token and calling Google's Antigravity
 * servers with it, which Google's terms name as a reason to suspend the account (ADR-0212, November 21, 2026). The
 * adapter is the only layer that knows which `agy` session is which thread, so it hands `owned` in.
 */
export interface AntigravityUsageHooks {
  scanUsageHistory(sink: UsageHistorySink, signal: AbortSignal): Promise<void>
}

export function antigravityUsageHooks(options: {
  /** The runtime's directory: user data on the desktop, the data directory on a headless host. */
  readonly directory: string
  /** Each native session Sotto owns, by `agy` session ID, to the adapter's own thread ID. */
  readonly owned: () => ReadonlyMap<string, string>
  readonly home?: string
}): AntigravityUsageHooks {
  const { appData } = antigravityFolders(options.directory)
  return {
    scanUsageHistory: (sink, signal) => scanAntigravityHistory({ own: appData, home: options.home ?? homedir(), owned: options.owned() }, sink, signal),
  }
}
