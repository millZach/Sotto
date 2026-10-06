// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HOST_STOP_DRAIN_MS, LAUNCH_SCRIPT_SOURCE, type LaunchOperation } from '../../src/main/hosts/launchScript'
import { bootStatusSchema } from '../../src/shared/bootStart'
import { fakeSystemd, type FakeSystemd, type FakeSystemdState } from '../fixtures/fakeSystemd'

// Start at boot (ADR-0054) over fake systemctl and loginctl executables on the path. Real systemd is never touched. macOS
// hosts cannot start at boot, so the launch script never asks systemd there and these cases have nothing to run.
const HOST_ID = '11111111-1111-4111-8111-111111111111'
// Each case runs several launch script operations, each a Node start and a fake systemctl call per step.
vi.setConfig({ testTimeout: 60_000 })
const directories: string[] = [], children: ChildProcess[] = [], pids: number[] = []
let systemd: FakeSystemd | undefined
afterEach(async () => {
  for (const pid of [...pids.splice(0), ...(systemd ? await systemd.spawned() : [])]) { try { process.kill(pid, 'SIGTERM') } catch { /* already exited */ } }
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill()
  systemd = undefined
  await new Promise(resolve => setTimeout(resolve, 100))
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }

async function fixture(state: FakeSystemdState = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-launch-boot-')); directories.push(directory)
  const installPath = join(directory, "installed host's $(literal) 100%")
  await mkdir(join(installPath, 'host'), { recursive: true })
  await writeFile(join(installPath, 'package.json'), JSON.stringify({ type: 'module' }))
  await copyFile(resolve('tests/fixtures/fakeSshHost.mjs'), join(installPath, 'host/index.js'))
  const dataDirectory = join(directory, 'data')
  systemd = await fakeSystemd(directory, { data: dataDirectory, ...state })
  // A deadline only a hung host reaches: each fake call is a process of its own, which a loaded machine starts slowly.
  return { directory, installPath, dataDirectory, remotePort: 0, readyTimeoutMs: 30_000, stopDrainMs: HOST_STOP_DRAIN_MS, systemd }
}
type Configuration = Awaited<ReturnType<typeof fixture>>
interface Outcome { readonly messages: Record<string, unknown>[]; readonly result: Record<string, unknown> }
/** One operation the way the desktop sends it, under the fakes. */
async function run(configuration: Configuration, operation: LaunchOperation | Record<string, unknown>, env: NodeJS.ProcessEnv = {}): Promise<Outcome> {
  const { systemd: fake, ...settings } = configuration
  const child = spawn(process.execPath, ['--input-type=commonjs', '-', JSON.stringify({ ...settings, ...operation })], { shell: false, windowsHide: true, env: { ...fake.env, ...env } })
  children.push(child)
  child.stdin.end(LAUNCH_SCRIPT_SOURCE)
  let output = ''
  child.stdout.on('data', chunk => { output += String(chunk) })
  await new Promise(resolve => child.once('close', resolve))
  const messages = output.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line) as Record<string, unknown>)
  const result = messages.at(-1) ?? {}
  if (typeof result.pid === 'number') pids.push(result.pid)
  return { messages, result }
}
const descriptor = async (configuration: Configuration) => JSON.parse(await readFile(join(configuration.dataDirectory, 'host-listener.json'), 'utf8')) as { pid: number; startedBy?: string }
/** A host the owner started by hand in the same folder: Sotto did not start it. */
async function startedByHand(configuration: Configuration, env: NodeJS.ProcessEnv = {}): Promise<ChildProcess> {
  const child = spawn(process.execPath, [join(configuration.installPath, 'host/index.js'), '--data', configuration.dataDirectory, '--port', '0'], { shell: false, windowsHide: true, env: { ...process.env, ...env } })
  children.push(child)
  await vi.waitFor(async () => expect((await descriptor(configuration)).pid).toBe(child.pid), { timeout: 10_000 })
  return child
}
/** Start at boot installed over a host the launch script started, as Start at boot leaves it. */
async function installed(state: FakeSystemdState = {}) {
  const configuration = await fixture({ linger: true, ...state })
  await run(configuration, { op: 'launch' })
  const install = await run(configuration, { op: 'boot-install', hostId: HOST_ID })
  expect(install.result).toEqual(expect.objectContaining({ type: 'boot-installed', installed: true, stopped: true }))
  return configuration
}
/** The calls since `from`, without the state reads, which say nothing about what the script changed. */
const changes = async (from = 0) => (await systemd!.calls()).slice(from).filter(call => !call.startsWith('systemctl show') && !call.startsWith('systemctl is-system-running') && !call.startsWith('loginctl show-user'))

