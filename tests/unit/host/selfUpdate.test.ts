// @vitest-environment node
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { spawn as spawnProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { createHostSelfUpdate, hostInstallation, runByBootUnit, transientRestartCommand, type HostSelfUpdate, type HostSelfUpdateOptions, type HostUpdateContext } from '../../../src/host/selfUpdate'
import { HOST_RELEASES_URL, hostArchiveName } from '../../../src/shared/hostUpdates'
import { HOST_ARCHIVE_LIMIT_BYTES, HOST_DOWNLOAD_TIMEOUT_MS, HOST_READY_TIMEOUT_MS, HOST_STOP_DRAIN_MS } from '../../../src/shared/hostLaunchTimings'
import { HOST_NODE_RANGE, LAUNCH_SCRIPT_SOURCE } from '../../../src/main/hosts/launchScript'

/**
 * A host that updates itself (ADR-0087), without running anything: the child processes it would start are stand-ins that
 * say what the launch script would, so these check what the host builds, refuses and waits for.
 */
const HOST_ID = '11111111-1111-4111-8111-111111111111'
const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })

interface Call { readonly file: string; readonly args: readonly string[]; readonly options: Record<string, unknown>; readonly stdin: string; readonly configuration: Record<string, unknown> }
type FakeChild = EventEmitter & { stdin: PassThrough; stdout: PassThrough; unref(): void; kill(): boolean; killed: boolean }
/** Stand-in children: `behave` says what each one does, by writing lines and ending, or doing nothing at all. */
function fakeSpawn(behave: (call: Call, child: FakeChild) => void | Promise<void>) {
  const calls: Call[] = []
  const spawn = ((file: string, args: readonly string[], options: Record<string, unknown>) => {
    const child = new EventEmitter() as FakeChild
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.killed = false
    child.unref = () => undefined
    child.kill = () => { if (!child.killed) { child.killed = true; setImmediate(() => { child.emit('exit', null, 'SIGTERM'); child.emit('close', null) }) } return true }
    let stdin = ''
    child.stdin.on('data', chunk => { stdin += String(chunk) })
    child.stdin.on('end', () => {
      const call: Call = { file, args, options, stdin, configuration: JSON.parse(args.at(-1)!) as Record<string, unknown> }
      calls.push(call)
      void behave(call, child)
    })
    // A child whose stdin the host never ends (systemd-run) is told at once.
    if (file === 'systemd-run') setImmediate(() => child.stdin.end())
    return child
  }) as unknown as typeof spawnProcess
  return { spawn, calls }
}
const answer = (child: FakeChild, ...lines: unknown[]): void => {
  for (const line of lines) child.stdout.write(JSON.stringify(line) + '\n')
  child.stdout.end()
  setImmediate(() => { child.emit('exit', 0, null); child.emit('close', 0) })
}
async function installed(version = '1.2.3', layout: 'flat' | 'versions' = 'versions') {
  const root = await mkdtemp(join(tmpdir(), 'sotto-self-update-')); directories.push(root)
  const install = join(root, 'sotto-host'), data = join(root, 'data')
  await mkdir(data, { recursive: true })
  const entry = layout === 'flat' ? join(install, 'host', 'index.js') : join(install, 'versions', version, 'host', 'index.js')
  return { root, install, data, entry }
}
function hostWith(place: Awaited<ReturnType<typeof installed>>, spawn: typeof spawnProcess, more: Partial<HostSelfUpdateOptions> = {}): HostSelfUpdate {
  const created = createHostSelfUpdate({ entry: place.entry, dataDirectory: place.data, port: 47_000, hostId: HOST_ID, sottoVersion: '1.2.3', startedBy: 'launch-script',
    node: '/usr/bin/node', env: { PATH: '/usr/bin' }, platform: 'linux', arch: 'x64', runByUnit: async () => false, spawn, ...more })
  if (!created.ok) throw new Error(created.reason)
  return created.update
}
const context = (owner: object = {}, steps: string[] = [], gone = new AbortController()): HostUpdateContext => ({ owner, gone: gone.signal, onStep: step => { steps.push(step) } })

