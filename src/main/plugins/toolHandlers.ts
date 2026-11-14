import type { RunGitCommand } from '../agents/git/gitStatus'
import { isMailPlugin, pluginAccountAdmits, type AccountPluginId, type GitHubSignIn, type PluginAccount, type PluginChange } from '../../shared/plugins'
import { PluginSecretLocked } from './accounts'
import { commentOnGitHub, describeGitHubIssue, openGitHubIssue, setGitHubIssueState } from './github/changes'
import { readGitHub } from './github/read'
import { MAIL_SEND_SERVERS, MAIL_SERVERS } from './mail/accounts'
import { openMail, searchMail, type MailOptions, type MailServer, type MailSignIn } from './mail/read'
import { sendMail } from './mail/send'
import type { PluginChangeAnswer, PluginChangeWait } from './pendingChanges'
import type { PluginToolHandlers, SecretTrouble } from './pluginTools'
import { cancelVercelDeployment, describeVercelDeployment, moveVercelProduction } from './vercel/changes'
import { readVercel, type VercelFetch } from './vercel/read'

/** The plugin accounts a computer holds, as the tools read them: without their secrets, one by its name, and a secret for one call. */
export interface PluginToolAccounts {
  list(): Promise<readonly PluginAccount[]>
  find(plugin: AccountPluginId, name: string | undefined, admits?: (account: PluginAccount) => boolean): Promise<PluginAccount | 'none' | 'withheld' | 'ambiguous' | 'unknown'>
  /** Throws `PluginSecretLocked` when the credential store will not hand it over. */
  secret(accountId: string): string
}

/** What a computer gives the plugin tools: its own accounts, its own `gh`, its own threads and its own way to ask the user. */
export interface PluginToolWiring {
  /** Whether this Sotto thread is offered the plugin tools. */
  readonly admits: (threadId: string) => boolean
  readonly accounts: PluginToolAccounts
  /** The project a thread belongs to, for an account kept to chosen projects, or null for a thread in none. */
  readonly projectOf: (threadId: string) => string | null
  /** Whether the thread is Watcher, or one this computer does not know, which reads and changes nothing. */
  readonly isWatcher: (threadId: string) => boolean
  /** Shows the user a change's card in the thread and waits for their answer. */
  readonly askChange: (threadId: string, change: PluginChange, wait: PluginChangeWait) => Promise<PluginChangeAnswer>
  readonly record: PluginToolHandlers['record']
  readonly gitHubSignIn: () => Promise<GitHubSignIn>
  /** This computer's own `gh`, which holds GitHub's sign-in. */
  readonly gh: RunGitCommand
  readonly vercelFetch: VercelFetch
  readonly vercelOptions: { readonly base?: string; readonly signal: AbortSignal }
  /**
   * Reading mail, on a computer whose threads can: where its mail grants are kept, the name of the provider a thread
   * runs on, and how a mail server is reached. Left out, no thread here is offered a mail account.
   */
  readonly mail?: {
    readonly grants: { has(threadId: string, accountId: string): Promise<boolean>; grant(threadId: string, accountId: string, generation?: number): Promise<boolean>; open(threadId: string): boolean; generation(accountId: string): number }
    readonly providerOf: (threadId: string) => string
    readonly options: MailOptions
  }
}

/**
 * The plugin tools' handlers for one computer (ADR-0205): the desktop, over the accounts the user added, and a paired
 * host, over the account copies it was sent. Both make each call themselves, with a secret that stays in their own
 * process: an account's token is read from the credential store for one call and goes to its service and nowhere else.
 *
 * Which accounts a thread may use is read afresh at every call (decision 9): a switch turned off, or a project taken
 * off an account, takes effect on the next one.
 */
