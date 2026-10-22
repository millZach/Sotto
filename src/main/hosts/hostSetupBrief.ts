import type { HostSetupStep } from '../../shared/hosts'
import { HOST_NODE_MAJOR, HOST_NODE_MINIMUM } from './sshFailure'
import { getReleaseTrack, releaseTrackName } from '../../shared/releaseTrack'

/** What the brief says about the device: everything Add host was given for it, and nothing else. */
export interface HostSetupBriefInput {
  /** The device's name, the host part of its SSH target. */
  readonly name: string
  readonly target: string
  readonly sshPort?: number | undefined
  readonly installPath: string
  readonly dataDirectory: string
  /** This computer's Sotto version, which the host must match. */
  readonly version: string
  /** The step Add it failed on and its reason code, when Have my agent fix this started the setup. */
  readonly failure?: { readonly step: HostSetupStep; readonly reason?: string | undefined } | undefined
}

const STEP_NAMES: Readonly<Record<HostSetupStep, string>> = {
  reach: 'reaching the device', tailscale: 'the Tailscale approval', 'sign-in': 'signing in', install: 'the host installation', start: 'starting the host', pair: 'pairing',
}

/**
 * The fixed first message of a host setup thread (ADR-0035). It names the device, its SSH target and folders, the
 * failure that led here if there was one, and the install steps `docs/guide.md` and `docs/release/releasing.md`
 * give today. It carries no key, token or password, and tells the agent never to read or copy one.
 *
 * #207 will let the desktop install the host itself; this lands before it, so the brief carries the install steps.
 * When #207 lands, the steps shrink to what automation cannot fix.
 */
export function hostSetupBrief(input: HostSetupBriefInput): string {
  const port = input.sshPort ? `port ${input.sshPort}` : 'the port from this computer\'s SSH configuration'
  const ssh = `ssh ${input.sshPort ? `-p ${input.sshPort} ` : ''}${input.target}`
  const archive = `Sotto-host-${input.version}-linux-x64.tar.gz`
  const name = releaseTrackName(getReleaseTrack(input.version))
  const failure = input.failure
    ? `\nAdd host already tried this device and stopped at ${STEP_NAMES[input.failure.step]}${input.failure.reason ? ` (reason code ${input.failure.reason})` : ''}. Start there.\n`
    : ''
  return `Set up the ${name} host on ${input.name}, so this computer can add it as a host in Sotto.

The device
- Name: ${input.name}
- SSH target: ${input.target}, on ${port}. Reach it from this computer with \`${ssh}\`.
- Host installation folder: ${input.installPath}
- Host data folder: ${input.dataDirectory}
- The host must be ${name} ${input.version}, the same version as this computer.
${failure}
What the host needs on ${input.name} (from Sotto's guide)
1. Node ${HOST_NODE_MINIMUM} or a later Node ${HOST_NODE_MAJOR} for the SSH account. Sotto looks for it on the account's path, then through its login shell, then where nvm, fnm, mise, asdf, Volta and Homebrew keep it. An older Node 24, or a newer or older major, does not work.
2. The host archive ${archive} from https://github.com/millZach/Sotto-releases/releases, checked against its .sha256 file and unpacked into the installation folder, so that host/index.js is directly inside it: \`mkdir -p <installation folder> && tar -xzf ${archive} -C <installation folder>\`. No npm install is needed. If ${input.name} cannot download it, download it on this computer and copy it over with scp.
3. A data folder the SSH account can create and write. Keep it outside the installation folder.

How to work
- Use the sotto_host_setup tools. host_status says what Sotto knows about this device. host_check runs Add host's own checks on it (reach it, sign in, check the installation, start the host) and says which step stopped and why, with a reason code; it saves nothing. host_add adds the device as a host; Sotto asks the user in this thread first, and you wait for their answer.
- Start with host_check. Fix what it reports, one thing at a time, then check again. When a check gets as far as starting the host, call host_add.
- Every command you run is a request the user answers. Say briefly what each one is for.
- If Tailscale asks the user to approve a connection, or SSH asks them a question, during host_check or host_add, Sotto asks them itself, over whichever page is open and in Settings > Hosts. The tool call waits for their answer.
- Ask the user before you change the SSH server's settings, Tailscale's settings, or anything outside the installation and data folders.
- Never read, print, copy or move a key, a token or a password, on ${input.name} or on this computer, and never touch this computer's credential store. The host needs none of them to start.
- If you cannot fix something, say what you found and what the user can do, and stop.`
}
