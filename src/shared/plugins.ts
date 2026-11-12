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

export const PLUGIN_IDS = ['github'] as const
export type PluginId = typeof PLUGIN_IDS[number]

/** A plugin as the page lists it. Its name is the service's own and is the same in every language. */
export interface PluginEntry { readonly id: PluginId; readonly name: string; readonly group: PluginGroupId }

export const PLUGINS: readonly PluginEntry[] = [
  { id: 'github', name: 'GitHub', group: 'code' },
]

export const PLUGINS_GITHUB_SIGN_IN = 'sotto:plugins:github-sign-in'

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

/** `window.sotto.plugins`: what Settings › Plugins reads from main. Nothing here ever carries a secret. */
export interface PluginsBridge {
  /** Asks gh, on this computer, who it is signed in to github.com as. */
  gitHubSignIn(): Promise<GitHubSignIn>
  /** The newest uses of plugins by threads' agents, newest first: what was done and by which thread, never its content. */
  recentUse(): Promise<ShownPluginUse[]>
}

/** The one name every client addresses the plugin tools by (ADR-0205). */
export const PLUGINS_MCP_SERVER = 'sotto_plugins'
export const PLUGIN_ACCOUNTS_TOOL = 'plugin_accounts'
export const PLUGIN_READ_TOOL = 'plugin_read'

export const PLUGINS_RECENT_USE = 'sotto:plugins:recent-use'

/**
 * What a read was of, as far as the record keeps it: a kind of thing, never which one. A repository's name, an
 * issue's number and what the read returned are the user's own and stay out of the record (ADR-0205, decision 10).
 */
export const PLUGIN_READ_KINDS = ['issues', 'pull-requests', 'repository', 'commits', 'checks', 'releases', 'search', 'account', 'other'] as const
export type PluginReadKind = typeof PLUGIN_READ_KINDS[number]

/** How a use ended: done, refused by Sotto before anything was sent, or failed at the service. */
export const PLUGIN_USE_OUTCOMES = ['done', 'refused', 'failed'] as const

/** One entry of the plugin use record: the thread, the plugin, what was done and how it ended. Never its content. */
export const pluginUseSchema = z.object({
  id: z.uuid(),
  at: z.iso.datetime(),
  threadId: z.string().min(1).max(200),
  plugin: z.enum(PLUGIN_IDS),
  tool: z.enum([PLUGIN_READ_TOOL]),
  kind: z.enum(PLUGIN_READ_KINDS),
  outcome: z.enum(PLUGIN_USE_OUTCOMES),
}).strict()
export type PluginUse = z.infer<typeof pluginUseSchema>

/** How many uses the record keeps: enough for Recent use on every row, and no growing history. */
export const PLUGIN_USE_KEPT = 200
/** How many of a plugin's uses its row shows. */
export const PLUGIN_USE_SHOWN = 5

/** A use as Settings shows it: with the thread's name as it is now, or none when the thread is gone. */
export const shownPluginUseSchema = pluginUseSchema.extend({ threadTitle: z.string().max(400).nullable() }).strict()
export type ShownPluginUse = z.infer<typeof shownPluginUseSchema>
export const shownPluginUsesSchema = z.array(shownPluginUseSchema).max(PLUGIN_USE_KEPT)
