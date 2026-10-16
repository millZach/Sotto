// @vitest-environment node
import { collectLaunchScript as collect, launchScriptChild, type LaunchScriptOutcome as Outcome } from '../fixtures/launchScriptRunner'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { describe, afterEach, expect, it, vi } from 'vitest'
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

function run(configuration: Configuration, operation: LaunchOperation | Record<string, unknown>): Promise<Outcome> {
  const child = launchScriptChild({ ...configuration, ...operation }, undefined, child => children.push(child))
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

it('receives and installs a full Owl archive, reuses identical retries and never replaces different published version files', async () => {
  const configuration = await fixture(), version = '9.9.9-owl.20261012.10', file = localArchiveName(version)
  const entry = await fakeHost(), archive = tarGz(hostRelease(version, entry))
  const install = () => run(configuration, { op: 'update-install', version, file, sha256: sha256(archive) })
  expect(last(await receive(configuration, file, archive))).toMatchObject({ type: 'update-received' })
  expect(last(await install())).toMatchObject({ type: 'update-installed', version })
  expect(last(await receive(configuration, file, archive))).toMatchObject({ type: 'update-received' })
  expect(last(await install())).toMatchObject({ type: 'update-installed', version })
  const changed = tarGz(hostRelease(version, 'changed build under published version'))
  expect(last(await receive(configuration, file, changed))).toMatchObject({ type: 'update-received' })
  expect(last(await run(configuration, { op: 'update-install', version, file, sha256: sha256(changed) }))).toMatchObject({ type: 'error', reason: 'update-version-conflict' })
  expect(await readFile(join(configuration.installPath, 'versions', version, 'host', 'index.js'), 'utf8')).toBe(entry)
  await writeFile(join(configuration.installPath, 'current'), version + '\n')
  const ready = await launch(configuration)
  expect(ready).toMatchObject({ type: 'ready', owned: true })
  expect((await descriptor(configuration)).entry).toContain(version)
  // A pointer at a running version cannot bypass the same-build check.
  expect(last(await receive(configuration, file, changed))).toMatchObject({ type: 'update-received' })
  expect(last(await run(configuration, { op: 'update-install', version, file, sha256: sha256(changed) }))).toMatchObject({ type: 'error', reason: 'update-version-conflict' })
  expect(alive(ready.pid as number)).toBe(true)
  expect(await pointer(configuration)).toBe(version + '\n')
  expect(await readFile(join(configuration.installPath, 'versions', version, 'host', 'index.js'), 'utf8')).toBe(entry)
  await writeFile(join(configuration.installPath, 'versions', version, 'runtime-manifest.json'), JSON.stringify({ sottoVersion: version, node: '>=99 <100' }))
  expect(spawnSync(process.execPath, ['-e', NODE_CHECK_SOURCE, JSON.stringify({ installPath: configuration.installPath })], { encoding: 'utf8', windowsHide: true })).toMatchObject({ status: 3 })
})

it('keeps a conflicting Owl build intact and installs a retry only after the owner backs its folder up', async () => {
  const configuration = await fixture(), version = '9.9.9-owl.20261012.2', file = localArchiveName(version)
  const entry = await fakeHost(), original = hostRelease(version, entry), replacement = hostRelease(version, entry + '\n// Published source\n')
  original['runtime-manifest.json'] = JSON.stringify({ ...JSON.parse(original['runtime-manifest.json']!), sourceCommit: 'a'.repeat(40) })
  replacement['runtime-manifest.json'] = JSON.stringify({ ...JSON.parse(replacement['runtime-manifest.json']!), sourceCommit: 'b'.repeat(40) })
  const archive = tarGz(original), updated = tarGz(replacement)
  const install = (bytes: Uint8Array) => run(configuration, { op: 'update-install', version, file, sha256: sha256(bytes) })
  await receive(configuration, file, archive)
  expect(last(await install(archive))).toMatchObject({ type: 'update-installed', version })
  await receive(configuration, file, updated)
  expect(last(await install(updated))).toEqual({ type: 'error', reason: 'update-version-conflict' })
  const target = join(configuration.installPath, 'versions', version), backup = target + '.saved-by-owner'
  for (const [name, contents] of Object.entries(original)) expect(await readFile(join(target, name), 'utf8')).toBe(contents)
  await expect(readFile(target + '.partial')).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await pointer(configuration)).toBeNull()
  // The owner resolves the explicit folder conflict while the host is stopped, preserving the old build's bytes.
  expect(dirname(resolve(target))).toBe(resolve(configuration.installPath, 'versions'))
  expect(dirname(resolve(backup))).toBe(resolve(configuration.installPath, 'versions'))
  await rename(target, backup)
  expect(last(await install(updated))).toMatchObject({ type: 'update-installed', version })
  for (const [name, contents] of Object.entries(original)) expect(await readFile(join(backup, name), 'utf8')).toBe(contents)
  for (const [name, contents] of Object.entries(replacement)) expect(await readFile(join(target, name), 'utf8')).toBe(contents)
  expect(await pointer(configuration)).toBeNull()
  expect(await readdir(join(configuration.installPath, 'versions', '.incoming'))).toEqual([])
  await launch(configuration)
  const ready = last(await run(configuration, { op: 'update-restart', hostId: HOST_ID, version }))
  expect(ready).toMatchObject({ type: 'ready', owned: true })
  hosts.push(ready.pid as number)
  expect(await pointer(configuration)).toBe(version + '\n')
  expect((await descriptor(configuration)).entry).toBe(join(target, 'host', 'index.js'))
  // Successful-restart pruning leaves the owner's backup and its immutable source metadata alone.
  for (const [name, contents] of Object.entries(original)) expect(await readFile(join(backup, name), 'utf8')).toBe(contents)
})