export function pluginToolHandlers(wiring: PluginToolWiring): PluginToolHandlers {
  const { accounts, gh, vercelFetch, vercelOptions } = wiring
  const { signal } = vercelOptions
  const admitsFor = (threadId: string): ((account: PluginAccount) => boolean) => {
    const project = wiring.projectOf(threadId)
    return account => pluginAccountAdmits(account, project)
  }
  /** An account's token for one call, or why it cannot be read: locked is not the same as gone. */
  const secretOf = (accountId: string): { readonly secret: string } | { readonly reason: 'locked' | 'no-secret' } => {
    try {
      const secret = accounts.secret(accountId)
      return secret ? { secret } : { reason: 'no-secret' }
    } catch (error) {
      return { reason: error instanceof PluginSecretLocked ? 'locked' : 'no-secret' }
    }
  }
  const { mail } = wiring
  /**
   * A mail account's servers, address and password for one read or send. The password is read from the credential
   * store and goes to the account's own servers alone.
   */
  const mailSignIn = (account: PluginAccount): { readonly server: MailServer; readonly sendServer: MailServer; readonly signIn: MailSignIn } | SecretTrouble => {
    if (!isMailPlugin(account.plugin) || !account.address) return 'no-secret'
    const read = secretOf(account.id)
    return 'reason' in read ? read.reason : { server: MAIL_SERVERS[account.plugin], sendServer: MAIL_SEND_SERVERS[account.plugin], signIn: { address: account.address, password: read.secret } }
  }
  return {
    ...(mail ? { mail: {
      granted: (threadId, accountId) => mail.grants.has(threadId, accountId),
      copyOf: accountId => mail.grants.generation(accountId),
      grant: (threadId, accountId, copy) => mail.grants.grant(threadId, accountId, copy),
      threadOpen: threadId => mail.grants.open(threadId),
      providerOf: mail.providerOf,
      search: async (account, search) => { const reach = mailSignIn(account); return typeof reach === 'string' ? reach : searchMail(reach.server, reach.signIn, search, mail.options) },
      open: async (account, id) => { const reach = mailSignIn(account); return typeof reach === 'string' ? reach : openMail(reach.server, reach.signIn, { id }, mail.options) },
      sendTrouble: account => { const reach = mailSignIn(account); return typeof reach === 'string' ? reach : null },
      // A send goes to the account's sending server, with the same sign-in as a read.
      send: async (account, draft) => {
        const reach = mailSignIn(account)
        return typeof reach === 'string' ? reach : sendMail(reach.sendServer, reach.signIn, draft, mail.options)
      },
    } } : {}),
    admits: wiring.admits, gitHubSignIn: wiring.gitHubSignIn, record: wiring.record, isWatcher: wiring.isWatcher, askChange: wiring.askChange,
    readGitHub: (path, query) => readGitHub(gh, path, query, signal),
    accounts: async threadId => (await accounts.list()).filter(admitsFor(threadId)),
    findAccount: (threadId, plugin, name) => accounts.find(plugin, name, admitsFor(threadId)),
    holdsAccount: async accountId => (await accounts.list()).some(account => account.id === accountId),
    readVercel: async (accountId, path, query) => {
      let secret: string
      try { secret = accounts.secret(accountId) } catch (error) {
        if (error instanceof PluginSecretLocked) return { ok: false, reason: 'locked' }
        throw error
      }
      return readVercel(vercelFetch, secret, path, query, vercelOptions)
    },
    commentOnGitHub: input => commentOnGitHub(gh, input, signal),
    openGitHubIssue: input => openGitHubIssue(gh, input, signal),
    describeGitHubIssue: input => describeGitHubIssue(gh, input, signal),
    setGitHubIssueState: input => setGitHubIssueState(gh, input, signal),
    // The deployment is read for its card with the account's token; one that cannot be read shows its ID alone.
    // A token that cannot be read at all is said before anyone is asked.
    describeVercelDeployment: async (accountId, deploymentId, teamId) => {
      const read = secretOf(accountId)
      return 'reason' in read ? read.reason : describeVercelDeployment(vercelFetch, read.secret, deploymentId, teamId, vercelOptions)
    },
    cancelVercelDeployment: async (accountId, deploymentId, teamId) => {
      let secret: string
      try { secret = accounts.secret(accountId) } catch (error) { return { ok: false, reason: error instanceof PluginSecretLocked ? 'locked' : 'no-secret' } }
      return cancelVercelDeployment(vercelFetch, secret, deploymentId, teamId, vercelOptions)
    },
    moveVercelProduction: async (accountId, action, projectId, deploymentId, teamId) => {
      let secret: string
      try { secret = accounts.secret(accountId) } catch (error) { return { ok: false, reason: error instanceof PluginSecretLocked ? 'locked' : 'no-secret' } }
      return moveVercelProduction(vercelFetch, secret, action, projectId, deploymentId, teamId, vercelOptions)
    },
  }
}
