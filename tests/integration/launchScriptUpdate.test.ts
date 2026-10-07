// @vitest-environment node
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { HOST_ARCHIVE_LIMIT_BYTES, HOST_DOWNLOAD_TIMEOUT_MS, HOST_STOP_DRAIN_MS, LAUNCH_SCRIPT_SOURCE, NODE_CHECK_SOURCE, NODE_PROBE_SOURCE, RECEIVE_SCRIPT_SOURCE, type LaunchOperation } from '../../src/main/hosts/launchScript'
import { hostRelease, localArchiveName, releasesPage, sha256, sidecar, tarGz } from '../fixtures/hostArchive'

/**
 * The launch script's host update (ADR-0040), run as the desktop runs it, against a flat install of the fake host and a
 * stand-in releases page: download and check, install beside the running version, and restart into it, or back.
 */
// These run the launch script with its own budgets: a stop may drain for HOST_STOP_DRAIN_MS and a start may take up to
// readyTimeoutMs, and one test restarts three times. The deadline covers them; a run that is not stuck never reaches it.
vi.setConfig({ testTimeout: 3 * (HOST_STOP_DRAIN_MS + 30_000) + 30_000 })
const directories: string[] = [], children: ChildProcess[] = [], hosts: number[] = [], pages: { close(): Promise<void> }[] = []
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill()
  for (const pid of hosts.splice(0)) { try { process.kill(pid, 'SIGTERM') } catch { /* already exited */ } }
  for (const page of pages.splice(0)) await page.close()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})
const HOST_ID = '11111111-1111-4111-8111-111111111111'
const NEW = '9.9.9'
const FILE = localArchiveName(NEW)
const fakeHost = (): Promise<string> => readFile(resolve('tests/fixtures/fakeSshHost.mjs'), 'utf8')
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-host-update-')); directories.push(directory)
  const installPath = join(directory, "installed host's $(literal)")
  await mkdir(join(installPath, 'host'), { recursive: true })
  await writeFile(join(installPath, 'package.json'), JSON.stringify({ version: '1.0.0', type: 'module' }))
  await copyFile(resolve('tests/fixtures/fakeSshHost.mjs'), join(installPath, 'host/index.js'))
  return { directory, installPath, dataDirectory: join(directory, 'data'), remotePort: 0, readyTimeoutMs: 30_000, stopDrainMs: HOST_STOP_DRAIN_MS,
    downloadTimeoutMs: HOST_DOWNLOAD_TIMEOUT_MS, archiveLimit: HOST_ARCHIVE_LIMIT_BYTES }
}
type Configuration = Awaited<ReturnType<typeof fixture>>
interface Outcome { readonly messages: Record<string, unknown>[]; readonly code: number | null; readonly errors: string }
function collect(child: ChildProcess): Promise<Outcome> {
  let output = '', errors = ''
  child.stdout!.on('data', chunk => { output += String(chunk) })
  child.stderr!.on('data', chunk => { errors += String(chunk) })
  return new Promise(resolve => child.once('close', code => resolve({ code, errors,
    messages: output.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line) as Record<string, unknown>) })))
}
function run(configuration: Configuration, operation: LaunchOperation | Record<string, unknown>): Promise<Outcome> {
  const child = spawn(process.execPath, ['--input-type=commonjs', '-', JSON.stringify({ ...configuration, ...operation })], { shell: false, windowsHide: true })
  children.push(child)
  child.stdin.end(LAUNCH_SCRIPT_SOURCE)
  return collect(child)
}
/** The receive script as the probe runs it: `node -e`, with the archive on stdin. */
function receive(configuration: Configuration, file: string, bytes: Uint8Array, size = bytes.byteLength): Promise<Outcome> {
  const child = spawn(process.execPath, ['-e', RECEIVE_SCRIPT_SOURCE, JSON.stringify({ ...configuration, op: 'update-receive', file, size })], { shell: false, windowsHide: true })
  children.push(child)
  child.stdin.end(bytes)
  return collect(child)
}
const last = (outcome: Outcome): Record<string, unknown> => outcome.messages.at(-1)!
async function launch(configuration: Configuration): Promise<Record<string, unknown>> {
  const ready = last(await run(configuration, { op: 'launch' }))
  if (typeof ready.pid === 'number') hosts.push(ready.pid)
  return ready
}
const descriptor = async (configuration: Configuration): Promise<{ pid: number; entry: string }> =>
  JSON.parse(await readFile(join(configuration.dataDirectory, 'host-listener.json'), 'utf8')) as { pid: number; entry: string }
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
const pointer = (configuration: Configuration): Promise<string | null> => readFile(join(configuration.installPath, 'current'), 'utf8').catch(() => null)
/** A releases page with `archive` published as `NEW` for this machine, and its sidecar unless another is given. */
async function publish(archive: Uint8Array, sum = sidecar(archive, FILE)): Promise<string> {
  const page = await releasesPage(new Map<string, Uint8Array | string>([[`/v${NEW}/${FILE}`, archive], [`/v${NEW}/${FILE}.sha256`, sum]]))
  pages.push(page)
  return page.url
}