describe('where a host was installed', () => {
  it('reads the installation folder from a version folder or a flat install, and refuses any other layout', () => {
    const root = join(tmpdir(), 'sotto-host')
    expect(hostInstallation(join(root, 'versions', '1.2.3', 'host', 'index.js'), '1.2.3')).toEqual({ installPath: root, version: '1.2.3' })
    expect(hostInstallation(join(root, 'versions', '1.2.3-owl.20261016.2', 'host', 'index.js'), '1.2.3-owl.20261016.2')).toEqual({ installPath: root, version: '1.2.3-owl.20261016.2' })
    expect(hostInstallation(join(root, 'host', 'index.js'), '1.2.3')).toEqual({ installPath: root, version: null })
    // A version folder that is not the version this host says it runs, or is not a version at all.
    expect(hostInstallation(join(root, 'versions', '1.2.2', 'host', 'index.js'), '1.2.3')).toBeNull()
    expect(hostInstallation(join(root, 'versions', 'latest', 'host', 'index.js'), '1.2.3')).toBeNull()
    // A checkout's source, a renamed bundle, and a relative path.
    expect(hostInstallation(join(root, 'src', 'host', 'index.ts'), '1.2.3')).toBeNull()
    expect(hostInstallation(join(root, 'host', 'main.js'), '1.2.3')).toBeNull()
    expect(hostInstallation(join(root, 'bundle', 'index.js'), '1.2.3')).toBeNull()
    expect(hostInstallation(join('sotto-host', 'host', 'index.js'), '1.2.3')).toBeNull()
    expect(hostInstallation('', '1.2.3')).toBeNull()
  })

  it('offers nothing for a host Sotto did not start, or one that runs from no release layout', async () => {
    const place = await installed()
    const options = { entry: place.entry, dataDirectory: place.data, port: 1, hostId: HOST_ID, sottoVersion: '1.2.3' }
    expect(createHostSelfUpdate(options)).toEqual({ ok: false, reason: 'update-not-owned' })
    expect(createHostSelfUpdate({ ...options, startedBy: 'someone' as never })).toEqual({ ok: false, reason: 'update-not-owned' })
    expect(createHostSelfUpdate({ ...options, startedBy: 'launch-script', entry: join(place.root, 'elsewhere.js') })).toEqual({ ok: false, reason: 'update-layout' })
    expect(createHostSelfUpdate({ ...options, startedBy: 'launch-script' }).ok).toBe(true)
    expect(createHostSelfUpdate({ ...options, startedBy: 'boot' }).ok).toBe(true)
  })

  it('tells a host its start at boot unit runs from its own cgroup, on Linux only', async () => {
    expect(await runByBootUnit('linux', async () => '0::/user.slice/user-1000.slice/user@1000.service/app.slice/sotto-host.service\n')).toBe(true)
    expect(await runByBootUnit('linux', async () => '0::/user.slice/user-1000.slice/session-4.scope\n')).toBe(false)
    expect(await runByBootUnit('linux', async () => '0::/user.slice/user@1000.service/app.slice/sotto-host-update-1a2b3c4d.service\n')).toBe(false)
    expect(await runByBootUnit('linux', async () => { throw new Error('no proc') })).toBe(false)
    expect(await runByBootUnit('darwin', async () => '0::/sotto-host.service')).toBe(false)
  })
})

