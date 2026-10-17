// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { HostCredentialEncryption } from '../../src/host/credentials'
import { DesktopHostRouter } from '../../src/main/hosts/desktopHostRouter'
import { DesktopHosts } from '../../src/main/hosts/desktopHosts'
import { HostUpdates } from '../../src/main/hosts/hostUpdate'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'
import { RECEIVE_SCRIPT_SOURCE } from '../../src/main/hosts/launchScript'
import { SshHostLauncher, type SshHostConnection, type SshHostUpdateOperation, type SshHostUpdateOptions, type SshHostUpdateResult } from '../../src/main/hosts/sshLauncher'
import { HOST_ARCHIVE_LIMIT_BYTES, HOST_READY_TIMEOUT_MS, HOST_STOP_DRAIN_MS, hostLaunchTimings } from '../../src/shared/hostLaunchTimings'
import { HOST_UPDATE_RESTART_BUDGET_MS } from '../../src/shared/hostSelfUpdate'
import { TAILNET_ONLY_MS } from '../../src/main/hosts/hostConnectionPlan'
import type { HostUpdateState, HostUpdateStep } from '../../src/shared/hostUpdates'
import { hostRelease, localArchiveName, releasesPage, sidecar, tarGz } from '../fixtures/hostArchive'
import { collectLaunchScript, launchScriptChild } from '../fixtures/launchScriptRunner'
import { buildSelfUpdatingHost, stopEverythingIn } from '../fixtures/selfUpdatingHostBuild'
import { serveStandIn } from '../fixtures/serveStandIn'
import { ensureFixtureDesktopAnswers } from '../fixtures/sshDesktopAnswers'
import { testCredentials } from '../fixtures/testCredentials'

/**
 * The desktop's half of a host that updates itself (ADR-0088, October 16 amendment), end to end: the real headless host,
 * built from this checkout into a release's layout and started by the launch script, as a child of this test, never in its
 * process. Its tailnet listener sits behind a stand-in for Tailscale Serve, and every SSH connection and launch script
 * operation the desktop opens is counted, run on this machine by the real launch script. On the host's tailnet connection
 * Update opens none of them; where the socket cannot carry a step, the step goes over SSH as before.
 */
// A restart drains the old host and waits for the new one, a rollback starts once more, and the desktop reconnects within
// the restart's budget. A run that is not stuck never comes near this.
vi.setConfig({ testTimeout: HOST_UPDATE_RESTART_BUDGET_MS + HOST_STOP_DRAIN_MS + 3 * HOST_READY_TIMEOUT_MS + 60_000 })
const OLD = '9.9.8', NEW = '9.9.9', FILE = localArchiveName(NEW)
const DNS = 'forge.tail5728ca.ts.net'
let built: { readonly directory: string; readonly source: string } | undefined
const roots: string[] = [], children: ChildProcess[] = [], closers: (() => Promise<void> | void)[] = []

beforeAll(async () => { built = await buildSelfUpdatingHost() }, 180_000)
afterAll(async () => { if (built) await rm(built.directory, { recursive: true, force: true }) })
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await Promise.resolve(close()).catch(() => undefined)
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL')
  for (const root of roots.splice(0)) {
    await stopEverythingIn(root)
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined)
  }
})

