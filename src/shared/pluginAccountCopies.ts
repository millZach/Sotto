import { z } from 'zod'
import { ACCOUNT_PLUGIN_IDS, PLUGIN_ACCOUNT_NAME_MAX, PLUGIN_ACCOUNT_PROJECTS_MAX, PLUGIN_ACCOUNTS_MAX, PLUGIN_SECRET_MAX, pluginAccountNameSchema, pluginAccountSchema } from './plugins'

/**
 * Account copies (CONTEXT.md, ADR-0205, amending ADR-0025): a plugin account's secret and settings, sent by the
 * desktop to one of the user's own paired hosts and kept in that host's encrypted credential file, so the host's
 * threads can use the account while the desktop is off.
 *
 * This is the one credential a paired client may send a host, and only a desktop the launch script recorded for that
 * host may send it. A phone, an app on the desktop's computer, an assistant and a team link can neither send a copy
 * nor read one. A copy belongs to the desktop that sent it: where a host records more than one desktop, each is told
 * of its own copies alone and may replace or remove only those, and a desktop that is revoked takes its copies with
 * it. A host never sends a secret back: what it lists is which accounts it holds and the day each one's secret was
 * saved.
 */
export const PLUGIN_ACCOUNT_COPIES_FEATURE = 'plugin-account-copies'

/**
 * An account as a copy carries it: only what the desktop itself could have saved, and saying outright who may use
 * it. The desktop's own record fills in a missing switch as on and missing projects as every project, which is right
 * for an account kept before either existed and wrong on the wire: a copy that left them out would arrive open to
 * every thread.
 */
const copiedAccountSchema = pluginAccountSchema.extend({
  name: pluginAccountNameSchema,
  on: z.boolean(),
  projects: z.array(z.string().min(1).max(512)).min(1).max(PLUGIN_ACCOUNT_PROJECTS_MAX).refine(projects => new Set(projects).size === projects.length).nullable(),
}).strict()
/**
 * An account as the desktop holds it, with its secret. The only message in the host protocol that carries one. A
 * mail account's is taken only by a host that lists `plugin-mail-copies`, and is sent to no other.
 */
export const pluginAccountCopySchema = z.object({ account: copiedAccountSchema, secret: z.string().min(1).max(PLUGIN_SECRET_MAX) }).strict()
export type PluginAccountCopy = z.infer<typeof pluginAccountCopySchema>

/**
 * What a host answers when it is sent a copy. `store`: it could not keep the secret, as a host started without a key
 * file cannot, or could not write its record of accounts; nothing was kept. `limit`: it already holds as many accounts
 * of that plugin as a plugin takes. `held`: another desktop sent the account under that ID. `name-taken`: another
 * desktop sent an account of that plugin with the same name, and a host never holds two of one name.
 */
export const PLUGIN_ACCOUNT_COPY_PROBLEMS = ['store', 'limit', 'held', 'name-taken'] as const
export const pluginAccountCopyReceiptSchema = z.discriminatedUnion('kept', [
  z.object({ kept: z.literal(true), keptAt: z.iso.datetime() }).strict(),
  z.object({ kept: z.literal(false), problem: z.enum(PLUGIN_ACCOUNT_COPY_PROBLEMS) }).strict(),
])
export type PluginAccountCopyReceipt = z.infer<typeof pluginAccountCopyReceiptSchema>

/**
 * What a host answers when it is told to let a copy go. Letting go of a copy it does not hold is done, not a failure.
 * `removed` is false only for a copy another desktop sent, which is not this one's to remove.
 */
export const pluginAccountCopyRemovedSchema = z.object({ removed: z.boolean() }).strict()
export type PluginAccountCopyRemoved = z.infer<typeof pluginAccountCopyRemovedSchema>

/**
 * A copy as a host lists it to the desktop that sent it: the account as the host holds it now, so the desktop can
 * tell a copy that arrived from one still waiting, a changed switch or project among them. Never the secret. The
 * settings are optional and unknown fields are dropped, so a desktop and a host a version apart still read each
 * other: a host from before the settings were listed says only which account and the day its secret was saved,
 * and the desktop then sends the copy again rather than guess.
 */
export const heldPluginAccountCopySchema = z.object({
  id: z.uuid(), plugin: z.enum(ACCOUNT_PLUGIN_IDS), savedAt: z.iso.datetime(),
  name: z.string().max(PLUGIN_ACCOUNT_NAME_MAX).optional(), signedInAs: z.string().max(200).nullable().optional(),
  on: z.boolean().optional(), projects: z.array(z.string().min(1).max(512)).max(PLUGIN_ACCOUNT_PROJECTS_MAX).nullable().optional(),
})
export type HeldPluginAccountCopy = z.infer<typeof heldPluginAccountCopySchema>
export const heldPluginAccountCopiesSchema = z.array(heldPluginAccountCopySchema).max(ACCOUNT_PLUGIN_IDS.length * PLUGIN_ACCOUNTS_MAX)

/** Where a headless host keeps the copies it is sent. A desktop's own local host has none: it holds the accounts themselves. */
export interface PluginAccountCopyStore {
  /** Whether a mail account's copy is kept here: the host's threads can read one, each asking the user once. */
  readonly mail?: boolean
  /** Keeps a copy for the desktop that sent it. */
  keep(copy: PluginAccountCopy, clientId: string): Promise<PluginAccountCopyReceipt>
  /** Lets go of a copy that desktop sent. */
  remove(id: string, clientId: string): Promise<PluginAccountCopyRemoved>
  /** The copies that desktop sent, and no other's. */
  list(clientId: string): Promise<HeldPluginAccountCopy[]>
  /** A desktop was revoked: every copy it sent is deleted, with its secret. */
  forgetDesktop(clientId: string): Promise<void>
}
