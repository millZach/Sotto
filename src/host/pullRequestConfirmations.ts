import { randomUUID } from 'node:crypto'
import { gitCommitIdSchema, pullRequestKey, type ConfirmedPullRequestAction, type GitPullRequestMergeMethod, type PullRequestConfirmation, type PullRequestConfirmationRequest } from '../shared/gitPullRequests'

/**
 * How long a confirmation receipt counts once the host gives it. The desktop asks for one after the user's yes in its
 * window and sends it with the press at once, so it needs a round trip; two minutes also covers a slow link, a move
 * between a host's two listeners and a client that shows its own confirmation between asking and sending, while a receipt
 * nobody used soon stops standing for a pull request that may have moved on since.
 */
export const PULL_REQUEST_CONFIRMATION_LIFETIME_MS = 2 * 60_000
/**
 * How long the host keeps a reading of a pull request it gave a client, which that client's receipt may be asked against.
 * The surface reads again when it opens, on Refresh and after each press, and a check that finished since is shown only by
 * another read, so a reading half an hour old is one the user has seldom acted on; one older asks for a fresh read.
 */
export const PULL_REQUEST_READ_LIFETIME_MS = 30 * 60_000
/** Receipts one client may hold at once; asking for another drops its oldest. */
const RECEIPTS_PER_CLIENT = 8
const RECEIPTS_MAX = 1_024
/** Readings one client's are kept for at once, and all clients' together; a new one drops the oldest. */
const READS_PER_CLIENT = 32
const READS_MAX = 1_024

interface Receipt {
  readonly clientId: string; readonly threadId: string; readonly key: string; readonly action: ConfirmedPullRequestAction
  readonly method: GitPullRequestMergeMethod | undefined; readonly head: string | null; readonly expires: number; used: boolean
}
/** One answer to a client's read of a thread's pull request, by the read ID it went with, and the head it named. */
interface Reading { readonly clientId: string; readonly threadId: string; readonly key: string; readonly head: string | null; readonly at: number }
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
/** What to do when the host's reading of the pull request is missing or names no head: have it read again. */
const readAgain = (action: ConfirmedPullRequestAction): string => `Open the pull request again so Sotto reads it, then press ${PRESS[action].control} again.`
/** Keeps the newest of one client's entries and of all of them, oldest dropped first, in a map kept in insertion order. */
function bound<T extends { readonly clientId: string }>(entries: Map<string, T>, clientId: string, perClient: number, all: number): void {
  const own = [...entries].filter(([, entry]) => entry.clientId === clientId)
  for (const [oldest] of own.slice(0, -perClient)) entries.delete(oldest)
  for (const oldest of entries.keys()) { if (entries.size <= all) break; entries.delete(oldest) }
}

/**
 * The host's confirmation receipts for merges, closes and auto-merges a paired client sends (#1691, ADR-0027, October 28
 * amendment). A receipt is the host's evidence that the client asked first, as a second step, for exactly the press it then
 * sends: the client, the thread, the pull request, the action and the merge method, and the head commit of the reading
 * that client showed when it asked, named by the read ID the host gave it with that reading. It counts once and for two
 * minutes. It is evidence of a deliberate step, never a grant (ADR-0004): it
 * answers no permission, and it cannot tell a person's press from a client's. Held in memory only, and shared by a headless
 * host's two listeners, as command receipts are (ADR-0053), so a desktop that moves between them keeps its receipt. Nothing
 * here is logged.
 */
export class PullRequestConfirmations {
  private readonly receipts = new Map<string, Receipt>()
  /**
   * Each reading of a thread's pull request the host gave a client, by the read ID that went with it. A client may have
   * several in flight and show only one of them, so a receipt is asked against the one it shows, never the last to finish.
   */
  private readonly readings = new Map<string, Reading>()
  private readonly now: () => number

  constructor(options: { readonly now?: () => number } = {}) { this.now = options.now ?? Date.now }

