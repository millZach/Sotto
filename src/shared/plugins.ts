import { z } from 'zod'
import type { Model3dBytesRequest, Model3dListed, Model3dRemoval, Model3dRevealRequest, Model3dView } from './models3d'
import type { SoundView } from './sounds'

/**
 * Plugins (ADR-0205): outside services Sotto can connect once, so every thread's agent has one known place to use
 * them. An Owl feature. A plugin joins this list in the slice that makes it work, so the page never shows a row that
 * does nothing; docs/plans/2026-11-11-plugins.md has the order.
 */
export const PLUGINS_FEATURE = 'plugins'

/** The groups Settings › Plugins sets its rows in, in the page's order. */
export const PLUGIN_GROUPS = ['code', 'mail', 'media'] as const
export type PluginGroupId = typeof PLUGIN_GROUPS[number]

/** Every plugin a thread's agent can use, each with a row on Settings › Plugins. */
export const PLUGIN_IDS = ['github', 'vercel', 'gmail', 'proton-mail', 'meshy', 'elevenlabs', 'higgsfield'] as const
export type PluginId = typeof PLUGIN_IDS[number]
/** Each plugin's name, which is the service's own and the same in every language. */
export const PLUGIN_NAMES: Readonly<Record<PluginId, string>> = { github: 'GitHub', vercel: 'Vercel', gmail: 'Gmail', 'proton-mail': 'Proton Mail', meshy: 'Meshy', elevenlabs: 'ElevenLabs', higgsfield: 'Higgsfield' }

/** The plugins that are mail accounts: read over IMAP, each thread asking once (ADR-0205, decision 8). */
export const MAIL_PLUGIN_IDS = ['gmail', 'proton-mail'] as const
export type MailPluginId = typeof MAIL_PLUGIN_IDS[number]
export const isMailPlugin = (plugin: string): plugin is MailPluginId => (MAIL_PLUGIN_IDS as readonly string[]).includes(plugin)

/** A plugin as the page lists it. Its name is the service's own and is the same in every language. */
export interface PluginEntry { readonly id: PluginId; readonly name: string; readonly group: PluginGroupId }

