import { join } from 'node:path'
import { resetGhLookup } from '../main/agents/git/ghCommand'
import { runGitStatusCommand, type RunGitCommand } from '../main/agents/git/gitStatus'
import { hostPluginAccountCopies, type HostPluginAccountCopies } from '../main/plugins/accountCopies'
import { PluginAccounts, type PluginCredentials } from '../main/plugins/accounts'
import { wordPluginChangeInEnglish } from '../main/plugins/changeWordsPlain'
import { readGitHubSignIn, sharedGitHubSignIn } from '../main/plugins/github/signIn'
import type { MailConnect } from '../main/plugins/mail/read'
import { MailGrants, mailThreadOpen } from '../main/plugins/mailGrants'
import { everyMonthStart, HeardSpending, monthOf, ReportRevisions } from '../main/plugins/meshy/spending'
import { PluginChangeRequests } from '../main/plugins/pendingChanges'
import { PluginToolServer } from '../main/plugins/pluginTools'
import { pluginToolHandlers, type PluginToolAccounts } from '../main/plugins/toolHandlers'
import type { VercelFetch } from '../main/plugins/vercel/read'
import type { MeshyApiFetch } from '../main/tools/meshy/api'
import { checkPhoto, photoToSend } from '../main/tools/meshy/photo'
import { ModelRecords, type ThreeDModel } from '../main/tools/meshy/records'
import { MeshyModels } from '../main/tools/meshy/service'
import { stripPhoto } from '../main/tools/meshy/strip'
import { PROVIDER_LABELS, type AgentHostSnapshot } from '../shared/agents'
import type { PluginSpendingShare, SpendingReport } from '../shared/pluginAccountCopies'
import type { GitHubSignIn } from '../shared/plugins'
import { isThreadClosed } from '../shared/threadActivity'

/** Tests stand in for this machine's `gh` and for Vercel; a host runs its own `gh` and reaches api.vercel.com. */
export interface HostPluginStandIns {
  readonly gh?: RunGitCommand
  readonly vercelFetch?: VercelFetch
  readonly vercelBase?: string
  /** How a mail server is reached, in place of TLS to the account's own. */
  readonly mailConnect?: MailConnect
  /** A stand-in for Meshy's API and file server, on one address, and how it is reached. */
  readonly meshyBase?: string
  readonly meshyFetch?: MeshyApiFetch
  readonly meshyWait?: (ms: number, signal: AbortSignal) => Promise<void>
  readonly now?: () => Date
}

export interface HostPlugins {
  /** Where the host keeps the account copies its desktop sends. */
  readonly copies: HostPluginAccountCopies
  /** Plugin changes waiting on the user, as this host's own requests in their threads. */
  readonly changes: PluginChangeRequests
  /** `sotto_plugins` for this host's own threads. */
  readonly tools: PluginToolServer
  /** Who this machine's gh is signed in to GitHub as: the account this host's threads act as. A name, never a token. */
  readonly gitHubSignIn: () => Promise<GitHubSignIn>
  /** Which of this host's threads the user has let read which mail accounts. */
  readonly mailGrants: MailGrants
  /** The 3D models this host's threads asked for, which follow forgetting a thread and Keep local history. */
  readonly models: ModelRecords
  /** Shared spending with the desktops that sent this host its Meshy copies (`plugin-meshy-spending`). */
  readonly spending: PluginSpendingShare
  /**
   * Once the paired clients are read: takes the words out of the 3D models' records if Keep local history is off, and
   * picks up the 3D models still being made when the host last stopped. Before then no copy's key may be read.
   */
  startModels(): Promise<void>
  /** Deleted threads take their waiting cards and their mail grants with them. */
  forgetThreads(threadIds: readonly string[]): void
  /** Forgets the grants of copies this host no longer holds, when it starts. */
  forgetGrantsOfGone(): Promise<void>
  close(): Promise<void>
}

