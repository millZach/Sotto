import { z } from 'zod'

/**
 * Plugins (ADR-0205): outside services Sotto can connect once, so every thread's agent has one known place to use
 * them. An Owl feature. A plugin joins this list in the slice that makes it work, so the page never shows a row that
 * does nothing; docs/plans/2026-11-11-plugins.md has the order.
 */
export const PLUGINS_FEATURE = 'plugins'

/** The groups Settings › Plugins sets its rows in, in the page's order. */
export const PLUGIN_GROUPS = ['code'] as const
export type PluginGroupId = typeof PLUGIN_GROUPS[number]

export const PLUGIN_IDS = ['github', 'vercel'] as const
export type PluginId = typeof PLUGIN_IDS[number]

/** A plugin as the page lists it. Its name is the service's own and is the same in every language. */
export interface PluginEntry { readonly id: PluginId; readonly name: string; readonly group: PluginGroupId }

export const PLUGINS: readonly PluginEntry[] = [
  { id: 'github', name: 'GitHub', group: 'code' },
  { id: 'vercel', name: 'Vercel', group: 'code' },
]

export const PLUGINS_GITHUB_SIGN_IN = 'sotto:plugins:github-sign-in'
export const PLUGINS_GITHUB_SIGN_IN_ELSEWHERE = 'sotto:plugins:github-sign-in-elsewhere'

/** The longest account name GitHub allows is 39 characters; anything far past it is not a name gh printed. */
const GITHUB_LOGIN_MAX = 100

/**
 * Where the `gh` command's own sign-in to github.com stands on this computer. GitHub's plugin account is that sign-in:
 * Sotto stores nothing for it and reads no token. `unknown` is a gh that could not be asked, which is not the same as
 * one that is signed out.
 */
export const gitHubSignInSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('signed-in'), login: z.string().min(1).max(GITHUB_LOGIN_MAX) }).strict(),
  z.object({ state: z.literal('signed-out') }).strict(),
  z.object({ state: z.literal('not-installed') }).strict(),
  z.object({ state: z.literal('unknown') }).strict(),
])
export type GitHubSignIn = z.infer<typeof gitHubSignInSchema>

/**
 * Who gh is signed in to GitHub as on one of the user's other computers, for Settings › Plugins. A thread there acts
 * as that account, which need not be this computer's. Besides gh's own four answers: `away`, the computer is not
 * connected, so its gh cannot be asked; `too-old`, its Sotto runs plugin tools, with that computer's own gh, and is
 * from before it could say who that is; `no-plugins`, its Sotto runs no plugin tools, so its threads do not use
 * GitHub through Sotto. A name, never a token.
 */
export const PLUGIN_HOST_SIGN_IN_STATES = ['signed-in', 'signed-out', 'not-installed', 'unknown', 'away', 'too-old', 'no-plugins'] as const
export const pluginHostSignInsSchema = z.array(z.object({
  computerId: z.string().min(1).max(512), name: z.string().max(512), state: z.enum(PLUGIN_HOST_SIGN_IN_STATES),
  /** The account, where gh is signed in. */
  login: z.string().min(1).max(GITHUB_LOGIN_MAX).optional(),
}).strict()).max(200)
export type PluginHostSignIn = z.infer<typeof pluginHostSignInsSchema>[number]

