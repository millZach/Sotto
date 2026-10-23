import { PROVIDER_LABELS } from '../../shared/agents'
import type { HostProviderId, HostProviderJobCase } from '../../shared/hostProviders'

/** What the brief says about the job: the host, the provider, the case and what the host reported, and nothing else. */
export interface HostProviderBriefInput {
  /** The name the user saved the host under. */
  readonly host: string
  readonly target: string
  readonly sshPort?: number | undefined
  readonly provider: HostProviderId
  readonly case: HostProviderJobCase
  /** What the host reported: the version it found, the oldest Sotto accepts, and the adapter's own sentence. */
  readonly version?: string | undefined
  readonly requiredVersion?: string | undefined
  readonly message?: string | undefined
}

/** The command each client is started by on the host, which the lookup searches for. */
export const PROVIDER_COMMANDS: Readonly<Record<HostProviderId, string>> = { claude: 'claude', codex: 'codex', grok: 'grok', devin: 'devin', muse: 'muse', opencode: 'opencode' }

/**
 * Each provider's official way to install it on Linux or macOS, as its maker documents it, and what the host's lookup
 * needs of the result. Checked September 28, 2026 against code.claude.com/docs/en/setup, github.com/openai/codex,
 * docs.x.ai and npm's @xai-official/grok, and docs.devin.ai/cli; OpenCode's on October 16, 2026 against opencode.ai/v2/docs
 * and npm's @opencode/cli (#1104).
 */
export const PROVIDER_INSTALL_METHODS: Readonly<Record<HostProviderId, string>> = {
  claude: 'Anthropic\'s native installer, `curl -fsSL https://claude.ai/install.sh | bash`, which puts `claude` in ~/.local/bin (https://code.claude.com/docs/en/setup). npm\'s `npm install -g @anthropic-ai/claude-code` installs the same binary. Update a native install with `claude update`.',
  codex: 'npm\'s `npm install -g @openai/codex`, or OpenAI\'s installer, `curl -fsSL https://chatgpt.com/codex/install.sh | sh` (https://github.com/openai/codex). The host starts only Codex\'s native binary, never a script that wraps it; the GitHub release archive `codex-x86_64-unknown-linux-musl.tar.gz` (or the aarch64 one) holds it, to be renamed `codex` and put in ~/.local/bin.',
  grok: 'npm\'s `npm install -g @xai-official/grok`, or xAI\'s installer, `curl -fsSL https://x.ai/cli/install.sh | bash` (https://docs.x.ai/build/overview). Either keeps the native binary in ~/.grok/bin, which the host searches first. An npm install needs Node for the SSH account.',
  devin: 'Cognition\'s installer, `curl -fsSL https://cli.devin.ai/install.sh | bash` (https://docs.devin.ai/cli). Check where it put `devin`; if that folder is not one the host searches, link the binary into ~/.local/bin.',
  muse: 'Meta\'s documented installer, `curl -fsSL https://dev.meta.ai/install.sh | bash`, which puts its launcher and versioned native binary in ~/.local/bin. Follow https://dev.meta.ai/docs/muse-code/ on Windows for its PowerShell installer. Preserve an existing manager-owned install and update it with that manager.',
  opencode: 'OpenCode 2\'s installer, `curl -fsSL https://opencode.ai/v2/install | bash`, which puts `opencode` in ~/.opencode/bin, which the host searches first, or npm\'s `npm install -g @opencode/cli` (https://opencode.ai/v2/docs/). Sotto drives OpenCode 2 only: `https://opencode.ai/install` and npm\'s `opencode-ai` install OpenCode 1, which it refuses. Never move an existing install between channels: a copy in ~/.opencode/bin updates with `opencode upgrade`, an npm copy with npm, and a Homebrew, scoop or pacman copy with that manager. Check the result with `opencode --version` only. Sotto keeps the host\'s OpenCode data and sign-ins in a folder of its own, so do not start OpenCode itself or sign it in.',
}

