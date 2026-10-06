import type { HostSetupStep } from '../../shared/hosts'

/**
 * Why an SSH host connection or request failed. The code is what code decides on (retry or stop, which
 * message); the message is what the user reads, and rewording it changes no decision.
 */
export type SshFailureCode =
  | 'ssh-missing'
  | 'ssh-too-old'
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
  | 'host-not-running'
  | 'boot-start-refused'
  | 'boot-unit-failed'
  | 'forward-failed'
  | 'forward-timeout'
  | 'pairing-failed'
  | 'permission-setup-failed'
  | 'revoke-failed'
  | 'admin-failed'
  | 'stop-failed'
  | 'update-failed'
  | 'boot-failed'
  | 'request-busy'
  | 'not-connected'
  | 'cancelled'
  | 'tailscale-unapproved'

/** The Node major a host archive needs when the archive does not say. `scripts/package-host.mjs` writes the same range. */
export const HOST_NODE_MAJOR = 24

const MESSAGES: Readonly<Record<SshFailureCode, string>> = {
  'ssh-missing': 'SSH could not start. Install OpenSSH and check that its executable is available.',
  'ssh-too-old': "This computer's OpenSSH is too old. Sotto needs OpenSSH 8.4 or later. Update OpenSSH on this computer, then reconnect.",
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
  'host-not-running': 'The host is not running on the SSH host, so nothing was changed there. Connect to it in Settings > Hosts, which starts it, then try again.',
  'boot-start-refused': 'The host starts at boot, and its systemd unit would not start. Nothing was lost. Check the unit on the SSH host, then reconnect.',
  'boot-unit-failed': 'The host starts at boot, and its systemd unit stopped before the host was ready. Nothing was lost, and the unit may still be trying to start it. Check the unit on the SSH host, then reconnect.',
  'forward-failed': 'The SSH port forward could not open. Reconnect, and if it fails again, check that the SSH server allows port forwarding.',
  'forward-timeout': 'The SSH forward was not ready in time. Check SSH access and reconnect.',
  'pairing-failed': 'The pairing code could not be read from the host. Check that the host is running and try again.',
  'permission-setup-failed': 'Desktop permissions could not be set up on the host. Nothing was replaced. Check its data folder, then reconnect.',
  'revoke-failed': 'Client access could not be revoked. Check the host connection and try Forget again.',
  'admin-failed': 'Phone access on the host could not be reached. Nothing was changed. Check that the host is running, then try again.',
  'stop-failed': 'The host could not be stopped. It may still be running on the SSH host.',
  'update-failed': 'The connection to the host closed before this step of its update finished.',
  'boot-failed': 'The connection to the host closed before start at boot was changed. Connect again to see whether it changed.',
  'request-busy': 'Wait for the current host request to finish.',
  'not-connected': 'Connect to the SSH host first.',
  'cancelled': 'The SSH connection was cancelled.',
  'tailscale-unapproved': 'Tailscale SSH asked you to approve this connection, and no approval came within 5 minutes, so Sotto stopped connecting. Approve it in your browser when Sotto asks, then reconnect.',
}

/** Node's own version string from the host, shown to the user only when it is plainly a version. */
function nodeMessage(code: 'node-too-old' | 'node-too-new', version: string | undefined): string {
  if (!version || !/^\d{1,4}(?:\.\d{1,6}){0,3}$/u.test(version)) return MESSAGES[code]
  return code === 'node-too-old'
    ? `The SSH host runs Node ${version}, which is too old for the host. Install Node ${HOST_NODE_MAJOR} for that SSH account, then reconnect.`
    : `The SSH host runs Node ${version}, which is newer than this host release supports. Install Node ${HOST_NODE_MAJOR} for that SSH account, then reconnect.`
}

/** A command that fixes a failure, for the user to run, and the sentence that introduces it. Sotto never runs it. */
export interface SshFix { readonly text: string; readonly command: string }

export class SshFailure extends Error {
  /** Set where there is one exact command that fixes the failure. */
  fix?: SshFix
  constructor(readonly code: SshFailureCode, message: string = MESSAGES[code]) {
    super(message)
    this.name = 'SshFailure'
  }
  static node(code: 'node-too-old' | 'node-too-new', version: string | undefined): SshFailure {
    return new SshFailure(code, nodeMessage(code, version))
  }
  /** This computer's ssh is older than askpass needs (OpenSSH 8.4). `version` is what `ssh -V` said, such as `8.1p1`. */
  static sshTooOld(version: string, platform: NodeJS.Platform): SshFailure {
    const update = platform === 'win32'
      ? 'Update it through Windows Update, or through OpenSSH Client in Settings > System > Optional features, then reconnect.'
      : 'Update OpenSSH on this computer, then reconnect.'
    return new SshFailure('ssh-too-old', `This computer's OpenSSH is version ${version}, which is too old. Sotto needs OpenSSH 8.4 or later. ${update}`)
  }
}