it('downloads, checks and installs a version beside a flat install, then restarts into it and keeps the old one', async () => {
  const configuration = await fixture()
  const old = await launch(configuration)
  const archive = tarGz(hostRelease(NEW, await fakeHost()))
  const releasesUrl = await publish(archive)

  const fetched = await run(configuration, { op: 'update-fetch', version: NEW, releasesUrl })
  // The host says when the download is in and the checksum is next.
  expect(fetched.messages).toEqual([{ type: 'update-step', step: 'check' }, { type: 'update-fetched', file: FILE, sha256: sha256(archive) }])
  const installed = await run(configuration, { op: 'update-install', version: NEW, file: FILE, sha256: sha256(archive) })
  expect(installed.messages).toEqual([{ type: 'update-step', step: 'install' }, { type: 'update-installed', version: NEW }])
  // Beside the running version, which still starts from the flat install until the restart.
  expect(JSON.parse(await readFile(join(configuration.installPath, 'versions', NEW, 'package.json'), 'utf8'))).toMatchObject({ version: NEW })
  expect(await readdir(join(configuration.installPath, 'versions', '.incoming'))).toEqual([])
  expect(await pointer(configuration)).toBeNull()
  expect(alive(old.pid as number)).toBe(true)

  const restarted = await run(configuration, { op: 'update-restart', hostId: HOST_ID, version: NEW })
  const ready = last(restarted)
  hosts.push(ready.pid as number)
  expect(restarted.messages[0]).toEqual({ type: 'update-step', step: 'restart' })
  expect(ready).toMatchObject({ type: 'ready', owned: true, hostId: HOST_ID })
  expect(ready.pid).not.toBe(old.pid)
  expect(alive(old.pid as number)).toBe(false)
  expect(await pointer(configuration)).toBe(`${NEW}\n`)
  expect((await descriptor(configuration)).entry).toBe(join(configuration.installPath, 'versions', NEW, 'host', 'index.js'))
  // The flat install stays where it was, and a later connect finds the new host.
  await expect(readFile(join(configuration.installPath, 'host', 'index.js'), 'utf8')).resolves.toBeTruthy()
  expect(await launch(configuration)).toMatchObject({ owned: true, pid: ready.pid })
  // No update lock is left behind.
  expect(await readdir(join(configuration.installPath, 'versions'))).toEqual(expect.not.arrayContaining(['.update-lock']))
})

it('starts the old version again, and points back at it, when the new one does not start', async () => {
  const configuration = await fixture()
  await launch(configuration)
  const archive = tarGz(hostRelease(NEW, 'process.exit(1)\n'))
  const releasesUrl = await publish(archive)
  expect(last(await run(configuration, { op: 'update-fetch', version: NEW, releasesUrl }))).toMatchObject({ type: 'update-fetched' })
  expect(last(await run(configuration, { op: 'update-install', version: NEW, file: FILE, sha256: sha256(archive) }))).toMatchObject({ type: 'update-installed' })
  const restarted = last(await run(configuration, { op: 'update-restart', hostId: HOST_ID, version: NEW }))
  expect(restarted).toEqual({ type: 'error', reason: 'update-start-failed', restarted: true, cause: 'host-start-failed' })
  const running = await descriptor(configuration)
  hosts.push(running.pid)
  expect(alive(running.pid)).toBe(true)
  expect(running.entry).toBe(join(configuration.installPath, 'host', 'index.js'))
  // A flat install has no pointer, and none is left pointing at the version that failed.
  expect(await pointer(configuration)).toBeNull()
})