describe('what a host builds for the launch script', () => {
  it('builds every path, setting and timing itself, takes only the version from the client, and streams the steps', async () => {
    const place = await installed()
    const { spawn, calls } = fakeSpawn((_call, child) => answer(child, { type: 'update-step', step: 'check' }, { type: 'update-fetched', file: hostArchiveName('1.2.4'), sha256: 'b'.repeat(64) }))
    const steps: string[] = []
    expect(await hostWith(place, spawn).run({ action: 'fetch', version: '1.2.4' }, context({}, steps))).toEqual({ type: 'update-fetched', file: hostArchiveName('1.2.4'), sha256: 'b'.repeat(64) })
    expect(steps).toEqual(['download', 'check'])
    const [call] = calls
    expect(call!.file).toBe('/usr/bin/node')
    expect(call!.args.slice(0, 2)).toEqual(['--input-type=commonjs', '-'])
    expect(call!.stdin).toBe(LAUNCH_SCRIPT_SOURCE)
    expect(call!.configuration).toEqual({ op: 'update-fetch', version: '1.2.4', installPath: place.install, dataDirectory: place.data, remotePort: 47_000, hostId: HOST_ID,
      nodeRange: HOST_NODE_RANGE, releasesUrl: HOST_RELEASES_URL, readyTimeoutMs: HOST_READY_TIMEOUT_MS, stopDrainMs: HOST_STOP_DRAIN_MS,
      downloadTimeoutMs: HOST_DOWNLOAD_TIMEOUT_MS, archiveLimit: HOST_ARCHIVE_LIMIT_BYTES })
    expect(call!.options).toMatchObject({ env: { PATH: '/usr/bin' }, windowsHide: true })
  })

  it('refuses any version that is not newer than its own, at fetch, install and restart alike', async () => {
    const place = await installed()
    const { spawn, calls } = fakeSpawn(() => undefined)
    const host = hostWith(place, spawn)
    for (const version of [undefined, '1.2.3', '1.2.2', '1.1.9', '0.9.0', 'latest', '1.2.4; rm -rf /', '../1.2.4']) {
      for (const action of ['fetch', 'restart'] as const) expect(await host.run({ action, ...(version ? { version } : {}) }, context()), `${action} ${version}`).toEqual({ type: 'error', reason: 'update-invalid' })
      expect(await host.run({ action: 'install', ...(version ? { version } : {}), file: hostArchiveName(version ?? ''), sha256: 'a'.repeat(64) }, context()), `install ${version}`).toEqual({ type: 'error', reason: 'update-invalid' })
    }
    expect(calls).toEqual([])
  })

  it('takes an Owl build of its own release as newer, by the rule the desktop uses', async () => {
    const place = await installed()
    const { spawn, calls } = fakeSpawn((_call, child) => answer(child, { type: 'update-fetched', file: hostArchiveName('1.2.3-owl.20261016.1'), sha256: 'c'.repeat(64) }))
    expect(await hostWith(place, spawn).run({ action: 'fetch', version: '1.2.3-owl.20261016.1' }, context())).toMatchObject({ type: 'update-fetched' })
    expect(calls).toHaveLength(1)
  })

  it('installs only the archive its own download names for its own system', async () => {
    const place = await installed()
    const { spawn, calls } = fakeSpawn((_call, child) => answer(child, { type: 'update-step', step: 'install' }, { type: 'update-installed', version: '1.2.4' }))
    const host = hostWith(place, spawn)
    for (const file of [hostArchiveName('1.2.4', 'darwin', 'arm64'), hostArchiveName('1.2.5'), '../../Sotto-host-1.2.4-linux-x64.tar.gz', '/tmp/' + hostArchiveName('1.2.4'), undefined])
      expect(await host.run({ action: 'install', version: '1.2.4', ...(file ? { file } : {}), sha256: 'a'.repeat(64) }, context()), String(file)).toEqual({ type: 'error', reason: 'update-invalid' })
    expect(await host.run({ action: 'install', version: '1.2.4', file: hostArchiveName('1.2.4'), sha256: 'NOT-HEX' }, context())).toEqual({ type: 'error', reason: 'update-invalid' })
    expect(calls).toEqual([])
    const steps: string[] = []
    expect(await host.run({ action: 'install', version: '1.2.4', file: hostArchiveName('1.2.4'), sha256: 'a'.repeat(64) }, context({}, steps))).toEqual({ type: 'update-installed', version: '1.2.4' })
    expect(steps).toEqual(['install'])
    expect(calls[0]!.configuration).toMatchObject({ op: 'update-install', version: '1.2.4', file: hostArchiveName('1.2.4'), sha256: 'a'.repeat(64), installPath: place.install })
  })

  it('answers the launch script’s own failure, and one it cannot read as update-failed', async () => {
    const place = await installed()
    let reply: unknown = { type: 'error', reason: 'checksum-mismatch', file: hostArchiveName('1.2.4') }
    const { spawn } = fakeSpawn((_call, child) => answer(child, reply))
    const host = hostWith(place, spawn)
    expect(await host.run({ action: 'fetch', version: '1.2.4' }, context())).toEqual(reply)
    reply = { type: 'update-fetched', file: '../escape', sha256: 'x' }
    expect(await host.run({ action: 'fetch', version: '1.2.4' }, context())).toEqual({ type: 'error', reason: 'update-failed' })
  })
})