/** The rows of Settings › Plugins: the plugins a user can connect there today. */
export const PLUGINS: readonly PluginEntry[] = [
  { id: 'github', name: 'GitHub', group: 'code' },
  { id: 'vercel', name: 'Vercel', group: 'code' },
  { id: 'gmail', name: 'Gmail', group: 'mail' },
  { id: 'proton-mail', name: 'Proton Mail', group: 'mail' },
  { id: 'meshy', name: 'Meshy', group: 'media' },
  { id: 'elevenlabs', name: 'ElevenLabs', group: 'media' },
  { id: 'higgsfield', name: 'Higgsfield', group: 'media' },
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
  /** Keeps the certificate a Proton Mail account's Bridge shows now, once Bridge takes the saved Bridge password. */
  trustCertificate(request: PluginAccountRemove): Promise<PluginAccountResult>
  /** Where Proton Mail Bridge stands for an account, looked at without signing in. */
  bridgeStatus(request: PluginAccountRemove): Promise<BridgeStatus>
  /** The credits each Meshy account's 3D models took this month. */
  meshyCredits(): Promise<MeshyCredits>
  /** Told when what a paired host said it spent changed, so the credits are read again. Returns the way to stop. */
  onMeshyCreditsChanged?(listener: () => void): () => void
  /** What each ElevenLabs account's sounds cost this month on this computer, in US dollars. */
  elevenLabsSpent?(): Promise<ElevenLabsSpent>
  /** Told when a sound was made or failed here, so what was spent is read again. Returns the way to stop. */
  onElevenLabsSpentChanged?(listener: () => void): () => void
  /** One 3D model as its thread draws it, by its ID, or null when Sotto holds no such 3D model (ADR-0141). */
  model3d(id: string): Promise<Model3dView | null>
  /** A 3D model's GLB, still picture or shape while the texture is painted, or null when Sotto will not hand them over. */
  model3dBytes(request: Model3dBytesRequest): Promise<Uint8Array | null>
  /** Told each 3D model's view whenever it changes. Returns the way to stop. */
  onModel3dChanged(listener: (view: Model3dView) => void): () => void
  /** Every 3D model being made or done, newest first, or one thread's (the Meshy plan's ticket 5). */
  models3d(threadId?: string): Promise<Model3dListed[]>
  /** Removes the record of a 3D model whose files are gone, never a file, and says what became of it. */
  removeModel3d(id: string): Promise<Model3dRemoval>
  /** Shows one of a 3D model's files in the folder app, by its name; its GLB when none is named. */
  revealModel3d(request: Model3dRevealRequest): Promise<boolean>
  /** Told the IDs of 3D models whose records went, with their forgotten thread or by Remove from 3D models. Returns the way to stop. */
  onModels3dRemoved(listener: (ids: readonly string[]) => void): () => void
  /** One sound as its thread draws it, by its ID, or null when Sotto holds no such sound (the plugins plan's slice 12, part 3). */
  sound?(id: string): Promise<SoundView | null>
  /** A made sound's MP3, or null when Sotto will not hand it over. Asked for only when the user presses Play. */
  soundBytes?(id: string): Promise<Uint8Array | null>
  /** Shows a made sound's MP3 in the folder app. */
  revealSound?(id: string): Promise<boolean>
  /** Told each sound's view whenever its record changes. Returns the way to stop. */
  onSoundChanged?(listener: (view: SoundView) => void): () => void
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
  /** The mail accounts a thread on this computer has been let read, for that thread's menu. */
  mailGrants(threadId: string): Promise<ThreadMailGrant[]>
  /** Ends a thread's leave to read a mail account, so it asks again. False when it could not be ended; it then still stands. */
  stopMailGrant(request: MailGrantStop): Promise<boolean>
  /** Told when some thread's mail grant was given or ended. Returns the way to stop. */
  onMailGrantsChanged(listener: () => void): () => void
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
/** Sends one email from a mail account. It asks every time, and no switch turns that off (decision 6). */
export const MAIL_SEND_TOOL = 'mail_send'
/**
 * Makes one 3D model with Meshy (ADR-0141). It asks first, unless the user turned off the account's Ask before each 3D
 * model, and never past the month's credit limit.
 */
export const MAKE_3D_MODEL_TOOL = 'make_3d_model'
/**
 * Makes one sound with ElevenLabs, as an MP3 in the thread's folder (ADR-0205, slice 12): speech, a sound effect or
 * music. It asks first, unless the user turned off the account's Ask before each sound, and never past the month's
 * limit in dollars.
 */
export const MAKE_SOUND_TOOL = 'make_sound'
export const PLUGIN_CHANGE_TOOLS = [GITHUB_COMMENT_TOOL, GITHUB_OPEN_ISSUE_TOOL, GITHUB_CLOSE_ISSUE_TOOL, GITHUB_REOPEN_ISSUE_TOOL, VERCEL_CANCEL_TOOL, VERCEL_PROMOTE_TOOL, VERCEL_ROLLBACK_TOOL, MAIL_SEND_TOOL, MAKE_3D_MODEL_TOOL, MAKE_SOUND_TOOL] as const
export type PluginChangeTool = typeof PLUGIN_CHANGE_TOOLS[number]

export const PLUGINS_RECENT_USE = 'sotto:plugins:recent-use'

/**
 * What a use was of, as far as the record keeps it: a kind of thing read or changed, never which one. A repository's
 * name, an issue's number, a comment's words and what a read returned are the user's own and stay out of the record
 * (ADR-0205, decision 10). Those from `comment` on are changes: a comment posted, an issue opened, closed or
 * reopened, a deployment's build cancelled, a deployment promoted to production, and production rolled back. Then
 * two reads of a mail account, a search and a message opened, and an email sent, which is a change. Never who an
 * email went to or what it said. Then a 3D model made with Meshy: never its words or its photo. Last, a sound made
 * with ElevenLabs, by its kind alone, speech, a sound effect or music: never its words, its voice or its name.
 */
export const PLUGIN_READ_KINDS = ['issues', 'pull-requests', 'repository', 'commits', 'checks', 'releases', 'search', 'account', 'deployments', 'projects', 'domains', 'logs', 'other',
  'comment', 'deployment-cancel', 'issue-open', 'issue-close', 'issue-reopen', 'deployment-promote', 'deployment-rollback', 'mail-search', 'mail-message', 'mail-send', '3d-model',
  'sound-speech', 'sound-effect', 'sound-music'] as const
export type PluginReadKind = typeof PLUGIN_READ_KINDS[number]

/**
 * How a use ended: done, refused by Sotto before anything was sent, or failed at the service. A change, and a
 * thread's first read of a mail account, can also end with the user saying no (`denied`) or with nobody answering its
 * card in time (`lapsed`); nothing was sent for either. An email can also end `unsure`: the user allowed it, the whole
 * message was handed to the mail server, and its answer never came, so Sotto cannot tell whether it was sent.
 */
export const PLUGIN_USE_OUTCOMES = ['done', 'refused', 'failed', 'denied', 'lapsed', 'unsure'] as const

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
export const PLUGINS_ACCOUNT_TRUST = 'sotto:plugins:account-trust'
export const PLUGINS_BRIDGE_STATUS = 'sotto:plugins:bridge-status'
/**
 * The credits each Meshy account's 3D models took this month, by account ID (ADR-0141): the month starts on the 1st,
 * by this computer's clock (Zach's pick on November 15, 2026). `here` is this computer's own. `credits` is the one
 * monthly limit's count (ADR-0205): this computer's and what each paired host holding the account's copy last said it
 * spent, and `across` names those hosts.
 */
export const PLUGINS_MESHY_CREDITS = 'sotto:plugins:meshy-credits'
/**
 * Main to the window: what a paired host said its threads spent of a Meshy account changed (ADR-0205), so the shared
 * count the 3D models page and Settings show is read again. A 3D model here changing is told by its own news.
 */
export const PLUGINS_MESHY_CREDITS_CHANGED = 'sotto:plugins:meshy-credits-changed'
/**
 * Main to the window: a sound was made or failed on this computer, or a paired host said what it spent of an ElevenLabs
 * account, so what each account spent is read again.
 */
export const PLUGINS_ELEVENLABS_SPENT_CHANGED = 'sotto:plugins:elevenlabs-spent-changed'
const creditCount = z.number().int().nonnegative()
export const meshyCreditsSchema = z.record(z.uuid(), z.object({ here: creditCount, credits: creditCount, across: z.array(z.string().max(200)).max(100) }).strict())
export type MeshyCredits = z.infer<typeof meshyCreditsSchema>
/**
 * What each ElevenLabs account's sounds cost this month, in US dollars at ElevenLabs' published API prices, by account
 * ID (ADR-0205, slice 12): the month starts on the 1st, by this computer's clock. `spent` is this computer's and every
 * paired host's that said what it spent of the account, and `across` names those hosts, as a Meshy account's credits are.
 */
export const PLUGINS_ELEVENLABS_SPENT = 'sotto:plugins:elevenlabs-spent'
export const elevenLabsSpentSchema = z.record(z.uuid(), z.object({ spent: z.number().nonnegative().max(10_000_000), across: z.array(z.string().max(200)).max(100) }).strict())
export type ElevenLabsSpent = z.infer<typeof elevenLabsSpentSchema>
/**
 * A sum in US dollars as Sotto says it, with two decimals: "$0.03". Null for one above nothing and below a cent, which
 * is said in words, "under $0.01", by whoever shows it in the interface language.
 */
export function dollarFigure(amount: number): string | null {
  if (amount > 0 && amount < 0.01) return null
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
/** A monthly limit in whole US dollars as Sotto says it: "$10". */
export const dollarLimit = (limit: number): string => `$${limit.toLocaleString('en-US')}`
/**
 * Where Proton Mail Bridge stands for an account on this computer: answering with the certificate kept, not running,
 * showing another certificate, or not known, as for an account that is not Proton Mail's.
 */
export const BRIDGE_STATUSES = ['running', 'not-running', 'certificate', 'unknown'] as const
export type BridgeStatus = typeof BRIDGE_STATUSES[number]
export const bridgeStatusSchema = z.enum(BRIDGE_STATUSES)
export const PLUGINS_PROJECTS = 'sotto:plugins:projects'
export const PLUGINS_COPIES = 'sotto:plugins:copies'
export const PLUGINS_COPY_SET = 'sotto:plugins:copy-set'
export const PLUGINS_COPY_NEW_SET = 'sotto:plugins:copy-new-set'
export const PLUGINS_COPIES_CHANGED = 'sotto:plugins:copies-changed'
export const PLUGINS_MAIL_GRANTS = 'sotto:plugins:mail-grants'
export const PLUGINS_MAIL_GRANT_STOP = 'sotto:plugins:mail-grant-stop'
export const PLUGINS_MAIL_GRANTS_CHANGED = 'sotto:plugins:mail-grants-changed'

/** The plugins an account is added to by pasting a secret. GitHub is not one: its account is gh's own sign-in. */
export const ACCOUNT_PLUGIN_IDS = ['vercel', 'gmail', 'proton-mail', 'meshy', 'elevenlabs', 'higgsfield'] as const
export type AccountPluginId = typeof ACCOUNT_PLUGIN_IDS[number]

/** A mail account's address, which signs in to it beside its password: one address, with nothing a mail server would read as more. */
export const PLUGIN_MAIL_ADDRESS_MAX = 320
export const pluginMailAddressSchema = z.string().trim().min(3).max(PLUGIN_MAIL_ADDRESS_MAX).regex(/^[^\s@<>"\\]+@[^\s@<>"\\]+$/u)

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

/**
 * A Higgsfield account's secret is a key ID and a key secret (ADR-0205, the plugins plan's slice 13). Higgsfield takes
 * them in one header as `Key <KEY_ID>:<KEY_SECRET>`, so Sotto keeps them the same way, joined by a colon in the one
 * credential slot the account has, and a copy to a host carries them unchanged. Each part is one line of characters a
 * header can carry, with no colon, so the two can always be told apart.
 */
export const PLUGIN_KEY_PART_MAX = 400
export const pluginKeyPartSchema = z.string().trim().min(1).max(PLUGIN_KEY_PART_MAX).regex(/^[\x21-\x39\x3b-\x7e]+$/u)
/** Whether a plugin's secret is a key ID and a key secret, asked for as two fields and kept as `<KEY_ID>:<KEY_SECRET>`. */
export const hasKeyId = (plugin: string): plugin is 'higgsfield' => plugin === 'higgsfield'

/** The most a monthly limit can be set to: far past any plan Meshy, ElevenLabs or Higgsfield sells, and short of nonsense. */
export const PLUGIN_MONTHLY_LIMIT_MAX = 1_000_000
/** Meshy's monthly credit limit when an account is added, its Pro plan's credits (ADR-0141). */
export const MESHY_MONTHLY_LIMIT_DEFAULT = 1_000
/**
 * ElevenLabs' monthly limit when an account is added, in whole US dollars at its published API prices (Zach's pick on
 * #2498, November 15, 2026): ElevenLabs bills its API in dollars, not credits.
 */
export const ELEVENLABS_MONTHLY_LIMIT_DEFAULT = 10
/**
 * Higgsfield's monthly limit when an account is added, in whole US dollars at its published prices (Zach's pick on
 * #2499, November 16, 2026): Higgsfield is paid from a prepaid balance in dollars.
 */
export const HIGGSFIELD_MONTHLY_LIMIT_DEFAULT = 10
/** What an account that spends may spend: whether each paid thing asks first, and the most it spends in a month. */
export const pluginSpendingSchema = z.object({ askBefore: z.boolean(), monthlyLimit: z.number().int().min(0).max(PLUGIN_MONTHLY_LIMIT_MAX) }).strict()
export type PluginSpending = z.infer<typeof pluginSpendingSchema>
/** The plugins whose accounts spend, and so carry an Ask before each switch and a monthly limit. */
export const SPENDING_PLUGIN_IDS = ['meshy', 'elevenlabs', 'higgsfield'] as const
export type SpendingPluginId = typeof SPENDING_PLUGIN_IDS[number]
/** Whether a plugin's accounts spend, and so carry an Ask before each switch and a monthly limit. */
export const isSpendingPlugin = (plugin: string): plugin is SpendingPluginId => (SPENDING_PLUGIN_IDS as readonly string[]).includes(plugin)
/**
 * Each spending plugin's monthly limit when an account is added, in the unit the service bills in: Meshy's credits,
 * ElevenLabs' and Higgsfield's whole US dollars.
 */
export const PLUGIN_MONTHLY_LIMIT_DEFAULTS: Readonly<Record<SpendingPluginId, number>> = { meshy: MESHY_MONTHLY_LIMIT_DEFAULT, elevenlabs: ELEVENLABS_MONTHLY_LIMIT_DEFAULT, higgsfield: HIGGSFIELD_MONTHLY_LIMIT_DEFAULT }

/** An account as the window sees it. `signedInAs` is the service's own name for the account, when it gave one. */
export const pluginAccountSchema = z.object({
  id: z.uuid(),
  plugin: z.enum(ACCOUNT_PLUGIN_IDS),
  name: z.string().min(1).max(PLUGIN_ACCOUNT_NAME_MAX),
  savedAt: z.iso.datetime(),
  signedInAs: z.string().max(200).nullable(),
  /** A mail account's address. A plugin that is not mail has none. */
  address: pluginMailAddressSchema.optional(),
  /** Whether threads may use the account at all (ADR-0205, decision 9). An account kept before the switch existed is on. */
  on: z.boolean().default(true),
  /**
   * The projects whose threads may use it. Null is every project. A project is its folder on this computer, under a
   * name of Sotto's own, so it is the same project for every provider that works in that folder.
   */
  projects: z.array(projectIdSchema).max(PLUGIN_ACCOUNT_PROJECTS_MAX).nullable().default(null),
  /**
   * What an account that spends may spend (ADR-0205 decision 7, ADR-0141; Zach's pick on November 15, 2026 that it
   * lives on the account): whether each paid thing asks first, on by default, and the most it spends in a month.
   * Meshy's accounts have it in Meshy's credits, and ElevenLabs' and Higgsfield's in whole US dollars.
   */
  spending: pluginSpendingSchema.optional(),
  /**
   * A Proton Mail account's Bridge on this computer (ADR-0205, slice 10): the ports it listens on at 127.0.0.1, and
   * the SHA-256 of the certificate it showed when the account was added or the user last trusted it. No other
   * plugin's account has one. Not a secret: it names a certificate and does not open anything.
   */
  bridge: z.object({ imapPort: z.number().int().min(1).max(65_535), smtpPort: z.number().int().min(1).max(65_535), certificate: z.string().regex(/^[0-9a-f]{64}$/u) }).strict().optional(),
}).strict()
export type PluginAccount = z.infer<typeof pluginAccountSchema>
/** Bridge's two ports, which are never the same: reading goes to one and sending to the other. */
export const bridgePortsSchema = z.object({ imapPort: z.number().int().min(1).max(65_535), smtpPort: z.number().int().min(1).max(65_535) }).strict()
  .refine(ports => ports.imapPort !== ports.smtpPort)
export type BridgePorts = z.infer<typeof bridgePortsSchema>
/** Proton Mail Bridge's own ports, which the add form starts with (Zach's pick on November 14, 2026). */
export const BRIDGE_DEFAULT_PORTS: BridgePorts = { imapPort: 1143, smtpPort: 1025 }
/** Whether a plugin's accounts are reached through Proton Mail Bridge on this computer, and kept on it. */
export const isBridgePlugin = (plugin: string): plugin is 'proton-mail' => plugin === 'proton-mail'

/**
 * Whether a thread may use an account: it is on, and it is either for every project or for the thread's own. A
 * thread with no project to go by, as Watcher's is, may use only an account kept to none: an account kept to chosen
 * projects is for those projects' threads and nobody else.
 */
export function pluginAccountAdmits(account: Pick<PluginAccount, 'on' | 'projects'>, projectId: string | null): boolean {
  return account.on && (account.projects === null || (projectId !== null && account.projects.includes(projectId)))
}
export const pluginAccountsSchema = z.array(pluginAccountSchema).max(ACCOUNT_PLUGIN_IDS.length * PLUGIN_ACCOUNTS_MAX)

/**
 * Whether a secret and a key ID go together for a plugin: for Higgsfield, a key ID and a key secret that are each one
 * part as `pluginKeyPartSchema` says; for any other plugin, no key ID.
 */
export const pluginKeyIdFits = (plugin: string, secret: string, keyId: string | undefined): boolean =>
  hasKeyId(plugin) ? keyId !== undefined && pluginKeyPartSchema.safeParse(keyId).success && pluginKeyPartSchema.safeParse(secret).success : keyId === undefined
/**
 * A new account: its plugin, the name the user gives it, its secret, for a mail account the address the secret signs
 * in, and for Higgsfield the key ID that goes with the key secret.
 */
export const pluginAccountAddSchema = z.object({
  plugin: z.enum(ACCOUNT_PLUGIN_IDS), name: pluginAccountNameSchema, secret: z.string().min(1).max(PLUGIN_SECRET_MAX), address: pluginMailAddressSchema.optional(),
  /** For Proton Mail, and only for it: Bridge's ports on this computer. */
  bridge: bridgePortsSchema.optional(),
  /** For Higgsfield, and only for it: the key ID, with the key secret as `secret`. */
  keyId: pluginKeyPartSchema.optional(),
}).strict().refine(account => isMailPlugin(account.plugin) === (account.address !== undefined) && isBridgePlugin(account.plugin) === (account.bridge !== undefined)
  && pluginKeyIdFits(account.plugin, account.secret, account.keyId))
export type PluginAccountAdd = z.infer<typeof pluginAccountAddSchema>
/** A new secret for an account. A Higgsfield account's comes with its key ID; main checks that against the account's plugin. */
export const pluginAccountReplaceSchema = z.object({ id: z.uuid(), secret: z.string().min(1).max(PLUGIN_SECRET_MAX), keyId: pluginKeyPartSchema.optional() }).strict()
export type PluginAccountReplace = z.infer<typeof pluginAccountReplaceSchema>
export const pluginAccountRemoveSchema = z.object({ id: z.uuid() }).strict()
export type PluginAccountRemove = z.infer<typeof pluginAccountRemoveSchema>
/** A change to which threads may use an account: its switch, the projects it is kept to, or both. Null is every project. */
export const pluginAccountUpdateSchema = z.object({
  id: z.uuid(), on: z.boolean().optional(),
  /** For an account that spends: whether each paid thing asks first, and the month's limit. */
  askBefore: z.boolean().optional(), monthlyLimit: z.number().int().min(0).max(PLUGIN_MONTHLY_LIMIT_MAX).optional(),
  projects: z.array(projectIdSchema).min(1).max(PLUGIN_ACCOUNT_PROJECTS_MAX).nullable().optional(),
}).strict().refine(update => update.on !== undefined || update.projects !== undefined || update.askBefore !== undefined || update.monthlyLimit !== undefined)
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
 * The mail accounts one thread has been let read (ADR-0205, decision 8), for the thread's own menu: each by Sotto's
 * ID for it and the name the user gave it. Never its address, and nothing of any other thread.
 */
export const threadMailGrantsSchema = z.array(z.object({ accountId: z.uuid(), plugin: z.enum(MAIL_PLUGIN_IDS), name: z.string().min(1).max(PLUGIN_ACCOUNT_NAME_MAX) }).strict())
  .max(MAIL_PLUGIN_IDS.length * PLUGIN_ACCOUNTS_MAX)
export type ThreadMailGrant = z.infer<typeof threadMailGrantsSchema>[number]
/** A thread as the window names it: its ID, behind the key that says which computer holds it. */
const grantThreadIdSchema = z.string().min(1).max(512)
export const mailGrantsOfSchema = z.object({ threadId: grantThreadIdSchema }).strict()
/** The user's Stop: this thread asks again before it next reads this account. */
export const mailGrantStopSchema = z.object({ threadId: grantThreadIdSchema, accountId: z.uuid() }).strict()
export type MailGrantStop = z.infer<typeof mailGrantStopSchema>

/**
 * Why an account was not saved or removed. `refused`: the service did not accept the secret. `unreachable`: the service
 * could not be asked. `busy`: the service is turning requests away for now. `name-taken`, `limit`: the plugin already has that name, or its full count of accounts.
 * `store`: Sotto could not keep the secret or the account. `gone`: the account is no longer there. `certificate`:
 * Proton Mail Bridge showed another certificate than the one kept for the account, so nothing was sent to it.
 */
export const PLUGIN_ACCOUNT_PROBLEMS = ['refused', 'unreachable', 'busy', 'name-taken', 'limit', 'store', 'gone', 'certificate'] as const
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
    /**
     * Not a change: a thread's first read of a mail account, which asks once (decision 8). The user's yes is a mail
     * grant for that thread and that account. It is asked on the same card a change is.
     */
    readonly kind: 'mail-read'
    /**
     * The plugin's name and the account's, as the user named it. Not its address: a card's words travel further
     * than the card, as when a replaced Watcher hands its open cards to the next provider, and the address is the
     * user's own until they have said yes.
     */
    readonly plugin: string; readonly account: string
    /** The provider the thread runs on, by name: what the thread reads goes there. */
    readonly provider: string
    /**
     * Set when the thread is Watcher (#2565): its card names Watcher rather than "this thread", and does not speak of
     * the thread being settled, since Watcher never is.
     */
    readonly watcher?: boolean
  }
  | {
    /**
     * One email from a mail account, which asks every time: a mail grant never covers it. The card shows everything
     * that is sent, the Bcc too, and names the account as the user named it, not by its address (Zach's pick on
     * November 14, 2026).
     */
    readonly kind: 'mail-send'
    readonly plugin: string; readonly account: string
    readonly to: readonly string[]; readonly cc: readonly string[]; readonly bcc: readonly string[]
    readonly subject: string; readonly text: string
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
  | {
    /**
     * One 3D model made with Meshy (ADR-0141). The card shows what goes to Meshy, the words or the photo's path in the
     * thread's folder, says Meshy may train on it, and gives what it costs beside the month's credits so far.
     */
    readonly kind: 'meshy-model'; readonly account: string; readonly name: string
    readonly words?: string; readonly photo?: string
    readonly credits: number; readonly monthCredits: number; readonly monthlyLimit: number
    /** The folder the files go into, relative to the thread's folder. */
    readonly folder: string
  }
  | {
    /**
     * One sound made with ElevenLabs (ADR-0205, slice 12): speech, a sound effect or music, as one MP3 in the thread's
     * folder. The card shows everything that goes to ElevenLabs, says it may train on it, and gives what it costs at
     * the published prices beside what the account spent this month, in US dollars (Zach's picks on #2498).
     */
    readonly kind: 'elevenlabs-sound'; readonly account: string; readonly name: string
    readonly sound: 'speech' | 'effect' | 'music'
    /** The words spoken, or what the effect or music is made from. */
    readonly words: string
    /** The voice speech is spoken in, by its name in the account. */
    readonly voice?: string
    /** How long an effect or music is; an effect without one is as long as ElevenLabs judges. */
    readonly seconds?: number
    readonly instrumental?: boolean
    readonly cost: number; readonly monthSpent: number; readonly monthlyLimit: number
    /** The folder the file goes into, relative to the thread's folder. */
    readonly folder: string
  }