it('restarts from one installed version to the next and keeps only the running one and the one before it', async () => {
  const configuration = await fixture()
  await launch(configuration)
  const entry = await fakeHost()
  for (const version of ['9.9.7', '9.9.8', NEW]) {
    const file = localArchiveName(version), archive = tarGz(hostRelease(version, entry))
    const page = await releasesPage(new Map<string, Uint8Array | string>([[`/v${version}/${file}`, archive], [`/v${version}/${file}.sha256`, sidecar(archive, file)]]))
    pages.push(page)
    expect(last(await run(configuration, { op: 'update-fetch', version, releasesUrl: page.url }))).toMatchObject({ type: 'update-fetched' })
    expect(last(await run(configuration, { op: 'update-install', version, file, sha256: sha256(archive) }))).toMatchObject({ type: 'update-installed' })
    const ready = last(await run(configuration, { op: 'update-restart', hostId: HOST_ID, version }))
    expect(ready, `Restart ${version}: ${JSON.stringify(ready)}`).toMatchObject({ type: 'ready', owned: true })
    hosts.push(ready.pid as number)
  }
  expect((await readdir(join(configuration.installPath, 'versions'))).filter(name => /^\d/u.test(name)).sort()).toEqual(['9.9.8', NEW])
  expect(await pointer(configuration)).toBe(`${NEW}\n`)
})

it.skipIf(process.platform !== 'win32').each(['EPERM', 'EBUSY'])('the fake host publishes its descriptor after temporary %s rename failures', async code => {
  const configuration = await fixture()
  const preload = join(configuration.directory, 'descriptor-rename.mjs')
  const descriptorPath = join(configuration.dataDirectory, 'host-listener.json')
  const proof = join(configuration.directory, 'rename-attempts.json')
  // Inject the reader's temporary Windows lock into the real copied fixture's fs boundary.
  await writeFile(preload, `import fs from 'node:fs/promises'
const rename = fs.rename.bind(fs)
let attempts = 0
fs.rename = async (from, to) => {
  if (to === ${JSON.stringify(descriptorPath)}) {
    await fs.writeFile(${JSON.stringify(proof)}, JSON.stringify(++attempts))
    if (attempts <= 2) throw Object.assign(new Error('Synthetic reader holds the descriptor'), { code: ${JSON.stringify(code)} })
  }
  return rename(from, to)
}
`)
  const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, join(configuration.installPath, 'host/index.js'), '--data', configuration.dataDirectory, '--port', '0'], { shell: false, windowsHide: true })
  children.push(child)
  await expect.poll(() => descriptor(configuration).catch(() => null)).toMatchObject({ pid: child.pid })
  expect(JSON.parse(await readFile(proof, 'utf8'))).toBeGreaterThanOrEqual(3)
  await expect(readFile(`${descriptorPath}.tmp`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
})

it('deletes a download whose checksum does not match the release, and installs nothing', async () => {
  const configuration = await fixture()
  const archive = tarGz(hostRelease(NEW, await fakeHost()))
  const releasesUrl = await publish(archive, `${'0'.repeat(64)}  ${FILE}\n`)
  const fetched = await run(configuration, { op: 'update-fetch', version: NEW, releasesUrl })
  expect(last(fetched)).toEqual({ type: 'error', reason: 'checksum-mismatch', file: FILE })
  expect(await readdir(join(configuration.installPath, 'versions')).catch(() => [])).toEqual([])
})

it('says the releases page could not be reached, or has no archive for this machine, naming the archive it asked for', async () => {
  const configuration = await fixture()
  expect(last(await run(configuration, { op: 'update-fetch', version: NEW, releasesUrl: 'http://127.0.0.1:1' })))
    .toEqual({ type: 'error', reason: 'download-unreachable', file: FILE })
  const empty = await releasesPage(new Map()); pages.push(empty)
  expect(last(await run(configuration, { op: 'update-fetch', version: NEW, releasesUrl: empty.url }))).toEqual({ type: 'error', reason: 'archive-unavailable', file: FILE })
})

