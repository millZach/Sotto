// @vitest-environment node
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { SshHostLauncher, type SshPrompt } from '../../src/main/hosts/sshLauncher'
import { spawnSsh, type SpawnSsh } from '../../src/main/hosts/sshProcess'

const directories: string[] = [], launchers: SshHostLauncher[] = []
afterEach(async () => { for (const launcher of launchers.splice(0)) await launcher.disconnect(); for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }) })
const configuration = { target: 'user@forge', installPath: '/opt/sotto release', dataDirectory: '~/.sotto' }
async function fixture(mode = 'started', timing?: { authenticationTimeoutMs?: number }) {
  const path = await mkdtemp(join(tmpdir(), 'sotto-ssh-')); directories.push(path)
  const record = join(path, 'ssh.jsonl')
  const children: ReturnType<typeof spawn>[] = []
  const spawner: SpawnSsh = (_file, args, options) => {
    const child = spawn(process.execPath, [resolve('tests/fixtures/fakeSsh.mjs'), ...args], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...options.env, FAKE_SSH_MODE: mode, FAKE_SSH_RECORD: record } })
    children.push(child)
    return { write: value => { child.stdin!.write(value) }, kill: () => { child.kill() },
      onData: listener => { child.stdout!.on('data', data => listener(String(data))); child.stderr!.on('data', data => listener(String(data))); return { dispose: () => { child.stdout!.removeAllListeners('data'); child.stderr!.removeAllListeners('data') } } },
      onExit: listener => { child.once('exit', code => listener({ exitCode: code ?? 255 })); return { dispose: () => child.removeAllListeners('exit') } } }
  }
  const launcher = new SshHostLauncher({ spawn: spawner, authenticationTimeoutMs: timing?.authenticationTimeoutMs ?? 5000, closeTimeoutMs: 200 })
  launchers.push(launcher)
  return { launcher, children, events: async () => (await readFile(record, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { type: string; args?: string[]; owned?: boolean; tunnel?: boolean; kind?: string }) }
}
it.each(['started', 'discovered'])('discovers readiness, verifies forward and leaves the host running on close: %s', async mode => {
  const { launcher, events } = await fixture(mode)
  const status: string[] = []
  const connection = await launcher.connect(configuration, { onStatus: value => status.push(value) })
  expect(connection.hostId).toBe('11111111-1111-4111-8111-111111111111')
  expect(connection.owned).toBe(mode === 'started')
  expect(connection.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u)
  expect(status).toEqual(['connecting', 'starting', 'forwarding', 'ready'])
  const initial = await events()
  expect(initial.filter(item => item.type === 'spawn')).toHaveLength(2)
  expect(initial.find(item => item.tunnel)?.args).toContainEqual(expect.stringMatching(/^127\.0\.0\.1:\d+:127\.0\.0\.1:4317$/u))
  expect(initial.some(item => item.type === 'pairing-requested')).toBe(false)
  expect(await connection.showHostPairingCode()).toMatchObject({ code: 'ABC123', hostId: connection.hostId })
  await connection.close()
  expect((await events()).some(item => item.type === 'host-stopped')).toBe(false)
  expect(status.at(-1)).toBe('disconnected')
})
it.each([['started', true], ['discovered', false]])('stop-host ends only a host this launcher started: %s', async (mode, stopped) => {
  const { launcher, events } = await fixture(mode)
  const connection = await launcher.connect(configuration)
  expect(await connection.stopHost()).toBe(stopped)
  expect((await events()).find(item => item.type === 'host-stopped')?.owned).toBe(mode === 'started')
})
it.each(['password', 'passphrase', 'host-key'])('surfaces split %s prompts for both SSH processes and waits for explicit answers', async mode => {
  const { launcher, events } = await fixture(mode)
  const prompts: SshPrompt[] = []
  let waiting: SshPrompt | null = null
  const connecting = launcher.connect(configuration, { onPrompt: prompt => { waiting = prompt; if (prompt) prompts.push(prompt) } })
  await vi.waitFor(() => expect(waiting?.kind).toBe(mode))
  expect((await events()).some(item => item.type === 'answered')).toBe(false)
  const first = waiting!
  launcher.answerPrompt(first.id, mode === 'host-key' ? 'yes' : 'test-secret')
  await vi.waitFor(() => expect(prompts).toHaveLength(2))
  launcher.answerPrompt(prompts[1]!.id, mode === 'host-key' ? 'yes' : 'test-secret')
  const connection = await connecting
  expect(waiting).toBeNull()
  expect(() => launcher.answerPrompt(first.id, 'yes')).toThrow('no longer waiting')
  expect(JSON.stringify(await events())).not.toContain('test-secret')
  await connection.close()
})
it.each([['refused', 'SSH refused'], ['missing', 'installation was not found'], ['port-taken', 'forward could not open'], ['wrong-host', 'forward could not open']])('returns a stable actionable error for %s', async (mode, message) => {
  const { launcher } = await fixture(mode)
  await expect(launcher.connect(configuration)).rejects.toThrow(message)
})
it('times out without a ready marker and starts a fresh forward before reconnect completes', async () => {
  const timed = await fixture('timeout', { authenticationTimeoutMs: 100 })
  await expect(timed.launcher.connect(configuration)).rejects.toThrow('in time')
  const { launcher, events } = await fixture('discovered')
  const first = await launcher.connect(configuration); await first.close()
  const second = await launcher.connect(configuration)
  expect((await events()).filter(item => item.type === 'forward-ready')).toHaveLength(2)
  expect((await events()).filter(item => item.type === 'host-stopped')).toHaveLength(0)
  await second.close()
})
it('reads past reply lines it cannot parse or does not know instead of failing the connection', async () => {
  const { launcher } = await fixture('noisy')
  const connection = await launcher.connect(configuration)
  expect(await connection.showHostPairingCode()).toMatchObject({ code: 'ABC123' })
  await connection.close()
})
it('declining a host key never completes a connection', async () => {
  const { launcher } = await fixture('host-key')
  const result = launcher.connect(configuration, { onPrompt: prompt => { if (prompt) launcher.answerPrompt(prompt.id, 'no') } })
  await expect(result).rejects.toThrow('SSH refused')
})

