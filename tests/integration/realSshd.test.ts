// @vitest-environment node
/**
 * The SSH transport against a real OpenSSH server: a throwaway sshd on a loopback port, the real ssh
 * client, the real launcher and askpass helper, and the real host build. Opt-in through
 * SOTTO_REAL_SSHD=1, because it needs a POSIX machine with openssh-server and Node 24; the Linux CI job
 * sets it (docs/ci.md). SOTTO_REAL_SSHD_INSTALL points at an extracted host archive; without it the test
 * stages one the way `npm run package:host` does. Nothing here touches the account's own ~/.ssh.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { HostCredentialEncryption } from '../../src/host/credentials'
import { AgentCredentials } from '../../src/main/agents/credentials'
import { PairedClients } from '../../src/main/agents/pairing'
import { DesktopHosts, reconnectDelayMs } from '../../src/main/hosts/desktopHosts'
import { DesktopHostRouter } from '../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'
import { SshHostLauncher } from '../../src/main/hosts/sshLauncher'
import { spawnSsh, type SpawnSsh } from '../../src/main/hosts/sshProcess'
import { desktopWindowClient } from '../../src/main/agents/hostService'
import type { HostStatus } from '../../src/shared/hosts'

const enabled = process.env.SOTTO_REAL_SSHD === '1'
// The Linux CI job runs this file only to run it, and vitest passes a file whose tests all skip. A lost
// or renamed variable there, or an install given without the switch, must turn the job red instead.
if (!enabled && (process.env.SOTTO_REAL_SSHD_INSTALL || (process.env.CI === 'true' && process.platform === 'linux'))) {
  throw new Error('The real-sshd journey would be skipped: set SOTTO_REAL_SSHD=1 wherever this file runs on Linux CI or with SOTTO_REAL_SSHD_INSTALL.')
}
// A synthetic passphrase for a throwaway key, so the real ssh asks through the askpass helper.
const PASSPHRASE = 'synthetic-real-sshd-passphrase'
let root: string, sshd: ChildProcess | undefined, sshdLog = ''
let install: string, data: string, fingerprint: string
let manager: DesktopHosts | undefined, router: DesktopHostRouter | undefined
const forwards: ChildProcess[] = [], prompts: NonNullable<HostStatus['prompt']>[] = [], scheduled: number[] = []
let spawnCount = 0, versionChecks = 0

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
const descriptor = async (): Promise<{ pid: number; port: number; hostId: string; startedBy?: string } | undefined> => {
  try { return JSON.parse(await readFile(join(data, 'host-listener.json'), 'utf8')) as { pid: number; port: number; hostId: string; startedBy?: string } } catch { return undefined }
}
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  await new Promise<void>(done => server.close(() => done()))
  return port
}
/** sshd has started listening once a TCP connection is answered with its banner. */
async function banner(port: number): Promise<boolean> {
  return new Promise(done => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.setTimeout(1000, () => { socket.destroy(); done(false) })
    socket.once('data', chunk => { socket.destroy(); done(chunk.toString('utf8').startsWith('SSH-')) })
    socket.once('error', () => done(false))
  })
}
/** The same layout as the host archive: host/index.js with zod beside it in node_modules. */
async function stageInstall(): Promise<string> {
  const directory = join(root, 'install')
  // The script `npm run build:host` runs, loaded by URL: it is plain JavaScript with no declarations.
  const { buildHost } = await import(pathToFileURL(resolve('scripts/build-host.mjs')).href) as { buildHost: (outDir: string) => Promise<void> }
  await buildHost(join(directory, 'host'))
  await cp(resolve('node_modules/zod'), join(directory, 'node_modules', 'zod'), { recursive: true })
  return directory
}

