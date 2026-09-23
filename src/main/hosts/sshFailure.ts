/**
 * Why an SSH host connection or request failed. The code is what code decides on (retry or stop, which
 * message); the message is what the user reads, and rewording it changes no decision.
 */
export type SshFailureCode =
  | 'ssh-missing'
  | 'ssh-unreachable'
  | 'ssh-failed'
  | 'auth-failed'
  | 'host-key-changed'
  | 'host-key-rejected'
  | 'identity-file-unreadable'
  | 'connect-timeout'
  | 'prompt-unanswered'
  | 'node-missing'
  | 'node-too-old'
  | 'node-too-new'
  | 'archive-missing'
  | 'descriptor-invalid'
  | 'port-taken'
  | 'host-busy'
  | 'host-start-failed'
  | 'host-timeout'
  | 'forward-failed'
  | 'forward-timeout'
  | 'pairing-failed'
  | 'revoke-failed'
  | 'stop-failed'
  | 'request-busy'
  | 'not-connected'
  | 'cancelled'

/** The Node major a host archive needs when the archive does not say. `scripts/package-host.mjs` writes the same range. */
export const HOST_NODE_MAJOR = 24

const MESSAGES: Readonly<Record<SshFailureCode, string>> = {
  'ssh-missing': 'SSH could not start. Install OpenSSH and check that its executable is available.',
  'ssh-unreachable': 'SSH could not reach the host. Check the host name and your network, then reconnect.',
  'ssh-failed': 'SSH could not connect to the host. Check the host name and SSH access, then reconnect.',
  'auth-failed': 'The SSH host refused your sign-in. Check the user name, password or identity file, then reconnect.',
  'host-key-changed': 'The SSH host key changed. Verify the host identity and update your SSH known hosts before reconnecting.',
  'host-key-rejected': 'The SSH host key was not trusted, so Sotto did not connect. Connect again to review the key.',
  'identity-file-unreadable': 'The SSH identity file could not be read. Choose its current path and reconnect.',
  'connect-timeout': 'SSH did not finish connecting in time. Check the host and your network, then reconnect.',
  'prompt-unanswered': 'SSH waited too long for your answer, so Sotto stopped connecting. Connect again when you are ready to answer.',
  'node-missing': `Node was not found on the SSH host. Install Node ${HOST_NODE_MAJOR} for that SSH account, then reconnect.`,
  'node-too-old': `The SSH host's Node is too old for the host. Install Node ${HOST_NODE_MAJOR} for that SSH account, then reconnect.`,
  'node-too-new': `The SSH host's Node is newer than this host release supports. Install Node ${HOST_NODE_MAJOR} for that SSH account, then reconnect.`,
  'archive-missing': 'The host installation was not found. Check its folder on the SSH host and reconnect.',
  'descriptor-invalid': 'The host connection record could not be read. Check the host data folder before reconnecting.',
  'port-taken': 'Another program is using the port the host last listened on. Stop it on the SSH host, then reconnect.',
  'host-busy': 'A host process already holds that data folder but is not answering. Check it on the SSH host, then reconnect.',
  'host-start-failed': 'The host could not start. Check its installation and data folder on the SSH host. If the data folder holds saved credentials, set SOTTO_HOST_KEY_FILE for that SSH account.',
  'host-timeout': 'The host was not ready in time. Check that it starts on the SSH host, then reconnect.',
  'forward-failed': 'The SSH port forward could not open. Reconnect, and if it fails again, check that the SSH server allows port forwarding.',
  'forward-timeout': 'The SSH forward was not ready in time. Check SSH access and reconnect.',
  'pairing-failed': 'The pairing code could not be read from the host. Check that the host is running and try again.',
  'revoke-failed': 'Client access could not be revoked. Check the host connection and try Forget again.',
  'stop-failed': 'The host could not be stopped. It may still be running on the SSH host.',
  'request-busy': 'Wait for the current host request to finish.',
  'not-connected': 'Connect to the SSH host first.',
  'cancelled': 'The SSH connection was cancelled.',
}

/** Node's own version string from the host, shown to the user only when it is plainly a version. */
function nodeMessage(code: 'node-too-old' | 'node-too-new', version: string | undefined): string {
  if (!version || !/^\d{1,4}(?:\.\d{1,6}){0,3}$/u.test(version)) return MESSAGES[code]
  return code === 'node-too-old'
    ? `The SSH host runs Node ${version}, which is too old for the host. Install Node ${HOST_NODE_MAJOR} for that SSH account, then reconnect.`
    : `The SSH host runs Node ${version}, which is newer than this host release supports. Install Node ${HOST_NODE_MAJOR} for that SSH account, then reconnect.`
}

export class SshFailure extends Error {
  constructor(readonly code: SshFailureCode, message: string = MESSAGES[code]) {
    super(message)
    this.name = 'SshFailure'
  }
  static node(code: 'node-too-old' | 'node-too-new', version: string | undefined): SshFailure {
    return new SshFailure(code, nodeMessage(code, version))
  }
}

/** The launch script's reasons that name a failure on the host side; anything else it says is `host-start-failed`. */
export const LAUNCH_REASONS: ReadonlySet<SshFailureCode> = new Set<SshFailureCode>([
  'archive-missing', 'descriptor-invalid', 'port-taken', 'host-busy', 'host-start-failed', 'host-timeout',
  'node-missing', 'node-too-old', 'node-too-new',
])
