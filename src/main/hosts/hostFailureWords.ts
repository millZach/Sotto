import { i18n, type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'

import { inEnglish } from '../interfaceLanguage'
import { HOST_NODE_MAJOR, HOST_NODE_MINIMUM, SshFailure, type SshFailureCode, type SshFix } from './sshFailure'

/**
 * Why a host connection failed, in words a saved host's row shows and the words Add host shows, which say nothing was
 * saved and what to do in the dialog instead (ADR-0123). Each is a whole message, so a language words the Add host
 * sentence itself rather than Sotto rewriting the row's. Kept as messages, not text, so the row and the dialog show them
 * in the interface language shown when they are read, and an agent setting a host up reads them in English.
 *
 * `sshFailure.ts` and the launch script are built into the headless host, which has no macros, so their English stays
 * there and is said again here; `hostFailureWords.test.ts` holds each to it, and each Add host sentence to the one the
 * row's English made before these were messages.
 */
export interface FailureWords { readonly saved: MessageDescriptor; readonly unsaved: MessageDescriptor }
/** A failure's words: Sotto's own, as a message, or text from elsewhere (a system error), shown as it came. */
export type Said = MessageDescriptor | string

/** An error whose sentence is one of these, so it can be said again in another language or in English. */
export class WordedError extends Error {
  constructor(readonly words: FailureWords, options?: ErrorOptions) { super(i18n._(words.saved), options) }
}
/** A refusal Sotto says to whoever asked: the user, or an agent setting a host up, which reads it in English. */
export class SaidError extends Error {
  constructor(readonly said: MessageDescriptor, options?: ErrorOptions) { super(i18n._(said), options) }
}

/** The words in the interface language shown now. */
export const shown = (said: Said): string => typeof said === 'string' ? said : i18n._(said)
/** The words in English, for a model. */
export const english = (said: Said): string => typeof said === 'string' ? said : inEnglish(said)
/** What an error says in English, for a model: its own words when it has them, its message otherwise. */
export function englishOf(error: unknown, otherwise: string): string {
  if (error instanceof SaidError) return inEnglish(error.said)
  if (error instanceof WordedError) return inEnglish(error.words.saved)
  const words = (error as { words?: FailureWords } | null)?.words
  if (words && typeof words === 'object' && 'saved' in words) return inEnglish(words.saved)
  return error instanceof Error ? error.message : otherwise
}

const minimum = HOST_NODE_MINIMUM, major = String(HOST_NODE_MAJOR)

/** A connect's own failures, on this computer and from the host's socket. */
export const CONNECT_FAILURES = {
  identityChanged: (): FailureWords => ({ saved: msg`The host identity changed. Check its data folder before connecting again.`, unsaved: msg`The host identity changed. Nothing was saved. Check its data folder before connecting again.` }),
  sameHost: (host: string): FailureWords => ({ saved: msg`This is the same host as ${host}, which is already saved. Switch ${host} on in the list instead.`, unsaved: msg`This is the same host as ${host}, which is already saved. Nothing was saved. Switch ${host} on in the list instead.` }),
  noLongerPaired: (): FailureWords => ({ saved: msg`This device is no longer paired and could not pair again. Check the host, then connect again.`, unsaved: msg`This device is no longer paired and could not pair again. Nothing was saved. Check the host, then connect again.` }),
  couldNotConnect: (): FailureWords => ({ saved: msg`The host could not connect. Check its SSH settings and try again.`, unsaved: msg`The host could not connect. Nothing was saved. Check its SSH settings and try again.` }),
  credentialsUnavailable: (): FailureWords => ({ saved: msg`Secure credential storage is unavailable. Unlock it before connecting again.`, unsaved: msg`Secure credential storage is unavailable. Nothing was saved. Unlock it before connecting again.` }),
  closedWhilePairing: (): FailureWords => ({ saved: msg`The connection was closed while this computer paired.`, unsaved: msg`The connection was closed while this computer paired. Nothing was saved.` }),
  differentHost: (): FailureWords => ({ saved: msg`This is a different host. Check the address before pairing.`, unsaved: msg`This is a different host. Nothing was saved. Check the address before pairing.` }),
  disconnectedWhileConnecting: (): FailureWords => ({ saved: msg`The host disconnected while connecting. Try connecting again.`, unsaved: msg`The host disconnected while connecting. Nothing was saved. Try connecting again.` }),
  pairsOverSsh: (): FailureWords => ({ saved: msg`This computer pairs with a host only through its SSH connection. Nothing was sent. Connect again over SSH.`, unsaved: msg`This computer pairs with a host only through its SSH connection. Nothing was saved. Nothing was sent. Connect again over SSH.` }),
  refusedDevice: (): FailureWords => ({ saved: msg`This host refused this device here. The pairing is kept.`, unsaved: msg`This host refused this device here. Nothing was saved. The pairing is kept.` }),
  busy: (): FailureWords => ({ saved: msg`The host is busy. Nothing was lost. Try again in a moment.`, unsaved: msg`The host is busy. Nothing was saved. Nothing was lost. Try again in a moment.` }),
  pairingCodeUnused: (): FailureWords => ({ saved: msg`This pairing code could not be used. Make a new code on the host and try again.`, unsaved: msg`This pairing code could not be used. Nothing was saved. Make a new code on the host and try again.` }),
  addressCredentials: (): FailureWords => ({ saved: msg`Use a host HTTP or HTTPS address without credentials in its URL.`, unsaved: msg`Use a host HTTP or HTTPS address without credentials in its URL. Nothing was saved.` }),
  addressHttps: (): FailureWords => ({ saved: msg`A remote host address must use HTTPS.`, unsaved: msg`A remote host address must use HTTPS. Nothing was saved.` }),
  connectionClosed: (): FailureWords => ({ saved: msg`This host connection was closed.`, unsaved: msg`This host connection was closed. Nothing was saved.` }),
  healthCheck: (): FailureWords => ({ saved: msg`The host did not answer its health check. Connect again.`, unsaved: msg`The host did not answer its health check. Nothing was saved. Connect again.` }),
  wrongHost: (): FailureWords => ({ saved: msg`This address belongs to a different host. Check the connection before continuing.`, unsaved: msg`This address belongs to a different host. Nothing was saved. Check the connection before continuing.` }),
  needsPairing: (): FailureWords => ({ saved: msg`This device needs to connect again or be paired on the host.`, unsaved: msg`This device needs to connect again or be paired on the host. Nothing was saved.` }),
  answeredElse: (): FailureWords => ({ saved: msg`The host answered with something else. Connect again.`, unsaved: msg`The host answered with something else. Nothing was saved. Connect again.` }),
  notOpened: (): FailureWords => ({ saved: msg`The host connection could not be opened.`, unsaved: msg`The host connection could not be opened. Nothing was saved.` }),
  refusedConnection: (): FailureWords => ({ saved: msg`The host refused this connection. Connect again.`, unsaved: msg`The host refused this connection. Nothing was saved. Connect again.` }),
  protocol: (): FailureWords => ({ saved: msg`The host did not accept this protocol.`, unsaved: msg`The host did not accept this protocol. Nothing was saved.` }),
  identityChangedConnect: (): FailureWords => ({ saved: msg`The host identity changed. Connect again.`, unsaved: msg`The host identity changed. Nothing was saved. Connect again.` }),
  requestDisconnected: (): FailureWords => ({ saved: msg`The host is disconnected. Connect again before sending.`, unsaved: msg`The host is disconnected. Nothing was saved. Connect again before sending.` }),
  requestPending: (): FailureWords => ({ saved: msg`Wait for the pending host request to finish.`, unsaved: msg`Wait for the pending host request to finish. Nothing was saved.` }),
  requestTimeout: (): FailureWords => ({ saved: msg`The host did not answer in time. Try refreshing.`, unsaved: msg`The host did not answer in time. Nothing was saved. Try refreshing.` }),
  commandUnconfirmed: (): FailureWords => ({ saved: msg`The host has not confirmed this command. Refresh before deciding what to do next.`, unsaved: msg`The host has not confirmed this command. Nothing was saved. Refresh before deciding what to do next.` }),
  closedBeforeConfirmed: (): FailureWords => ({ saved: msg`The connection closed before this request could be confirmed.`, unsaved: msg`The connection closed before this request could be confirmed. Nothing was saved.` }),
  closedCommand: (): FailureWords => ({ saved: msg`The connection closed before the host confirmed this command. Refresh before deciding what to do next.`, unsaved: msg`The connection closed before the host confirmed this command. Nothing was saved. Refresh before deciding what to do next.` }),
  closedRefresh: (): FailureWords => ({ saved: msg`The host connection closed. Connect again to refresh.`, unsaved: msg`The host connection closed. Nothing was saved. Add the host again to refresh.` }),
  earlierConnection: (): FailureWords => ({ saved: msg`This result belongs to an earlier connection. Refresh the host.`, unsaved: msg`This result belongs to an earlier connection. Nothing was saved. Refresh the host.` }),
  anotherIdentity: (): FailureWords => ({ saved: msg`The host returned another host identity. Reconnect before continuing.`, unsaved: msg`The host returned another host identity. Nothing was saved. Reconnect before continuing.` }),
  aheadForRestart: (version: string): FailureWords => ({ saved: msg`This host already runs Sotto ${version}, which this computer installs when Sotto restarts. Nothing on the host was lost. Restart Sotto to finish its update, then try again.`, unsaved: msg`This host already runs Sotto ${version}, which this computer installs when Sotto restarts. Nothing was saved. Nothing on the host was lost. Restart Sotto to finish its update, then try again.` }),
  newerHost: (): FailureWords => ({ saved: msg`This host is running a newer version of Sotto than this computer. Nothing on the host was lost. Update Sotto on this computer, then connect again.`, unsaved: msg`This host is running a newer version of Sotto than this computer. Nothing was saved. Nothing on the host was lost. Update Sotto on this computer, then connect again.` }),
  olderOwned: (version: string): FailureWords => ({ saved: msg`This host is running a different version of Sotto. Nothing on the host was lost. Update it from the Threads page, or put the Sotto ${version} host in its installation folder, press Stop host, then connect again.`, unsaved: msg`This host is running a different version of Sotto. Nothing was saved. Nothing on the host was lost. Update it from the Threads page, or put the Sotto ${version} host in its installation folder, press Stop host, then connect again.` }),
  olderNotOwned: (version: string): FailureWords => ({ saved: msg`This host is running a different version of Sotto. Nothing on the host was lost. Update it from the Threads page, or put the Sotto ${version} host in its installation folder, stop the host on that machine, then connect again.`, unsaved: msg`This host is running a different version of Sotto. Nothing was saved. Nothing on the host was lost. Update it from the Threads page, or put the Sotto ${version} host in its installation folder, stop the host on that machine, then connect again.` }),
  differentOwned: (version: string): FailureWords => ({ saved: msg`This host is running a different version of Sotto. Nothing on the host was lost. Put the Sotto ${version} host in its installation folder, press Stop host, then connect again.`, unsaved: msg`This host is running a different version of Sotto. Nothing was saved. Nothing on the host was lost. Put the Sotto ${version} host in its installation folder, press Stop host, then connect again.` }),
  differentNotOwned: (version: string): FailureWords => ({ saved: msg`This host is running a different version of Sotto. Nothing on the host was lost. Put the Sotto ${version} host in its installation folder, stop the host on that machine, then connect again.`, unsaved: msg`This host is running a different version of Sotto. Nothing was saved. Nothing on the host was lost. Put the Sotto ${version} host in its installation folder, stop the host on that machine, then connect again.` }),
} as const

/** Every SSH failure with its standard words, by code (`MESSAGES` in sshFailure.ts). */
const SSH_FAILURES: Readonly<Record<SshFailureCode, () => FailureWords>> = {
  'ssh-missing': () => ({ saved: msg`SSH could not start. Install OpenSSH and check that its executable is available.`, unsaved: msg`SSH could not start. Nothing was saved. Install OpenSSH and check that its executable is available.` }),
  'ssh-too-old': () => ({ saved: msg`This computer's OpenSSH is too old. Sotto needs OpenSSH 8.4 or later. Update OpenSSH on this computer, then reconnect.`, unsaved: msg`This computer's OpenSSH is too old. Nothing was saved. Sotto needs OpenSSH 8.4 or later. Update OpenSSH on this computer, then add the host again.` }),
  'ssh-unreachable': () => ({ saved: msg`SSH could not reach the host. Check the host name and your network, then reconnect.`, unsaved: msg`SSH could not reach the host. Nothing was saved. Check the host name and your network, then add the host again.` }),
  'ssh-failed': () => ({ saved: msg`SSH could not connect to the host. Check the host name and SSH access, then reconnect.`, unsaved: msg`SSH could not connect to the host. Nothing was saved. Check the host name and SSH access, then add the host again.` }),
  'auth-failed': () => ({ saved: msg`The SSH host refused your sign-in. Check the user name, password or identity file, then reconnect.`, unsaved: msg`The SSH host refused your sign-in. Nothing was saved. Check the user name, password or identity file, then add the host again.` }),
  'host-key-changed': () => ({ saved: msg`The SSH host key changed. Verify the host identity and update your SSH known hosts before reconnecting.`, unsaved: msg`The SSH host key changed. Nothing was saved. Verify the host identity and update your SSH known hosts before adding the host again.` }),
  'host-key-rejected': () => ({ saved: msg`The SSH host key was not trusted, so Sotto did not connect. Connect again to review the key.`, unsaved: msg`The SSH host key was not trusted, so Sotto did not connect. Nothing was saved. Add the host again to review the key.` }),
  'identity-file-unreadable': () => ({ saved: msg`The SSH identity file could not be read. Choose its current path and reconnect.`, unsaved: msg`The SSH identity file could not be read. Nothing was saved. Choose its current path and add the host again.` }),
  'connect-timeout': () => ({ saved: msg`SSH did not finish connecting in time. Check the host and your network, then reconnect.`, unsaved: msg`SSH did not finish connecting in time. Nothing was saved. Check the host and your network, then add the host again.` }),
  'prompt-unanswered': () => ({ saved: msg`SSH waited too long for your answer, so Sotto stopped connecting. Connect again when you are ready to answer.`, unsaved: msg`SSH waited too long for your answer, so Sotto stopped connecting. Nothing was saved. Add the host again when you are ready to answer.` }),
  'node-missing': () => ({ saved: msg`Node was not found on the SSH host. Install Node ${minimum} or a later Node ${major} for that SSH account, then reconnect.`, unsaved: msg`Node was not found on the SSH host. Nothing was saved. Install Node ${minimum} or a later Node ${major} for that SSH account, then add the host again.` }),
  'node-too-old': () => ({ saved: msg`The SSH host's Node is too old for the host. Install Node ${minimum} or a later Node ${major} for that SSH account, then reconnect.`, unsaved: msg`The SSH host's Node is too old for the host. Nothing was saved. Install Node ${minimum} or a later Node ${major} for that SSH account, then add the host again.` }),
  'node-too-new': () => ({ saved: msg`The SSH host's Node is newer than this host release supports. Install Node ${minimum} or a later Node ${major} for that SSH account, then reconnect.`, unsaved: msg`The SSH host's Node is newer than this host release supports. Nothing was saved. Install Node ${minimum} or a later Node ${major} for that SSH account, then add the host again.` }),
  'archive-missing': () => ({ saved: msg`The host installation was not found. Check its folder on the SSH host and reconnect.`, unsaved: msg`The host installation was not found. Nothing was saved. Check its folder on the SSH host and add the host again.` }),
  'descriptor-invalid': () => ({ saved: msg`The host connection record could not be read. Check the host data folder before reconnecting.`, unsaved: msg`The host connection record could not be read. Nothing was saved. Check the host data folder before adding the host again.` }),
  'port-taken': () => ({ saved: msg`Another program is using the port the host last listened on. Stop it on the SSH host, then reconnect.`, unsaved: msg`Another program is using the port the host last listened on. Nothing was saved. Stop it on the SSH host, then add the host again.` }),
  'host-busy': () => ({ saved: msg`A host process already holds that data folder but is not answering. Check it on the SSH host, then reconnect.`, unsaved: msg`A host process already holds that data folder but is not answering. Nothing was saved. Check it on the SSH host, then add the host again.` }),
  'host-start-failed': () => ({ saved: msg`The host could not start. Check its installation and data folder on the SSH host. If the data folder holds saved credentials, set SOTTO_HOST_KEY_FILE for that SSH account.`, unsaved: msg`The host could not start. Nothing was saved. Check its installation and data folder on the SSH host. If the data folder holds saved credentials, set SOTTO_HOST_KEY_FILE for that SSH account.` }),
  'host-timeout': () => ({ saved: msg`The host was not ready in time. Check that it starts on the SSH host, then reconnect.`, unsaved: msg`The host was not ready in time. Nothing was saved. Check that it starts on the SSH host, then add the host again.` }),
  'host-not-running': () => ({ saved: msg`The host is not running on the SSH host, so nothing was changed there. Connect to it in Settings > Hosts & phones, which starts it, then try again.`, unsaved: msg`The host is not running on the SSH host, so nothing was changed there. Nothing was saved. Connect to it in Settings > Hosts & phones, which starts it, then try again.` }),
  'boot-start-refused': () => ({ saved: msg`The host starts at boot, and its systemd unit would not start. Nothing was lost. Check the unit on the SSH host, then reconnect.`, unsaved: msg`The host starts at boot, and its systemd unit would not start. Nothing was saved. Nothing was lost. Check the unit on the SSH host, then add the host again.` }),
  'boot-unit-failed': () => ({ saved: msg`The host starts at boot, and its systemd unit stopped before the host was ready. Nothing was lost, and the unit may still be trying to start it. Check the unit on the SSH host, then reconnect.`, unsaved: msg`The host starts at boot, and its systemd unit stopped before the host was ready. Nothing was saved. Nothing was lost, and the unit may still be trying to start it. Check the unit on the SSH host, then add the host again.` }),
  'forward-failed': () => ({ saved: msg`The SSH port forward could not open. Reconnect, and if it fails again, check that the SSH server allows port forwarding.`, unsaved: msg`The SSH port forward could not open. Nothing was saved. Reconnect, and if it fails again, check that the SSH server allows port forwarding.` }),
  'forward-timeout': () => ({ saved: msg`The SSH forward was not ready in time. Check SSH access and reconnect.`, unsaved: msg`The SSH forward was not ready in time. Nothing was saved. Check SSH access and add the host again.` }),
  'pairing-failed': () => ({ saved: msg`The pairing code could not be read from the host. Check that the host is running and try again.`, unsaved: msg`The pairing code could not be read from the host. Nothing was saved. Check that the host is running and try again.` }),
  'permission-setup-failed': () => ({ saved: msg`Desktop permissions could not be set up on the host. Nothing was replaced. Check its data folder, then reconnect.`, unsaved: msg`Desktop permissions could not be set up on the host. Nothing was saved. Nothing was replaced. Check its data folder, then add the host again.` }),
  'revoke-failed': () => ({ saved: msg`Client access could not be revoked. Check the host connection and try Forget again.`, unsaved: msg`Client access could not be revoked. Nothing was saved. Check the host connection and try Forget again.` }),
  'admin-failed': () => ({ saved: msg`Phone access on the host could not be reached. Nothing was changed. Check that the host is running, then try again.`, unsaved: msg`Phone access on the host could not be reached. Nothing was saved. Nothing was changed. Check that the host is running, then try again.` }),
  'stop-failed': () => ({ saved: msg`The host could not be stopped. It may still be running on the SSH host.`, unsaved: msg`The host could not be stopped. Nothing was saved. It may still be running on the SSH host.` }),
  'update-failed': () => ({ saved: msg`The connection to the host closed before this step of its update finished.`, unsaved: msg`The connection to the host closed before this step of its update finished. Nothing was saved.` }),
  'boot-failed': () => ({ saved: msg`The connection to the host closed before start at boot was changed. Connect again to see whether it changed.`, unsaved: msg`The connection to the host closed before start at boot was changed. Nothing was saved. Add the host again to see whether it changed.` }),
  'request-busy': () => ({ saved: msg`Wait for the current host request to finish.`, unsaved: msg`Wait for the current host request to finish. Nothing was saved.` }),
  'not-connected': () => ({ saved: msg`Connect to the SSH host first.`, unsaved: msg`Connect to the SSH host first. Nothing was saved.` }),
  'cancelled': () => ({ saved: msg`The SSH connection was cancelled.`, unsaved: msg`The SSH connection was cancelled. Nothing was saved.` }),
  'tailscale-unapproved': () => ({ saved: msg`Tailscale SSH asked you to approve this connection, and no approval came within 5 minutes, so Sotto stopped connecting. Approve it in your browser when Sotto asks, then reconnect.`, unsaved: msg`Tailscale SSH asked you to approve this connection, and no approval came within 5 minutes, so Sotto stopped connecting. Nothing was saved. Approve it in your browser when Sotto asks, then add the host again.` }),
}
/** The SSH failures whose sentence names a version or a wait: `SshFailure.node`, `SshFailure.sshTooOld` and Tailscale's holds. */
export const SSH_FAILURE_VARIANTS = {
  nodeTooOldVersion: (version: string): FailureWords => ({ saved: msg`The SSH host runs Node ${version}, which is too old for the host. Install Node ${minimum} or a later Node ${major} for that SSH account, then reconnect.`, unsaved: msg`The SSH host runs Node ${version}, which is too old for the host. Nothing was saved. Install Node ${minimum} or a later Node ${major} for that SSH account, then add the host again.` }),
  nodeTooNewVersion: (version: string): FailureWords => ({ saved: msg`The SSH host runs Node ${version}, which is newer than this host release supports. Install Node ${minimum} or a later Node ${major} for that SSH account, then reconnect.`, unsaved: msg`The SSH host runs Node ${version}, which is newer than this host release supports. Nothing was saved. Install Node ${minimum} or a later Node ${major} for that SSH account, then add the host again.` }),
  sshTooOldWindows: (version: string): FailureWords => ({ saved: msg`This computer's OpenSSH is version ${version}, which is too old. Sotto needs OpenSSH 8.4 or later. Update it through Windows Update, or through OpenSSH Client in Settings > System > Optional features, then reconnect.`, unsaved: msg`This computer's OpenSSH is version ${version}, which is too old. Nothing was saved. Sotto needs OpenSSH 8.4 or later. Update it through Windows Update, or through OpenSSH Client in Settings > System > Optional features, then add the host again.` }),
  sshTooOldElsewhere: (version: string): FailureWords => ({ saved: msg`This computer's OpenSSH is version ${version}, which is too old. Sotto needs OpenSSH 8.4 or later. Update OpenSSH on this computer, then reconnect.`, unsaved: msg`This computer's OpenSSH is version ${version}, which is too old. Nothing was saved. Sotto needs OpenSSH 8.4 or later. Update OpenSSH on this computer, then add the host again.` }),
  holdForward: (): FailureWords => ({ saved: msg`Tailscale SSH asked you to approve the port forward as well, and closed it after 30 seconds without an approval. Try again, and approve it in your browser when Sotto asks.`, unsaved: msg`Tailscale SSH asked you to approve the port forward as well, and closed it after 30 seconds without an approval. Nothing was saved. Try again, and approve it in your browser when Sotto asks.` }),
  holdRequest: (): FailureWords => ({ saved: msg`Tailscale SSH asked you to approve this request, and Sotto shows an approval only while it connects. Nothing was changed. Switch the host off and on, approve the connection in your browser when Sotto asks, then try again.`, unsaved: msg`Tailscale SSH asked you to approve this request, and Sotto shows an approval only while it connects. Nothing was saved. Nothing was changed. Switch the host off and on, approve the connection in your browser when Sotto asks, then try again.` }),
} as const

/** The words of an SSH failure, by its code and what it names; undefined for one that carries words of its own. */
export function sshFailureWords(failure: SshFailure): FailureWords | undefined {
  const named = failure.named
  if (named?.kind === 'node') return failure.code === 'node-too-old' ? SSH_FAILURE_VARIANTS.nodeTooOldVersion(named.version) : SSH_FAILURE_VARIANTS.nodeTooNewVersion(named.version)
  if (named?.kind === 'ssh-too-old') return named.platform === 'win32' ? SSH_FAILURE_VARIANTS.sshTooOldWindows(named.version) : SSH_FAILURE_VARIANTS.sshTooOldElsewhere(named.version)
  if (named?.kind === 'hold') return named.hold === 'forward' ? SSH_FAILURE_VARIANTS.holdForward() : SSH_FAILURE_VARIANTS.holdRequest()
  return failure.standard ? SSH_FAILURES[failure.code]() : undefined
}

/** The sentence that introduces an SSH failure's fix (`failureFix`), by its code. */
export function sshFixWords(code: SshFailureCode, fix: SshFix): Said {
  // Only the sentence `failureFix` writes for the code is said again; any other is shown as it came.
  const words = standardFixWords(code, fix)
  return typeof words !== 'string' && inEnglish(words) !== fix.text ? fix.text : words
}
function standardFixWords(code: SshFailureCode, fix: SshFix): Said {
  switch (code) {
    case 'ssh-failed': case 'ssh-unreachable': case 'auth-failed': case 'connect-timeout': return msg`To see what SSH itself says, run this in a terminal on this computer:`
    case 'host-key-changed': return msg`Once you know the new key is the host's own, remove the old one from your known hosts on this computer:`
    case 'boot-start-refused': case 'boot-unit-failed': return msg`To see why, run this on the SSH host:`
    case 'archive-missing': {
      const archive = fix.archive
      return archive === undefined ? fix.text : msg`Download ${archive} from the Sotto releases page to the SSH host, then unpack it into the host installation folder there:`
    }
    default: return fix.text
  }
}

/** A failure's words, or its message for both when it has none of Sotto's: a system error, shown as it came. */
export function failureWords(failure: Error): { readonly saved: Said; readonly unsaved: Said } {
  const own = failure instanceof SshFailure ? sshFailureWords(failure) : failure instanceof WordedError ? failure.words : (failure as { words?: FailureWords }).words
  return own ?? { saved: failure.message, unsaved: unsavedText(failure.message) }
}
/**
 * Add host's sentence for text that is none of Sotto's messages, such as a system error, which is shown as it came: the
 * row's English with "Nothing was saved." after its first sentence. Sotto's own failures have whole Add host messages above.
 */
export function unsavedText(message: string): string {
  const next = message.replace(/,? then reconnect\.$/u, ', then add the host again.').replace(/ and reconnect\.$/u, ' and add the host again.')
    .replace(/ before reconnecting\.$/u, ' before adding the host again.').replace(/Connect again (to|when)/u, 'Add the host again $1')
  const end = next.search(/[.!?]\s/u)
  return end < 0 ? `${next} Nothing was saved.` : `${next.slice(0, end + 1)} Nothing was saved. ${next.slice(end + 2)}`
}