describe.skipIf(!enabled)('the SSH transport against a real OpenSSH server', () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'sotto-real-sshd-'))
    data = join(root, 'host-data')
    install = process.env.SOTTO_REAL_SSHD_INSTALL ? resolve(process.env.SOTTO_REAL_SSHD_INSTALL) : await stageInstall()
    await stat(join(install, 'host', 'index.js'))
    const keygen = process.env.SOTTO_SSH_KEYGEN ?? 'ssh-keygen'
    execFileSync(keygen, ['-q', '-t', 'ed25519', '-N', '', '-C', 'sotto-real-sshd-host', '-f', join(root, 'host_key')])
    execFileSync(keygen, ['-q', '-t', 'ed25519', '-N', PASSPHRASE, '-C', 'sotto-real-sshd-client', '-f', join(root, 'client_key')])
    fingerprint = execFileSync(keygen, ['-l', '-E', 'sha256', '-f', join(root, 'host_key.pub')], { encoding: 'utf8' }).split(' ')[1]!
    await writeFile(join(root, 'authorized_keys'), await readFile(join(root, 'client_key.pub')), { mode: 0o600 })
    const port = await freePort()
    // A non-root sshd serves only the account running it, the way OpenSSH's own regression suite runs.
    // The account's PATH puts this Node first; a runner's system Node may be older than the host needs.
    await writeFile(join(root, 'sshd_config'), [
      `Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${join(root, 'host_key')}`, `PidFile ${join(root, 'sshd.pid')}`,
      `AuthorizedKeysFile ${join(root, 'authorized_keys')}`, 'StrictModes no', 'UsePAM no', 'PasswordAuthentication no',
      'KbdInteractiveAuthentication no', 'PubkeyAuthentication yes', 'AllowTcpForwarding local', 'PermitTTY no', 'X11Forwarding no',
      `AllowUsers ${userInfo().username}`, `SetEnv PATH=${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`, 'LogLevel VERBOSE', '',
    ].join('\n'))
    // The client's configuration: where localhost's port is, and a known_hosts file of the test's own.
    await writeFile(join(root, 'ssh_config'), ['Host localhost', `  Port ${port}`, `  UserKnownHostsFile ${join(root, 'known_hosts')}`,
      '  GlobalKnownHostsFile /dev/null', '  UpdateHostKeys no', ''].join('\n'))
    sshd = spawn(process.env.SOTTO_SSHD ?? '/usr/sbin/sshd', ['-D', '-e', '-f', join(root, 'sshd_config')], { stdio: ['ignore', 'ignore', 'pipe'] })
    sshd.stderr!.setEncoding('utf8')
    sshd.stderr!.on('data', (chunk: string) => { sshdLog = (sshdLog + chunk).slice(-32_768) })
    const deadline = Date.now() + 10_000
    while (!(await banner(port))) {
      if (sshd.exitCode !== null || Date.now() > deadline) throw new Error('sshd did not start:\n' + sshdLog)
      await new Promise(done => setTimeout(done, 100))
    }
  }, 120_000)
  afterAll(async () => {
    await manager?.close(); router?.dispose()
    const running = await descriptor().catch(() => undefined)
    if (running && alive(running.pid)) process.kill(running.pid, 'SIGTERM')
    sshd?.kill('SIGTERM')
    if (root && dirname(root) === tmpdir() && root.includes('sotto-real-sshd-')) await rm(root, { recursive: true, force: true })
  })

  it('connects, pairs itself, reconnects after the forward dies, leaves the host on Disconnect, stops it and forgets it', { timeout: 180_000 }, async () => {
    const credentials = new AgentCredentials(join(root, 'desktop'), new HostCredentialEncryption('synthetic-desktop-credential-key'))
    await credentials.load()
    router = new DesktopHostRouter(emptyDesktopState)
    const env = { ...process.env }
    delete env.SSH_AUTH_SOCK
    // The real ssh, pointed at the test's own client configuration. The forward is the ssh with -N.
    const spawner: SpawnSsh = (file, args, options) => {
      // `ssh -V` is the version check, which never connects; everything else is a connection's ssh.
      if (args.includes('-V')) versionChecks += 1
      else spawnCount += 1
      const child = spawnSsh(file, ['-F', join(root, 'ssh_config'), ...args], options)
      if (args.includes('-N')) forwards.push(child)
      return child
    }
    manager = new DesktopHosts({ directory: join(root, 'desktop'), credentials, router, localHostRunning: false, localHostEnabled: () => false, restart: () => undefined,
      launcher: () => new SshHostLauncher({ spawn: spawner, env, readyTimeoutMs: 30_000, authenticationTimeoutMs: 60_000 }),
      retryDelayMs: attempt => { scheduled.push(attempt); return reconnectDelayMs(attempt) } })
    await manager.start()
    const answered = new Set<string>()
    manager.subscribe(state => {
      const prompt = state.hosts[0]?.prompt
      if (!prompt || answered.has(prompt.id)) return
      answered.add(prompt.id); prompts.push(prompt)
      void manager!.command({ type: 'ssh-answer', id: state.hosts[0]!.id, promptId: prompt.id, answer: prompt.kind === 'host-key' ? 'yes' : PASSPHRASE })
    })
    const remote = { id: randomUUID(), name: 'Real sshd', target: `${userInfo().username}@localhost`, identityFile: join(root, 'client_key'), installPath: install, dataDirectory: data }
    const row = () => manager!.get().hosts.find(host => host.id === remote.id)
    const diagnostics = () => `\nhost row: ${JSON.stringify(row())}\nsshd:\n${sshdLog}`
    await manager.command({ type: 'save', host: remote })

    // Connect: the host key and the key's passphrase are asked once each, through the real askpass
    // helper, although four ssh processes (-G, launch, forward, pairing code) run.
    await manager.command({ type: 'connect', id: remote.id })
    expect(row(), diagnostics()).toMatchObject({ phase: 'connected', owned: true, clientId: expect.any(String), hostId: expect.any(String) })
    expect(prompts.map(prompt => prompt.kind)).toEqual(['host-key', 'passphrase'])
    expect(prompts[0]!.text).toContain(fingerprint)
    expect(spawnCount).toBe(4)
    // The runner's real `ssh -V` was read and is new enough.
    expect(versionChecks).toBe(1)
    const first = (await descriptor())!
    expect(first).toMatchObject({ startedBy: 'launch-script', hostId: row()!.hostId })
    const { clientId, hostId } = row()!

    // The host's threads reach the desktop through the forward, and a command reaches the host.
    expect(router.shell().connections).toEqual([expect.objectContaining({ hostId, kind: 'remote' })])
    await manager.command({ type: 'select', hostId: hostId! })
    expect(router.shell().hostId).toBe(hostId)
    expect(Array.isArray(router.shell().host.threads)).toBe(true)
    const client = desktopWindowClient('real-sshd-test')
    await router.command({ type: 'configure', patch: { provider: 'claude', enabledProviders: ['claude'] } }, client)
    await vi.waitFor(() => expect(router!.shell().configuration.enabledProviders).toEqual(['claude']))

    // The forward dies: the connection drops and comes back after the first backoff step, to the same
    // running host, with the same pairing. Only the passphrase is asked again; the key is now known.
    const dropped = Date.now()
    forwards[0]!.kill('SIGKILL')
    await vi.waitFor(() => expect(row()).toMatchObject({ phase: 'connecting', reconnecting: true }), { timeout: 10_000 })
    await vi.waitFor(() => expect(row(), diagnostics()).toMatchObject({ phase: 'connected', reconnecting: false }), { timeout: 60_000, interval: 100 })
    expect(Date.now() - dropped).toBeGreaterThanOrEqual(reconnectDelayMs(0))
    expect(scheduled).toEqual([0])
    expect(row()).toMatchObject({ clientId, hostId, owned: true })
    expect((await descriptor())!.pid).toBe(first.pid)
    expect(prompts.map(prompt => prompt.kind)).toEqual(['host-key', 'passphrase', 'passphrase'])

    // Disconnect leaves the host running.
    await manager.command({ type: 'disconnect', id: remote.id })
    expect(row()!.phase).toBe('disconnected')
    expect(alive(first.pid)).toBe(true)
    expect((await fetch(`http://127.0.0.1:${first.port}/v1/health`)).status).toBe(200)

    // Stop host stops it.
    await manager.command({ type: 'connect', id: remote.id })
    expect(row(), diagnostics()).toMatchObject({ phase: 'connected', owned: true, clientId })
    await manager.command({ type: 'stop-host', id: remote.id })
    expect(row()!.phase).toBe('disconnected')
    await vi.waitFor(() => expect(alive(first.pid)).toBe(false), { timeout: 10_000 })

    // The next connect starts a new host on the same identity and pairing, and Forget revokes that
    // pairing on the host and stops it.
    await manager.command({ type: 'connect', id: remote.id })
    expect(row(), diagnostics()).toMatchObject({ phase: 'connected', owned: true, clientId, hostId })
    const second = (await descriptor())!
    expect(second.pid).not.toBe(first.pid)
    const before = new PairedClients(data); await before.load()
    expect(before.list().map(item => item.clientId)).toEqual([clientId])
    await manager.command({ type: 'forget', id: remote.id })
    const spawned = spawnCount, retries = scheduled.length
    expect(manager.get().hosts).toEqual([])
    expect(credentials.has(`remote-host:${remote.id}`)).toBe(false)
    await vi.waitFor(() => expect(alive(second.pid)).toBe(false), { timeout: 10_000 })
    const after = new PairedClients(data); await after.load()
    expect(after.list()).toEqual([])

    // Nothing pairs again on its own: a reconnect Forget failed to cancel would have started by the
    // first backoff step, so wait past it and look again.
    await new Promise(done => setTimeout(done, reconnectDelayMs(0) + 2_000))
    expect(spawnCount).toBe(spawned)
    expect(scheduled).toHaveLength(retries)
    const settled = new PairedClients(data); await settled.load()
    expect(settled.list()).toEqual([])

    // A further connect does not pair again: the host is no longer saved, and no ssh starts.
    await expect(manager.command({ type: 'connect', id: remote.id })).rejects.toThrow('no longer saved')
    expect(spawnCount).toBe(spawned)
    expect(versionChecks).toBe(1)
    const later = new PairedClients(data); await later.load()
    expect(later.list()).toEqual([])
  })
})