/**
 * Plugins on a headless host (ADR-0205, decision 4): the account copies its desktop sent, and `sotto_plugins` for the
 * host's own threads over them, so a thread here uses an account while the desktop is off.
 *
 * The host makes each call itself. GitHub's account is this machine's own `gh` sign-in, which is not the desktop's.
 * An account copy's token is read from the host's encrypted credential file for one call and goes to its service and
 * nowhere else; no agent, client or log holds it. A change waits on a card in its thread, which reaches the user as
 * this host's other requests do and is answered only by a client that may answer here.
 *
 * Every copy is for every project: an account kept to chosen projects is never copied, since a project is a folder on
 * the desktop. A thread is therefore asked for no project, and a copy that names projects all the same, as none
 * should, is used by no thread. The host keeps no record of use; **Recent use** on the desktop is the desktop's own.
 *
 * A mail account's copy is read by this host's threads from this machine, each thread asking the user once (decision
 * 8). The mail grants are the host's own, in its own folder, for its own threads: a grant given on the desktop is
 * for a desktop's thread and means nothing here. A copy that is let go, or whose desktop is revoked, takes its
 * grants with it, since a copy sent again comes under the same ID.
 *
 * A copy is its sender's: a thread here uses one only while the desktop that sent it is still paired. Revoking a
 * desktop deletes its copies, but a delete can fail, or the host can go away first, and a revoked desktop can never
 * ask for it again. So who sent a copy is asked at every use, the token included, and what no paired desktop sent is
 * deleted when the host next starts.
 */