/** `window.sotto.plugins`: what Settings › Plugins reads from main. Nothing here ever carries a secret. */
export interface PluginsBridge {
  /** Asks gh, on this computer, who it is signed in to github.com as. */
  gitHubSignIn(): Promise<GitHubSignIn>
  /** Asks gh on each of the user's other computers who it is signed in as there, where that computer is connected and runs plugin tools. */
  gitHubSignInElsewhere(): Promise<PluginHostSignIn[]>
  /** The newest uses of plugins by threads' agents, newest first: what was done and by which thread, never its content. */
  recentUse(): Promise<ShownPluginUse[]>
  /** The accounts the user added, without their secrets. */
  accounts(): Promise<PluginAccount[]>
  /** Checks a secret with its service and keeps it. The secret goes to main once and never comes back. */
  addAccount(request: PluginAccountAdd): Promise<PluginAccountResult>
  replaceSecret(request: PluginAccountReplace): Promise<PluginAccountResult>
  /** Deletes the account's secret and the account. Nothing changes at the service. */
  removeAccount(request: PluginAccountRemove): Promise<PluginAccountResult>
  /** Switches an account on or off for threads, or keeps it to chosen projects. */
  updateAccount(request: PluginAccountUpdate): Promise<PluginAccountResult>
  /** This computer's projects, for choosing which ones an account is kept to. */
  projects(): Promise<PluginProject[]>
  /** The user's other computers and where each account's copy stands on each. */
  copies(): Promise<PluginCopiesView>
  /** Keeps a copy of an account on one of the user's other computers, or stops keeping one. */
  setCopy(request: PluginCopySet): Promise<PluginCopiesView>
  /** Whether a new account, or a newly paired computer, starts with a copy. */
  setCopyNew(copyNew: boolean): Promise<PluginCopiesView>
  /** Told when a copy arrived, a computer connected or left, or a choice changed. Returns the way to stop. */
  onCopiesChanged(listener: () => void): () => void
}

/** The one name every client addresses the plugin tools by (ADR-0205). */
export const PLUGINS_MCP_SERVER = 'sotto_plugins'
export const PLUGIN_ACCOUNTS_TOOL = 'plugin_accounts'
export const PLUGIN_READ_TOOL = 'plugin_read'
/** The named tools that change something (ADR-0205, decision 6): each asks the user before anything is sent. */
export const GITHUB_COMMENT_TOOL = 'github_comment'
export const GITHUB_OPEN_ISSUE_TOOL = 'github_open_issue'
export const GITHUB_CLOSE_ISSUE_TOOL = 'github_close_issue'
export const GITHUB_REOPEN_ISSUE_TOOL = 'github_reopen_issue'
export const VERCEL_CANCEL_TOOL = 'vercel_cancel_deployment'
export const VERCEL_PROMOTE_TOOL = 'vercel_promote_deployment'
export const VERCEL_ROLLBACK_TOOL = 'vercel_rollback_production'
export const PLUGIN_CHANGE_TOOLS = [GITHUB_COMMENT_TOOL, GITHUB_OPEN_ISSUE_TOOL, GITHUB_CLOSE_ISSUE_TOOL, GITHUB_REOPEN_ISSUE_TOOL, VERCEL_CANCEL_TOOL, VERCEL_PROMOTE_TOOL, VERCEL_ROLLBACK_TOOL] as const
export type PluginChangeTool = typeof PLUGIN_CHANGE_TOOLS[number]

export const PLUGINS_RECENT_USE = 'sotto:plugins:recent-use'

/**
 * What a use was of, as far as the record keeps it: a kind of thing read or changed, never which one. A repository's
 * name, an issue's number, a comment's words and what a read returned are the user's own and stay out of the record
 * (ADR-0205, decision 10). Those from `comment` on are changes: a comment posted, an issue opened, closed or
 * reopened, a deployment's build cancelled, a deployment promoted to production, and production rolled back.
 */
export const PLUGIN_READ_KINDS = ['issues', 'pull-requests', 'repository', 'commits', 'checks', 'releases', 'search', 'account', 'deployments', 'projects', 'domains', 'logs', 'other',
  'comment', 'deployment-cancel', 'issue-open', 'issue-close', 'issue-reopen', 'deployment-promote', 'deployment-rollback'] as const
export type PluginReadKind = typeof PLUGIN_READ_KINDS[number]

/**
 * How a use ended: done, refused by Sotto before anything was sent, or failed at the service. A change can also end
 * with the user saying no (`denied`) or with nobody answering its card in time (`lapsed`); nothing was sent for either.
 */
export const PLUGIN_USE_OUTCOMES = ['done', 'refused', 'failed', 'denied', 'lapsed'] as const

/** One entry of the plugin use record: the thread, the plugin, what was done and how it ended. Never its content. */
export const pluginUseSchema = z.object({
  id: z.uuid(),
  at: z.iso.datetime(),
  threadId: z.string().min(1).max(200),
  plugin: z.enum(PLUGIN_IDS),
  /** The plugin account the use was through, by Sotto's own ID. None for GitHub, whose account is gh's sign-in. */
  accountId: z.uuid().optional(),
  tool: z.enum([PLUGIN_READ_TOOL, ...PLUGIN_CHANGE_TOOLS]),
  kind: z.enum(PLUGIN_READ_KINDS),
  outcome: z.enum(PLUGIN_USE_OUTCOMES),
}).strict()
export type PluginUse = z.infer<typeof pluginUseSchema>

