import { join } from 'node:path'
import { everyMonthStart, HeardSpending, monthOf, ReportRevisions } from '../main/plugins/spending'
import type { SpendingPlugin } from '../main/plugins/spendingSync'
import type { PluginSpendingShare, SpendingReport } from '../shared/pluginAccountCopies'
import type { PluginAccount } from '../shared/plugins'

/** A host's shared spending for one plugin's copies, and what its make tool asks of it. */
export interface HostSpending {
  /** What a desktop says and is told (`plugin-meshy-spending` or `plugin-elevenlabs-spending`). */
  readonly share: PluginSpendingShare
  /** Something of this host's own changed: its desktops are told only when its count for an account moved. */
  countChanged(): void
  /**
   * What the copy's desktop last said the account spent, which holds every other computer's, in the plugin's unit.
   * `waiting` until that desktop has said anything of the account; `unreadable` while what was said cannot be read or
   * was not written down.
   */
  others(accountId: string): Promise<number | 'waiting' | 'unreadable'>
  close(): void
}

/**
 * A paired host's side of shared spending for one plugin (ADR-0205): one monthly limit wherever the account is. Each
 * desktop that sent this host copies of the plugin's accounts says what each spent everywhere but here, which is kept
 * in a small file in the host's data folder, and is told what this host's own threads spent of its copies alone.
 * Counts are whole numbers in the plugin's unit: Meshy's credits, or US cents for ElevenLabs.
 */
export function hostSpending(options: {
  readonly plugin: SpendingPlugin
  readonly directory: string
  /** Who sent each copy this host holds, by account ID. */
  readonly senders: () => Promise<Readonly<Record<string, string>>>
  readonly accounts: () => Promise<readonly PluginAccount[]>
  /** This host's own count this month, by account ID, in the plugin's unit. */
  readonly own: () => Promise<ReadonlyMap<string, number>>
  readonly now: () => Date
}): HostSpending {
  const { now, senders } = options
  // One limit wherever the account is: what each copy's desktop last said it spent, with when (ADR-0205).
  const heard = new HeardSpending(join(options.directory, `plugin-${options.plugin}-spending.json`), now)
  const listeners = new Set<() => void>()
  const changed = (): void => { for (const listener of [...listeners]) { try { listener() } catch { /* A listener's failure is its own. */ } } }
  // Each change is looked at for whether this host's count moved, and only a count that did is told. Looks asked for
  // while one runs are one more look after it.
  let counted = new Map<string, number>()
  let looking: Promise<void> | undefined
  let lookAgain = false
  const countChanged = (): void => {
    if (looking) { lookAgain = true; return }
    looking = options.own().then(counts => {
      const moved = counts.size !== counted.size || [...counts].some(([id, count]) => counted.get(id) !== count)
      counted = new Map(counts)
      if (moved) changed()
    }, () => undefined).finally(() => { looking = undefined; if (lookAgain) { lookAgain = false; countChanged() } })
  }
  const stopMonths = everyMonthStart(() => { counted = new Map(); changed() }, now)
  const revisions = new ReportRevisions()
  /**
   * This host's own count this month for each of the plugin's copies one desktop sent. Numbered as soon as they are
   * counted, and counts are read one after another, so a report with a higher number never says less than was spent
   * before it.
   */
  const ownFor = async (clientId: string): Promise<SpendingReport[]> => {
    const sent = await senders()
    const counts = await options.own()
    const revision = revisions.next()
    const month = monthOf(now())
    return (await options.accounts()).filter(account => account.plugin === options.plugin && sent[account.id] === clientId)
      .map(account => ({ accountId: account.id, month, credits: counts.get(account.id) ?? 0, session: revisions.session, revision }))
  }
  const share: PluginSpendingShare = {
    // A desktop speaks only for the copies it sent: what it says of any other account is not kept. What it says is
    // written down before it is answered, and a write that fails is no answer, so the desktop never takes it as heard.
    share: async (reports, clientId) => {
      const sent = await senders()
      await heard.hear(clientId, reports.filter(report => sent[report.accountId] === clientId))
      return ownFor(clientId)
    },
    own: ownFor,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  return {
    share, countChanged,
    // A copy spends nothing until its desktop has said what the account spent (Sol's review): a copy whose report came
    // before it, or has not come yet, would otherwise count the desktop's spending as none. Nor while what was said
    // cannot be read or was not written down.
    others: async accountId => {
      const sender = (await senders().catch((): Readonly<Record<string, string>> => ({})))[accountId]
      try {
        // Heard from, and for this month: one heard from only before the 1st has not said what it spent since.
        if (sender === undefined || !await heard.hasThisMonth(sender, accountId)) return 'waiting'
        return await heard.total(accountId)
      } catch { return 'unreadable' }
    },
    close: () => { stopMonths(); listeners.clear() },
  }
}