/** The launch script's reasons that name a failure on the host side; anything else it says is `host-start-failed`. */
export const LAUNCH_REASONS: ReadonlySet<SshFailureCode> = new Set<SshFailureCode>([
  'archive-missing', 'descriptor-invalid', 'port-taken', 'host-busy', 'host-start-failed', 'host-timeout', 'host-not-running',
  'boot-start-refused', 'boot-unit-failed', 'node-missing', 'node-too-old', 'node-too-new',
])

/**
 * The host setup checklist step each failure belongs to. A code that is not here (a timeout, SSH's catch-all,
 * a cancel) shows on whichever step the connect had reached.
 */
const FAILURE_STEPS: Partial<Readonly<Record<SshFailureCode, HostSetupStep>>> = {
  'ssh-missing': 'reach', 'ssh-too-old': 'reach', 'ssh-unreachable': 'reach',
  'tailscale-unapproved': 'tailscale',
  'auth-failed': 'sign-in', 'host-key-changed': 'sign-in', 'host-key-rejected': 'sign-in', 'identity-file-unreadable': 'sign-in', 'prompt-unanswered': 'sign-in',
  // Until the host archive carries its own Node (#207), a missing or unsuitable Node is part of the installation.
  'node-missing': 'install', 'node-too-old': 'install', 'node-too-new': 'install', 'archive-missing': 'install',
  'descriptor-invalid': 'start', 'port-taken': 'start', 'host-busy': 'start', 'host-start-failed': 'start', 'host-timeout': 'start', 'host-not-running': 'start',
  'boot-start-refused': 'start', 'boot-unit-failed': 'start',
  'forward-failed': 'start', 'forward-timeout': 'start',
  'pairing-failed': 'pair',
  'permission-setup-failed': 'pair',
}
export const failureStep = (code: SshFailureCode): HostSetupStep | undefined => FAILURE_STEPS[code]

/** What an ssh process that ended without a result left behind: its exit, its stderr, and whether Tailscale held it. */
export interface SshExit {
  readonly spawnFailed?: boolean | undefined
  readonly exitCode?: number | null | undefined
  readonly stderr: string
  /** Tailscale SSH asked for approval on this process, and it never signed in. */
  readonly heldForApproval?: boolean | undefined
  /** The process ran with the live keepalive, so a hold ended after 30 seconds: the port forward, or a request once connected. */
  readonly liveWait?: 'forward' | 'request' | undefined
}
/** A hold that ended after 30 seconds, where the 5-minute approval wait does not apply. */
const SHORT_HOLDS = {
  forward: 'Tailscale SSH asked you to approve the port forward as well, and closed it after 30 seconds without an approval. Try again, and approve it in your browser when Sotto asks.',
  request: 'Tailscale SSH asked you to approve this request, and Sotto shows an approval only while it connects. Nothing was changed. Switch the host off and on, approve the connection in your browser when Sotto asks, then try again.',
} as const
/**
 * Why an ssh process ended without a result, from its exit and OpenSSH's own words, falling back to what the
 * operation was for. Never logged.
 */