describe('one update at a time', () => {
  it('refuses a second action while one runs, and lets only the client that asked cancel its download', async () => {
    const place = await installed()
    const held: FakeChild[] = []
    const { spawn } = fakeSpawn((_call, child) => { held.push(child) })
    const host = hostWith(place, spawn)
    const asker = {}, other = {}
    const fetching = host.run({ action: 'fetch', version: '1.2.4' }, context(asker))
    await expect.poll(() => held.length).toBe(1)
    expect(await host.run({ action: 'fetch', version: '1.2.4' }, context(other))).toEqual({ type: 'error', reason: 'update-busy' })
    expect(await host.run({ action: 'install', version: '1.2.4', file: hostArchiveName('1.2.4'), sha256: 'a'.repeat(64) }, context(other))).toEqual({ type: 'error', reason: 'update-busy' })
    expect(await host.run({ action: 'cancel' }, context(other))).toEqual({ type: 'update-cancelled', cancelled: false })
    expect(await host.run({ action: 'cancel' }, context(asker))).toEqual({ type: 'update-cancelled', cancelled: true })
    expect(await fetching).toEqual({ type: 'update-cancelled', cancelled: true })
    expect(held[0]!.killed).toBe(true)
    expect(await host.run({ action: 'cancel' }, context(asker))).toEqual({ type: 'update-cancelled', cancelled: false })
  })

  it('ends a download when its client goes, and never an install', async () => {
    const place = await installed()
    const held: FakeChild[] = []
    const { spawn } = fakeSpawn((_call, child) => { held.push(child) })
    const host = hostWith(place, spawn)
    const leaving = new AbortController()
    const fetching = host.run({ action: 'fetch', version: '1.2.4' }, context({}, [], leaving))
    await expect.poll(() => held.length).toBe(1)
    leaving.abort()
    expect(await fetching).toEqual({ type: 'update-cancelled', cancelled: true })
    expect(held[0]!.killed).toBe(true)
    const gone = new AbortController()
    const installing = host.run({ action: 'install', version: '1.2.4', file: hostArchiveName('1.2.4'), sha256: 'a'.repeat(64) }, context({}, [], gone))
    await expect.poll(() => held.length).toBe(2)
    gone.abort()
    expect(held[1]!.killed).toBe(false)
    answer(held[1]!, { type: 'update-installed', version: '1.2.4' })
    expect(await installing).toEqual({ type: 'update-installed', version: '1.2.4' })
  })

  it('leaves the folder’s update lock to the launch script, and answers its refusal while another update holds it', async () => {
    const place = await installed()
    const { spawn, calls } = fakeSpawn((_call, child) => answer(child, { type: 'error', reason: 'update-busy' }))
    expect(await hostWith(place, spawn).run({ action: 'fetch', version: '1.2.4' }, context())).toEqual({ type: 'error', reason: 'update-busy' })
    expect(calls).toHaveLength(1)
    await expect(readFile(join(place.install, 'versions', '.update-lock', 'pid'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('the restart and its status file', () => {
  async function ready(version = '1.2.4') {
    const place = await installed()
    await mkdir(join(place.install, 'versions', version, 'host'), { recursive: true })
    await writeFile(join(place.install, 'versions', version, 'host', 'index.js'), '')
    return place
  }
  const statusFile = (place: { data: string }): string => join(place.data, 'host-update-status.json')
  /** What the launch script does at its checks: claim its own attempt, then say how it stands. */
  async function claimAs(call: Call, value: Record<string, unknown>): Promise<boolean> {
    const resultFile = String(call.configuration.resultFile), attempt = String(call.configuration.attempt)
    try { await writeFile(`${resultFile}.${attempt}.claim`, 'restart', { flag: 'wx' }) } catch { return false }
    await writeFile(resultFile, JSON.stringify({ v: 1, attempt, version: call.configuration.version, ...value }))
    return true
  }

  it('refuses a version that is not installed beside it', async () => {
    const place = await installed()
    const { spawn, calls } = fakeSpawn(() => undefined)
    expect(await hostWith(place, spawn).run({ action: 'restart', version: '1.2.4' }, context())).toEqual({ type: 'error', reason: 'update-missing' })
    expect(calls).toEqual([])
  })

  it('answers once the restart claims its attempt, from a detached process that outlives the host', async () => {
    const place = await ready()
    await writeFile(statusFile(place), JSON.stringify({ v: 1, attempt: 'aaaaaaaa', version: '1.2.2', state: 'finished', result: { type: 'ready', hostId: HOST_ID, pid: 9 } }))
    const { spawn, calls } = fakeSpawn(async call => {
      // The last update's file is gone before this one starts.
      expect(await readFile(statusFile(place), 'utf8').catch(() => null)).toBeNull()
      await claimAs(call, { state: 'restarting', pid: 4242 })
    })
    const steps: string[] = []
    expect(await hostWith(place, spawn).run({ action: 'restart', version: '1.2.4' }, context({}, steps))).toEqual({ type: 'update-restarting', version: '1.2.4' })
    expect(steps).toEqual(['restart'])
    expect(calls[0]!.options).toMatchObject({ detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    expect(calls[0]!.stdin).toBe(LAUNCH_SCRIPT_SOURCE)
    expect(calls[0]!.configuration).toMatchObject({ op: 'update-restart', version: '1.2.4', hostId: HOST_ID, resultFile: statusFile(place), installPath: place.install,
      attempt: expect.stringMatching(/^[a-f0-9]{16}$/u), answerWaitMs: 5000 })
  })

  it('tells the restart once its answer is on the way, and only after one that went ahead', async () => {
    const place = await ready()
    let claim: Record<string, unknown> = { state: 'restarting' }
    const { spawn, calls } = fakeSpawn(async call => { await claimAs(call, claim) })
    const host = hostWith(place, spawn)
    expect(await host.run({ action: 'restart', version: '1.2.4' }, context())).toEqual({ type: 'update-restarting', version: '1.2.4' })
    const answered = `${statusFile(place)}.${String(calls[0]!.configuration.attempt)}.answered`
    // Written only once the host has handed its answer on.
    await expect(readFile(answered)).rejects.toMatchObject({ code: 'ENOENT' })
    await host.delivered()
    expect(await readFile(answered, 'utf8')).toBe('')
    await rm(answered)
    // Said once: a second delivery, and the answer to a restart that did not go ahead, write nothing.
    await host.delivered()
    claim = { state: 'finished', result: { type: 'error', reason: 'update-busy' } }
    expect(await host.run({ action: 'restart', version: '1.2.4' }, context())).toEqual({ type: 'error', reason: 'update-busy' })
    await host.delivered()
    expect((await readdir(place.data)).filter(name => name.endsWith('.answered'))).toEqual([])
  })

  it('answers the restart’s own refusal when it stopped before touching anything', async () => {
    const place = await ready()
    const { spawn } = fakeSpawn(async call => { await claimAs(call, { state: 'finished', result: { type: 'error', reason: 'update-busy' } }) })
    expect(await hostWith(place, spawn).run({ action: 'restart', version: '1.2.4' }, context())).toEqual({ type: 'error', reason: 'update-busy' })
  })

  it('gives up after its wait and claims the attempt, so neither that restart nor a later one goes ahead on it', async () => {
    const place = await ready()
    const late: Call[] = []
    const { spawn } = fakeSpawn(call => { late.push(call) })
    const host = hostWith(place, spawn, { restartWaitMs: 150 })
    expect(await host.run({ action: 'restart', version: '1.2.4' }, context())).toEqual({ type: 'error', reason: 'restart-not-sent' })
    const first = late[0]!
    expect(JSON.parse(await readFile(statusFile(place), 'utf8'))).toEqual({ v: 1, attempt: first.configuration.attempt, version: '1.2.4', state: 'finished',
      result: { type: 'error', reason: 'restart-not-sent' } })
    // The restart that comes late finds its attempt claimed, which is how the launch script knows to stop.
    expect(await claimAs(first, { state: 'restarting' })).toBe(false)
    // Trying again clears the status file, but the late restart still cannot claim: its attempt's claim is kept.
    const { spawn: answering } = fakeSpawn(async call => { await claimAs(call, { state: 'restarting' }) })
    expect(await hostWith(place, answering).run({ action: 'restart', version: '1.2.4' }, context())).toEqual({ type: 'update-restarting', version: '1.2.4' })
    expect(await claimAs(first, { state: 'restarting' })).toBe(false)
    // A status another attempt wrote is not this one's answer.
    const { spawn: stranger } = fakeSpawn(async (call, child) => {
      await writeFile(String(call.configuration.resultFile), JSON.stringify({ v: 1, attempt: 'bbbbbbbb', version: '1.2.4', state: 'restarting' }))
      setImmediate(() => child.emit('exit', 0, null))
    })
    expect(await hostWith(place, stranger, { restartWaitMs: 24 * 60 * 60_000 }).run({ action: 'restart', version: '1.2.4' }, context())).toEqual({ type: 'error', reason: 'restart-not-sent' })
    // A restart process that ended without a word is given up on at once, long before a wait this test would never outlast.
    const { spawn: silent } = fakeSpawn((_call, child) => { setImmediate(() => child.emit('exit', 1, null)) })
    expect(await hostWith(place, silent, { restartWaitMs: 24 * 60 * 60_000 }).run({ action: 'restart', version: '1.2.4' }, context())).toEqual({ type: 'error', reason: 'restart-not-sent' })
  })

  it('runs the restart in a transient unit of its own for a host its start at boot unit runs', async () => {
    const place = await ready()
    const { spawn, calls } = fakeSpawn(async (call, child) => {
      if (call.file !== 'systemd-run') return
      setImmediate(() => child.emit('exit', 0, null))
      await claimAs(call, { state: 'restarting' })
    })
    const host = hostWith(place, spawn, { runByUnit: async () => true, env: { PATH: '/usr/bin', HOME: '/home/zach', XDG_RUNTIME_DIR: '/run/user/1000', SOTTO_HOST_KEY_FILE: '/home/zach/.sotto-key' } })
    expect(await host.run({ action: 'restart', version: '1.2.4' }, context())).toEqual({ type: 'update-restarting', version: '1.2.4' })
    const [call] = calls
    expect(call!.file).toBe('systemd-run')
    const script = join(place.data, 'host-update-restart.cjs')
    expect(await readFile(script, 'utf8')).toBe(LAUNCH_SCRIPT_SOURCE)
    expect(call!.args.slice(0, 4)).toEqual(['--user', '--collect', '--quiet', expect.stringMatching(/^--unit=sotto-host-update-[0-9a-f]{8}$/u)])
    expect(call!.args).toEqual(expect.arrayContaining(['--setenv=SOTTO_HOST_KEY_FILE=/home/zach/.sotto-key', '--setenv=XDG_RUNTIME_DIR=/run/user/1000', '--setenv=HOME=/home/zach']))
    expect(call!.args.slice(-4, -1)).toEqual(['--', '/usr/bin/node', script])
  })

  it('reports how the last restart went, or that there was none', async () => {
    const place = await installed()
    const { spawn } = fakeSpawn(() => undefined)
    const host = hostWith(place, spawn)
    const attempt = 'cccccccc'
    expect(await host.run({ action: 'outcome' }, context())).toEqual({ type: 'update-outcome', running: '1.2.3', restart: { state: 'none' } })
    await writeFile(statusFile(place), JSON.stringify({ v: 1, attempt, version: '1.2.4', state: 'restarting', pid: 12 }))
    expect(await host.run({ action: 'outcome' }, context())).toEqual({ type: 'update-outcome', running: '1.2.3', restart: { state: 'restarting', version: '1.2.4' } })
    await writeFile(statusFile(place), JSON.stringify({ v: 1, attempt, version: '1.2.4', state: 'finished', result: { type: 'error', reason: 'update-start-failed', restarted: true, cause: 'host-start-failed' } }))
    expect(await host.run({ action: 'outcome' }, context())).toEqual({ type: 'update-outcome', running: '1.2.3',
      restart: { state: 'finished', version: '1.2.4', result: { type: 'error', reason: 'update-start-failed', restarted: true, cause: 'host-start-failed' } } })
    // A file it did not write, or one too large to be one, reads as none.
    await writeFile(statusFile(place), JSON.stringify({ v: 1, attempt, state: 'finished', version: '1.2.4', result: { type: 'error', reason: 'x', padding: 'y'.repeat(5000) } }))
    expect(await host.run({ action: 'outcome' }, context())).toEqual({ type: 'update-outcome', running: '1.2.3', restart: { state: 'none' } })
    await writeFile(statusFile(place), JSON.stringify({ v: 1, version: '1.2.4', state: 'restarting' }))
    expect(await host.run({ action: 'outcome' }, context())).toEqual({ type: 'update-outcome', running: '1.2.3', restart: { state: 'none' } })
    await writeFile(statusFile(place), 'not json')
    expect(await host.run({ action: 'outcome' }, context())).toEqual({ type: 'update-outcome', running: '1.2.3', restart: { state: 'none' } })
  })

  it('gives a transient unit only the environment the restart needs', () => {
    const args = transientRestartCommand({ node: '/n', script: '/d/s.cjs', configuration: '{}', unit: 'sotto-host-update-1', env: { PATH: '/bin', SECRET_TOKEN: 'no', HOME: '', LANG: 'C\nX' } })
    expect(args).toEqual(['--user', '--collect', '--quiet', '--unit=sotto-host-update-1', '--setenv=PATH=/bin', '--', '/n', '/d/s.cjs', '{}'])
  })
})