it('refuses an Owl archive whose package and runtime manifest versions disagree', async () => {
  const configuration = await fixture(), version = '9.9.9-owl.20261012.1', file = localArchiveName(version)
  const files = hostRelease(version, await fakeHost()); files['runtime-manifest.json'] = JSON.stringify({ sottoVersion: '9.9.9', node: '>=24 <25' })
  const archive = tarGz(files)
  await receive(configuration, file, archive)
  expect(last(await run(configuration, { op: 'update-install', version, file, sha256: sha256(archive) }))).toMatchObject({ type: 'error', reason: 'archive-invalid' })
  await expect(readFile(join(configuration.installPath, 'versions', version, 'package.json'))).rejects.toMatchObject({ code: 'ENOENT' })
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

describe('a restart a host asked for over its own socket (ADR-0087)', () => {
  const statusOf = (configuration: Configuration): Promise<unknown> =>
    readFile(join(configuration.dataDirectory, 'host-update-status.json'), 'utf8').then(text => JSON.parse(text) as unknown, () => null)
  const resultFileOf = (configuration: Configuration): string => join(configuration.dataDirectory, 'host-update-status.json')
  async function installNew(configuration: Configuration, entry: string): Promise<void> {
    const archive = tarGz(hostRelease(NEW, entry))
    expect(last(await receive(configuration, FILE, archive))).toMatchObject({ type: 'update-received' })
    expect(last(await run(configuration, { op: 'update-install', version: NEW, file: FILE, sha256: sha256(archive) }))).toMatchObject({ type: 'update-installed' })
  }

  const ATTEMPT = 'a1b2c3d4e5f60718'
  it('writes why it stopped before touching anything, and how a restart that went ahead ended', async () => {
    const configuration = await fixture()
    const old = await launch(configuration)
    const resultFile = resultFileOf(configuration)
    // Not installed yet: refused before anything was touched, and the file says so.
    expect(last(await run(configuration, { op: 'update-restart', hostId: HOST_ID, version: NEW, resultFile, attempt: 'f'.repeat(16) }))).toEqual({ type: 'error', reason: 'update-missing' })
    expect(await statusOf(configuration)).toEqual({ v: 1, attempt: 'f'.repeat(16), version: NEW, state: 'finished', result: { type: 'error', reason: 'update-missing' } })
    await rm(resultFile)
    await installNew(configuration, await fakeHost())
    // The host that asked has already answered its desktop, so the restart goes ahead without waiting, and tidies the mark away.
    const answered = `${resultFile}.${ATTEMPT}.answered`
    await writeFile(answered, '')
    const ready = last(await run(configuration, { op: 'update-restart', hostId: HOST_ID, version: NEW, resultFile, attempt: ATTEMPT, answerWaitMs: 60_000 }))
    hosts.push(ready.pid as number)
    expect(ready).toMatchObject({ type: 'ready', owned: true, hostId: HOST_ID })
    // Only what the desktop reads of the result is kept.
    expect(await statusOf(configuration)).toEqual({ v: 1, attempt: ATTEMPT, version: NEW, state: 'finished', result: { type: 'ready', hostId: HOST_ID, pid: ready.pid } })
    expect(alive(old.pid as number)).toBe(false)
    expect(await pointer(configuration)).toBe(`${NEW}\n`)
    await expect(readFile(answered)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('stops without touching anything once the host that asked has given up and claimed the attempt', async () => {
    const configuration = await fixture()
    const old = await launch(configuration)
    await installNew(configuration, await fakeHost())
    const resultFile = resultFileOf(configuration)
    await writeFile(`${resultFile}.${ATTEMPT}.claim`, 'host')
    const abandoned = JSON.stringify({ v: 1, attempt: ATTEMPT, version: NEW, state: 'finished', result: { type: 'error', reason: 'restart-not-sent' } }) + '\n'
    await writeFile(resultFile, abandoned)
    expect(last(await run(configuration, { op: 'update-restart', hostId: HOST_ID, version: NEW, resultFile, attempt: ATTEMPT }))).toEqual({ type: 'error', reason: 'restart-not-sent' })
    expect(await readFile(resultFile, 'utf8')).toBe(abandoned)
    // Even with the status file gone, as a later attempt clears it, the claim still stops this attempt.
    await rm(resultFile)
    expect(last(await run(configuration, { op: 'update-restart', hostId: HOST_ID, version: NEW, resultFile, attempt: ATTEMPT }))).toEqual({ type: 'error', reason: 'restart-not-sent' })
    await expect(readFile(resultFile)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(alive(old.pid as number)).toBe(true)
    expect(await pointer(configuration)).toBeNull()
    expect(await readdir(join(configuration.installPath, 'versions'))).toEqual(expect.not.arrayContaining(['.update-lock']))
  })

  it('records a rollback, and writes nothing to a file outside the data folder or without an attempt', async () => {
    const configuration = await fixture()
    await launch(configuration)
    await installNew(configuration, 'process.exit(1)\n')
    const outside = join(configuration.directory, 'status.json')
    expect(last(await run(configuration, { op: 'update-restart', hostId: HOST_ID, version: '9.9.10', resultFile: outside, attempt: ATTEMPT }))).toEqual({ type: 'error', reason: 'update-missing' })
    await expect(readFile(outside)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(last(await run(configuration, { op: 'update-restart', hostId: HOST_ID, version: '9.9.10', resultFile: resultFileOf(configuration) }))).toEqual({ type: 'error', reason: 'update-missing' })
    expect(await statusOf(configuration)).toBeNull()
    // No host says it answered: the restart waits its short while, then goes ahead anyway.
    const restarted = last(await run(configuration, { op: 'update-restart', hostId: HOST_ID, version: NEW, resultFile: resultFileOf(configuration), attempt: ATTEMPT, answerWaitMs: 200 }))
    hosts.push((await descriptor(configuration)).pid)
    expect(restarted).toEqual({ type: 'error', reason: 'update-start-failed', restarted: true, cause: 'host-start-failed' })
    expect(await statusOf(configuration)).toEqual({ v: 1, attempt: ATTEMPT, version: NEW, state: 'finished', result: { type: 'error', reason: 'update-start-failed', restarted: true, cause: 'host-start-failed' } })
  })

  it('reads its configuration as its last argument when it runs as a file, as it does in a transient unit', async () => {
    const configuration = await fixture()
    const script = join(configuration.directory, 'host-update-restart.cjs')
    await writeFile(script, LAUNCH_SCRIPT_SOURCE)
    const child = spawn(process.execPath, [script, JSON.stringify({ ...configuration, op: 'update-install', version: NEW, file: FILE, sha256: 'a'.repeat(64) })], { shell: false, windowsHide: true })
    children.push(child)
    expect(last(await collect(child))).toEqual({ type: 'error', reason: 'update-missing' })
  })
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

describe("Windows rename errors", () => {
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

it('leaves exactly one owner when several updates take over the same stale lock at once', async () => {
  const configuration = await fixture()
  // A releases page that never answers: whichever update owns the lock waits in its download, holding it.
  let requests = 0
  const silent = createServer(() => { requests++ })
  await new Promise<void>(done => silent.listen(0, '127.0.0.1', done))
  pages.push({ close: () => new Promise(done => { silent.closeAllConnections(); silent.close(() => done()) }) })
  const releasesUrl = `http://127.0.0.1:${(silent.address() as { port: number }).port}`
  const lock = join(configuration.installPath, 'versions', '.update-lock')
  // The lock of an update whose process has gone.
  const gone = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true })
  await new Promise(resolve => gone.once('exit', resolve))
  await mkdir(lock, { recursive: true }); await writeFile(join(lock, 'pid'), String(gone.pid))
  for (let round = 0; round < 4; round++) {
    requests = 0
    const contenders = Array.from({ length: 4 }, () => launchScriptChild({ ...configuration, op: 'update-fetch', version: NEW, releasesUrl }, undefined, child => children.push(child)))
    const outcomes = contenders.map(child => collect(child))
    // All but one find the lock held; the one that owns it waits in its download.
    const refused: number[] = []
    await vi.waitFor(async () => {
      refused.splice(0, refused.length, ...await Promise.all(contenders.map(async (child, index) => child.exitCode === null ? -1 : last(await outcomes[index]!).reason === 'update-busy' ? index : -2)))
      expect(refused.filter(index => index >= 0)).toHaveLength(3)
      expect(requests).toBe(1)
    }, { timeout: 30_000, interval: 50 })
    const owner = contenders.find(child => child.exitCode === null)!
    expect(Number(await readFile(join(lock, 'pid'), 'utf8'))).toBe(owner.pid)
    // The owner is killed, as a stopped download is: its lock is stale for the next round.
    owner.kill()
    await outcomes[contenders.indexOf(owner)]
  }
  expect((await readdir(join(configuration.installPath, 'versions'))).filter(name => name.startsWith('.update-lock.'))).toEqual([])
})

it('downloads under the lock, which a download that was stopped gives up to the next update', async () => {
  const configuration = await fixture()
  // A releases page that never answers: the download waits, as one does after Cancel update until it notices.
  const silent = createServer(() => undefined)
  await new Promise<void>(done => silent.listen(0, '127.0.0.1', done))
  pages.push({ close: () => new Promise(done => { silent.closeAllConnections(); silent.close(() => done()) }) })
  const pending = run(configuration, { op: 'update-fetch', version: NEW, releasesUrl: `http://127.0.0.1:${(silent.address() as { port: number }).port}` })
  await vi.waitFor(async () => expect(await readFile(join(configuration.installPath, 'versions', '.update-lock', 'pid'), 'utf8')).toMatch(/^\d+$/u))
  // An update over SSH, or one a host runs on itself over its socket, waits its turn while the download runs.
  expect(last(await run(configuration, { op: 'update-install', version: NEW, file: FILE, sha256: 'a'.repeat(64) }))).toEqual({ type: 'error', reason: 'update-busy' })
  expect(last(await run(configuration, { op: 'update-fetch', version: NEW, releasesUrl: 'http://127.0.0.1:1' }))).toEqual({ type: 'error', reason: 'update-busy' })
  for (const child of children) if (child.exitCode === null) child.kill()
  await pending
  // The stopped download's lock names a process that has gone, so the next update takes it over.
  expect(last(await run(configuration, { op: 'update-install', version: NEW, file: FILE, sha256: 'a'.repeat(64) }))).toEqual({ type: 'error', reason: 'update-missing' })
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

describe("POSIX receive-script probe", () => {
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
})