  /**
   * The host is answering this client a read of one of a thread's pull requests, naming this head: the read ID to send
   * with it. A head that is not a commit ID, or none, is kept as null: the pull request was read, but nothing can hold a
   * merge to it.
   */
  read(clientId: string, threadId: string, url: string, head: string | undefined): string | undefined {
    const key = pullRequestKey(url)
    if (!key) return undefined
    this.pruneReadings()
    const readId = randomUUID(), named = gitCommitIdSchema.safeParse(head)
    this.readings.set(readId, { clientId, threadId, key, head: named.success ? named.data : null, at: this.now() })
    bound(this.readings, clientId, READS_PER_CLIENT, READS_MAX)
    return readId
  }

  /**
   * A receipt for one press, or why there is none. The client names the reading it shows by its read ID, and the host
   * gives a receipt only against a reading it gave that client of that thread's pull request, so the receipt stands for
   * what the client was shown. For a merge or an auto-merge it gives one only when that reading named the head commit,
   * which the press is then held to (ADR-0027, October 28 amendment). A close holds GitHub to no head, so it needs none.
   */
  issue(clientId: string, press: PullRequestConfirmationRequest): { ok: true; receipt: PullRequestConfirmation } | { ok: false; message: string } {
    const { action } = press
    if (press.readId === undefined) return refusal(action, 'This device did not say which reading of the pull request it is showing.', readAgain(action))
    this.pruneReadings()
    const reading = this.readings.get(press.readId)
    if (!reading) return refusal(action, 'This host no longer has the reading of the pull request this device is showing. It may be over 30 minutes old, or the host may have restarted.', readAgain(action))
    if (reading.clientId !== clientId) return refusal(action, 'That reading of the pull request was made for another device.', readAgain(action))
    if (reading.threadId !== press.threadId || reading.key !== pullRequestKey(press.url)) return refusal(action, 'That reading is of another pull request.', readAgain(action))
    if (action !== 'close' && reading.head === null) return refusal(action, 'GitHub did not say which commit this pull request is on in the reading this device is showing.', readAgain(action))
    this.prune()
    const confirmation = randomUUID(), expires = this.now() + PULL_REQUEST_CONFIRMATION_LIFETIME_MS
    this.receipts.set(confirmation, { clientId, threadId: press.threadId, key: reading.key, action, method: press.method, head: reading.head, expires, used: false })
    bound(this.receipts, clientId, RECEIPTS_PER_CLIENT, RECEIPTS_MAX)
    return { ok: true, receipt: { confirmation, expiresAt: new Date(expires).toISOString() } }
  }

  /**
   * Whether the press this client sent may run on this receipt, and, for a merge or an auto-merge, the head commit it must
   * be held to, which is always there when the answer is yes. Its own client's use spends it whether or not it matches, so
   * it never counts twice; another client's use is refused and spends nothing.
   */
  redeem(clientId: string, confirmation: string | undefined, press: Press): { ok: true; matchHeadCommit?: string } | { ok: false; message: string } {
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
    if (action === 'close') return { ok: true }
    // `issue` gives a merge or an auto-merge no receipt without a head; this holds the press to one whatever changes there.
    if (!receipt.head) return refusal(action, 'That confirmation does not say which commit this pull request is on.', readAgain(action))
    return { ok: true, matchHeadCommit: receipt.head }
  }

  private pruneReadings(): void {
    const now = this.now()
    for (const [id, reading] of this.readings) if (reading.at + PULL_REQUEST_READ_LIFETIME_MS <= now) this.readings.delete(id)
  }
  /** Receipts are kept a lifetime past expiry, so a late one is told it expired rather than that it is unknown. */
  private prune(): void {
    const now = this.now()
    for (const [id, receipt] of this.receipts) if (receipt.expires + PULL_REQUEST_CONFIRMATION_LIFETIME_MS <= now) this.receipts.delete(id)
  }
}