describe.skipIf(process.platform === 'darwin')('start at boot in the launch script (ADR-0054)', () => {
  it('says start at boot is not supported on a machine that does not run systemd, and changes nothing', async () => {
    const configuration = await fixture({ systemd: false, userManager: false })
    const status = await run(configuration, { op: 'boot-status' })
    expect(status.result).toEqual({ type: 'boot-status', supported: false, reason: 'no-user-manager', installed: false, enabled: false, active: false, linger: false, nodeDrift: false })
    expect(bootStatusSchema.safeParse(status.result).success).toBe(true)
    const install = await run(configuration, { op: 'boot-install', hostId: HOST_ID })
    expect(install.result).toMatchObject({ type: 'boot-installed', installed: false, bootStart: { supported: false, reason: 'no-user-manager' } })
    await expect(readFile(configuration.systemd.unitPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await changes()).toEqual([])
  })

  it('offers start at boot to an account with no session and no linger, whose user manager linger then starts', async () => {
    const configuration = await fixture({ userManager: false, linger: false, enableLinger: 'allow' })
    const launched = await run(configuration, { op: 'launch' })
    expect(launched.result).toMatchObject({ type: 'ready', owned: true, bootStart: { supported: true, installed: false, linger: false, fix: `sudo loginctl enable-linger ${userInfo().username}` } })
    const install = await run(configuration, { op: 'boot-install', hostId: HOST_ID })
    expect(install.result).toMatchObject({ type: 'boot-installed', installed: true, stopped: true, bootStart: { supported: true, enabled: true, active: true, linger: true } })
    expect((await changes())[0]).toBe('loginctl enable-linger')
  })

  it('refuses, changing nothing, while another installation\'s unit holds the name', async () => {
    const configuration = await fixture({ linger: true })
    const other = '[Service]\nExecStart=/bin/sh "/opt/other sotto/boot-start.sh"\n'
    await mkdir(join(configuration.systemd.unitPath, '..'), { recursive: true })
    await writeFile(configuration.systemd.unitPath, other)
    expect((await run(configuration, { op: 'boot-install', hostId: HOST_ID })).result).toEqual({ type: 'error', reason: 'boot-unit-taken' })
    expect(await readFile(configuration.systemd.unitPath, 'utf8')).toBe(other)
    expect(await changes()).toEqual([])
  })

  it('waits its turn behind an update of the same installation, and changes nothing', async () => {
    const configuration = await fixture({ linger: true })
    await mkdir(join(configuration.installPath, 'versions', '.update-lock'), { recursive: true })
    await writeFile(join(configuration.installPath, 'versions', '.update-lock', 'pid'), String(process.pid))
    expect((await run(configuration, { op: 'boot-install', hostId: HOST_ID })).result).toEqual({ type: 'error', reason: 'update-busy' })
    expect(await changes()).toEqual([])
  })

  it('takes the unit and its script away again when the user manager will not enable it, and leaves the host running', async () => {
    const configuration = await fixture({ linger: true, enableExit: 1 })
    const launched = await run(configuration, { op: 'launch' })
    expect((await run(configuration, { op: 'boot-install', hostId: HOST_ID })).result).toEqual({ type: 'error', reason: 'boot-install-failed' })
    expect(await changes()).toEqual(['systemctl daemon-reload', 'systemctl enable sotto-host', 'systemctl disable --now sotto-host', 'systemctl daemon-reload', 'systemctl reset-failed sotto-host'])
    await expect(readFile(configuration.systemd.unitPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(configuration.installPath, 'boot-start.sh'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(alive(launched.result.pid as number)).toBe(true)
  })

  it('leaves an install that was already there, and the host it runs, when installing again fails', async () => {
    const configuration = await installed()
    const unitHost = (await descriptor(configuration)).pid
    await systemd!.set({ enableExit: 1 })
    const before = (await systemd!.calls()).length
    expect((await run(configuration, { op: 'boot-install', hostId: HOST_ID })).result).toEqual({ type: 'error', reason: 'boot-install-failed' })
    expect(await changes(before)).toEqual(['systemctl daemon-reload', 'systemctl enable sotto-host'])
    await expect(readFile(configuration.systemd.unitPath, 'utf8')).resolves.toContain('Sotto host')
    await expect(readFile(join(configuration.installPath, 'boot-start.sh'), 'utf8')).resolves.toContain('exec "$node"')
    expect(alive(unitHost)).toBe(true)
  })

  it('undoes the install and starts the host the way a launch does when the unit will not start it', async () => {
    const configuration = await fixture({ linger: true, startExit: 1 })
    const launched = await run(configuration, { op: 'launch' })
    const install = await run(configuration, { op: 'boot-install', hostId: HOST_ID })
    expect(install.result).toEqual({ type: 'error', reason: 'boot-start-failed', restarted: true, cause: 'boot-start-refused' })
    expect(alive(launched.result.pid as number)).toBe(false)
    await expect(readFile(configuration.systemd.unitPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await systemd!.state()).enabled).toBe(false)
    const restarted = await descriptor(configuration)
    pids.push(restarted.pid)
    expect(restarted).toMatchObject({ startedBy: 'launch-script' })
    expect(alive(restarted.pid)).toBe(true)
  })

  it('writes the key file the launch\'s own environment names into the unit\'s script, as its path', async () => {
    const configuration = await fixture({ linger: true })
    await run(configuration, { op: 'launch' })
    await run(configuration, { op: 'boot-install', hostId: HOST_ID }, { SOTTO_HOST_KEY_FILE: "/home/someone/keys/sotto's key" })
    const script = await readFile(join(configuration.installPath, 'boot-start.sh'), 'utf8')
    expect(script).toContain("SOTTO_HOST_KEY_FILE='/home/someone/keys/sotto'\\''s key'\nexport SOTTO_HOST_KEY_FILE\n")
  })

  it('counts a host the unit runs as Sotto\'s even when its release does not record the boot mark', async () => {
    const configuration = await fixture({ linger: true })
    await run(configuration, { op: 'launch' })
    expect((await run(configuration, { op: 'boot-install', hostId: HOST_ID }, { FAKE_HOST_BEFORE_BOOT_MARK: '1' })).result).toMatchObject({ type: 'boot-installed', stopped: true })
    expect((await descriptor(configuration)).startedBy).toBeUndefined()
    expect((await run(configuration, { op: 'launch' })).result).toMatchObject({ type: 'ready', owned: true })
    expect((await run(configuration, { op: 'stop-host', hostId: HOST_ID })).result).toEqual({ type: 'host-stopped', stopped: true, hostId: HOST_ID })
  })

  it('installs the unit and its script, then hands a host the launch script started over to the unit, which restarts it once', async () => {
    const configuration = await fixture({ linger: true })
    const launched = await run(configuration, { op: 'launch' })
    expect(launched.result).toMatchObject({ type: 'ready', owned: true, bootStart: { supported: true, installed: false, enabled: false, linger: true, nodeDrift: false } })
    const before = (await systemd!.calls()).length
    const install = await run(configuration, { op: 'boot-install', hostId: HOST_ID })
    expect(install.result).toMatchObject({ type: 'boot-installed', installed: true, stopped: true, bootStart: { supported: true, installed: true, enabled: true, active: true, linger: true, nodeDrift: false } })
    expect(alive(launched.result.pid as number)).toBe(false)
    expect(await descriptor(configuration)).toMatchObject({ pid: install.result.pid, startedBy: 'boot' })
    expect(await changes(before)).toEqual(['systemctl daemon-reload', 'systemctl enable sotto-host', 'systemctl reset-failed sotto-host', 'systemctl start sotto-host'])
    const unit = (await readFile(configuration.systemd.unitPath, 'utf8')).split('\n')
    // The start limit belongs to [Unit]: systemd ignores it under [Service].
    expect(unit.slice(unit.indexOf('[Unit]'), unit.indexOf('[Service]'))).toEqual(expect.arrayContaining(['StartLimitIntervalSec=120', 'StartLimitBurst=5']))
    expect(unit.slice(unit.indexOf('[Service]'), unit.indexOf('[Install]'))).toEqual(expect.arrayContaining(['Environment=SOTTO_HOST_STARTED_BY=boot', 'KillMode=mixed', 'TimeoutStopSec=25',
      'Restart=on-failure', 'RestartSec=5', 'RestartPreventExitStatus=75']))
    expect(unit).toContain('WantedBy=default.target')
    // The saved host's own installation folder, quoted so systemd reads its specifier and variable characters literally.
    const quoted = join(configuration.installPath, 'boot-start.sh').replace(/\\/gu, '\\\\').replace(/%/gu, '%%').replace(/\$/gu, '$$$$')
    expect(unit).toContain(`ExecStart=/bin/sh "${quoted}"`)
    const script = await readFile(join(configuration.installPath, 'boot-start.sh'), 'utf8')
    expect(script).toContain(`node='${process.execPath.split("'").join("'\\''")}'`)
    expect(script).toContain('exec "$node" "$entry" --data "$data" --port "$port"')
    expect(script).not.toContain('--key-file')
  })

  it('turns linger on for the account first when it is off, without sudo', async () => {
    const configuration = await fixture({ linger: false, enableLinger: 'allow' })
    await run(configuration, { op: 'launch' })
    const install = await run(configuration, { op: 'boot-install', hostId: HOST_ID })
    expect(install.result).toMatchObject({ type: 'boot-installed', installed: true, bootStart: { linger: true, enabled: true } })
    expect((await changes())[0]).toBe('loginctl enable-linger')
  })

  it('writes nothing and leaves the running host alone when polkit refuses linger, and gives the command for the owner', async () => {
    const configuration = await fixture({ linger: false, enableLinger: 'refuse' })
    const launched = await run(configuration, { op: 'launch' })
    const install = await run(configuration, { op: 'boot-install', hostId: HOST_ID })
    expect(install.result).toMatchObject({ type: 'boot-installed', installed: false, stopped: false,
      bootStart: { supported: true, installed: false, enabled: false, linger: false, fix: `sudo loginctl enable-linger ${userInfo().username}` } })
    expect(await changes()).toEqual(['loginctl enable-linger'])
    await expect(readFile(configuration.systemd.unitPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(configuration.installPath, 'boot-start.sh'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await descriptor(configuration)).pid).toBe(launched.result.pid)
    expect(alive(launched.result.pid as number)).toBe(true)
  })

  it('leaves a host Sotto did not start running, for the unit to take over at the next boot', async () => {
    const configuration = await fixture({ linger: true })
    const byHand = await startedByHand(configuration)
    const install = await run(configuration, { op: 'boot-install', hostId: HOST_ID })
    expect(install.result).toMatchObject({ type: 'boot-installed', installed: true, stopped: false, bootStart: { enabled: true, active: false } })
    expect(await changes()).toEqual(['systemctl daemon-reload', 'systemctl enable sotto-host'])
    expect(byHand.exitCode).toBeNull()
  })

  describe('a launch with the unit enabled and linger on', () => {
    it('uses the host the unit runs, and starts nothing', async () => {
      const configuration = await installed()
      const unitHost = (await descriptor(configuration)).pid
      const before = (await systemd!.calls()).length
      const launch = await run(configuration, { op: 'launch' })
      expect(launch.result).toMatchObject({ type: 'ready', owned: true, pid: unitHost, bootStart: { enabled: true, active: true } })
      expect(await changes(before)).toEqual([])
      expect(await systemd!.spawned()).toHaveLength(1)
    })

    it('has the unit start the host when none runs, and spawns no detached host', async () => {
      const configuration = await installed()
      await run(configuration, { op: 'stop-host', hostId: HOST_ID })
      const before = (await systemd!.calls()).length
      const launch = await run(configuration, { op: 'launch' })
      expect(launch.result).toMatchObject({ type: 'ready', owned: true })
      expect(await descriptor(configuration)).toMatchObject({ pid: launch.result.pid, startedBy: 'boot' })
      expect(await changes(before)).toEqual(['systemctl reset-failed sotto-host', 'systemctl start sotto-host'])
    })

    it('uses a host Sotto did not start that holds the folder, and starts nothing', async () => {
      const configuration = await installed()
      await run(configuration, { op: 'stop-host', hostId: HOST_ID })
      const byHand = await startedByHand(configuration)
      const before = (await systemd!.calls()).length
      const launch = await run(configuration, { op: 'launch' })
      expect(launch.result).toMatchObject({ type: 'ready', owned: false, pid: byHand.pid })
      expect(await changes(before)).toEqual([])
    })

    it('clears a start limit the unit hit before it asks for a start', async () => {
      const configuration = await installed()
      await run(configuration, { op: 'stop-host', hostId: HOST_ID })
      await systemd!.set({ unit: { ActiveState: 'failed', SubState: 'failed', Result: 'start-limit-hit', NRestarts: '0', ExecMainStatus: '1' } })
      const before = (await systemd!.calls()).length
      expect((await run(configuration, { op: 'launch' })).result).toMatchObject({ type: 'ready', owned: true })
      expect(await changes(before)).toEqual(['systemctl reset-failed sotto-host', 'systemctl start sotto-host'])
    })

    it('reports a start the user manager refuses at once, rather than waiting for a host', async () => {
      const configuration = await installed()
      await run(configuration, { op: 'stop-host', hostId: HOST_ID })
      await systemd!.set({ startExit: 1 })
      const launch = await run(configuration, { op: 'launch' })
      expect(launch.result).toEqual({ type: 'error', reason: 'boot-start-refused' })
    })

    it('reports a unit that lands failed after a start that returned 0 at once', async () => {
      const configuration = await installed()
      await run(configuration, { op: 'stop-host', hostId: HOST_ID })
      await systemd!.set({ afterStart: 'failed' })
      const launch = await run(configuration, { op: 'launch' })
      expect(launch.result).toEqual({ type: 'error', reason: 'boot-unit-failed' })
    })

    it('reports a unit that keeps restarting with its runs failing well before the host is given up on', async () => {
      const configuration = await installed()
      await run(configuration, { op: 'stop-host', hostId: HOST_ID })
      await systemd!.set({ afterStart: 'crash-loop' })
      const launch = await run(configuration, { op: 'launch' })
      expect(launch.result).toEqual({ type: 'error', reason: 'boot-unit-failed' })
    })

    it('waits through a single restart, such as a moment\'s lock contention, and uses the host the unit then runs', async () => {
      const configuration = await installed()
      await run(configuration, { op: 'stop-host', hostId: HOST_ID })
      await systemd!.set({ afterStart: 'retry-once' })
      const launch = await run(configuration, { op: 'launch' })
      expect(launch.result).toMatchObject({ type: 'ready', owned: true })
      expect(await descriptor(configuration)).toMatchObject({ startedBy: 'boot' })
    })

    it('waits for and uses a host that took the lock while the unit started, rather than calling the unit failed', async () => {
      const configuration = await installed()
      await run(configuration, { op: 'stop-host', hostId: HOST_ID })
      await systemd!.set({ afterStart: 'lost-lock' })
      // The other host holds the lock for a while before it listens, so the unit has given up before that host answers.
      const launch = await run(configuration, { op: 'launch' }, { FAKE_HOST_START_DELAY_MS: '1500' })
      expect(launch.result).toMatchObject({ type: 'ready', owned: false })
      expect((await descriptor(configuration)).startedBy).toBeUndefined()
    })
  })

  it('restarts the unit on the data folder the saved host has now, after Edit connection changed it', async () => {
    const configuration = await installed()
    const unitHost = (await descriptor(configuration)).pid
    const moved = { ...configuration, dataDirectory: join(configuration.directory, "moved data's folder") }
    const before = (await systemd!.calls()).length
    const launch = await run(moved, { op: 'launch' })
    expect(launch.result).toMatchObject({ type: 'ready', owned: true, bootStart: { enabled: true, active: true } })
    expect(alive(unitHost)).toBe(false)
    expect(await descriptor(moved)).toMatchObject({ pid: launch.result.pid, startedBy: 'boot' })
    expect(await changes(before)).toEqual(['systemctl stop sotto-host', 'systemctl reset-failed sotto-host', 'systemctl start sotto-host'])
    expect(await readFile(join(configuration.installPath, 'boot-start.sh'), 'utf8')).toContain(`data='${moved.dataDirectory.split("'").join("'\\''")}'`)
  })

  it('turns start at boot off when linger is off, stops the unit\'s host and spawns one detached host in its place', async () => {
    const configuration = await installed()
    const unitHost = (await descriptor(configuration)).pid
    await systemd!.set({ linger: false })
    const before = (await systemd!.calls()).length
    const launch = await run(configuration, { op: 'launch' })
    expect(launch.result).toMatchObject({ type: 'ready', owned: true,
      bootStart: { installed: true, enabled: false, active: false, linger: false, fix: `sudo loginctl enable-linger ${userInfo().username}` } })
    expect(await changes(before)).toEqual(['systemctl disable --now sotto-host'])
    expect(alive(unitHost)).toBe(false)
    expect(await descriptor(configuration)).toMatchObject({ pid: launch.result.pid, startedBy: 'launch-script' })
    // The unit's files stay, disabled, for Start at boot to enable again once linger is on.
    await expect(readFile(configuration.systemd.unitPath, 'utf8')).resolves.toContain('[Install]')
    await expect(readFile(join(configuration.installPath, 'boot-start.sh'), 'utf8')).resolves.toContain('exec "$node"')
  })

  it('stops a host the unit runs through the user manager, and keeps the unit enabled for the next boot', async () => {
    const configuration = await installed()
    const unitHost = (await descriptor(configuration)).pid
    const before = (await systemd!.calls()).length
    expect((await run(configuration, { op: 'stop-host', hostId: HOST_ID })).result).toEqual({ type: 'host-stopped', stopped: true, hostId: HOST_ID })
    expect(alive(unitHost)).toBe(false)
    expect(await changes(before)).toEqual(['systemctl stop sotto-host'])
    expect((await systemd!.state()).enabled).toBe(true)
  })

  describe('boot-remove', () => {
    it('disables the unit, removes its files and clears its failed state, and starts nothing for a host that is switched off', async () => {
      const configuration = await installed()
      await run(configuration, { op: 'stop-host', hostId: HOST_ID })
      const before = (await systemd!.calls()).length, hosts = (await systemd!.spawned()).length
      const remove = await run(configuration, { op: 'boot-remove', restart: false })
      expect(remove.result).toMatchObject({ type: 'boot-removed', stopped: false, bootStart: { installed: false, enabled: false } })
      expect(remove.result.pid).toBeUndefined()
      expect(await changes(before)).toEqual(['systemctl disable --now sotto-host', 'systemctl daemon-reload', 'systemctl reset-failed sotto-host'])
      await expect(readFile(configuration.systemd.unitPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(join(configuration.installPath, 'boot-start.sh'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await systemd!.spawned()).toHaveLength(hosts)
    })

    it('starts one detached host in place of the unit\'s for a host that is switched on', async () => {
      const configuration = await installed()
      const unitHost = (await descriptor(configuration)).pid
      const remove = await run(configuration, { op: 'boot-remove', restart: true })
      expect(remove.result).toMatchObject({ type: 'boot-removed', stopped: true, bootStart: { installed: false } })
      expect(alive(unitHost)).toBe(false)
      expect(await descriptor(configuration)).toMatchObject({ pid: remove.result.pid, startedBy: 'launch-script' })
    })
  })

  describe('an update of a host the unit runs', () => {
    async function withVersions(configuration: Configuration) {
      for (const version of ['1.0.0', '1.1.0']) {
        await mkdir(join(configuration.installPath, 'versions', version, 'host'), { recursive: true })
        await writeFile(join(configuration.installPath, 'versions', version, 'package.json'), JSON.stringify({ type: 'module' }))
        await copyFile(resolve('tests/fixtures/fakeSshHost.mjs'), join(configuration.installPath, 'versions', version, 'host/index.js'))
      }
      await writeFile(join(configuration.installPath, 'current'), '1.0.0\n')
    }

    it('restarts the unit on the new version, clearing its failed state first, and rewrites a script whose Node drifted', async () => {
      const configuration = await installed()
      await withVersions(configuration)
      const script = join(configuration.installPath, 'boot-start.sh')
      await writeFile(script, (await readFile(script, 'utf8')).replace(/^node='.*'$/mu, "node='/opt/old-node/bin/node'"))
      expect((await run(configuration, { op: 'boot-status' })).result).toMatchObject({ type: 'boot-status', installed: true, nodeDrift: true })
      const before = (await systemd!.calls()).length
      const restart = await run(configuration, { op: 'update-restart', hostId: HOST_ID, version: '1.1.0' })
      expect(restart.result).toMatchObject({ type: 'ready', owned: true, bootStart: { active: true, nodeDrift: false } })
      expect(await changes(before)).toEqual(['systemctl stop sotto-host', 'systemctl reset-failed sotto-host', 'systemctl start sotto-host'])
      expect(await descriptor(configuration)).toMatchObject({ startedBy: 'boot', entry: expect.stringContaining('1.1.0') })
      expect(await readFile(script, 'utf8')).toContain(`node='${process.execPath.split("'").join("'\\''")}'`)
    })

    it('reports a restart the user manager refuses at once, as a launch does', async () => {
      const configuration = await installed()
      await withVersions(configuration)
      await systemd!.set({ startExit: 1 })
      const outcome = await run(configuration, { op: 'update-restart', hostId: HOST_ID, version: '1.1.0' })
      expect(outcome.result).toMatchObject({ type: 'error', reason: 'update-start-failed', restarted: false, cause: 'boot-start-refused' })
      expect(await readFile(join(configuration.installPath, 'current'), 'utf8')).toBe('1.0.0\n')
    })

    it('reports a new version the unit cannot keep running at once, and rolls back through the unit the same way', async () => {
      const configuration = await installed()
      await withVersions(configuration)
      // The fake cannot see why a host exits, so the unit keeps failing for the new version's start alone, and the
      // rollback's start runs the old version again.
      await systemd!.set({ afterStart: 'crash-loop', once: true })
      const before = (await systemd!.calls()).length
      const outcome = await run(configuration, { op: 'update-restart', hostId: HOST_ID, version: '1.1.0' })
      expect(outcome.result).toMatchObject({ type: 'error', reason: 'update-start-failed', restarted: true, cause: 'boot-unit-failed' })
      // The rollback stops the unit that is still trying the new version before it starts the old one.
      expect(await changes(before)).toEqual(['systemctl stop sotto-host', 'systemctl reset-failed sotto-host', 'systemctl start sotto-host',
        'systemctl stop sotto-host', 'systemctl reset-failed sotto-host', 'systemctl start sotto-host'])
      expect(await readFile(join(configuration.installPath, 'current'), 'utf8')).toBe('1.0.0\n')
      expect(await descriptor(configuration)).toMatchObject({ startedBy: 'boot', entry: expect.stringContaining('1.0.0') })
    })

    it('stops a new version the unit keeps running but that never answers, and rolls back to the old one', async () => {
      const configuration = await installed()
      await withVersions(configuration)
      // The new version holds the folder's lock and never listens, so the unit stays active while the wait runs out.
      const newHost = join(configuration.installPath, 'versions', '1.1.0', 'host')
      await copyFile(join(newHost, 'index.js'), join(newHost, 'fake.mjs'))
      await writeFile(join(newHost, 'index.js'), "process.env.FAKE_HOST_START_DELAY_MS = '600000'\nawait import('./fake.mjs')\n")
      const before = (await systemd!.calls()).length, hosts = (await systemd!.spawned()).length
      const outcome = await run({ ...configuration, readyTimeoutMs: 8000 }, { op: 'update-restart', hostId: HOST_ID, version: '1.1.0' })
      expect(outcome.result).toEqual({ type: 'error', reason: 'update-start-failed', restarted: true, cause: 'host-timeout' })
      expect(await changes(before)).toEqual(['systemctl stop sotto-host', 'systemctl reset-failed sotto-host', 'systemctl start sotto-host',
        'systemctl stop sotto-host', 'systemctl reset-failed sotto-host', 'systemctl start sotto-host'])
      const [hung] = (await systemd!.spawned()).slice(hosts)
      expect(alive(hung!)).toBe(false)
      expect(await readFile(join(configuration.installPath, 'current'), 'utf8')).toBe('1.0.0\n')
      expect(await descriptor(configuration)).toMatchObject({ startedBy: 'boot', entry: expect.stringContaining('1.0.0') })
    }, 60_000)
  })
})

it.runIf(process.platform === 'darwin')('says start at boot is not supported on macOS, and asks systemd nothing', async () => {
  const configuration = await fixture()
  expect((await run(configuration, { op: 'boot-status' })).result).toEqual({ type: 'boot-status', supported: false, reason: 'macos', installed: false, enabled: false, active: false, linger: false, nodeDrift: false })
  expect(await systemd!.calls()).toEqual([])
})
