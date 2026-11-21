import { z } from 'zod'
import type { ProviderId } from './providerIds'

/**
 * Owlets (ADR-0210): Sotto's own named helpers, an Owl feature. An owlet is one project-bound thread that carries its
 * name and role, in a folder of its own that Sotto makes in its home computer's data folder. These are the parts both
 * processes and the host read.
 */

/** The folder in Sotto's data folder that holds every owlet's own folder, on each computer. */
export const OWLETS_FOLDER = 'owlets'
/** How the window names an owlet's folder: the name the user knows it by, not the data folder's path. */
export const owletFolderLabel = (name: string): string => `Owlets/${name}`
export const OWLET_NAME_MAX = 40
export const OWLET_ROLE_MAX = 200

/**
 * The providers an owlet can run on: those whose own memory Sotto turns off in an owlet's folder (Zach's pick on
 * November 20, 2026). Claude Code's auto memory and Codex's memories are switched off for every thread working there.
 * Another provider joins only once its own memory is known to be off there.
 */
export const OWLET_PROVIDERS: readonly ProviderId[] = ['claude', 'codex']
export const owletProviderAllowed = (provider: ProviderId | undefined): boolean => provider !== undefined && OWLET_PROVIDERS.includes(provider)

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/iu
/**
 * Why a name can't be an owlet's, or undefined when it can. The name is also its folder's, so it keeps to letters,
 * numbers, spaces, hyphens and apostrophes that every computer's file system takes. A window says each in its own words.
 */
export type OwletNameProblem = 'empty' | 'long' | 'characters'
export function owletNameProblem(name: string): OwletNameProblem | undefined {
  const trimmed = name.trim()
  if (!trimmed) return 'empty'
  if (trimmed.length > OWLET_NAME_MAX) return 'long'
  if (!/^[\p{L}\p{N}][\p{L}\p{N} '-]*$/u.test(trimmed) || WINDOWS_RESERVED.test(trimmed)) return 'characters'
  return undefined
}

/**
 * What a host says when it refuses an owlet command, each a fixed English sentence on the wire, which a window says again
 * in the interface language (`owletRefusalWords`).
 */
export const OWLET_REFUSALS = {
  off: 'Owlets are available in Sotto Owl. Nothing was changed.',
  empty: 'Give the owlet a name. Nothing was changed.',
  long: 'Keep the name to 40 characters. Nothing was changed.',
  characters: 'Use letters, numbers, spaces and hyphens in the name. Nothing was changed.',
  role: 'Keep the role to 200 characters. Nothing was changed.',
  taken: 'An owlet on this computer has that name, or a folder by that name. Choose another name. Nothing was changed.',
  provider: 'An owlet runs on Claude Code or Codex, whose own memory Sotto turns off. Choose one of their models. Nothing was changed.',
  exists: 'This owlet already exists. Nothing was changed.',
  notOwlet: 'This thread is not an owlet. Nothing was changed.',
  unavailable: 'Owlets are unavailable on this computer. Update Sotto there. Nothing was changed.',
  noProject: 'The owlet\'s folder did not appear as a project. Its folder was kept. Try again.',
  stopping: 'Sotto is stopping. Nothing more was made.',
} as const
export type OwletRefusal = keyof typeof OWLET_REFUSALS
/** What a command naming an owlet's thread is told where Owlets are off: the thread is dormant. */
export const OWLETS_HELD = 'Owlets are available in Sotto Owl. Open an Owl build to continue. Nothing was sent.'
/** Two owlets on one computer can't share a name, because they would share a folder. */
export const sameOwletName = (a: string, b: string): boolean => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase()

const owletNameSchema = z.string().max(OWLET_NAME_MAX * 2).refine(name => owletNameProblem(name) === undefined).transform(name => name.trim())
const owletRoleSchema = z.string().max(OWLET_ROLE_MAX * 2).transform(role => role.trim()).refine(role => role.length <= OWLET_ROLE_MAX)

/** What makes a thread an owlet: its name and its role, in the user's words. Sotto's record, kept on the thread. */
export const agentOwletSchema = z.object({ name: owletNameSchema, role: owletRoleSchema }).strict()
export type AgentOwlet = z.infer<typeof agentOwletSchema>

/**
 * What an owlet's provider is told at each launch (ADR-0210): its name and the role the user gave it. English, as what Sotto
 * sends a model is. The role is the user's own words.
 */
export function owletInstructions(owlet: AgentOwlet): string {
  return [`You are ${owlet.name}, an owlet: a long-lived helper the user named in Sotto. Every conversation with you is more turns in this one thread, in a folder of your own.`,
    owlet.role ? `Your role, in the user's words: ${owlet.role}` : '',
    'The user answers every question and permission card; you never answer your own.'].filter(Boolean).join('\n')
}

export const isOwletThread = (thread: { readonly owlet?: AgentOwlet | undefined }): boolean => thread.owlet !== undefined
