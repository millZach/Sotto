// @vitest-environment node
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { SshFailure, SshHostLauncher, type SshApproval, type SshPrompt } from '../../src/main/hosts/sshLauncher'
import { CONTROL_OPTIONS, type SpawnSsh } from '../../src/main/hosts/sshProcess'
import { AskpassBroker } from '../../src/main/hosts/sshAskpass'
import { LAUNCH_SCRIPT_SOURCE } from '../../src/main/hosts/launchScript'
import { createServer } from 'node:http'
import { hostRelease, localArchiveName, releasesPage, sha256, sidecar, tarGz } from '../fixtures/hostArchive'

const directories: string[] = [], launchers: SshHostLauncher[] = [], hosts: number[] = []
afterEach(async () => {
  for (const launcher of launchers.splice(0)) await launcher.disconnect()
  for (const pid of hosts.splice(0)) { try { process.kill(pid, 'SIGTERM') } catch { /* already exited */ } }
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})
const configuration = { target: 'user@forge', installPath: '/opt/sotto release', dataDirectory: '/data/sotto' }
const SCRIPT_SHA = createHash('sha256').update(LAUNCH_SCRIPT_SOURCE).digest('hex')
interface Spawned { type: string; args: string[]; tunnel: boolean; resolve: boolean; op?: string; stdinSha256: string; askpass: boolean }
async function fixture(mode = 'started', options: { authenticationTimeoutMs?: number; approvalTimeoutMs?: number; startMs?: number; holdMs?: number; version?: string; platform?: NodeJS.Platform; readyTimeoutMs?: number } = {}) {
  const path = await mkdtemp(join(tmpdir(), 'sotto-ssh-')); directories.push(path)
  const record = join(path, 'ssh.jsonl')
  const spawner: SpawnSsh = (_file, args, spawnOptions) => spawn(process.execPath, [resolve('tests/fixtures/fakeSsh.mjs'), ...args],
    { shell: false, windowsHide: true, stdio: [spawnOptions.stdin, 'pipe', 'pipe'],
      env: { ...spawnOptions.env, FAKE_SSH_MODE: mode, FAKE_SSH_RECORD: record, FAKE_SSH_ROOT: path, FAKE_SSH_START_MS: String(options.startMs ?? 0), FAKE_SSH_HOLD_MS: String(options.holdMs ?? 200), FAKE_SSH_VERSION: options.version ?? '' } })
  // Ordinary connection tests use production budgets; only deadline tests shorten them deliberately.
  const launcher = new SshHostLauncher({ spawn: spawner,
    ...(options.authenticationTimeoutMs !== undefined ? { authenticationTimeoutMs: options.authenticationTimeoutMs } : {}),
    ...(options.readyTimeoutMs !== undefined ? { readyTimeoutMs: options.readyTimeoutMs } : {}),
    ...(options.approvalTimeoutMs ? { approvalTimeoutMs: options.approvalTimeoutMs } : {}),
    ...(options.platform ? { platform: options.platform } : {}) })
  launchers.push(launcher)
  const events = async () => (await readFile(record, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Spawned & { kind?: string; accepted?: boolean; owned?: boolean })
  return { launcher, path, events, spawns: async () => (await events()).filter(event => event.type === 'spawn') }
}
async function failure(promise: Promise<unknown>): Promise<SshFailure> {
  const error = await promise.then(() => undefined, (reason: unknown) => reason)
  expect(error).toBeInstanceOf(SshFailure)
  return error as SshFailure
}

it.each(['started', 'discovered'])('discovers readiness, verifies the forward and leaves the host running on close: %s', async mode => {
  const { launcher, spawns } = await fixture(mode)
  const status: string[] = []
  const connection = await launcher.connect(configuration, { onStatus: value => status.push(value) })
  expect(connection.hostId).toBe('11111111-1111-4111-8111-111111111111')
  expect(connection.owned).toBe(mode === 'started')
  expect(connection.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u)
  expect(connection.route).toEqual({ hostname: 'forge.example.net', user: 'user', port: 2222, identityFiles: ['~/.ssh/id_ed25519', '~/.ssh/id_rsa'] })
  expect(status).toEqual(['connecting', ...(mode === 'started' ? ['starting'] : []), 'forwarding', 'ready'])
  expect(await connection.showHostPairingCode()).toMatchObject({ code: 'ABC123', hostId: connection.hostId })
  await connection.close()
  expect(status.at(-1)).toBe('disconnected')
  const spawned = await spawns()
  // -G, launch, forward, pairing code: four ssh processes, and only the forward outlives its answer.
  expect(spawned.map(item => item.resolve ? 'resolve' : item.tunnel ? 'forward' : item.op)).toEqual(['resolve', 'launch', 'forward', 'pairing-code'])
  expect(spawned.find(item => item.tunnel)?.args).toContainEqual(expect.stringMatching(/^127\.0\.0\.1:\d+:127\.0\.0\.1:4317$/u))
})
it('starts the sign-in deadline after the askpass helper is ready', async () => {
  const { launcher } = await fixture('started', { authenticationTimeoutMs: 10_000 })
  const preparing = Promise.withResolvers<void>(), ready = Promise.withResolvers<void>()
  const start = AskpassBroker.start.bind(AskpassBroker)
  const preparation = vi.spyOn(AskpassBroker, 'start').mockImplementation(async (...args) => {
    preparing.resolve()
    await ready.promise
    return start(...args)
  })
  const statuses: string[] = []
  vi.useFakeTimers()
  const connecting = launcher.connect(configuration, { onStatus: status => statuses.push(status) })
  void connecting.catch(error => preparing.reject(error))
  try {
    await preparing.promise
    await vi.advanceTimersByTimeAsync(10_001)
    expect(statuses).toEqual(['connecting'])
    vi.useRealTimers()
    ready.resolve()
    const connection = await connecting
    expect(connection.hostId).toBe('11111111-1111-4111-8111-111111111111')
    await connection.close()
  } finally {
    vi.useRealTimers()
    ready.resolve()
    preparation.mockRestore()
    await connecting.catch(() => undefined)
  }
})
it('turns multiplexing and any configured remote command off and asks through askpass on every ssh, and pipes the launch script to every control command', async () => {
  const { launcher, spawns } = await fixture('started')
  const connection = await launcher.connect(configuration)
  await connection.showHostPairingCode()
  expect(await connection.revokeClient('22222222-2222-4222-8222-222222222222')).toBe(true)
  expect(await connection.stopHost()).toBe(true)
  const spawned = await spawns()
  expect(spawned).toHaveLength(6)
  for (const item of spawned) {
    const options = item.args.flatMap((value, index) => value === '-o' ? [item.args[index + 1]] : [])
    for (const control of ['ControlMaster=no', 'ControlPath=none', 'ControlPersist=no']) expect(options).toContain(control)
    // A `RemoteCommand tmux new -A` in the user's configuration must not replace or refuse Sotto's command.
    expect(options).toEqual(expect.arrayContaining(['RemoteCommand=none', 'RequestTTY=no']))
    expect(item.askpass).toBe(true)
  }
  expect(CONTROL_OPTIONS).toEqual(['-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ControlPersist=no'])
  const control = spawned.filter(item => item.op)
  expect(control.map(item => item.op)).toEqual(['launch', 'pairing-code', 'revoke-client', 'stop-host'])
  for (const item of control) {
    expect(item.stdinSha256).toBe(SCRIPT_SHA)
    // The source is never an argument, so it is never in the remote process list.
    expect(item.args.join(' ')).not.toContain('process.stdout.on')
  }
})

it('sets up desktop permissions through the verified SSH host, carrying no credential', async () => {
  const { launcher, spawns } = await fixture('started')
  const connection = await launcher.connect(configuration)
  await connection.ensureDesktopAnswers('22222222-2222-4222-8222-222222222222')
  const control = (await spawns()).find(item => item.op === 'desktop-answers')!
  expect(control.stdinSha256).toBe(SCRIPT_SHA)
  expect(control.args.join(' ')).not.toContain('Sotto connected this desktop')
  await expect(connection.ensureDesktopAnswers('bad\nclient')).rejects.toThrow('valid paired client')
})
it('asks for a password once per connect although three ssh processes sign in, and never records it', async () => {
  // Password reuse is the assertion here; allow the same sign-in budget as the real launcher.
  const { launcher, events } = await fixture('password', { authenticationTimeoutMs: 120_000 })
  const prompts: SshPrompt[] = []
  const promptReady = Promise.withResolvers<SshPrompt>()
  let waiting: SshPrompt | null = null
  const connecting = launcher.connect(configuration, { onPrompt: prompt => { waiting = prompt; if (prompt) { prompts.push(prompt); promptReady.resolve(prompt) } } })
  // Observe rejection immediately, including cleanup after an assertion fails before connecting is awaited.
  void connecting.then(() => promptReady.reject(new Error('SSH connected without asking for a password.')), error => promptReady.reject(error))
  const prompt = await promptReady.promise
  expect(prompt.kind).toBe('password')
  expect(prompt.text).toBe("user@forge's password:")
  launcher.answerPrompt(prompt.id, 'test-secret')
  const connection = await connecting
  await connection.showHostPairingCode()
  expect(prompts).toHaveLength(1)
  expect(waiting).toBeNull()
  expect((await events()).filter(event => event.type === 'answered')).toEqual([
    { type: 'answered', kind: 'password', accepted: true }, { type: 'answered', kind: 'password', accepted: true }, { type: 'answered', kind: 'password', accepted: true }])
  expect(JSON.stringify(await events())).not.toContain('test-secret')
  expect(() => launcher.answerPrompt(prompts[0]!.id, 'again')).toThrow('no longer waiting')
})
it('asks again when an answer is refused, instead of repeating it', async () => {
  const { launcher, events } = await fixture('passphrase')
  const prompts: SshPrompt[] = []
  const connecting = launcher.connect(configuration, { onPrompt: prompt => { if (prompt) { prompts.push(prompt); launcher.answerPrompt(prompt.id, prompts.length === 1 ? 'wrong' : 'test-secret') } } })
  await connecting
  expect(prompts.map(prompt => prompt.kind)).toEqual(['passphrase', 'passphrase'])
  expect((await events()).filter(event => event.type === 'answered').map(event => event.accepted)).toEqual([false, true, true])
})
it('lets a security key notice pass without asking for anything', async () => {
  const { launcher, events } = await fixture('notice')
  const prompts: SshPrompt[] = []
  const connection = await launcher.connect(configuration, { onPrompt: prompt => { if (prompt) prompts.push(prompt) } })
  await connection.showHostPairingCode()
  // SSH_ASKPASS_PROMPT=none is OpenSSH telling, not asking: no password field, and each notice ends at once.
  expect(prompts).toEqual([])
  expect((await events()).filter(event => event.type === 'notice')).toEqual([
    { type: 'notice', ended: true }, { type: 'notice', ended: true }, { type: 'notice', ended: true }])
})
it('takes a question off the screen when ssh stops waiting for it, and asks the next one fresh', async () => {
  const { launcher, events } = await fixture('withdraw')
  const shown: (SshPrompt | null)[] = []
  const connection = await launcher.connect(configuration, { onPrompt: prompt => {
    shown.push(prompt)
    // The first question's helper goes away unanswered; only the question after it is answered.
    if (prompt && shown.filter(Boolean).length === 2) launcher.answerPrompt(prompt.id, 'test-secret')
  } })
  await connection.showHostPairingCode()
  expect(shown.map(prompt => prompt?.kind ?? null)).toEqual(['password', null, 'password', null])
  expect(shown[0]!.id).not.toBe(shown[2]!.id)
  expect(() => launcher.answerPrompt(shown[0]!.id, 'late')).toThrow('no longer waiting')
  expect((await events()).filter(event => event.type === 'abandoned' || event.type === 'answered')).toEqual([
    { type: 'abandoned' }, { type: 'answered', kind: 'password', accepted: true },
    { type: 'answered', kind: 'password', accepted: true }, { type: 'answered', kind: 'password', accepted: true }])
})
it('shows a host key with its fingerprint and trusts it once', async () => {
  const { launcher, spawns } = await fixture('host-key')
  const prompts: SshPrompt[] = []
  const connection = await launcher.connect(configuration, { onPrompt: prompt => { if (prompt) { prompts.push(prompt); launcher.answerPrompt(prompt.id, 'yes') } } })
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toMatchObject({ kind: 'host-key' })
  expect(prompts[0]!.text).toContain("The authenticity of host 'forge (192.0.2.1)' can't be established.")
  // The helper keeps the fingerprint in OpenSSH's question on both platforms.
  expect(prompts[0]!.text).toMatch(/key fingerprint is SHA256:fixtureKey\./u)
  expect((await spawns())[0]!.args).toContain(process.platform === 'win32' ? 'LogLevel=DEBUG1' : 'LogLevel=INFO')
  await connection.close()
})
it('declining a host key never completes a connection and stops there', async () => {
  const { launcher } = await fixture('host-key')
  const result = launcher.connect(configuration, { onPrompt: prompt => { if (prompt) launcher.answerPrompt(prompt.id, 'no') } })
  expect((await failure(result)).code).toBe('host-key-rejected')
})
it.each([
  ['refused', 'auth-failed', 'refused your sign-in'],
  ['unreachable', 'ssh-unreachable', 'could not reach the host'],
  ['missing', 'archive-missing', 'installation was not found'],
  ['port-taken', 'forward-failed', 'forward could not open'],
  ['wrong-host', 'forward-failed', 'forward could not open'],
])('fails with a typed reason and a plain message for %s', async (mode, code, message) => {
  const { launcher } = await fixture(mode)
  const error = await failure(launcher.connect(configuration))
  expect(error.code).toBe(code)
  expect(error.message).toContain(message)
})
it('reports Node missing, not an SSH refusal, when the remote shell exits 127', async () => {
  const { launcher } = await fixture('node-missing')
  const error = await failure(launcher.connect(configuration))
  expect(error.code).toBe('node-missing')
  expect(error.message).toBe('Node was not found on the SSH host. Install Node 24 for that SSH account, then reconnect.')
})
it('reports a Node too old for the host with the version the host has', async () => {
  const { launcher } = await fixture('node-old')
  const error = await failure(launcher.connect(configuration))
  expect(error.code).toBe('node-too-old')
  expect(error.message).toBe('The SSH host runs Node 18.19.0, which is too old for the host. Install Node 24 for that SSH account, then reconnect.')
})
it('times out without a result, then connects again with a fresh forward', async () => {
  const timed = await fixture('timeout', { authenticationTimeoutMs: 300 })
  expect((await failure(timed.launcher.connect(configuration))).code).toBe('connect-timeout')
  const { launcher, events } = await fixture('discovered')
  const first = await launcher.connect(configuration); await first.close()
  const second = await launcher.connect(configuration)
  expect((await events()).filter(item => item.type === 'forward-ready')).toHaveLength(2)
  expect((await events()).filter(item => item.type === 'host-stopped')).toHaveLength(0)
  // `ssh -V` runs for the first connect only; its answer holds for the same ssh.
  expect((await events()).filter(item => item.type === 'version')).toHaveLength(1)
  await second.close()
})
it.each([
  ['linux', 'OpenSSH_8.1p1', '8.1p1', 'Update OpenSSH on this computer, then reconnect.'],
  ['win32', 'OpenSSH_for_Windows_7.7p1', '7.7p1', 'Update it through Windows Update, or through OpenSSH Client in Settings > System > Optional features, then reconnect.'],
] as const)('refuses an OpenSSH older than 8.4 in plain words before signing in: %s', async (platform, banner, version, advice) => {
  const { launcher, events } = await fixture('password', { version: banner, platform })
  const prompts: SshPrompt[] = []
  const error = await failure(launcher.connect(configuration, { onPrompt: prompt => { if (prompt) prompts.push(prompt) } }))
  expect(error.code).toBe('ssh-too-old')
  expect(error.message).toBe(`This computer's OpenSSH is version ${version}, which is too old. Sotto needs OpenSSH 8.4 or later. ${advice}`)
  // Nothing else ran: no lookup, no sign-in, no question.
  expect((await events()).map(item => item.type)).toEqual(['version'])
  expect(prompts).toEqual([])
})
it('lets OpenSSH 8.4 through', async () => {
  const { launcher } = await fixture('discovered', { version: 'OpenSSH_8.4p1' })
  await (await launcher.connect(configuration)).close()
})
it('gives the host its own time to start however long signing in took', async () => {
  // Sign-in has 4 s and the host 5 s. A password answered after 1 s and a host that then needs 4 s to
  // start take longer than sign-in's budget together, and still connect.
  const { launcher } = await fixture('password', { authenticationTimeoutMs: 4000, readyTimeoutMs: 5000, startMs: 4000 })
  const status: string[] = []
  const connection = await launcher.connect(configuration, { onStatus: value => status.push(value),
    onPrompt: prompt => { if (prompt) setTimeout(() => launcher.answerPrompt(prompt.id, 'test-secret'), 1000) } })
  expect(status).toEqual(['connecting', 'starting', 'forwarding', 'ready'])
  await connection.close()
})
it('stops with prompt-unanswered when nobody answers', async () => {
  const { launcher } = await fixture('password', { authenticationTimeoutMs: 3000 })
  let shown = false
  const error = await failure(launcher.connect(configuration, { onPrompt: prompt => { if (prompt) shown = true } }))
  expect(shown).toBe(true)
  expect(error.code).toBe('prompt-unanswered')
})
it('reads past what a login profile prints and lines it cannot parse', async () => {
  const { launcher } = await fixture('noisy')
  const connection = await launcher.connect(configuration)
  expect(await connection.showHostPairingCode()).toMatchObject({ code: 'ABC123' })
})
it('reports a dropped forward once connected', async () => {
  const { launcher } = await fixture('drop')
  const dropped: string[] = []
  await launcher.connect(configuration, { onDisconnected: message => dropped.push(message) })
  await vi.waitFor(() => expect(dropped).toHaveLength(1))
  expect(dropped[0]).toContain('could not reach the host')
})
it.each([['started', true], ['discovered', false]])('stop-host ends only a host this launcher started: %s', async (mode, stopped) => {
  const { launcher, events } = await fixture(mode)
  const connection = await launcher.connect(configuration)
  expect(await connection.stopHost()).toBe(stopped)
  expect((await events()).find(item => item.type === 'host-stopped')?.owned).toBe(mode === 'started')
})

// The whole path: the real launch script run on this machine behind the fake ssh, a real forward, a fake host.
it('keeps a host it started owned across a reconnect, so Stop host still stops it', async () => {
  const { launcher, path } = await fixture('run')
  const install = join(path, 'opt', 'sotto release', 'host')
  await mkdir(install, { recursive: true })
  await writeFile(join(install, '..', 'package.json'), JSON.stringify({ type: 'module' }))
  await copyFile(resolve('tests/fixtures/fakeSshHost.mjs'), join(install, 'index.js'))
  const first = await launcher.connect(configuration)
  expect(first.owned).toBe(true)
  const descriptor = JSON.parse(await readFile(join(path, 'data', 'sotto', 'host-listener.json'), 'utf8')) as { pid: number }
  hosts.push(descriptor.pid)
  expect(await first.showHostPairingCode()).toMatchObject({ code: 'ABC123' })
  await first.close()
  const second = await launcher.connect(configuration)
  expect(second).toMatchObject({ owned: true, hostId: first.hostId })
  expect(await second.stopHost()).toBe(true)
  expect(() => process.kill(descriptor.pid, 0)).toThrow()
})

// Phone access on a host (ADR-0050): the launch hands back the host's administrative token, so no second sign-in is needed.
it('keeps the administrative token the launch read for this connection, and never puts it on a command line', async () => {
  const { launcher, path, spawns } = await fixture('run')
  const install = join(path, 'opt', 'sotto release', 'host')
  await mkdir(install, { recursive: true })
  await writeFile(join(install, '..', 'package.json'), JSON.stringify({ type: 'module' }))
  await copyFile(resolve('tests/fixtures/fakeSshHost.mjs'), join(install, 'index.js'))
  const connection = await launcher.connect(configuration)
  hosts.push((JSON.parse(await readFile(join(path, 'data', 'sotto', 'host-listener.json'), 'utf8')) as { pid: number }).pid)
  expect(await connection.hostAdminToken()).toBe('remote-only-secret')
  const spawned = await spawns()
  expect(spawned.filter(item => item.op).map(item => item.op)).toEqual(['launch'])
  for (const item of spawned) expect(item.args.join(' ')).not.toContain('remote-only-secret')
  await connection.stopHost()
})
it('says phone access cannot be reached when the launch handed back no token', async () => {
  const { launcher } = await fixture('started')
  const connection = await launcher.connect(configuration)
  expect((await failure(connection.hostAdminToken())).code).toBe('admin-failed')
})

// The host setup checklist and Tailscale SSH's `check` mode (#429).
const keepalives = (args: string[]): string | undefined => args.find(value => value.startsWith('ServerAliveCountMax='))
it('reports each checklist step it reaches: a question means SSH reached the host, and the first output that it signed in', async () => {
  const { launcher } = await fixture('password')
  const steps: string[] = []
  const connection = await launcher.connect(configuration, { onStep: step => steps.push(step), onPrompt: prompt => { if (prompt) launcher.answerPrompt(prompt.id, 'test-secret') } })
  expect(steps).toEqual(['reach', 'sign-in', 'install', 'start'])
  await connection.close()
})
it('waits while Tailscale SSH holds the connection for approval, hands over the approval page, and carries on once approved', async () => {
  const { launcher, path, spawns, events } = await fixture('started+tailscale')
  const steps: string[] = [], approvals: (SshApproval | null)[] = []
  const connection = await launcher.connect(configuration, { onStep: step => steps.push(step), onApproval: approval => {
    approvals.push(approval)
    // The user approves in the browser a moment after the page opens.
    if (approval?.url) setTimeout(() => void writeFile(join(path, 'approved'), ''), 300)
  } })
  expect(steps).toEqual(['reach', 'tailscale', 'install', 'start'])
  expect(approvals.at(-2)).toEqual({ url: 'https://login.tailscale.com/a/l1fixture2b3c' })
  expect(approvals.at(-1)).toBeNull()
  expect((await events()).filter(item => item.type.startsWith('tailscale-')).map(item => item.type)).toEqual(['tailscale-held', 'tailscale-approved'])
  // A command that signs in may wait out an approval; the port forward, the live connection, keeps 30 seconds.
  const spawned = await spawns()
  expect(keepalives(spawned.find(item => item.op === 'launch')!.args)).toBe('ServerAliveCountMax=21')
  expect(keepalives(spawned.find(item => item.tunnel)!.args)).toBe('ServerAliveCountMax=2')
  expect(spawned.find(item => item.op === 'launch')!.args).toContain('ServerAliveInterval=15')
  await connection.close()
})
it('stops with tailscale-unapproved when nobody approves within the approval budget', async () => {
  const { launcher } = await fixture('started+tailscale', { approvalTimeoutMs: 2500, authenticationTimeoutMs: 1500 })
  const steps: string[] = [], approvals: (SshApproval | null)[] = []
  const started = Date.now()
  let heldAt = 0
  const error = await failure(launcher.connect(configuration, { onStep: step => steps.push(step), onApproval: approval => { approvals.push(approval); if (approval && !heldAt) heldAt = Date.now() } }))
  // The approval budget, counted from Tailscale's request, replaced the shorter sign-in budget.
  expect(Date.now() - heldAt).toBeGreaterThanOrEqual(2400)
  expect(Date.now() - started).toBeGreaterThan(1500)
  expect(error.code).toBe('tailscale-unapproved')
  expect(error.message).toBe('Tailscale SSH asked you to approve this connection, and no approval came within 5 minutes, so Sotto stopped connecting. Approve it in your browser when Sotto asks, then reconnect.')
  expect(steps).toEqual(['reach', 'tailscale'])
  expect(approvals.at(-1)).toBeNull()
})
it("reads OpenSSH's own timeout on a connection Tailscale held as the approval not coming", async () => {
  const { launcher } = await fixture('started+tailscale-timeout')
  expect((await failure(launcher.connect(configuration))).code).toBe('tailscale-unapproved')
})
it('shows an approval Tailscale asks of the port forward, and says it ended after 30 seconds when none came', async () => {
  const { launcher } = await fixture('started+tailscale-forward')
  const steps: string[] = [], approvals: (SshApproval | null)[] = []
  const error = await failure(launcher.connect(configuration, { onStep: step => steps.push(step), onApproval: approval => approvals.push(approval) }))
  // The forward keeps its live keepalive, so the step stays where the connect was, and the sentence says 30 seconds.
  expect(steps).toEqual(['reach', 'install', 'start'])
  expect(approvals[0]).toEqual({ url: 'https://login.tailscale.com/a/l1fixture2b3c' })
  expect(approvals.at(-1)).toBeNull()
  expect(error.code).toBe('tailscale-unapproved')
  expect(error.message).toBe('Tailscale SSH asked you to approve the port forward as well, and closed it after 30 seconds without an approval. Try again, and approve it in your browser when Sotto asks.')
})
it('connects once a held port forward is approved, and reads its later drop as a dropped connection', async () => {
  const { launcher, path } = await fixture('drop+tailscale-forward', { holdMs: 10_000 })
  const approvals: (SshApproval | null)[] = []
  const dropped = new Promise<string>(resolve => {
    void launcher.connect(configuration, { onDisconnected: resolve, onApproval: approval => {
      approvals.push(approval)
      if (approval?.url) setTimeout(() => void writeFile(join(path, 'approved'), ''), 200)
    } })
  })
  expect(await dropped).toBe('SSH could not reach the host. Check the host name and your network, then reconnect.')
  expect(approvals).toEqual([{ url: 'https://login.tailscale.com/a/l1fixture2b3c' }, null])
})
it('keeps the live keepalive for a request once connected, and says how to approve one Tailscale holds', async () => {
  const { launcher, spawns } = await fixture('started+tailscale-request')
  const approvals: (SshApproval | null)[] = []
  const connection = await launcher.connect(configuration, { onApproval: approval => approvals.push(approval) })
  const error = await failure(connection.showHostPairingCode())
  expect(keepalives((await spawns()).find(item => item.op === 'pairing-code')!.args)).toBe('ServerAliveCountMax=2')
  // Nothing shows an approval once connected, so none was handed over, and the sentence says how to get one.
  expect(approvals).toEqual([])
  expect(error.code).toBe('tailscale-unapproved')
  expect(error.message).toBe('Tailscale SSH asked you to approve this request, and Sotto shows an approval only while it connects. Nothing was changed. Switch the host off and on, approve the connection in your browser when Sotto asks, then try again.')
  await connection.close()
})
it('reads "Connection to <host> port <n> timed out" as a timeout, with the command that shows SSH\'s own words', async () => {
  const { launcher } = await fixture('port-timeout')
  const error = await failure(launcher.connect(configuration))
  expect(error.code).toBe('connect-timeout')
  expect(error.fix).toEqual({ text: 'To see what SSH itself says, run this in a terminal on this computer:', command: 'ssh user@forge' })
})
it('reports a Node too new on the installation step, after SSH signed in', async () => {
  const { launcher } = await fixture('node-new')
  const steps: string[] = []
  const error = await failure(launcher.connect(configuration, { onStep: step => steps.push(step) }))
  expect(error.code).toBe('node-too-new')
  expect(error.message).toBe('The SSH host runs Node 26.1.0, which is newer than this host release supports. Install Node 24 for that SSH account, then reconnect.')
  expect(steps).toEqual(['reach', 'install'])
})

// A host update over the same path (ADR-0040): the real launch script behind the fake ssh, a stand-in releases page.
async function installedFlat(path: string): Promise<void> {
  const install = join(path, 'opt', 'sotto release', 'host')
  await mkdir(install, { recursive: true })
  await writeFile(join(install, '..', 'package.json'), JSON.stringify({ version: '1.0.0', type: 'module' }))
  await copyFile(resolve('tests/fixtures/fakeSshHost.mjs'), join(install, 'index.js'))
}
const runningHost = async (path: string): Promise<number> => (JSON.parse(await readFile(join(path, 'data', 'sotto', 'host-listener.json'), 'utf8')) as { pid: number }).pid
it('updates a host it started over SSH: the host downloads and checks, unpacks beside it, and restarts into the new version', async () => {
  // Each start gets the 30 seconds a real one does: the restart starts a host while the whole suite runs beside it.
  const { launcher, path, spawns } = await fixture('run', { readyTimeoutMs: 30_000 })
  await installedFlat(path)
  const connection = await launcher.connect(configuration)
  hosts.push(await runningHost(path))
  const archive = tarGz(hostRelease('9.9.9', await readFile(resolve('tests/fixtures/fakeSshHost.mjs'), 'utf8')))
  const file = localArchiveName('9.9.9')
  const page = await releasesPage(new Map<string, Uint8Array | string>([[`/v9.9.9/${file}`, archive], [`/v9.9.9/${file}.sha256`, sidecar(archive, file)]]))
  try {
    const steps: string[] = []
    const fetched = await connection.updateHost({ op: 'update-fetch', version: '9.9.9', releasesUrl: page.url }, { onStep: step => steps.push(step) })
    expect(fetched).toEqual({ type: 'update-fetched', file, sha256: sha256(archive) })
    expect(await connection.updateHost({ op: 'update-install', version: '9.9.9', file, sha256: sha256(archive) }, { onStep: step => steps.push(step) })).toEqual({ type: 'update-installed', version: '9.9.9' })
    const ready = await connection.updateHost({ op: 'update-restart', version: '9.9.9' }, { onStep: step => steps.push(step) })
    expect(ready).toMatchObject({ type: 'ready', owned: true, hostId: connection.hostId })
    if (ready.type === 'ready') hosts.push(ready.pid)
    expect(steps).toEqual(['check', 'install', 'restart'])
    // The restart names the host this connection reached, and every operation took the launch script on stdin.
    const updates = (await spawns()).filter(item => item.op?.startsWith('update-'))
    expect(updates.map(item => item.op)).toEqual(['update-fetch', 'update-install', 'update-restart'])
    for (const item of updates) expect(item.stdinSha256).toBe(SCRIPT_SHA)
    expect(await readFile(join(path, 'opt', 'sotto release', 'current'), 'utf8')).toBe('9.9.9\n')
  } finally { await page.close() }
})
it('copies an archive to the host over SSH with the receive script and the archive on stdin', async () => {
  const { launcher, path, spawns } = await fixture('run')
  await installedFlat(path)
  const connection = await launcher.connect(configuration)
  hosts.push(await runningHost(path))
  const archive = tarGz(hostRelease('9.9.9', 'export {}'))
  const file = localArchiveName('9.9.9')
  expect(await connection.updateHost({ op: 'update-receive', file, size: archive.byteLength, archive })).toEqual({ type: 'update-received', size: archive.byteLength })
  expect(sha256(await readFile(join(path, 'opt', 'sotto release', 'versions', '.incoming', file)))).toBe(sha256(archive))
  expect((await spawns()).find(item => item.op === 'update-receive')!.stdinSha256).toBe(sha256(archive))
})
it('ends the ssh of an update step when the update is cancelled, and keeps the connection', async () => {
  const { launcher, path } = await fixture('run')
  await installedFlat(path)
  const connection = await launcher.connect(configuration)
  hosts.push(await runningHost(path))
  // A releases page that never answers, so the download waits until it is cancelled.
  const silent = createServer(() => undefined)
  await new Promise<void>(done => silent.listen(0, '127.0.0.1', done))
  const address = silent.address() as { port: number }
  try {
    const cancel = new AbortController()
    const pending = connection.updateHost({ op: 'update-fetch', version: '9.9.9', releasesUrl: `http://127.0.0.1:${address.port}` }, { signal: cancel.signal })
    setTimeout(() => cancel.abort(), 300)
    expect((await failure(pending)).code).toBe('cancelled')
    expect(await connection.showHostPairingCode()).toMatchObject({ code: 'ABC123' })
  } finally { silent.closeAllConnections(); await new Promise(done => silent.close(done)) }
})