/** How many uses the record keeps: enough for Recent use on every row, and no growing history. */
export const PLUGIN_USE_KEPT = 200
/** How many of a plugin's uses its row shows. */
export const PLUGIN_USE_SHOWN = 5

/** The longest name a thread can have (`agents.ts`: a thread's title, and what rename-thread takes). */
export const PLUGIN_USE_THREAD_TITLE_MAX = 512
/** A use as Settings shows it: with the thread's name as it is now, or none when the thread is gone. */
export const shownPluginUseSchema = pluginUseSchema.extend({ threadTitle: z.string().max(PLUGIN_USE_THREAD_TITLE_MAX).nullable() }).strict()
export type ShownPluginUse = z.infer<typeof shownPluginUseSchema>
export const shownPluginUsesSchema = z.array(shownPluginUseSchema).max(PLUGIN_USE_KEPT)

/**
 * Plugin accounts (ADR-0205): one sign-in to a plugin that the user added and named. Its secret sits in the credential
 * store and is never among these fields: the window learns that it is saved and when, and nothing more.
 */
export const PLUGINS_ACCOUNTS = 'sotto:plugins:accounts'
export const PLUGINS_ACCOUNT_ADD = 'sotto:plugins:account-add'
export const PLUGINS_ACCOUNT_REPLACE = 'sotto:plugins:account-replace'
export const PLUGINS_ACCOUNT_REMOVE = 'sotto:plugins:account-remove'
export const PLUGINS_ACCOUNT_UPDATE = 'sotto:plugins:account-update'
export const PLUGINS_PROJECTS = 'sotto:plugins:projects'
export const PLUGINS_COPIES = 'sotto:plugins:copies'
export const PLUGINS_COPY_SET = 'sotto:plugins:copy-set'
export const PLUGINS_COPY_NEW_SET = 'sotto:plugins:copy-new-set'
export const PLUGINS_COPIES_CHANGED = 'sotto:plugins:copies-changed'

/** The plugins an account is added to by pasting a secret. GitHub is not one: its account is gh's own sign-in. */
export const ACCOUNT_PLUGIN_IDS = ['vercel'] as const
export type AccountPluginId = typeof ACCOUNT_PLUGIN_IDS[number]

export const PLUGIN_ACCOUNT_NAME_MAX = 40
/** Longer than any token a plugin issues, and short enough that a pasted file is turned away. */
export const PLUGIN_SECRET_MAX = 1_000
/** How many accounts one plugin holds. */
export const PLUGIN_ACCOUNTS_MAX = 10
/** How many projects one account can be kept to. */
export const PLUGIN_ACCOUNT_PROJECTS_MAX = 200
const projectIdSchema = z.string().min(1).max(512)

/** A name the user gives an account: what the page shows and what an agent names it by. */
export const pluginAccountNameSchema = z.string().trim().min(1).max(PLUGIN_ACCOUNT_NAME_MAX)
  .refine(name => [...name].every(character => character.charCodeAt(0) >= 0x20 && character.charCodeAt(0) !== 0x7f))

/** An account as the window sees it. `signedInAs` is the service's own name for the account, when it gave one. */
export const pluginAccountSchema = z.object({
  id: z.uuid(),
  plugin: z.enum(ACCOUNT_PLUGIN_IDS),
  name: z.string().min(1).max(PLUGIN_ACCOUNT_NAME_MAX),
  savedAt: z.iso.datetime(),
  signedInAs: z.string().max(200).nullable(),
  /** Whether threads may use the account at all (ADR-0205, decision 9). An account kept before the switch existed is on. */
  on: z.boolean().default(true),
  /**
   * The projects whose threads may use it. Null is every project. A project is its folder on this computer, under a
   * name of Sotto's own, so it is the same project for every provider that works in that folder.
   */
  projects: z.array(projectIdSchema).max(PLUGIN_ACCOUNT_PROJECTS_MAX).nullable().default(null),
}).strict()
export type PluginAccount = z.infer<typeof pluginAccountSchema>