const published = (entry: string): Map<string, Uint8Array | string> => {
  const archive = tarGz(hostRelease(NEW, entry, { commonjs: true }))
  return new Map<string, Uint8Array | string>([[`/v${NEW}/${FILE}`, archive], [`/v${NEW}/${FILE}.sha256`, sidecar(archive, FILE)]])
}
/** An address nothing listens on, for a host that cannot reach the releases page. */
async function nowhere(): Promise<string> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  await new Promise<void>(resolve => server.close(() => resolve()))
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 1}`
}
const idle = { working: () => [], workingNow: () => [], interrupt: async () => undefined, subscribe: () => () => undefined }

/**
 * forge as Add host leaves it: a flat install of `OLD` started by the launch script, with Tailscale running and ssh on its
 * path recording any use; saved on this computer, paired, and connected over its tailnet.
 */
async function scene(options: { readonly entry?: string; readonly hostReachesReleases?: boolean; readonly holdFirstDownload?: boolean
  /** Holds every launch script operation over SSH until it settles, so a test decides when SSH carries a step. */
  readonly beforeSsh?: () => Promise<void> } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-desktop-self-update-')); roots.push(root)
  const install = join(root, 'sotto-host'), data = join(root, 'data'), bin = join(root, 'bin'), sshUsed = join(root, 'ssh-used')
  await mkdir(join(install, 'host'), { recursive: true }); await mkdir(bin); await mkdir(data)
  await copyFile(join(built!.directory, 'index.js'), join(install, 'host', 'index.js'))
  await writeFile(join(install, 'package.json'), JSON.stringify({ name: 'sotto-host', version: OLD }))
  await writeFile(join(bin, 'ssh'), `#!/bin/sh\necho used > '${sshUsed}'\nexit 255\n`, { mode: 0o755 })
  await writeFile(join(bin, 'ssh.cmd'), `@echo used > "${sshUsed}"\r\n@exit /b 255\r\n`)
  // Tailscale runs on forge, as the end-to-end stand-in reads it; this machine's own is never touched.
  await writeFile(join(data, 'e2e-tailscale.json'), JSON.stringify({ state: 'running', dnsName: DNS, hostName: 'forge' }))
  // A held download is answered never, so it runs until it is cancelled; any later one is answered at once.
  let held = options.holdFirstDownload === true
  const page = await releasesPage(published(options.entry ?? built!.source), 0, request => {
    if (!held || !request.path.endsWith('.tar.gz')) return undefined
    held = false
    return new Promise<void>(() => undefined)
  })
  closers.push(() => page.close())
  const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH'
  const env = { ...process.env, [pathKey]: bin + delimiter + (process.env[pathKey] ?? ''),
    SOTTO_TEST_HOST_RELEASES_URL: options.hostReachesReleases === false ? await nowhere() : page.url }
  const configuration = { installPath: install, dataDirectory: data, remotePort: 0, ...hostLaunchTimings() }
  /** One launch script operation, run here the way SSH runs it on forge; its steps are told as it reports them. */
  const script = async (operation: Record<string, unknown>, onStep?: (step: HostUpdateStep) => void): Promise<Record<string, unknown>> => {
    const outcome = await collectLaunchScript(launchScriptChild({ ...configuration, ...operation }, env, child => children.push(child)))
    for (const message of outcome.messages) if (message.type === 'update-step') onStep?.(message.step as HostUpdateStep)
    return outcome.messages.filter(message => message.type !== 'update-step').at(-1) ?? { type: 'error', reason: 'update-failed' }
  }
  const ready = await script({ op: 'launch' })
  expect(ready, JSON.stringify(ready)).toMatchObject({ type: 'ready', owned: true, startedBy: 'launch-script' })
  const descriptor = async () => JSON.parse(await readFile(join(data, 'host-listener.json'), 'utf8')) as { port: number; hostId: string; adminToken: string; tailnetAddress?: string }
  const admin = async (route: string, body: unknown): Promise<Record<string, unknown>> => {
    const { port, adminToken } = await descriptor()
    const response = await fetch(`http://127.0.0.1:${port}/v1/admin/${route}`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return await response.json() as Record<string, unknown>
  }
  /** Where Serve would carry the tailnet listener, as the host's stand-in Tailscale says; nothing while it carries none. */
  const served = (): number | undefined => { try { return (JSON.parse(readFileSync(join(data, 'serve-stand-in.json'), 'utf8')) as { port: number }).port } catch { return undefined } }
  const stand = await serveStandIn(served); closers.push(() => stand.close())

  /** Every SSH connection the desktop opened, by kind, and every launch script operation it ran over one. */
  const connects: string[] = [], operations: string[] = []
  const overSsh = async (operation: SshHostUpdateOperation, update: SshHostUpdateOptions = {}): Promise<SshHostUpdateResult> => {
    await options.beforeSsh?.()
    if (operation.op === 'update-receive') {
      // The receive script, as SSH runs it: `node -e`, with the archive on stdin.
      const child = spawn(process.execPath, ['-e', RECEIVE_SCRIPT_SOURCE, JSON.stringify({ file: operation.file, size: operation.size, installPath: install, archiveLimit: HOST_ARCHIVE_LIMIT_BYTES })], { windowsHide: true })
      children.push(child)
      child.stdin.end(Buffer.from(operation.archive))
      return (await collectLaunchScript(child)).messages.at(-1) as SshHostUpdateResult
    }
    const launch = operation.op === 'update-restart' ? { op: 'update-restart', hostId: (await descriptor()).hostId, version: operation.version } : operation
    return await script(launch, update.onStep) as SshHostUpdateResult
  }
  class ChildSsh extends SshHostLauncher {
    override async connect(...[, , connect = {}]: Parameters<SshHostLauncher['connect']>): Promise<SshHostConnection> {
      const which = connect.start === false ? 'admin' : 'ssh'
      connects.push(which)
      const about = await descriptor()
      return { url: `http://127.0.0.1:${about.port}`, hostId: about.hostId, owned: true, route: { hostname: 'forge', identityFiles: [] }, system: `${process.platform}-${process.arch}`,
        ...(about.tailnetAddress ? { tailnetAddress: about.tailnetAddress } : {}),
        close: async () => undefined,
        showHostPairingCode: async () => { const code = await script({ op: 'pairing-code', hostId: about.hostId }); return { code: code.code as string, expiresAt: code.expiresAt as string, hostId: about.hostId } },
        ensureDesktopAnswers: clientId => ensureFixtureDesktopAnswers(data, about.hostId, clientId),
        revokeClient: async clientId => (await admin('revoke-client', { clientId })).revoked === true,
        hostAdminToken: async () => (await descriptor()).adminToken,
        stopHost: async () => { throw new Error('This test never stops its host over SSH.') },
        updateHost: async (operation, update) => { operations.push(`${which} ${operation.op}`); return overSsh(operation, update) },
        boot: async () => { throw new Error('This test host has no start at boot.') },
      }
    }
    override async disconnect(): Promise<void> { /* nothing stays open */ }
  }
  const desktopDirectory = join(root, 'desktop')
  const credentials = await testCredentials(desktopDirectory, { encryption: new HostCredentialEncryption('synthetic-desktop-credential-key') })
  let router!: DesktopHostRouter, manager!: DesktopHosts
  /** How far the desktop's clock runs ahead of this machine's, so a test can be past the first minute of retries at once. */
  let ahead = 0
  const open = async (): Promise<void> => {
    router = new DesktopHostRouter(emptyDesktopState)
    manager = new DesktopHosts({ directory: desktopDirectory, credentials, router, localHostRunning: false, localHostEnabled: () => false, restart: () => undefined,
      clientVersion: NEW, launcher: () => new ChildSsh(), retryDelayMs: () => 250, tailnetReturnMs: 60_000, now: () => Date.now() + ahead,
      // MagicDNS and Serve's certificate cannot run here: forge's name goes to the stand-in on loopback.
      resolveTailnet: address => new URL(address).hostname === DNS ? stand.url : address })
    const opened = { manager, router }
    closers.push(async () => { await opened.manager.close(); opened.router.dispose() })
    await manager.start()
  }
  await open()
  // The saved folders are forge's own, which the SSH stand-in above runs against wherever this test laid them out.
  const remote = { id: randomUUID(), name: 'forge', target: 'forge', identityFile: '', installPath: '/opt/sotto', dataDirectory: '/data/sotto' }
  await manager.command({ type: 'add', host: remote })
  const onTailnet = () => vi.waitFor(() => expect(manager.get().hosts[0]).toMatchObject({ phase: 'connected', via: 'tailnet' }), { timeout: 30_000, interval: 100 })
  await onTailnet()
  // Add host's SSH connection paired and recorded this computer, then closed once the socket moved to the tailnet.
  expect(connects).toEqual(['ssh'])

  /** The update panel for forge, wired to the saved hosts the way main wires it, with every step it showed. */
  const updatePanel = () => {
    const updates = new HostUpdates({ version: NEW, releasesUrl: page.url, threads: idle,
      hosts: { candidates: () => manager.updateCandidates(), run: (id, operation, update) => manager.runUpdate(id, operation, update),
        restart: (id, version, update) => manager.restartForUpdate(id, version, update), subscribe: listener => manager.subscribe(() => listener()) } })
    closers.push(() => updates.dispose())
    const steps: HostUpdateStep[] = []
    updates.subscribe(() => { const step = updates.state()[0]?.step; if (step && steps.at(-1) !== step) steps.push(step) })
    const one = (): HostUpdateState => updates.state()[0]!
    const run = async (): Promise<HostUpdateState> => {
      expect(one()).toMatchObject({ from: OLD, to: NEW, phase: 'needs' })
      await updates.command(remote.id, 'update')
      await vi.waitFor(() => expect(['done', 'failed']).toContain(one().phase), { timeout: HOST_UPDATE_RESTART_BUDGET_MS + 60_000, interval: 200 })
      return one()
    }
    return { updates, steps, one, run }
  }
  return { root, install, data, sshUsed, stand, admin, page, connects, operations, remote, onTailnet, updatePanel, hostId: ready.hostId as string,
    get manager() { return manager },
    /** Moves the desktop's clock on by `ms`. */
    runAhead: (ms: number) => { ahead += ms },
    /** Sotto starting again: a new connect, over the tailnet, with nothing of the last one's connection kept. */
    relaunch: async () => { await manager.close(); router.dispose(); await open(); await onTailnet() } }
}
const deny = async (s: Awaited<ReturnType<typeof scene>>): Promise<void> => {
  const clientId = s.manager.get().hosts[0]!.clientId!
  expect(await s.admin('deny-answers', { clientId })).toMatchObject({ ok: true })
}