it('takes an archive copied over SSH, then checks it against the checksum it is given before unpacking it', async () => {
  const configuration = await fixture()
  const archive = tarGz(hostRelease(NEW, await fakeHost()))
  // A copy cut short leaves nothing behind.
  expect(last(await receive(configuration, FILE, archive.subarray(0, 100), archive.byteLength))).toEqual({ type: 'error', reason: 'copy-incomplete' })
  expect(await readdir(join(configuration.installPath, 'versions', '.incoming'))).toEqual([])
  expect(last(await receive(configuration, FILE, archive))).toEqual({ type: 'update-received', size: archive.byteLength })
  // A checksum that does not match deletes the copy.
  expect(last(await run(configuration, { op: 'update-install', version: NEW, file: FILE, sha256: 'f'.repeat(64) }))).toEqual({ type: 'error', reason: 'checksum-mismatch' })
  expect(await readdir(join(configuration.installPath, 'versions', '.incoming'))).toEqual([])
  expect(last(await receive(configuration, FILE, archive))).toMatchObject({ type: 'update-received' })
  expect(last(await run(configuration, { op: 'update-install', version: NEW, file: FILE, sha256: sha256(archive) }))).toEqual({ type: 'update-installed', version: NEW })
  // The receive script takes only an archive name, never a path.
  expect(last(await receive(configuration, '../escape.tar.gz', archive))).toEqual({ type: 'error', reason: 'update-invalid' })
})

it('refuses an archive that is not the release it was asked for, or needs another Node, and keeps no half-unpacked folder', async () => {
  const configuration = await fixture()
  for (const [files, reason] of [[hostRelease('9.9.8', 'export {}'), 'archive-invalid'], [hostRelease(NEW, 'export {}', { nodeRange: '>=99 <100' }), 'node-unsupported']] as const) {
    const archive = tarGz(files)
    expect(last(await receive(configuration, FILE, archive))).toMatchObject({ type: 'update-received' })
    const installed = last(await run(configuration, { op: 'update-install', version: NEW, file: FILE, sha256: sha256(archive) }))
    expect(installed).toMatchObject({ type: 'error', reason })
    if (reason === 'node-unsupported') expect(installed).toMatchObject({ range: '>=99 <100', node: process.versions.node })
    expect((await readdir(join(configuration.installPath, 'versions'))).filter(name => name !== '.incoming')).toEqual([])
  }
})

it('installs and restarts one update at a time in a folder, and takes over a lock whose process has gone', async () => {
  const configuration = await fixture()
  const install = { op: 'update-install', version: NEW, file: FILE, sha256: 'a'.repeat(64) }
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: 'ignore', windowsHide: true })
  children.push(holder)
  await new Promise(resolve => holder.once('spawn', resolve))
  await mkdir(join(configuration.installPath, 'versions', '.update-lock'), { recursive: true })
  await writeFile(join(configuration.installPath, 'versions', '.update-lock', 'pid'), String(holder.pid))
  expect(last(await run(configuration, install))).toEqual({ type: 'error', reason: 'update-busy' })
  expect(last(await run(configuration, { op: 'update-restart', hostId: HOST_ID, version: NEW }))).toEqual({ type: 'error', reason: 'update-busy' })
  holder.kill()
  await vi.waitFor(() => expect(alive(holder.pid!)).toBe(false))
  expect(last(await run(configuration, install))).toEqual({ type: 'error', reason: 'update-missing' })
})

it('downloads without the lock, so a cancelled download still finishing never holds up the next update', async () => {
  const configuration = await fixture()
  // A releases page that never answers: the download waits, as one does after Cancel update until it notices.
  const silent = createServer(() => undefined)
  await new Promise<void>(done => silent.listen(0, '127.0.0.1', done))
  pages.push({ close: () => new Promise(done => { silent.closeAllConnections(); silent.close(() => done()) }) })
  const pending = run(configuration, { op: 'update-fetch', version: NEW, releasesUrl: `http://127.0.0.1:${(silent.address() as { port: number }).port}` })
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(last(await run(configuration, { op: 'update-install', version: NEW, file: FILE, sha256: 'a'.repeat(64) }))).toEqual({ type: 'error', reason: 'update-missing' })
  for (const child of children) if (child.exitCode === null) child.kill()
  await pending
})

it('says another program has the host\'s port when a host with a gone process left its record and cannot start', async () => {
  const configuration = await fixture()
  const taken = createServer(() => undefined)
  await new Promise<void>(done => taken.listen(0, '127.0.0.1', done))
  pages.push({ close: () => new Promise(done => taken.close(() => done())) })
  const port = (taken.address() as { port: number }).port
  await mkdir(configuration.dataDirectory, { recursive: true })
  // The record of a host that has gone, on the fixed port another program now listens on.
  const gone = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true })
  await new Promise(resolve => gone.once('exit', resolve))
  await writeFile(join(configuration.dataDirectory, 'host-listener.json'), JSON.stringify({ v: 1, hostId: HOST_ID, pid: gone.pid, port }))
  const outcome = await run({ ...configuration, remotePort: port }, { op: 'launch' })
  expect(last(outcome)).toEqual({ type: 'error', reason: 'port-taken' })
})