/**
 * Whether a thread may use an account: it is on, and it is either for every project or for the thread's own. A
 * thread with no project to go by, as Watcher's is, may use only an account kept to none: an account kept to chosen
 * projects is for those projects' threads and nobody else.
 */
export function pluginAccountAdmits(account: Pick<PluginAccount, 'on' | 'projects'>, projectId: string | null): boolean {
  return account.on && (account.projects === null || (projectId !== null && account.projects.includes(projectId)))
}
export const pluginAccountsSchema = z.array(pluginAccountSchema).max(ACCOUNT_PLUGIN_IDS.length * PLUGIN_ACCOUNTS_MAX)

export const pluginAccountAddSchema = z.object({ plugin: z.enum(ACCOUNT_PLUGIN_IDS), name: pluginAccountNameSchema, secret: z.string().min(1).max(PLUGIN_SECRET_MAX) }).strict()
export type PluginAccountAdd = z.infer<typeof pluginAccountAddSchema>
export const pluginAccountReplaceSchema = z.object({ id: z.uuid(), secret: z.string().min(1).max(PLUGIN_SECRET_MAX) }).strict()
export type PluginAccountReplace = z.infer<typeof pluginAccountReplaceSchema>
export const pluginAccountRemoveSchema = z.object({ id: z.uuid() }).strict()
export type PluginAccountRemove = z.infer<typeof pluginAccountRemoveSchema>
/** A change to which threads may use an account: its switch, the projects it is kept to, or both. Null is every project. */
export const pluginAccountUpdateSchema = z.object({
  id: z.uuid(), on: z.boolean().optional(),
  projects: z.array(projectIdSchema).min(1).max(PLUGIN_ACCOUNT_PROJECTS_MAX).nullable().optional(),
}).strict().refine(update => update.on !== undefined || update.projects !== undefined)
export type PluginAccountUpdate = z.infer<typeof pluginAccountUpdateSchema>

/** A project as the page offers it for an account: its name, and whether it is settled, which keeps it off the list unless it is chosen. */
export const pluginProjectSchema = z.object({ id: projectIdSchema, title: z.string().max(512), settled: z.boolean() }).strict()
export type PluginProject = z.infer<typeof pluginProjectSchema>
export const pluginProjectsSchema = z.array(pluginProjectSchema).max(10_000)

/**
 * Where an account's copy on another computer stands (ADR-0205, amending ADR-0025). `kept`: that computer holds the
 * account as it is here. `waiting`: a copy is wanted and the computer has not answered for it, because it is not
 * connected or is being asked now. `off`: the user keeps no copy there. `too-old`: its Sotto cannot keep copies.
 * `no-key`: it could not keep the secret, as a host started without a key file cannot. `full`: it holds as many
 * accounts of the plugin as a plugin takes. `name-taken`, `held`: another of the user's computers sent it an account
 * of that name, or that very account. `locked`: this computer's credential store would not hand over the secret.
 * `failed`: the copy could not be sent, and is tried again. `no-record`: this computer cannot read its own record of
 * which computers keep a copy, so none is sent and this one is not taken back.
 */
export const PLUGIN_ACCOUNT_COPY_STATES = ['kept', 'waiting', 'off', 'here-only', 'no-record', 'too-old', 'no-key', 'full', 'name-taken', 'held', 'locked', 'failed'] as const
export type PluginAccountCopyState = typeof PLUGIN_ACCOUNT_COPY_STATES[number]
/**
 * Whether a computer may still hold a copy that is not wanted there, `off` or `here-only`. Only the computer can say
 * it holds none. `no`: it said so, or no copy is leaving. `now`: it is known to hold one and is being told to let it
 * go. `asking`: it is connected and has not yet said what it holds. `away`: it is not connected, and is told when it
 * next is. `cannot`: its Sotto does not keep account copies now, so it can neither say what it holds nor delete one.
 */