/** Where the host's CLI lookup searches on Linux and macOS, in order (ADR-0036, `src/main/agents/cliLookup.ts`). */
export function providerLookupOrder(provider: HostProviderId): string {
  const command = PROVIDER_COMMANDS[provider]
  const own = provider === 'grok' ? '~/.grok/bin (Grok Build\'s own folder), then '
    : provider === 'opencode' ? '~/.opencode/bin (where OpenCode 2\'s installer puts it), then ' : ''
  const last = provider === 'codex' ? ', then ~/.codex/bin' : ''
  return `${own}the host's PATH, which from a non-interactive SSH shell is often only /usr/local/bin:/usr/bin:/bin; then the login shell's PATH, read once when the host starts; then ~/.local/bin; then mise's installs/${command}/latest (its bin folder, its top folder, and node_modules/.bin), asdf's, nvm's and fnm's newest versions, Volta, and Homebrew or Linuxbrew; then npm's global prefix (npm_config_prefix, a prefix in ~/.npmrc, ~/.npm-global, ~/.local/share/npm)${last}. A version manager's shim is never taken, and nor is a script that runs \`mise x\`, \`mise exec\` or \`asdf exec\`: the lookup goes on to the install behind it.`
}

const GOALS: Readonly<Record<HostProviderJobCase, (name: string, host: string) => string>> = {
  install: (name, host) => `Install ${name} on ${host}, where Sotto's host can find it and start it.`,
  update: (name, host) => `Update ${name} on ${host} to a version Sotto supports, where Sotto's host can find it and start it.`,
  fix: (name, host) => `Find out why Sotto's host on ${host} cannot find or start ${name}, which is installed there, and fix it.`,
}

/**
 * The fixed first message of a provider job's thread (ADR-0035, amended for #461). It names the host and its SSH
 * address, the provider, the case and what the host reported, where the host's lookup searches, and the provider's
 * official install method. It carries no key, token, password or sign-in code, tells the agent never to read or copy
 * one, and leaves signing in to the user.
 */
export function hostProviderBrief(input: HostProviderBriefInput): string {
  const name = PROVIDER_LABELS[input.provider]
  const command = PROVIDER_COMMANDS[input.provider]
  const ssh = `ssh ${input.sshPort ? `-p ${input.sshPort} ` : ''}${input.target}`
  const reported = input.case === 'install'
    ? `The host did not find ${name} anywhere it looks.`
    : input.case === 'update'
      ? `The host found ${name} ${input.version ?? '(its version was not reported)'}, which is too old. Sotto needs ${input.requiredVersion ? `${input.requiredVersion} or later` : 'a newer version (its floor is a set of flags, not a version number)'}.`
      : `${name} is installed on ${input.host}${input.version ? ` (${input.version})` : ''}, but the host could not find it or start it.`
  const said = input.message ? ` The host said: "${input.message}"` : ''
  const update = input.case === 'update'
    ? `\n- Update it with the channel that installed it: the one it was installed by (npm, mise, asdf, Homebrew, or its own \`${command} ${input.provider === 'opencode' ? 'upgrade' : 'update'}\`). Installing a second copy elsewhere leaves the old one first in the lookup.`
    : ''
  return `${GOALS[input.case](name, input.host)}

The job
- Host: ${input.host}, reached from this computer with \`${ssh}\`.
- Provider: ${name}, started by the command \`${command}\`.
- What the host reported: ${reported}${said}

Where the host looks for ${command}, in order
${providerLookupOrder(input.provider)}
Install so the result lands in one of those places. ~/.local/bin, mise's latest install and npm's global prefix work without a restart; a folder that only a shell profile adds to PATH is seen only after the host restarts.

How ${name} is installed (its maker's own method)
${PROVIDER_INSTALL_METHODS[input.provider]}

How to work
- Use the sotto_host_setup tools. provider_status says what Sotto knows about ${name} on ${input.host}. provider_check has ${input.host}'s host look for ${name} again and start it, the same as Check again on its tile; it says whether the host found it.
- Start with provider_status, then look at ${input.host} over SSH before changing anything.${update}
- After each fix, call provider_check. Stop as soon as it says the host found ${name}: the job is over, and the user signs in from Settings > Hosts & phones.
- Never sign in, sign out or change ${name}'s account, and never run its login command. Signing in is the user's.
- Every command you run is a request the user answers. Say briefly what each one is for.
- Ask the user before you use sudo, change system packages, or change anything outside the account's home folder.
- Never read, print, copy or move a key, a token, a password or a sign-in code, on ${input.host} or on this computer, and never touch this computer's credential store.
- If you cannot fix something, say what you found and what the user can do, and stop.`
}