describe('a host update over the tailnet (ADR-0088)', () => {
  it('downloads, installs and restarts over the host’s socket with no ssh, and reconnects over the tailnet to the new version', async () => {
    const s = await scene()
    const panel = s.updatePanel()
    expect(await panel.run()).toMatchObject({ phase: 'done', from: NEW, route: 'host' })
    // The host's own steps, as its pushes said them, in the panel's order.
    expect(panel.steps).toEqual(['download', 'check', 'install', 'restart'])
    // No SSH connection opened and no launch script ran over one, on this computer; and none was used on the host.
    expect(s.connects).toEqual(['ssh'])
    expect(s.operations).toEqual([])
    await expect(readFile(s.sshUsed)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(s.manager.get().hosts[0]).toMatchObject({ phase: 'connected', via: 'tailnet', version: NEW })
    expect(s.manager.get().hosts[0]!.error).toBeUndefined()
    expect((await readFile(join(s.install, 'current'), 'utf8')).trim()).toBe(NEW)
  })

  it('reads how the restart went from the host once it is back when the restart’s answer is lost, and sends no second restart', async () => {
    const s = await scene()
    // The network drops just as the host answers that it is restarting, before any of the answer arrives.
    // Then the tailnet does not answer for longer than a dropped connection's first minute of tailnet-only retries.
    let cut = false
    s.stand.cutWhen(bytes => {
      cut = bytes.includes('"update-restarting"')
      if (cut) { s.stand.answer(502); s.runAhead(TAILNET_ONLY_MS + 1_000) }
      return cut
    })
    const panel = s.updatePanel()
    const done = panel.run()
    await vi.waitFor(() => expect(cut).toBe(true), { timeout: 60_000, interval: 100 })
    const health = (): number => s.stand.requests.filter(request => request === 'GET /v1/health').length
    const tried = health()
    await vi.waitFor(() => expect(health()).toBeGreaterThanOrEqual(tried + 3), { timeout: 60_000, interval: 100 })
    // Within the restart's budget only the tailnet is tried, so Tailscale SSH is asked nothing.
    expect(s.connects).toEqual(['ssh'])
    s.stand.answer('proxy')
    expect(await done).toMatchObject({ phase: 'done', from: NEW })
    expect(s.connects).toEqual(['ssh'])
    expect(s.operations).toEqual([])
    expect(s.manager.get().hosts[0]).toMatchObject({ phase: 'connected', via: 'tailnet', version: NEW })
  })

  it('reads a rollback from the host once it is back when the restart’s answer is lost', async () => {
    const s = await scene({ entry: 'process.exit(1)\n' })
    let cut = false
    s.stand.cutWhen(bytes => (cut = bytes.includes('"update-restarting"')))
    const panel = s.updatePanel()
    // Only the host's outcome can say this: the answer that would have said the restart went never arrived.
    expect(await panel.run()).toMatchObject({ phase: 'failed', failure: { step: 'restart',
      message: `${NEW} installed on forge, but its host did not start, so Sotto started ${OLD} again.` } })
    expect(cut).toBe(true)
    expect(s.connects).toEqual(['ssh'])
    expect(s.operations).toEqual([])
  })

  it('downloads over SSH when the tailnet drops during the host’s own download, then installs and restarts over the socket', async () => {
    // SSH's download waits for the tailnet to be back, so the steps after it find the socket there.
    const s: Awaited<ReturnType<typeof scene>> = await scene({ holdFirstDownload: true, beforeSsh: () => vi.waitFor(() => expect(s.manager.get().hosts[0]).toMatchObject({ phase: 'connected', via: 'tailnet' }), { timeout: 30_000, interval: 100 }) })
    const panel = s.updatePanel()
    const done = panel.run()
    await vi.waitFor(() => expect(s.page.requests).toContain(`/v${NEW}/${FILE}`))
    s.stand.cut()
    expect(await done).toMatchObject({ phase: 'done', from: NEW, route: 'host' })
    expect(s.operations).toEqual(['admin update-fetch'])
    expect(s.connects).toEqual(['ssh', 'admin'])
    expect(s.manager.get().hosts[0]).toMatchObject({ phase: 'connected', via: 'tailnet', version: NEW })
  })

  it('ends the try as a lost connection when the install’s answer is lost, with nothing sent over SSH', async () => {
    const s = await scene()
    let cut = false
    s.stand.cutWhen(bytes => (cut = bytes.includes('"update-installed"')))
    const panel = s.updatePanel()
    expect(await panel.run()).toMatchObject({ phase: 'failed', failure: { step: 'install', message: 'The connection to forge closed during the update, before anything was switched.' } })
    expect(cut).toBe(true)
    expect(s.operations).toEqual([])
    expect(s.connects).toEqual(['ssh'])
    await s.onTailnet()
  })

  it('says the old version was started again when the new one would not start, over the socket alone', async () => {
    const s = await scene({ entry: 'process.exit(1)\n' })
    const panel = s.updatePanel()
    expect(await panel.run()).toMatchObject({ phase: 'failed', failure: { step: 'restart',
      message: `${NEW} installed on forge, but its host did not start, so Sotto started ${OLD} again.`, kept: 'forge\'s threads are back. Nothing was lost.' } })
    expect(s.connects).toEqual(['ssh'])
    expect(s.operations).toEqual([])
    expect(s.manager.get().hosts[0]).toMatchObject({ phase: 'connected', via: 'tailnet', version: OLD })
  })

  it('cancels a download over the socket with nothing over SSH, and Try again waits for the host to have stopped it', async () => {
    const s = await scene({ holdFirstDownload: true })
    const panel = s.updatePanel()
    await panel.updates.command(s.remote.id, 'update')
    await vi.waitFor(() => expect(s.page.requests).toContain(`/v${NEW}/${FILE}`))
    expect(panel.one()).toMatchObject({ phase: 'updating', step: 'download' })
    await panel.updates.command(s.remote.id, 'cancel')
    expect(panel.one()).toMatchObject({ phase: 'needs' })
    // At once: the host is still ending the download it was asked to cancel, and would refuse a second as busy.
    await panel.updates.command(s.remote.id, 'update')
    await vi.waitFor(() => expect(['done', 'failed']).toContain(panel.one().phase), { timeout: HOST_UPDATE_RESTART_BUDGET_MS + 60_000, interval: 200 })
    expect(panel.one()).toMatchObject({ phase: 'done', from: NEW })
    expect(s.page.requests.filter(path => path.endsWith('.tar.gz'))).toHaveLength(2)
    expect(s.connects).toEqual(['ssh'])
    expect(s.operations).toEqual([])
  })

  it('copies the archive over SSH when the host cannot reach the releases page, and installs and restarts over the socket', async () => {
    const s = await scene({ hostReachesReleases: false })
    const panel = s.updatePanel()
    expect(await panel.run()).toMatchObject({ phase: 'done', from: NEW, route: 'desktop' })
    // The copy is SSH's alone, through an admin connection; nothing else went over it.
    expect(s.connects).toEqual(['ssh', 'admin'])
    expect(s.operations).toEqual(['admin update-receive'])
    expect(s.manager.get().hosts[0]).toMatchObject({ phase: 'connected', via: 'tailnet', version: NEW })
  })

  it('updates over SSH, as before, a host whose hello does not offer the route', async () => {
    const s = await scene()
    // The desktop's grant is taken away, so the host offers it no update; a new connect hears that in its hello.
    await deny(s)
    await s.relaunch()
    expect(s.connects).toEqual(['ssh'])
    const panel = s.updatePanel()
    expect(await panel.run()).toMatchObject({ phase: 'done', from: NEW, route: 'host' })
    expect(s.operations).toEqual(['admin update-fetch', 'admin update-install', 'admin update-restart'])
    expect(s.connects).toEqual(['ssh', 'admin'])
    expect(s.manager.get().hosts[0]).toMatchObject({ phase: 'connected', via: 'tailnet', version: NEW })
  })

  it('goes over SSH when the host refuses the route it offered, as after --deny-answers', async () => {
    const s = await scene()
    // Taken away after this connection's hello listed it: the host refuses each step, and each goes over SSH instead.
    await deny(s)
    const panel = s.updatePanel()
    expect(await panel.run()).toMatchObject({ phase: 'done', from: NEW, route: 'host' })
    expect(s.operations).toEqual(['admin update-fetch', 'admin update-install', 'admin update-restart'])
    expect(s.connects).toEqual(['ssh', 'admin'])
    expect(s.manager.get().hosts[0]).toMatchObject({ phase: 'connected', via: 'tailnet', version: NEW })
  })
})