export const PLUGIN_ACCOUNT_COPY_LEAVING = ['no', 'now', 'asking', 'away', 'cannot'] as const
export type PluginAccountCopyLeaving = typeof PLUGIN_ACCOUNT_COPY_LEAVING[number]
/** How many computers the page is told of: more than anyone pairs. */
const PLUGIN_COPY_COMPUTERS_MAX = 200
const computerIdSchema = z.string().min(1).max(512)
/** The user's other computers and each account's copy on each, for Settings › Plugins. Never a secret, and nothing of where a computer is. */
export const pluginCopiesViewSchema = z.object({
  /** Whether a new account, or a newly paired computer, starts with a copy. */
  copyNew: z.boolean(),
  /** Whether this computer could read its record of choices. Where it could not, nothing is sent and no choice can be made. */
  readable: z.boolean(),
  computers: z.array(z.object({ id: computerIdSchema, name: z.string().max(512), connected: z.boolean() }).strict()).max(PLUGIN_COPY_COMPUTERS_MAX),
  copies: z.array(z.object({ accountId: z.uuid(), computerId: computerIdSchema, state: z.enum(PLUGIN_ACCOUNT_COPY_STATES), leaving: z.enum(PLUGIN_ACCOUNT_COPY_LEAVING) }).strict())
    .max(PLUGIN_COPY_COMPUTERS_MAX * ACCOUNT_PLUGIN_IDS.length * PLUGIN_ACCOUNTS_MAX),
}).strict()
export type PluginCopiesView = z.infer<typeof pluginCopiesViewSchema>
export const pluginCopySetSchema = z.object({ accountId: z.uuid(), computerId: computerIdSchema, on: z.boolean() }).strict()
export type PluginCopySet = z.infer<typeof pluginCopySetSchema>
export const pluginCopyNewSetSchema = z.object({ copyNew: z.boolean() }).strict()

/**
 * Why an account was not saved or removed. `refused`: the service did not accept the secret. `unreachable`: the service
 * could not be asked. `busy`: the service is turning requests away for now. `name-taken`, `limit`: the plugin already has that name, or its full count of accounts.
 * `store`: Sotto could not keep the secret or the account. `gone`: the account is no longer there.
 */
export const PLUGIN_ACCOUNT_PROBLEMS = ['refused', 'unreachable', 'busy', 'name-taken', 'limit', 'store', 'gone'] as const
export type PluginAccountProblem = typeof PLUGIN_ACCOUNT_PROBLEMS[number]
export const pluginAccountResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), accounts: pluginAccountsSchema }).strict(),
  z.object({ ok: z.literal(false), problem: z.enum(PLUGIN_ACCOUNT_PROBLEMS) }).strict(),
])
export type PluginAccountResult = z.infer<typeof pluginAccountResultSchema>

/**
 * A plugin change as its tool asked for it, for the card that asks the user first (ADR-0205, decision 7). The card is
 * worded from this, so it says in plain words what will happen and shows everything that will be sent.
 */
export type PluginChange =
  | {
    readonly kind: 'github-comment'; readonly owner: string; readonly repo: string; readonly number: number; readonly body: string
    /** Who gh is signed in to github.com as, where it said: the account the comment is posted as. */
    readonly account?: string
  }
  | { readonly kind: 'github-open-issue'; readonly owner: string; readonly repo: string; readonly title: string; readonly body: string; readonly account?: string }
  | {
    readonly kind: 'github-close-issue' | 'github-reopen-issue'; readonly owner: string; readonly repo: string; readonly number: number
    /** The issue's title as GitHub gave it, read before asking, so the card names the issue in words. */
    readonly title: string
    /** Why it is closed, which is sent with the call: finished, or not going to be done. */
    readonly reason?: 'completed' | 'not_planned'
    readonly account?: string
  }
  | {
    /** Promote and roll back move production: every production address of the project serves the deployment. */
    readonly kind: 'vercel-cancel' | 'vercel-promote' | 'vercel-rollback'; readonly account: string; readonly deploymentId: string
    /** The project the deployment belongs to, by Vercel's own ID for it. Promote and roll back send it. */
    readonly projectId?: string
    /** The team the agent named, which is sent with the call. */
    readonly teamId?: string
    /** What Vercel says of the deployment, read before asking, where it said: none of it is taken on trust for the call. */
    readonly project?: string; readonly target?: string; readonly url?: string; readonly state?: string
  }
