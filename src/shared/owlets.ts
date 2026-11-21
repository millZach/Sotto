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
/** An owlet per computer is a thread per owlet, so a few hundred is far past use and keeps every list short. */
export const OWLETS_PER_HOST_MAX = 200

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
 * numbers, spaces, hyphens and apostrophes that every computer's file system takes.
 */
export function owletNameProblem(name: string): string | undefined {
  const trimmed = name.trim()
  if (!trimmed) return 'Give the owlet a name.'
  if (trimmed.length > OWLET_NAME_MAX) return `Keep the name to ${OWLET_NAME_MAX} characters.`
  if (!/^[\p{L}\p{N}][\p{L}\p{N} '-]*$/u.test(trimmed) || WINDOWS_RESERVED.test(trimmed)) return 'Use letters, numbers, spaces and hyphens in the name.'
  return undefined
}
/** Two owlets on one computer can't share a name, because they would share a folder. */
export const sameOwletName = (a: string, b: string): boolean => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase()

const owletNameSchema = z.string().max(OWLET_NAME_MAX * 2).refine(name => owletNameProblem(name) === undefined).transform(name => name.trim())
const owletRoleSchema = z.string().max(OWLET_ROLE_MAX * 2).transform(role => role.trim()).refine(role => role.length <= OWLET_ROLE_MAX)

/** What makes a thread an owlet: its name and its role, in the user's words. Sotto's record, kept on the thread. */
export const agentOwletSchema = z.object({ name: owletNameSchema, role: owletRoleSchema }).strict()
export type AgentOwlet = z.infer<typeof agentOwletSchema>

export const isOwletThread = (thread: { readonly owlet?: AgentOwlet | undefined }): boolean => thread.owlet !== undefined
