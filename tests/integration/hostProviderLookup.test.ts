// @vitest-environment node
/**
 * A headless host connects every provider that is installed and signed in when it starts, finds one a version
 * manager installed, and keeps a provider the user disconnected off across restarts (#459, ADR-0036).
 */
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { startHeadlessHost } from '../../src/host'
import { desktopWindowClient } from '../../src/main/agents/hostService'
import { resetCliLookup } from '../../src/main/agents/cliLookup'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { defaultAgentConfiguration, type AgentConfiguration, type AgentHostSnapshot, type AgentState, type ProviderId } from '../../src/shared/agents'

type Host = Awaited<ReturnType<typeof startHeadlessHost>>
const client = desktopWindowClient('host-provider-lookup')
const roots: string[] = []
const hosts: Host[] = []
afterEach(async () => {
  await Promise.allSettled(hosts.splice(0).map(host => host.close()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
})
async function folder(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  roots.push(root)
  return root
}
/** The saved coordinator state a host reads at start, the way a new host saved it before this change. */
async function saved(data: string, configuration: Partial<AgentConfiguration>): Promise<void> {
  await mkdir(data, { recursive: true })
  await writeFile(join(data, 'agents.json'), JSON.stringify({
    configuration: { ...defaultAgentConfiguration(), ...configuration },
    assignments: [], queue: [], activeThreadId: null, activeProjectId: null, draft: '', draftThreadId: null, composing: false, outbox: [],
  }))
}
const connection = (state: AgentState, provider: ProviderId) => state.host.providers?.find(status => status.id === provider)?.connection
const connections = (host: Host) => Object.fromEntries((['codex', 'claude', 'grok', 'devin'] as const).map(provider => [provider, connection(host.service.shell(), provider)]))
async function configuration(data: string): Promise<AgentConfiguration> {
  return (JSON.parse(await readFile(join(data, 'agents.json'), 'utf8')) as { configuration: AgentConfiguration }).configuration
}
/** A provider installed but not signed in: its connect fails, as Claude Code's did on forge on September 28. */
class SignedOut extends E2EAgentHost {
  override async connect(): Promise<AgentHostSnapshot> { throw new Error('Sign in to this provider on the host, then connect again.') }
}
/** A scripted provider that counts the connections asked of it, so staying off is a count and not a wait. */
class Counted extends E2EAgentHost {
  connects = 0
  override async connect(): Promise<AgentHostSnapshot> { this.connects += 1; return super.connect() }
}
const counted = () => ({ codex: new Counted(), claude: new Counted(), grok: new Counted(), devin: new Counted() })
const scripted = () => ({ codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost() })
async function start(data: string, providers: Partial<Record<ProviderId, E2EAgentHost>> = scripted()): Promise<Host> {
  const host = await startHeadlessHost({ dataDirectory: data, providers, reasoner: e2eAgentReasoner })
  hosts.push(host)
  return host
}

describe('a headless host and its providers', () => {
  it('connects every provider it can at start, not only the saved ones, and keeps one the user disconnected off across restarts', async () => {
    const data = join(await folder('sotto-host-providers-'), 'data')
    // What forge had saved: Claude Code alone, and Claude Code not signed in.
    await saved(data, { enabledProviders: ['claude'] })
    let host = await start(data, { ...scripted(), claude: new SignedOut() })
    await expect.poll(() => connections(host)).toEqual({ codex: 'connected', claude: 'error', grok: 'connected', devin: 'connected' })
    expect(host.service.shell().host.connected).toBe(true)

    // Disconnecting through the host is the user's choice, and it is recorded as one.
    expect((await host.service.command({ type: 'disconnect', provider: 'grok' }, client)).error).toBeNull()
    expect((await configuration(data)).disconnectedProviders).toEqual(['grok'])
    await host.close(); hosts.splice(hosts.indexOf(host), 1)

    const restarted = counted()
    host = await start(data, restarted)
    await expect.poll(() => connections(host)).toEqual({ codex: 'connected', claude: 'connected', grok: 'disconnected', devin: 'connected' })
    // A turned-off provider is not asked at start.
    expect(restarted.grok.connects).toBe(0)

    // Connecting it again is the user's choice too, and the record goes.
    expect((await host.service.command({ type: 'connect', provider: 'grok' }, client)).error).toBeNull()
    expect(connection(host.service.shell(), 'grok')).toBe('connected')
    expect((await configuration(data)).disconnectedProviders).toBeUndefined()
  })

  it('keeps every provider off on a host that was disconnected before the record existed', async () => {
    const data = join(await folder('sotto-host-providers-'), 'data')
    // Disconnect with no provider saved an empty enabled set, which nothing else writes.
    await saved(data, { enabledProviders: [] })
    const providers = counted()
    const host = await start(data, providers)
    expect(host.service.shell().host.connected).toBe(false)
    expect(Object.values(providers).map(provider => provider.connects)).toEqual([0, 0, 0, 0])
    expect((await configuration(data)).disconnectedProviders).toEqual(['codex', 'claude', 'grok', 'devin'])
  })

  it('turns off every provider on Disconnect, and a changed enabled set records what it left out', async () => {
    const data = join(await folder('sotto-host-providers-'), 'data')
    let host = await start(data)
    await expect.poll(() => connections(host)).toEqual({ codex: 'connected', claude: 'connected', grok: 'connected', devin: 'connected' })
    await host.service.command({ type: 'configure', patch: { enabledProviders: ['codex', 'claude'] } }, client)
    expect((await configuration(data)).disconnectedProviders).toEqual(['grok', 'devin'])
    await host.service.command({ type: 'configure', patch: { enabledProviders: ['codex', 'claude', 'grok'] } }, client)
    expect((await configuration(data)).disconnectedProviders).toEqual(['devin'])
    await host.service.command({ type: 'disconnect' }, client)
    expect((await configuration(data)).disconnectedProviders).toEqual(['codex', 'claude', 'grok', 'devin'])
    await host.close(); hosts.splice(hosts.indexOf(host), 1)

    const restarted = counted()
    host = await start(data, restarted)
    expect(connections(host)).toEqual({ codex: 'disconnected', claude: 'disconnected', grok: 'disconnected', devin: 'disconnected' })
    expect(Object.values(restarted).map(provider => provider.connects)).toEqual([0, 0, 0, 0])
    // With nothing connected, a create names the machine and the page that connects one, and claims no draft.
    const project = join(await folder('sotto-host-providers-'), 'site')
    expect((await host.service.command({ type: 'create-project', provider: 'codex', title: 'site', path: project }, client)).error)
      .toBe('No provider is connected on this host. Connect one in Settings > Hosts.')
  })
})

/**
 * forge on September 28, 2026: the launch script starts the host from a non-interactive SSH shell whose PATH is
 * `/usr/local/bin:/usr/bin:/bin`, and every provider CLI comes from mise. This runs the real Claude Code adapter
 * against the scripted CLI, installed the way mise installs one, with its `#!/usr/bin/env node` needing mise's Node.
 */
describe.skipIf(process.platform === 'win32')("a headless host on a machine whose CLIs come from mise (POSIX mise executable and symlink layout)", () => {
  // The runner's own manager folders must not stand in for the fake home's.
  const keys = ['PATH', 'HOME', 'SHELL', 'XDG_DATA_HOME', 'MISE_DATA_DIR', 'ASDF_DATA_DIR', 'NVM_DIR', 'FNM_DIR', 'VOLTA_HOME', 'HOMEBREW_PREFIX', 'npm_config_prefix', 'NPM_CONFIG_PREFIX'] as const
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  afterEach(() => {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    resetCliLookup()
  })

  it('finds Claude Code under mise\'s installs, connects it on its own, and creates a project with it', async () => {
    const root = await folder('sotto-host-mise-')
    const home = join(root, 'home'), data = join(root, 'data'), state = join(root, 'claude-state')
    const installs = join(home, '.local', 'share', 'mise', 'installs')
    await mkdir(state, { recursive: true })
    const script = async (path: string, body: string): Promise<void> => {
      await mkdir(dirname(path), { recursive: true }); await writeFile(path, body); await chmod(path, 0o755)
    }
    // mise keeps each version in its own folder and links `latest` to the newest. Its Node says it ran, so the
    // test can tell it from any other Node on the machine.
    await script(join(installs, 'claude', '2.1.281', 'bin', 'claude'), `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(join(state, 'node.log'))}, (process.env.SOTTO_FAKE_NODE ?? 'another Node') + '\\n')\nprocess.argv.splice(2, 0, ${JSON.stringify(state)})\nimport(${JSON.stringify(pathToFileURL(resolve('tests/fixtures/fakeClaudeThread.mjs')).href)})\n`)
    await symlink('./2.1.281', join(installs, 'claude', 'latest'))
    await script(join(installs, 'node', '24.21.0', 'bin', 'node'), `#!/bin/sh\nexport SOTTO_FAKE_NODE=installs\nexec ${JSON.stringify(process.execPath)} "$@"\n`)
    await symlink('./24.21.0', join(installs, 'node', 'latest'))
    // mise itself, a shim that resolves to it, and forge's ~/.local/bin wrapper that runs `mise x`. Each would run
    // mise, which says so; the lookup must pass all of them over for the install.
    const mise = join(root, 'usr', 'bin', 'mise')
    await script(mise, `#!/bin/sh\necho "$@" >> ${JSON.stringify(join(state, 'mise.log'))}\nexit 1\n`)
    await mkdir(join(home, '.local', 'share', 'mise', 'shims'), { recursive: true })
    await symlink(mise, join(home, '.local', 'share', 'mise', 'shims', 'claude'))
    await script(join(home, '.local', 'bin', 'claude'), `#!/bin/bash\n${mise} use -g --quiet claude || exit 1\nexec ${mise} x claude -- claude "$@"\n`)
    // forge's login shell puts mise's shims and ~/.local/bin on PATH, as its profile does.
    const shell = join(root, 'login-shell')
    await script(shell, '#!/bin/sh\nPATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH"\nexport PATH\nshift\nexec /bin/sh "$@"\n')
    // Nothing saved names Claude Code. The others are turned off, so the host starts no client this machine has.
    await saved(data, { enabledProviders: [], disconnectedProviders: ['codex', 'grok', 'devin'] })

    // forge's PATH held no Node and no Claude Code; a runner's /usr/local/bin may hold both, so it is left out.
    const path = ['/usr/local/bin', '/usr/bin', '/bin'].filter(entry => !existsSync(join(entry, 'node')) && !existsSync(join(entry, 'claude')))
    expect(path).toContain('/usr/bin')
    for (const key of keys) delete process.env[key]
    Object.assign(process.env, { PATH: path.join(':'), HOME: home, SHELL: shell })
    resetCliLookup()
    const host = await startHeadlessHost({ dataDirectory: data, reasoner: e2eAgentReasoner })
    hosts.push(host)
    await expect.poll(() => connection(host.service.shell(), 'claude'), { timeout: 10_000 }).toBe('connected')
    for (const provider of ['codex', 'grok', 'devin'] as const) expect(connection(host.service.shell(), provider)).toBe('disconnected')

    const project = join(root, 'site')
    const result = await host.service.command({ type: 'create-project', provider: 'claude', title: 'site', path: project }, client)
    expect(result.error).toBeNull()
    expect(host.service.shell().host.projects.map(item => item.path)).toContain(project)
    expect(await readFile(join(state, 'violations.jsonl'), 'utf8').catch(() => '')).toBe('')
    // Every Claude Code process ran as mise installed it, on mise's Node from the PATH the host gave it, and none
    // went through mise.
    const nodes = (await readFile(join(state, 'node.log'), 'utf8')).trim().split('\n')
    expect(new Set(nodes)).toEqual(new Set(['installs']))
    expect(existsSync(join(state, 'mise.log'))).toBe(false)
  })
})
