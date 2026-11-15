import { isBridgePlugin, isMailPlugin, type BridgePorts, type MailPluginId, type PluginAccount } from '../../../shared/plugins'
import type { SecretCheck } from '../accounts'
import { checkMailSignIn, mailServerAnswers, mailServerCertificate, type MailOptions, type MailServer } from './read'
import type { MailCertificate } from './startTls'

/**
 * Where Gmail's accounts are read. An account's address and password go to this server and to no other. Gmail's is
 * the one Google's own page gives for mail programs, read on November 13, 2026
 * (developers.google.com/workspace/gmail/imap/imap-smtp): `imap.gmail.com`, port 993, TLS from the first byte.
 */
export const MAIL_SERVERS: { readonly gmail: MailServer } = {
  gmail: { host: 'imap.gmail.com', port: 993 },
}

/**
 * Where Gmail's accounts send from. Gmail's is on the same page of Google's, read on November 14, 2026:
 * `smtp.gmail.com`, port 465, which "require[s] implicit SSL/TLS", so the connection is TLS from the first byte, as a
 * read's is. For mail sent this way the page gives 100 recipients a message, and 500 messages a day, or 2,000 from a
 * paid Google Workspace account.
 */
export const MAIL_SEND_SERVERS: { readonly gmail: MailServer } = {
  gmail: { host: 'smtp.gmail.com', port: 465 },
}

/** Where Proton Mail Bridge listens: this computer, and nowhere else (ADR-0205, slice 10). */
const BRIDGE_HOST = '127.0.0.1'

/**
 * A Proton Mail account's servers: Bridge on this computer, at the ports the user gave, begun in the clear and made
 * TLS by STARTTLS, with the certificate kept for the account or `learn` for a check.
 */
export const bridgeServers = (ports: BridgePorts, certificate: MailCertificate | 'learn'): { readonly read: MailServer; readonly send: MailServer } => ({
  read: { host: BRIDGE_HOST, port: ports.imapPort, startTls: { certificate } },
  send: { host: BRIDGE_HOST, port: ports.smtpPort, startTls: { certificate } },
})

/** Where an account is read and sends from, or null for one that is not mail, or a Proton account kept without its Bridge. */
export function mailServersOf(account: PluginAccount): { readonly read: MailServer; readonly send: MailServer } | null {
  if (!isMailPlugin(account.plugin)) return null
  if (isBridgePlugin(account.plugin)) return account.bridge ? bridgeServers(account.bridge, account.bridge.certificate) : null
  return { read: MAIL_SERVERS.gmail, send: MAIL_SEND_SERVERS.gmail }
}

/** A check that was taken, with the certificate Proton Mail Bridge showed, to keep. */
export type MailAccountCheck = SecretCheck | { readonly ok: false; readonly problem: 'certificate' }

/**
 * Whether a mail account's address and password are good, asked of its server by signing in, as an account is
 * checked before it is kept. A server that would not answer is not the same as one that refused the password.
 *
 * A Proton Mail account is checked with Bridge on this computer. With `learn`, as when it is added or the user trusts
 * a new certificate, the certificate Bridge shows is handed back to be kept; otherwise Bridge must show the one kept.
 */
export async function checkMailAccount(plugin: MailPluginId, address: string, password: string, options: MailOptions = {}, bridge?: { readonly ports: BridgePorts; readonly certificate: MailCertificate | 'learn' }): Promise<MailAccountCheck & { readonly certificate?: MailCertificate }> {
  if (isBridgePlugin(plugin) && !bridge) return { ok: false, problem: 'refused' }
  const server = bridge ? bridgeServers(bridge.ports, bridge.certificate).read : MAIL_SERVERS.gmail
  const checked = await checkMailSignIn(server, { address, password }, options)
  // Bridge's SMTP port is where every send goes: one where nothing answers, as a mistyped port, is said now rather
  // than at the first send.
  if (checked.ok && bridge && !await mailServerAnswers(bridgeServers(bridge.ports, 'learn').send, options)) return { ok: false, problem: 'unreachable' }
  if (checked.ok) return { ok: true, signedInAs: null, ...(checked.certificate ? { certificate: checked.certificate } : {}) }
  if (checked.reason === 'certificate') return { ok: false, problem: 'certificate' }
  return { ok: false, problem: checked.reason === 'refused' || checked.reason === 'input' ? 'refused' : checked.reason === 'busy' ? 'busy' : 'unreachable' }
}

/**
 * Where Proton Mail Bridge stands for an account, for its row: `running`, `not-running` when nothing answers at its
 * IMAP port, or `certificate` when what answers shows another certificate than the one kept. It signs in to nothing
 * and sends no password.
 */
export async function bridgeStatus(account: PluginAccount, options: MailOptions = {}): Promise<'running' | 'not-running' | 'certificate' | 'unknown'> {
  const servers = mailServersOf(account)
  if (!servers || !isBridgePlugin(account.plugin)) return 'unknown'
  // Both of Bridge's ports: reading goes to one and sending to the other.
  if (!await mailServerAnswers(servers.read, options) || !await mailServerAnswers(servers.send, options)) return 'not-running'
  const shown = await mailServerCertificate(servers.read, options)
  return shown === 'kept' ? 'running' : shown === 'other' ? 'certificate' : shown === 'unreachable' ? 'not-running' : 'unknown'
}
