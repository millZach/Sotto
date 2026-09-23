// @vitest-environment node
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { SshFailure, SshHostLauncher, type SshPrompt } from '../../src/main/hosts/sshLauncher'
import { CONTROL_OPTIONS, type SpawnSsh } from '../../src/main/hosts/sshProcess'
import { LAUNCH_SCRIPT_SOURCE } from '../../src/main/hosts/launchScript'

const directories: string[] = [], launchers: SshHostLauncher[] = [], hosts: number[] = []
afterEach(async () => {
  for (const launcher of launchers.splice(0)) await launcher.disconnect()
  for (const pid of hosts.splice(0)) { try { process.kill(pid, 'SIGTERM') } catch { /* already exited */ } }
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})
const configuration = { target: 'user@forge', installPath: '/opt/sotto release', dataDirectory: '/data/sotto' }
const SCRIPT_SHA = createHash('sha256').update(LAUNCH_SCRIPT_SOURCE).digest('hex')
interface Spawned { type: string; args: string[]; tunnel: boolean; resolve: boolean; op?: string; stdinSha256: string; askpass: boolean }
async function fixture(mode = 'started', options: { authenticationTimeoutMs?: number; startMs?: number } = {}) {
  const path = await mkdtemp(join(tmpdir(), 'sotto-ssh-')); directories.push(path)
  const record = join(path, 'ssh.jsonl')
  const spawner: SpawnSsh = (_file, args, spawnOptions) => spawn(process.execPath, [resolve('tests/fixtures/fakeSsh.mjs'), ...args],
    { shell: false, windowsHide: true, stdio: [spawnOptions.stdin, 'pipe', 'pipe'],
      env: { ...spawnOptions.env, FAKE_SSH_MODE: mode, FAKE_SSH_RECORD: record, FAKE_SSH_ROOT: path, FAKE_SSH_START_MS: String(options.startMs ?? 0) } })
  const launcher = new SshHostLauncher({ spawn: spawner, authenticationTimeoutMs: options.authenticationTimeoutMs ?? 10_000, readyTimeoutMs: 5000 })
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
it('turns multiplexing off and asks through askpass on every ssh, and pipes the launch script to every control command', async () => {
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
it('asks for a password once per connect although three ssh processes sign in, and never records it', async () => {
  const { launcher, events } = await fixture('password')
  const prompts: SshPrompt[] = []
  let waiting: SshPrompt | null = null
  const connecting = launcher.connect(configuration, { onPrompt: prompt => { waiting = prompt; if (prompt) prompts.push(prompt) } })
  await vi.waitFor(() => expect(waiting?.kind).toBe('password'))
  expect(waiting!.text).toBe("user@forge's password:")
  launcher.answerPrompt(waiting!.id, 'test-secret')
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
  // Windows' cmd.exe keeps only the first line of the question; the fingerprint comes back from ssh's own debug output.
  expect(prompts[0]!.text).toMatch(/key fingerprint is SHA256:fixtureKey\./u)
  expect((await spawns())[0]!.args).toContain(process.platform === 'win32' ? 'LogLevel=DEBUG1' : 'LogLevel=ERROR')
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
  await second.close()
})
it('gives the host its own time to start however long signing in took', async () => {
  // Sign-in has 3 s and the host 5 s. A password answered after 1.5 s and a host that then needs 3.5 s
  // to start take longer than sign-in's budget together, and still connect.
  const { launcher } = await fixture('password', { authenticationTimeoutMs: 3000, startMs: 3500 })
  const status: string[] = []
  const connection = await launcher.connect(configuration, { onStatus: value => status.push(value),
    onPrompt: prompt => { if (prompt) setTimeout(() => launcher.answerPrompt(prompt.id, 'test-secret'), 1500) } })
  expect(status).toEqual(['connecting', 'starting', 'forwarding', 'ready'])
  await connection.close()
})
it('stops with prompt-unanswered when nobody answers', async () => {
  const { launcher } = await fixture('password', { authenticationTimeoutMs: 500 })
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