export function hostPlugins(options: {
  readonly directory: string
  readonly credentials: PluginCredentials
  /** One of the host's threads as the coordinator holds it, read in place, or nothing for a thread it does not hold. */
  readonly thread: (threadId: string) => AgentHostSnapshot['threads'][number] | undefined
  /** One of the host's projects, read in place, for whether the user settled it. */
  readonly project?: (projectId: string) => AgentHostSnapshot['projects'][number] | undefined
  readonly admits: (threadId: string) => boolean
  /** Whether a client is still paired with this host, read in place. */
  readonly paired: (clientId: string) => boolean
  /** One of the host's threads' working folder, found as the host's Files finds it, or null. Left out, no thread here makes a 3D model. */
  readonly folderOf?: (threadId: string) => Promise<string | null>
  /** Places a 3D model's line in its thread, as the desktop does. False when it could not be placed. */
  readonly showInThread?: (threadId: string, model: ThreeDModel) => Promise<boolean>
  /** The host's Keep local history, read in place; off until its settings are read. */
  readonly historyEnabled?: () => boolean
  readonly standIns?: HostPluginStandIns
}): HostPlugins {
  const accounts = new PluginAccounts(options.directory, {
    credentials: options.credentials,
    // A host adds no account of its own, so nothing is ever asked of a service from here.
    check: async () => ({ ok: false, problem: 'unreachable' }),
  })
  const stop = new AbortController()
  const gh = options.standIns?.gh ?? runGitStatusCommand
  const { thread } = options
  // Whether a thread is open as a mail grant means it, by the one test the desktop's grants go by: not settled, by
  // itself or with its project, not archived and not gone.
  const mailGrants = new MailGrants(options.directory, { open: threadId => {
    const found = thread(threadId)
    const project = found ? options.project?.(found.projectId) : undefined
    return found !== undefined && mailThreadOpen({ threads: [found], projects: project ? [project] : [] }, threadId)
  } })
  const changes = new PluginChangeRequests({ open: threadId => { const found = thread(threadId); return found !== undefined && !isThreadClosed(found) }, noticed: () => { mailGrants.noticed() } })
  // A copy that goes takes every thread's leave to read it, in the step that deletes it: whether the desktop let it
  // go, another copy of its name took its place, or its desktop was revoked. A copy sent again comes under the same
  // ID, and must not find a grant that was given for the one before it.
  const store = hostPluginAccountCopies(options.directory, options.credentials, undefined, accounts, accountId => { void mailGrants.forgetAccount(accountId).catch(() => undefined) })
  // This host's threads can read a mail account and ask before they do, so it keeps one.
  const copies: HostPluginAccountCopies = { ...store, mail: true }
  // A grant left in the file for a copy that is gone, as a host that went away part-way leaves, goes at the next start.
  const forgetGrantsOfGone = async (): Promise<void> => {
    const held = new Set((await accounts.list()).map(account => account.id))
    for (const accountId of new Set((await mailGrants.list()).map(grant => grant.accountId))) if (!held.has(accountId)) await mailGrants.forgetAccount(accountId)
  }
  // Who sent each copy, as last read. A token is read without waiting, so it is checked against this, and against
  // whether that desktop is paired now: a copy listed a moment before its desktop was revoked hands over nothing.
  let sentBy: Readonly<Record<string, string>> = {}
  const live = (accountId: string): boolean => { const sender = sentBy[accountId]; return sender !== undefined && options.paired(sender) }
  // Senders that cannot be read are nobody's: no copy is used, rather than every one.
  const readSenders = async (): Promise<void> => { sentBy = await copies.senders().catch(() => ({})) }
  const usable: PluginToolAccounts = {
    list: async () => { await readSenders(); return (await accounts.list()).filter(account => live(account.id)) },
    find: async (plugin, name, admits) => { await readSenders(); return accounts.find(plugin, name, account => live(account.id) && (admits?.(account) ?? true)) },
    secret: accountId => live(accountId) ? accounts.secret(accountId) : '',
  }
  // Each read looks for gh afresh, and reads asked for while one runs share it rather than starting gh again.
  const gitHubSignIn = sharedGitHubSignIn(() => { resetGhLookup(); return readGitHubSignIn(gh, stop.signal) })
  // 3D models (ADR-0141, ADR-0205): this host's threads make them with the Meshy copies its desktops sent, into their
  // own folders on this machine. Each record is this host's own, in its own folder, and Meshy's API is reached from
  // here with the copy's key, read for one call. The key of a copy whose desktop is no longer paired is never read.
  const now = options.standIns?.now ?? (() => new Date())
  const historyEnabled = options.historyEnabled ?? (() => false)
  const models = new ModelRecords(options.directory, { historyEnabled })
  const meshyBase = options.standIns?.meshyBase
  // One limit wherever the account is: what each copy's desktop last said it spent, with when (ADR-0205).
  const heard = new HeardSpending(join(options.directory, 'plugin-meshy-spending.json'), now)
  const spendingListeners = new Set<() => void>()
  const spendingChanged = (): void => { for (const listener of [...spendingListeners]) { try { listener() } catch { /* A listener's failure is its own. */ } } }
  // Each change to a 3D model is looked at for whether this host's count moved, and only a count that did is told.
  // Looks asked for while one runs are one more look after it.
  let counted = new Map<string, number>()
  let looking: Promise<void> | undefined
  let lookAgain = false
  const countChanged = (): void => {
    if (looking) { lookAgain = true; return }
    looking = models.monthCredits(now()).then(credits => {
      const moved = credits.size !== counted.size || [...credits].some(([id, count]) => counted.get(id) !== count)
      counted = new Map(credits)
      if (moved) spendingChanged()
    }, () => undefined).finally(() => { looking = undefined; if (lookAgain) { lookAgain = false; countChanged() } })
  }
  const meshyModels = new MeshyModels({ records: models, signal: stop.signal,
    fetch: options.standIns?.meshyFetch ?? ((url, init) => fetch(url, init)),
    ...(meshyBase ? { base: meshyBase, assets: meshyBase } : {}), ...(options.standIns?.meshyWait ? { wait: options.standIns.meshyWait } : {}),
    keyOf: async accountId => (await usable.list()).some(account => account.id === accountId && account.plugin === 'meshy') ? usable.secret(accountId) || undefined : undefined,
    changed: () => { countChanged() },
  })
  const stopMonths = everyMonthStart(() => { counted = new Map(); spendingChanged() }, now)
  const revisions = new ReportRevisions()
  /**
   * This host's own credits this month for each Meshy copy one desktop sent. Numbered as soon as they are counted, and
   * counts are read one after another, so a report with a higher number never says less than was spent before it.
   */
  const ownFor = async (clientId: string): Promise<SpendingReport[]> => {
    const senders = await copies.senders()
    const credits = await models.monthCredits(now())
    const revision = revisions.next()
    const month = monthOf(now())
    return (await accounts.list()).filter(account => account.plugin === 'meshy' && senders[account.id] === clientId)
      .map(account => ({ accountId: account.id, month, credits: credits.get(account.id) ?? 0, session: revisions.session, revision }))
  }
  const spending: PluginSpendingShare = {
    // A desktop speaks only for the copies it sent: what it says of any other account is not kept.
    share: async (reports, clientId) => {
      const senders = await copies.senders()
      await heard.hear(clientId, reports.filter(report => senders[report.accountId] === clientId))
      return ownFor(clientId)
    },
    own: ownFor,
    subscribe: listener => { spendingListeners.add(listener); return () => { spendingListeners.delete(listener) } },
  }
  const { folderOf } = options
  const meshy = folderOf ? {
    folderOf,
    // This host's own 3D models and what the copy's desktop last said, which holds every other computer's.
    monthCredits: async (accountId: string) => ((await models.monthCredits(now())).get(accountId) ?? 0) + await heard.total(accountId),
    // No image library here: the photo's metadata is taken out of its file, its pixels left as they are (#2497).
    checkPhoto, photoToSend: (root: string, checked: Parameters<typeof photoToSend>[1], path: string) => photoToSend(root, checked, path, stripPhoto),
    make: (request: Parameters<MeshyModels['make']>[0]) => meshyModels.make(request),
    showInThread: async (threadId: string, model: ThreeDModel) => await options.showInThread?.(threadId, model).catch(() => false) ?? false,
  } : undefined
  const tools = new PluginToolServer(pluginToolHandlers({
    admits: options.admits, accounts: usable,
    projectOf: () => null,
    // A thread the host does not know is taken for Watcher: it changes nothing.
    isWatcher: threadId => { const found = thread(threadId); return found === undefined || found.kind === 'watcher' || found.kind === 'watcher-history' },
    askChange: (threadId, change, wait) => changes.ask(threadId, wordPluginChangeInEnglish(change), wait),
    record: async () => undefined,
    gitHubSignIn, gh,
    ...(meshy ? { meshy } : {}),
    vercelFetch: options.standIns?.vercelFetch ?? ((url, init) => fetch(url, init)),
    vercelOptions: { ...(options.standIns?.vercelBase ? { base: options.standIns.vercelBase } : {}), signal: stop.signal },
    // Mail is read from this machine, with the copy's password from the host's own credential file. The card that
    // asks names the provider the host's thread runs on, since what it reads goes there.
    mail: {
      grants: mailGrants,
      providerOf: threadId => { const provider = thread(threadId)?.providerId; return provider ? PROVIDER_LABELS[provider] : '' },
      options: { signal: stop.signal, ...(options.standIns?.mailConnect ? { connect: options.standIns.mailConnect } : {}) },
    },
  }))
  return {
    copies, changes, tools, gitHubSignIn, mailGrants, forgetGrantsOfGone, models, spending,
    startModels: async () => {
      await models.privacyChanged().catch(() => undefined)
      await meshyModels.resume()
      countChanged()
    },
    // A forgotten thread's 3D models' records go with it; what they cost this month still counts (ADR-0141).
    forgetThreads: threadIds => { changes.forgetThreads(threadIds); void mailGrants.forgetThreads(threadIds).catch(() => undefined); void models.forgetThreads(threadIds).catch(() => undefined) },
    close: async () => { stop.abort(); stopMonths(); spendingListeners.clear(); changes.close(); mailGrants.close(); await tools.close() },
  }
}
