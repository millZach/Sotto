import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { E2EAgentHost } from '../../src/main/e2e/agentEffects'
import { ProviderUnavailable } from '../../src/main/agents/providerProblem'
import { ProviderClients, type RunLike } from '../../src/main/agents/providerClients'
import { installerDetail, installerOutput } from '../../src/main/agents/installerDetail'
import type { AgentHostSnapshot, ProviderId } from '../../src/shared/agents'

/**
 * forge on September 29, 2026, for the #480 journey (tests/e2e/host-client-updates.spec.ts): Claude Code, Codex and
 * Grok Build installed by mise, signed in and all three behind; Devin not installed. The mise layout is real, in the
 * host's throwaway home, so the host reads each client's channel from disk the way it does on forge; only mise, Node
 * and the registry are stood in for. Files in `directory` steer it:
 *
 * - `codex.fail`: Codex's next upgrade drops its download, once.
 * - `grok.hold`: Grok Build's install step waits until the file is gone, so its second step can be seen.
 */
export const INSTALLED: Readonly<Record<'claude' | 'codex' | 'grok', string>> = { claude: '2.1.281', codex: '0.155.1', grok: '1.0.41' }
export const PUBLISHED: Readonly<Record<'claude' | 'codex' | 'grok', string>> = { claude: '2.1.284', codex: '0.158.0', grok: '1.0.43' }
const PACKAGES: Readonly<Record<string, 'claude' | 'codex' | 'grok'>> = { '%40anthropic-ai/claude-code': 'claude', '%40openai/codex': 'codex', '%40xai-official/grok': 'grok' }
const FOLDERS = { claude: 'claude', codex: 'codex', grok: 'npm-xai-official-grok' } as const
const TOOLS = { claude: 'claude', codex: 'codex', grok: 'npm:@xai-official/grok' } as const

/** A client connected with the version on "disk", which it reads again when told a new one is there, as an adapter does. */
class InstalledClient extends E2EAgentHost {
  constructor(private readonly id: 'claude' | 'codex' | 'grok', private readonly disk: Record<string, string>) { super(); this.running = disk[id]! }
  private running: string
  private versioned(snapshot: AgentHostSnapshot): AgentHostSnapshot { return { ...snapshot, version: this.running, ...(snapshot.connected ? { account: 'Subscription' } : {}) } }
  override async connect(): Promise<AgentHostSnapshot> { return this.versioned(await super.connect()) }
  override async snapshot(): Promise<AgentHostSnapshot> { return this.versioned(await super.snapshot()) }
  async clientUpdated(): Promise<void> { this.running = this.disk[this.id]! }
}
class NotInstalled extends E2EAgentHost {
  override async connect(): Promise<AgentHostSnapshot> { throw new ProviderUnavailable('not-installed', 'Install Devin CLI and run devin auth login, then connect again. Your threads and drafts are kept.') }
}

export function clientUpdateHost(directory: string, home: string) {
  const miseData = join(home, '.local', 'share', 'mise')
  const installs = join(miseData, 'installs')
  const disk: Record<string, string> = { ...INSTALLED }
  for (const id of ['claude', 'codex', 'grok'] as const) {
    mkdirSync(join(installs, FOLDERS[id], INSTALLED[id]), { recursive: true })
    writeFileSync(join(installs, FOLDERS[id], '.mise.backend.toml'), `short = "${TOOLS[id]}"\n`)
  }
  const grokPackage = join(installs, FOLDERS.grok, INSTALLED.grok, 'node_modules', '@xai-official', 'grok', 'bin')
  mkdirSync(grokPackage, { recursive: true })
  writeFileSync(join(grokPackage, 'postinstall.js'), '')
  mkdirSync(join(home, '.grok', 'bin'), { recursive: true })
  process.env.MISE_DATA_DIR = miseData
  // npm's global folder on this computer must not claim Grok Build: the one under test is mise's.
  process.env.APPDATA = join(home, 'AppData', 'Roaming')
  delete process.env.npm_config_prefix
  const where: Record<ProviderId, string> = {
    claude: join(installs, 'claude', 'latest', 'claude'), codex: join(installs, 'codex', 'latest', 'bin', 'codex'),
    grok: join(home, '.grok', 'bin', 'grok'), devin: join(home, 'nowhere', 'devin'),
  }
  const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
  const run: RunLike = async (_executable, args) => {
    if (args[0] === 'where') return { ok: true, stdout: join(installs, FOLDERS.grok, INSTALLED.grok) }
    if (args[0] === 'upgrade') {
      const id = (Object.keys(TOOLS) as (keyof typeof TOOLS)[]).find(key => TOOLS[key] === args[1])!
      await wait(700)
      if (id === 'codex' && existsSync(join(directory, 'codex.fail'))) {
        rmSync(join(directory, 'codex.fail'))
        const said = [
          `mise ERROR Failed to install aqua:openai/codex@${PUBLISHED.codex}`,
          `mise ERROR error sending request for url (https://github.com/openai/codex/releases/download/rust-v${PUBLISHED.codex}/codex-x86_64-unknown-linux-musl.tar.gz)`,
          'mise ERROR /Users/John Smith/Library/Application Support/mise/codex failed: exit status 1',
          String.raw`C:\Users\John Smith\AppData\codex.exe: The process cannot access the file. connection reset by peer`].join('\n')
        return { ok: false, detail: installerDetail(said)!, printed: installerOutput(said)! }
      }
      if (id !== 'grok') disk[id] = PUBLISHED[id]
      return { ok: true, stdout: '' }
    }
    if (!args[0]?.endsWith('postinstall.js')) return { ok: false, detail: 'The journey ran something other than mise or the install step.' }
    // Grok Build's install step: the new program reaches ~/.grok/bin only now.
    while (existsSync(join(directory, 'grok.hold'))) await wait(100)
    disk.grok = PUBLISHED.grok
    return { ok: true, stdout: '' }
  }
  const clients = new ProviderClients({ run, misePath: async () => '/usr/bin/mise',
    fetchImpl: async url => new Response(JSON.stringify({ version: PUBLISHED[Object.entries(PACKAGES).find(([name]) => url.includes(name))![1]] }), { status: 200 }) })
  return {
    clients, locateClient: async (provider: ProviderId) => where[provider],
    providers: { claude: new InstalledClient('claude', disk), codex: new InstalledClient('codex', disk), grok: new InstalledClient('grok', disk), devin: new NotInstalled() },
  }
}