export function classifySshExit(run: SshExit, fallback: SshFailureCode): SshFailure {
  if (run.spawnFailed) return new SshFailure('ssh-missing')
  // 127 is the remote shell's "command not found": the account has no usable shell or Node.
  if (run.exitCode === 127) return new SshFailure('node-missing')
  // Tailscale answers no keepalive while it holds a connection for approval, so the end of a held connection
  // (a timeout, or Tailscale closing it) means the approval never came.
  if (run.heldForApproval) return run.liveWait ? new SshFailure('tailscale-unapproved', SHORT_HOLDS[run.liveWait]) : new SshFailure('tailscale-unapproved')
  const text = run.stderr.split(/\r?\n/u).filter(line => !/^debug\d?:/u.test(line)).join('\n')
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/iu.test(text)) return new SshFailure('host-key-changed')
  if (/Host key verification failed/iu.test(text)) return new SshFailure('host-key-rejected')
  if (/Permission denied|Too many authentication failures|Authentication failed/iu.test(text)) return new SshFailure('auth-failed')
  if (/bind .*Address already in use|cannot listen to port|Could not request local forwarding|forwarding failed/iu.test(text)) return new SshFailure('forward-failed')
  // OpenSSH's own read timeout while connecting and signing in (ServerAliveInterval x ServerAliveCountMax).
  if (/Connection to \S+ port \d+ timed out/iu.test(text)) return new SshFailure('connect-timeout')
  if (/Could not resolve hostname|Name or service not known|Connection refused|Connection timed out|Operation timed out|Network is unreachable|No route to host|Connection closed by|Connection reset|kex_exchange_identification/iu.test(text)) return new SshFailure('ssh-unreachable')
  // 255 is ssh's own exit: it failed before or instead of running the command. Anything else came from the host's side.
  return new SshFailure(run.exitCode === 255 && fallback !== 'forward-failed' ? 'ssh-failed' : fallback)
}

/** A word safe to show inside a command the user copies: a host name, an address, a user or a port. */
const plainWord = (value: string): boolean => /^[A-Za-z0-9._:@[\]-]{1,255}$/u.test(value)
/** A folder on the SSH host written the way a POSIX shell reads it inside double quotes, or undefined when it needs more care. */
function shellFolder(path: string): string | undefined {
  if (!/^(?:~\/|\/)[A-Za-z0-9._/-]{0,1024}$/u.test(path)) return undefined
  return path.startsWith('~/') ? `"$HOME/${path.slice(2)}"` : `"${path}"`
}
/**
 * An identity file on this computer written so a POSIX shell, PowerShell and cmd.exe all read it as one word,
 * or undefined when it needs more care. It is already absolute: `validateSshHost()` expanded `~`.
 */
function localPath(path: string): string | undefined {
  if (!/^[A-Za-z0-9._:/\\ -]{1,1024}$/u.test(path)) return undefined
  return path.includes(' ') ? `"${path}"` : path
}
/**
 * The exact command that fixes a failure, where there is one: SSH's own words for a sign-in or reach
 * failure, the stale known-hosts entry for a changed key, and the archive for a missing installation.
 */
export function failureFix(code: SshFailureCode, context: {
  readonly target: string; readonly sshPort?: number | undefined; readonly installPath: string
  /** An identity file saved with the host, which Sotto passes with `IdentitiesOnly`; the command signs in the same way. */
  readonly identityFile?: string | undefined
  /** Where the SSH configuration sent the target, from `ssh -G`, when it was read. */
  readonly hostname?: string | undefined; readonly port?: number | undefined; readonly version: string
}): SshFix | undefined {
  const port = context.sshPort ?? context.port
  if (code === 'ssh-failed' || code === 'ssh-unreachable' || code === 'auth-failed' || code === 'connect-timeout') {
    if (!plainWord(context.target)) return undefined
    const identity = context.identityFile ? localPath(context.identityFile) : ''
    if (identity === undefined) return undefined
    return { text: 'To see what SSH itself says, run this in a terminal on this computer:',
      command: `ssh ${identity ? `-i ${identity} -o IdentitiesOnly=yes ` : ''}${context.sshPort ? `-p ${context.sshPort} ` : ''}${context.target}` }
  }
  if (code === 'host-key-changed') {
    const host = context.hostname ?? context.target.split('@').at(-1) ?? ''
    if (!plainWord(host) || host.includes('@')) return undefined
    const entry = port && port !== 22 ? `'[${host}]:${port}'` : host
    return { text: "Once you know the new key is the host's own, remove the old one from your known hosts on this computer:", command: `ssh-keygen -R ${entry}` }
  }
  // A start at boot unit that would not start, or would not stay up, says why in its own journal (ADR-0054).
  if (code === 'boot-start-refused' || code === 'boot-unit-failed') {
    return { text: 'To see why, run this on the SSH host:', command: 'journalctl --user -u sotto-host -n 50 --no-pager' }
  }
  if (code === 'archive-missing') {
    const folder = shellFolder(context.installPath)
    if (!folder || !/^\d+\.\d+\.\d+$/u.test(context.version)) return undefined
    const archive = `Sotto-host-${context.version}-linux-x64.tar.gz`
    return { text: `Download ${archive} from the Sotto releases page to the SSH host, then unpack it into the host installation folder there:`,
      command: `mkdir -p ${folder} && tar -xzf ${archive} -C ${folder}` }
  }
  return undefined
}
