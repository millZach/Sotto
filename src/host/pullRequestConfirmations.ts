import { randomUUID } from 'node:crypto'
import { pullRequestKey, type ConfirmedPullRequestAction, type GitPullRequestMergeMethod, type PullRequestConfirmation, type PullRequestConfirmationRequest } from '../shared/gitPullRequests'

/**
 * How long a confirmation receipt counts once the host gives it. The desktop asks for one after the user's yes in its
 * window and sends it with the press at once, so it needs a round trip; two minutes also covers a slow link, a move
 * between a host's two listeners and a client that shows its own confirmation between asking and sending, while a receipt
 * nobody used soon stops standing for a pull request that may have moved on since.
 */
export const PULL_REQUEST_CONFIRMATION_LIFETIME_MS = 2 * 60_000
/** Receipts one client may hold at once; asking for another drops its oldest. */
const RECEIPTS_PER_CLIENT = 8
const RECEIPTS_MAX = 1_024
/** The heads read for clients that are kept, newest last; the oldest goes first. */
const READS_MAX = 1_024

interface Receipt {
  readonly clientId: string; readonly threadId: string; readonly key: string; readonly action: ConfirmedPullRequestAction
  readonly method: GitPullRequestMergeMethod | undefined; readonly head: string | null; readonly expires: number; used: boolean
}
type Press = Pick<PullRequestConfirmationRequest, 'threadId' | 'url' | 'action' | 'method'>

/** Each press in the words of the control the user pressed, and what a refusal of it leaves undone. */
const PRESS: Record<ConfirmedPullRequestAction, { readonly doing: string; readonly nothing: string; readonly control: string }> = {
  merge: { doing: 'A merge', nothing: 'Nothing was merged.', control: 'Merge' },
  'enable-auto-merge': { doing: 'Turning on auto-merge', nothing: 'Auto-merge was not turned on.', control: 'Merge when ready' },
  close: { doing: 'Closing a pull request', nothing: 'The pull request was not closed.', control: 'Close pull request' },
}
/** What happened, that nothing was done, and what to do next. */
function refusal(action: ConfirmedPullRequestAction, happened: string, next = `Press ${PRESS[action].control} again.`): { ok: false; message: string } {
  return { ok: false, message: `${happened} ${PRESS[action].nothing} ${next}` }
}

/**
 * The host's confirmation receipts for merges, closes and auto-merges a paired client sends (#1691, ADR-0027, October 28
 * amendment). A receipt is the host's evidence that the client asked first, as a second step, for exactly the press it then
 * sends: the client, the thread, the pull request, the action and the merge method, and the head commit the host last read
 * for that client. It counts once and for two minutes. It is evidence of a deliberate step, never a grant (ADR-0004): it
 * answers no permission, and it cannot tell a person's press from a client's. Held in memory only, and shared by a headless
 * host's two listeners, as command receipts are (ADR-0053), so a desktop that moves between them keeps its receipt. Nothing
 * here is logged.
 */
export class PullRequestConfirmations {
  private readonly receipts = new Map<string, Receipt>()
  /** The head commit each client was last answered for a thread's pull request, by client, thread and pull request. */
  private readonly heads = new Map<string, string | null>()
  private readonly now: () => number

  constructor(options: { readonly now?: () => number } = {}) { this.now = options.now ?? Date.now }

  /** The host answered this client a read of one of a thread's pull requests, on this head (null when GitHub named none). */
  read(clientId: string, threadId: string, url: string, head: string | null): void {
    const key = pullRequestKey(url)
    if (!key) return
    const at = JSON.stringify([clientId, threadId, key])
    this.heads.delete(at); this.heads.set(at, head)
    for (const oldest of this.heads.keys()) { if (this.heads.size <= READS_MAX) break; this.heads.delete(oldest) }
  }

  /**
   * A receipt for one press, or why there is none. The host gives one only for a pull request it has read for this client,
   * so the receipt stands for the pull request as that client was last shown it.
   */
  issue(clientId: string, press: Press): { ok: true; receipt: PullRequestConfirmation } | { ok: false; message: string } {
    const key = pullRequestKey(press.url)
    const head = key ? this.heads.get(JSON.stringify([clientId, press.threadId, key])) : undefined
    if (!key || head === undefined) return refusal(press.action, 'This host has not read this pull request for this device since it started.',
      `Refresh the pull request, then press ${PRESS[press.action].control} again.`)
    this.prune()
    const confirmation = randomUUID(), expires = this.now() + PULL_REQUEST_CONFIRMATION_LIFETIME_MS
    this.receipts.set(confirmation, { clientId, threadId: press.threadId, key, action: press.action, method: press.method, head, expires, used: false })
    const own = [...this.receipts].filter(([, receipt]) => receipt.clientId === clientId)
    for (const [oldest] of own.slice(0, -RECEIPTS_PER_CLIENT)) this.receipts.delete(oldest)
    for (const oldest of this.receipts.keys()) { if (this.receipts.size <= RECEIPTS_MAX) break; this.receipts.delete(oldest) }
    return { ok: true, receipt: { confirmation, expiresAt: new Date(expires).toISOString() } }
  }

  /**
   * Whether the press this client sent may run on this receipt, and the head it was given on. Its own client's use spends
   * it whether or not it matches, so it never counts twice; another client's use is refused and spends nothing.
   */
  redeem(clientId: string, confirmation: string | undefined, press: Press): { ok: true; head: string | null } | { ok: false; message: string } {
    const { action } = press
    if (confirmation === undefined) return refusal(action, `${PRESS[action].doing} from another device needs this host's confirmation, and none came with it.`,
      `Update Sotto on this device, then press ${PRESS[action].control} again.`)
    this.prune()
    const receipt = this.receipts.get(confirmation)
    if (!receipt) return refusal(action, 'This host has no record of that confirmation. It may have restarted since.')
    if (receipt.clientId !== clientId) return refusal(action, 'That confirmation was given to another device.', `Press ${PRESS[action].control} again on this device.`)
    if (receipt.used) return refusal(action, 'That confirmation was already used.')
    receipt.used = true
    if (receipt.expires <= this.now()) return refusal(action, 'That confirmation expired before the press reached this host.')
    if (receipt.threadId !== press.threadId || receipt.key !== pullRequestKey(press.url) || receipt.action !== action || receipt.method !== press.method) {
      return refusal(action, 'That confirmation was for a different press.')
    }
    return { ok: true, head: receipt.head }
  }

  /** Receipts are kept a lifetime past expiry, so a late one is told it expired rather than that it is unknown. */
  private prune(): void {
    const now = this.now()
    for (const [id, receipt] of this.receipts) if (receipt.expires + PULL_REQUEST_CONFIRMATION_LIFETIME_MS <= now) this.receipts.delete(id)
  }
}
