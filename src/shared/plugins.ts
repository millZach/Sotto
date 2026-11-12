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
}
