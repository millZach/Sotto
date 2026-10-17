// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { collectLaunchScript as collect, launchScriptChild } from '../fixtures/launchScriptRunner'
import { hostRelease, localArchiveName, releasesPage, sha256, sidecar, tarGz } from '../fixtures/hostArchive'
import { buildSelfUpdatingHost, installSelfUpdatingHost, stopEverythingIn } from '../fixtures/selfUpdatingHostBuild'
import { rawPeer } from '../fixtures/rawHostPeer'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { hostLaunchTimings, HOST_STOP_DRAIN_MS, HOST_READY_TIMEOUT_MS } from '../../src/shared/hostLaunchTimings'
import type { SocketFrames } from '../../src/host/socketFrames'

/**
 * A host that updates itself when a paired desktop asks over its socket (ADR-0088), end to end: the real headless host,
 * built from this checkout into a release's layout and started the way the launch script starts it, paired and recorded as
 * a desktop the way an SSH connect does, then updated over its socket from a stand-in releases page, with no ssh at all.
 */
// A restart drains the old host for up to HOST_STOP_DRAIN_MS and waits for the new one for up to its ready timeout, and a
// rollback starts once more. A run that is not stuck never reaches this.
vi.setConfig({ testTimeout: HOST_STOP_DRAIN_MS + 3 * HOST_READY_TIMEOUT_MS + 60_000 })
const OLD = '9.9.8', NEW = '9.9.9', FILE = localArchiveName(NEW)
let built: { readonly directory: string; readonly source: string } | undefined
const roots: string[] = [], pages: { close(): Promise<void> }[] = [], raws: SocketFrames[] = [], children: ChildProcess[] = []

beforeAll(async () => { built = await buildSelfUpdatingHost() }, 180_000)
afterAll(async () => { if (built) await rm(built.directory, { recursive: true, force: true }) })

afterEach(async () => {
  for (const frames of raws.splice(0)) frames.close()
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL')
  for (const page of pages.splice(0)) await page.close()
  for (const root of roots.splice(0)) {
    await stopEverythingIn(root)
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined)
  }
})

