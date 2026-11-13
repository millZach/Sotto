import { resetGhLookup } from '../main/agents/git/ghCommand'
import { runGitStatusCommand, type RunGitCommand } from '../main/agents/git/gitStatus'
import { hostPluginAccountCopies } from '../main/plugins/accountCopies'
import { PluginAccounts, type PluginCredentials } from '../main/plugins/accounts'
import { wordPluginChangeInEnglish } from '../main/plugins/changeWordsPlain'
import { readGitHubSignIn, sharedGitHubSignIn } from '../main/plugins/github/signIn'
import { PluginChangeRequests } from '../main/plugins/pendingChanges'
import { PluginToolServer } from '../main/plugins/pluginTools'
import { pluginToolHandlers } from '../main/plugins/toolHandlers'
import type { VercelFetch } from '../main/plugins/vercel/read'
import type { AgentHostSnapshot } from '../shared/agents'
import type { PluginAccountCopyStore } from '../shared/pluginAccountCopies'
import { isThreadClosed } from '../shared/threadActivity'

/** Tests stand in for this machine's `gh` and for Vercel; a host runs its own `gh` and reaches api.vercel.com. */
export interface HostPluginStandIns {
  readonly gh?: RunGitCommand
  readonly vercelFetch?: VercelFetch
  readonly vercelBase?: string
}

export interface HostPlugins {
  /** Where the host keeps the account copies its desktop sends. */
  readonly copies: PluginAccountCopyStore
  /** Plugin changes waiting on the user, as this host's own requests in their threads. */
  readonly changes: PluginChangeRequests
  /** `sotto_plugins` for this host's own threads. */
  readonly tools: PluginToolServer
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
 */
export function hostPlugins(options: {
  readonly directory: string
  readonly credentials: PluginCredentials
  /** One of the host's threads as the coordinator holds it, read in place, or nothing for a thread it does not hold. */
  readonly thread: (threadId: string) => AgentHostSnapshot['threads'][number] | undefined
  readonly admits: (threadId: string) => boolean
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
  const tools = new PluginToolServer(pluginToolHandlers({
    admits: options.admits, accounts,
    projectOf: () => null,
    // A thread the host does not know is taken for Watcher: it changes nothing.
    isWatcher: threadId => { const found = thread(threadId); return found === undefined || found.kind === 'watcher' || found.kind === 'watcher-history' },
    askChange: (threadId, change, wait) => changes.ask(threadId, wordPluginChangeInEnglish(change), wait),
    record: async () => undefined,
    gitHubSignIn: sharedGitHubSignIn(() => { resetGhLookup(); return readGitHubSignIn(gh, stop.signal) }),
    gh,
    vercelFetch: options.standIns?.vercelFetch ?? ((url, init) => fetch(url, init)),
    vercelOptions: { ...(options.standIns?.vercelBase ? { base: options.standIns.vercelBase } : {}), signal: stop.signal },
  }))
  return {
    copies: hostPluginAccountCopies(options.directory, options.credentials, undefined, accounts), changes, tools,
    close: async () => { stop.abort(); changes.close(); await tools.close() },
  }
}
