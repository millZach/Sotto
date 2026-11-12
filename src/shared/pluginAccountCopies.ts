import { z } from 'zod'
import { ACCOUNT_PLUGIN_IDS, PLUGIN_ACCOUNTS_MAX, PLUGIN_SECRET_MAX, pluginAccountSchema } from './plugins'

/**
 * Account copies (CONTEXT.md, ADR-0205, amending ADR-0025): a plugin account's secret and settings, sent by the
 * desktop to one of the user's own paired hosts and kept in that host's encrypted credential file, so the host's
 * threads can use the account while the desktop is off.
 *
 * This is the one credential a paired client may send a host, and only one client may send it: the desktop the launch
 * script recorded for that host. A phone, an app on the desktop's computer, an assistant and a team link can neither
 * send a copy nor read one, and a host never sends a secret back: what it lists is which accounts it holds and when it
 * took each, so the desktop can tell a copy that is waiting from one that arrived.
 */
export const PLUGIN_ACCOUNT_COPIES_FEATURE = 'plugin-account-copies'

/** An account as the desktop holds it, with its secret. The only message in the host protocol that carries one. */
export const pluginAccountCopySchema = z.object({ account: pluginAccountSchema, secret: z.string().min(1).max(PLUGIN_SECRET_MAX) }).strict()
export type PluginAccountCopy = z.infer<typeof pluginAccountCopySchema>

/**
 * What a host answers when it is sent a copy. `store`: it could not keep the secret, as a host started without a key
 * file cannot, or could not write its record of accounts; nothing was kept. `limit`: it already holds as many accounts
 * of that plugin as a plugin takes.
 */
export const PLUGIN_ACCOUNT_COPY_PROBLEMS = ['store', 'limit'] as const
export const pluginAccountCopyReceiptSchema = z.discriminatedUnion('kept', [
  z.object({ kept: z.literal(true), keptAt: z.iso.datetime() }).strict(),
  z.object({ kept: z.literal(false), problem: z.enum(PLUGIN_ACCOUNT_COPY_PROBLEMS) }).strict(),
])
export type PluginAccountCopyReceipt = z.infer<typeof pluginAccountCopyReceiptSchema>

/** What a host answers when it is told to let a copy go. Letting go of a copy it does not hold is done, not a failure. */
export const pluginAccountCopyRemovedSchema = z.object({ removed: z.boolean() }).strict()
export type PluginAccountCopyRemoved = z.infer<typeof pluginAccountCopyRemovedSchema>

/** A copy as a host lists it: which account, and the day its secret was saved on the desktop. Never the secret. */
export const heldPluginAccountCopySchema = z.object({ id: z.uuid(), plugin: z.enum(ACCOUNT_PLUGIN_IDS), savedAt: z.iso.datetime() }).strict()
export type HeldPluginAccountCopy = z.infer<typeof heldPluginAccountCopySchema>
export const heldPluginAccountCopiesSchema = z.array(heldPluginAccountCopySchema).max(ACCOUNT_PLUGIN_IDS.length * PLUGIN_ACCOUNTS_MAX)

/** Where a headless host keeps the copies it is sent. A desktop's own local host has none: it holds the accounts themselves. */
export interface PluginAccountCopyStore {
  keep(copy: PluginAccountCopy): Promise<PluginAccountCopyReceipt>
  remove(id: string): Promise<PluginAccountCopyRemoved>
  list(): Promise<HeldPluginAccountCopy[]>
}