// Real OpenSSH runs under a pseudo-terminal in cooked mode, so every request line the launcher writes
// comes back as echo before any reply. A pipe never echoes, which is how the pairing failure hid.
async function ptyFixture(mode = 'started') {
  const path = await mkdtemp(join(tmpdir(), 'sotto-ssh-pty-')); directories.push(path)
  const record = join(path, 'ssh.jsonl')
  let output = ''
  const spawner: SpawnSsh = async (_file, args, options) => {
    const child = await spawnSsh(process.execPath, [resolve('tests/fixtures/fakeSsh.mjs'), ...args], { ...options, env: { ...options.env, FAKE_SSH_MODE: mode, FAKE_SSH_RECORD: record } })
    const onData = child.onData.bind(child)
    return { write: value => child.write(value), kill: () => child.kill(), onExit: listener => child.onExit(listener),
      onData: listener => onData(data => { output += data; listener(data) }) }
  }
  const launcher = new SshHostLauncher({ spawn: spawner, authenticationTimeoutMs: 15_000, closeTimeoutMs: 500 })
  launchers.push(launcher)
  return { launcher, output: () => output, events: async () => (await readFile(record, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { type: string }) }
}
it('pairs, revokes and stops through a real pseudo-terminal that echoes every request', async () => {
  const { launcher, output, events } = await ptyFixture()
  const connection = await launcher.connect(configuration)
  expect(await connection.showHostPairingCode()).toMatchObject({ code: 'ABC123', hostId: connection.hostId })
  // The terminal echoed the request itself, marker and all; the launcher read past it.
  expect(output()).toMatch(/"type":"pairing-code","id":"[0-9a-f-]{36}"\}/u)
  expect(await connection.revokeClient('22222222-2222-4222-8222-222222222222')).toBe(true)
  expect(await connection.stopHost()).toBe(true)
  expect((await events()).map(item => item.type)).toEqual(expect.arrayContaining(['pairing-requested', 'revoke-requested', 'host-stopped']))
})