it('never restarts a host it did not start, and leaves it running', async () => {
  const configuration = await fixture()
  const existing = spawn(process.execPath, [join(configuration.installPath, 'host/index.js'), '--data', configuration.dataDirectory, '--port', '0'], { shell: false, windowsHide: true })
  children.push(existing)
  await vi.waitFor(async () => expect((await descriptor(configuration)).pid).toBe(existing.pid))
  const archive = tarGz(hostRelease(NEW, await fakeHost()))
  expect(last(await receive(configuration, FILE, archive))).toMatchObject({ type: 'update-received' })
  expect(last(await run(configuration, { op: 'update-install', version: NEW, file: FILE, sha256: sha256(archive) }))).toMatchObject({ type: 'update-installed' })
  expect(last(await run(configuration, { op: 'update-restart', hostId: HOST_ID, version: NEW }))).toEqual({ type: 'error', reason: 'update-not-owned' })
  expect(existing.exitCode).toBeNull()
  expect(await pointer(configuration)).toBeNull()
})

it('starts the version current names, falls back to a flat install without one, and checks Node against its manifest', async () => {
  const configuration = await fixture()
  await mkdir(join(configuration.installPath, 'versions', NEW, 'host'), { recursive: true })
  await writeFile(join(configuration.installPath, 'versions', NEW, 'package.json'), JSON.stringify({ version: NEW, type: 'module' }))
  await copyFile(resolve('tests/fixtures/fakeSshHost.mjs'), join(configuration.installPath, 'versions', NEW, 'host', 'index.js'))
  // A pointer at a version that is not installed is ignored.
  await writeFile(join(configuration.installPath, 'current'), '9.9.1\n')
  const flat = await launch(configuration)
  expect((await descriptor(configuration)).entry).toBe(join(configuration.installPath, 'host', 'index.js'))
  process.kill(flat.pid as number, 'SIGTERM')
  await vi.waitFor(() => expect(alive(flat.pid as number)).toBe(false))
  await writeFile(join(configuration.installPath, 'current'), `${NEW}\n`)
  await launch(configuration)
  expect((await descriptor(configuration)).entry).toBe(join(configuration.installPath, 'versions', NEW, 'host', 'index.js'))
  // The Node check reads the running version's manifest, not the flat install's.
  const major = Number(process.versions.node.split('.')[0])
  await writeFile(join(configuration.installPath, 'runtime-manifest.json'), JSON.stringify({ node: `>=${major} <${major + 1}` }))
  await writeFile(join(configuration.installPath, 'versions', NEW, 'runtime-manifest.json'), JSON.stringify({ node: '>=99 <100' }))
  expect(spawnSync(process.execPath, ['-e', NODE_CHECK_SOURCE, JSON.stringify({ installPath: configuration.installPath })], { encoding: 'utf8', windowsHide: true })).toMatchObject({ status: 3 })
})

it.skipIf(process.platform === 'win32')('runs the receive script through the Node probe, with the archive on stdin', async () => {
  const configuration = await fixture()
  const archive = tarGz(hostRelease(NEW, await fakeHost()))
  const major = Number(process.versions.node.split('.')[0])
  const child = spawn('/bin/sh', ['-c', NODE_PROBE_SOURCE, 'sotto-launch', JSON.stringify({ ...configuration, op: 'update-receive', file: FILE, size: archive.byteLength, nodeRange: `>=${major} <${major + 1}` }), NODE_CHECK_SOURCE, RECEIVE_SCRIPT_SOURCE],
    { env: { ...process.env, PATH: `${resolve(process.execPath, '..')}:${process.env.PATH ?? ''}` } })
  children.push(child)
  child.stdin.end(archive)
  expect((await collect(child)).messages).toEqual([{ type: 'signed-in' }, { type: 'update-received', size: archive.byteLength }])
  expect(sha256(await readFile(join(configuration.installPath, 'versions', '.incoming', FILE)))).toBe(sha256(archive))
})
