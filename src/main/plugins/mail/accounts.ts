import type { MailPluginId } from '../../../shared/plugins'
import type { SecretCheck } from '../accounts'
import { checkMailSignIn, type MailOptions, type MailServer } from './read'

/**
 * Where each mail plugin's accounts are read. An account's address and password go to this server and to no other.
 * Gmail's is the one Google's own page gives for mail programs, read on November 13, 2026
 * (developers.google.com/workspace/gmail/imap/imap-smtp): `imap.gmail.com`, port 993, TLS from the first byte.
 */
export const MAIL_SERVERS: Readonly<Record<MailPluginId, MailServer>> = {
  gmail: { host: 'imap.gmail.com', port: 993 },
}

/**
 * Where each mail plugin's accounts send from. Gmail's is on the same page of Google's, read on November 14, 2026:
 * `smtp.gmail.com`, port 465, which "require[s] implicit SSL/TLS", so the connection is TLS from the first byte, as a
 * read's is. For mail sent this way the page gives 100 recipients a message, and 500 messages a day, or 2,000 from a
 * paid Google Workspace account.
 */
export const MAIL_SEND_SERVERS: Readonly<Record<MailPluginId, MailServer>> = {
  gmail: { host: 'smtp.gmail.com', port: 465 },
}

/**
 * Whether a mail account's address and password are good, asked of its server by signing in, as an account is
 * checked before it is kept. A server that would not answer is not the same as one that refused the password.
 */
export async function checkMailAccount(plugin: MailPluginId, address: string, password: string, options: MailOptions = {}): Promise<SecretCheck> {
  const checked = await checkMailSignIn(MAIL_SERVERS[plugin], { address, password }, options)
  if (checked.ok) return { ok: true, signedInAs: null }
  return { ok: false, problem: checked.reason === 'refused' || checked.reason === 'input' ? 'refused' : checked.reason === 'busy' ? 'busy' : 'unreachable' }
}