/** forge's host as an SSH launch leaves it: a flat install of `OLD`, started by the launch script, with ssh on its path recording any use. */
async function installedHost(publish: Map<string, Uint8Array | string>, hold?: Parameters<typeof releasesPage>[2]) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-self-update-')); roots.push(root)
  const { install, data, sshUsed, env: installEnv } = await installSelfUpdatingHost(root, built!.directory, OLD)
  const page = await releasesPage(publish, 0, hold); pages.push(page)
  const env = { ...installEnv, SOTTO_TEST_HOST_RELEASES_URL: page.url }
  const configuration = { installPath: install, dataDirectory: data, remotePort: 0, ...hostLaunchTimings() }
  const script = async (operation: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const outcome = await collect(launchScriptChild({ ...configuration, ...operation }, env, child => children.push(child)))
    return outcome.messages.at(-1)!
  }
  const ready = await script({ op: 'launch' })
  expect(ready, JSON.stringify(ready)).toMatchObject({ type: 'ready', owned: true, startedBy: 'launch-script' })
  const hostId = ready.hostId as string
  // Paired and recorded as a desktop, with its default grant, as every SSH connect does.
  const code = await script({ op: 'pairing-code', hostId })
  const paired = await SocketHostService.pair(`http://127.0.0.1:${ready.port as number}`, code.code as string, 'Sotto desktop')
  expect(await script({ op: 'desktop-answers', hostId, clientId: paired.clientId })).toMatchObject({ type: 'desktop-answers' })
  return { root, install, data, page, hostId, paired, ready, sshUsed, script }
}
/** A socket to whichever host now answers in the data folder, with its hello accepting host updates. */
async function connect(data: string, token: string) {
  const descriptor = JSON.parse(await readFile(join(data, 'host-listener.json'), 'utf8')) as { port: number; pid: number }
  const response = await fetch(`http://127.0.0.1:${descriptor.port}/v1/session`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
  const { session } = await response.json() as { session: string }
  const peer = await rawPeer(descriptor.port, session); raws.push(peer.frames)
  const hello = await peer.call('hello', { op: 'hello', accepts: ['host-update'] })
  const steps = (): unknown[] => peer.messages.filter(message => message.event === 'host-update-step').map(message => message.step)
  let calls = 0
  // A download, an unpack or a restart's checks can take a while on a busy machine; the answer is waited for generously.
  const update = async (request: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const id = `update-${++calls}`
    peer.frames.send({ v: 1, id, session, op: 'host-update', ...request })
    await vi.waitFor(() => expect(peer.messages.some(message => message.id === id)).toBe(true), { timeout: HOST_STOP_DRAIN_MS + 2 * HOST_READY_TIMEOUT_MS, interval: 50 })
    const reply = peer.messages.find(message => message.id === id)!
    expect(reply, JSON.stringify(reply)).toMatchObject({ ok: true })
    return reply.result as Record<string, unknown>
  }
  return { ...peer, session, descriptor, hello: hello.result as { features: string[]; sottoVersion: string }, steps, update }
}
/** The host now holding the data folder, once one other than `pid` answers its health. */
async function nextHost(data: string, pid: number): Promise<{ pid: number; port: number; sottoVersion: string }> {
  let found: { pid: number; port: number; sottoVersion: string } | undefined
  await vi.waitFor(async () => {
    const descriptor = JSON.parse(await readFile(join(data, 'host-listener.json'), 'utf8')) as { pid: number; port: number }
    expect(descriptor.pid).not.toBe(pid)
    found = await (await fetch(`http://127.0.0.1:${descriptor.port}/v1/health`)).json() as { pid: number; port: number; sottoVersion: string }
    expect(found.pid).toBe(descriptor.pid)
  }, { timeout: HOST_STOP_DRAIN_MS + 2 * HOST_READY_TIMEOUT_MS, interval: 200 })
  return found!
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
const published = (entry: string): Map<string, Uint8Array | string> => {
  const archive = tarGz(hostRelease(NEW, entry, { commonjs: true }))
  return new Map<string, Uint8Array | string>([[`/v${NEW}/${FILE}`, archive], [`/v${NEW}/${FILE}.sha256`, sidecar(archive, FILE)]])
}

it('downloads, installs and restarts into a newer release over its socket with no ssh, and says how it went once it is back', async () => {
  const files = published(built!.source)
  const host = await installedHost(files)
  const desktop = await connect(host.data, host.paired.token)
  expect(desktop.hello).toMatchObject({ sottoVersion: OLD, features: expect.arrayContaining(['host-update']) })

  const fetched = await desktop.update({ action: 'fetch', version: NEW })
  expect(fetched).toEqual({ type: 'update-fetched', file: FILE, sha256: sha256(files.get(`/v${NEW}/${FILE}`) as Uint8Array) })
  expect(host.page.requests).toEqual([`/v${NEW}/${FILE}`, `/v${NEW}/${FILE}.sha256`])
  expect(await desktop.update({ action: 'install', version: NEW, file: fetched.file, sha256: fetched.sha256 })).toEqual({ type: 'update-installed', version: NEW })
  expect(await desktop.update({ action: 'restart', version: NEW })).toEqual({ type: 'update-restarting', version: NEW })
  expect(desktop.steps()).toEqual(['download', 'check', 'install', 'restart'])

  const next = await nextHost(host.data, host.ready.pid as number)
  expect(next.sottoVersion).toBe(NEW)
  await vi.waitFor(() => expect(alive(host.ready.pid as number)).toBe(false))
  expect((await readFile(join(host.install, 'current'), 'utf8')).trim()).toBe(NEW)
  // The same pairing reaches the new host, which says what happened.
  const again = await connect(host.data, host.paired.token)
  expect(again.hello.sottoVersion).toBe(NEW)
  await vi.waitFor(async () => expect(await again.update({ action: 'outcome' })).toEqual({ type: 'update-outcome', running: NEW,
    restart: { state: 'finished', version: NEW, attempt: expect.stringMatching(/^[a-f0-9]{16}$/u), result: { type: 'ready', hostId: host.hostId, pid: next.pid } } }), { timeout: 10_000 })
  // It runs the newer release now, so the same version is refused rather than installed again.
  expect(await again.update({ action: 'fetch', version: NEW })).toEqual({ type: 'error', reason: 'update-invalid' })
  await expect(readFile(host.sshUsed)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readdir(join(host.install, 'versions'))).toEqual(expect.not.arrayContaining(['.update-lock']))
})

it('starts the old version again when the new one will not start, and says so through outcome', async () => {
  const host = await installedHost(published('process.exit(1)\n'))
  const desktop = await connect(host.data, host.paired.token)
  const fetched = await desktop.update({ action: 'fetch', version: NEW })
  expect(await desktop.update({ action: 'install', version: NEW, file: fetched.file, sha256: fetched.sha256 })).toMatchObject({ type: 'update-installed' })
  expect(await desktop.update({ action: 'restart', version: NEW })).toEqual({ type: 'update-restarting', version: NEW })
  const back = await nextHost(host.data, host.ready.pid as number)
  expect(back.sottoVersion).toBe(OLD)
  const again = await connect(host.data, host.paired.token)
  await vi.waitFor(async () => expect(await again.update({ action: 'outcome' })).toEqual({ type: 'update-outcome', running: OLD,
    restart: { state: 'finished', version: NEW, attempt: expect.stringMatching(/^[a-f0-9]{16}$/u), result: { type: 'error', reason: 'update-start-failed', restarted: true, cause: 'host-start-failed' } } }), { timeout: 10_000 })
  await expect(readFile(join(host.install, 'current'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('refuses with update-busy while another update holds the installation folder, as an SSH update and a socket one refuse each other', async () => {
  const files = published(built!.source)
  const host = await installedHost(files)
  const desktop = await connect(host.data, host.paired.token)
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: 'ignore', windowsHide: true }); children.push(holder)
  await new Promise(done => holder.once('spawn', done))
  const lock = join(host.install, 'versions', '.update-lock')
  await mkdir(lock, { recursive: true }); await writeFile(join(lock, 'pid'), String(holder.pid))
  // The version is there to restart into, so only the lock stands in the way.
  await mkdir(join(host.install, 'versions', NEW, 'host'), { recursive: true }); await writeFile(join(host.install, 'versions', NEW, 'host', 'index.js'), '')
  const archive = files.get(`/v${NEW}/${FILE}`) as Uint8Array
  expect(await desktop.update({ action: 'fetch', version: NEW })).toEqual({ type: 'error', reason: 'update-busy' })
  expect(await desktop.update({ action: 'install', version: NEW, file: FILE, sha256: sha256(archive) })).toEqual({ type: 'error', reason: 'update-busy' })
  expect(await desktop.update({ action: 'restart', version: NEW })).toEqual({ type: 'error', reason: 'update-busy' })
  expect(alive(host.ready.pid as number)).toBe(true)
  // And the other way: an SSH install refuses while this host's own install holds the lock.
  holder.kill(); await vi.waitFor(() => expect(alive(holder.pid!)).toBe(false))
  await rm(lock, { recursive: true, force: true }); await rm(join(host.install, 'versions', NEW), { recursive: true, force: true })
  expect(await desktop.update({ action: 'fetch', version: NEW })).toMatchObject({ type: 'update-fetched' })
  expect(await desktop.update({ action: 'install', version: NEW, file: FILE, sha256: sha256(archive) })).toEqual({ type: 'update-installed', version: NEW })
  await mkdir(lock); await writeFile(join(lock, 'pid'), String(host.ready.pid))
  expect(await host.script({ op: 'update-install', version: NEW, file: FILE, sha256: sha256(archive) })).toEqual({ type: 'error', reason: 'update-busy' })
})

it('ends a download when the desktop that asked for it goes, and refuses a second one while it runs', async () => {
  let first = true
  const never = new Promise<void>(() => undefined)
  // The first download of the archive is held for as long as the test runs; any later one is answered at once.
  const host = await installedHost(published(built!.source), request => { if (request.path.endsWith('.tar.gz') && first) { first = false; return never } return undefined })
  const leaving = await connect(host.data, host.paired.token)
  const staying = await connect(host.data, host.paired.token)
  leaving.frames.send({ v: 1, id: 'held', session: leaving.session, op: 'host-update', action: 'fetch', version: NEW })
  await vi.waitFor(() => expect(host.page.requests).toContain(`/v${NEW}/${FILE}`))
  expect(leaving.steps()).toEqual(['download'])
  expect(await staying.update({ action: 'fetch', version: NEW })).toEqual({ type: 'error', reason: 'update-busy' })
  // The download holds the installation folder's update lock, so a download or an install over SSH waits its turn too.
  expect(await host.script({ op: 'update-fetch', version: NEW, releasesUrl: host.page.url })).toEqual({ type: 'error', reason: 'update-busy' })
  expect(await host.script({ op: 'update-install', version: NEW, file: FILE, sha256: 'a'.repeat(64) })).toEqual({ type: 'error', reason: 'update-busy' })
  // Only the desktop that asked may cancel it.
  expect(await staying.update({ action: 'cancel' })).toEqual({ type: 'update-cancelled', cancelled: false })
  leaving.frames.close()
  // The held download was ended with its desktop's socket: the next one is not refused as busy, and finishes.
  await vi.waitFor(async () => expect(await staying.update({ action: 'fetch', version: NEW })).toMatchObject({ type: 'update-fetched', file: FILE }), { timeout: 20_000, interval: 250 })
})

it('finishes an install whose desktop went partway', async () => {
  const files = published(built!.source)
  const host = await installedHost(files)
  const desktop = await connect(host.data, host.paired.token)
  const fetched = await desktop.update({ action: 'fetch', version: NEW })
  desktop.frames.send({ v: 1, id: 'install', session: desktop.session, op: 'host-update', action: 'install', version: NEW, file: fetched.file, sha256: fetched.sha256 })
  desktop.frames.close()
  await vi.waitFor(async () => expect(JSON.parse(await readFile(join(host.install, 'versions', NEW, 'package.json'), 'utf8'))).toMatchObject({ version: NEW }), { timeout: 30_000, interval: 200 })
  await vi.waitFor(async () => expect(await readdir(join(host.install, 'versions'))).toEqual(expect.not.arrayContaining(['.update-lock', `${NEW}.partial`])))
  // The host is free for the next step, and still runs the old version until it is restarted.
  const again = await connect(host.data, host.paired.token)
  expect(await again.update({ action: 'install', version: NEW, file: fetched.file, sha256: fetched.sha256 })).toMatchObject({ type: 'error', reason: 'update-missing' })
  expect(alive(host.ready.pid as number)).toBe(true)
})
