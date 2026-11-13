import { resetGhLookup } from '../main/agents/git/ghCommand'
import { runGitStatusCommand, type RunGitCommand } from '../main/agents/git/gitStatus'
import { hostPluginAccountCopies, type HostPluginAccountCopies } from '../main/plugins/accountCopies'
import { PluginAccounts, type PluginCredentials } from '../main/plugins/accounts'
import { wordPluginChangeInEnglish } from '../main/plugins/changeWordsPlain'
import { readGitHubSignIn, sharedGitHubSignIn } from '../main/plugins/github/signIn'
import { PluginChangeRequests } from '../main/plugins/pendingChanges'
import { PluginToolServer } from '../main/plugins/pluginTools'
import { pluginToolHandlers, type PluginToolAccounts } from '../main/plugins/toolHandlers'
import type { VercelFetch } from '../main/plugins/vercel/read'
import type { AgentHostSnapshot } from '../shared/agents'
import type { GitHubSignIn } from '../shared/plugins'
import { isThreadClosed } from '../shared/threadActivity'

/** Tests stand in for this machine's `gh` and for Vercel; a host runs its own `gh` and reaches api.vercel.com. */
export interface HostPluginStandIns {
  readonly gh?: RunGitCommand
  readonly vercelFetch?: VercelFetch
  readonly vercelBase?: string
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
  readonly admits: (threadId: string) => boolean
  /** Whether a client is still paired with this host, read in place. */
  readonly paired: (clientId: string) => boolean
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
  const changes = new PluginChangeRequests({ open: threadId => { const found = thread(threadId); return found !== undefined && !isThreadClosed(found) } })
  const copies = hostPluginAccountCopies(options.directory, options.credentials, undefined, accounts)
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
  const tools = new PluginToolServer(pluginToolHandlers({
    admits: options.admits, accounts: usable,
    projectOf: () => null,
    // A thread the host does not know is taken for Watcher: it changes nothing.
    isWatcher: threadId => { const found = thread(threadId); return found === undefined || found.kind === 'watcher' || found.kind === 'watcher-history' },
    askChange: (threadId, change, wait) => changes.ask(threadId, wordPluginChangeInEnglish(change), wait),
    record: async () => undefined,
    gitHubSignIn, gh,
    vercelFetch: options.standIns?.vercelFetch ?? ((url, init) => fetch(url, init)),
    vercelOptions: { ...(options.standIns?.vercelBase ? { base: options.standIns.vercelBase } : {}), signal: stop.signal },
  }))
  return {
    copies, changes, tools, gitHubSignIn,
    close: async () => { stop.abort(); changes.close(); await tools.close() },
  }
}
