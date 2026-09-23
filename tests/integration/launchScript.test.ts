// @vitest-environment node
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { HOST_STOP_DRAIN_MS, LAUNCH_SCRIPT_SOURCE, NODE_CHECK_SOURCE, NODE_PROBE_SOURCE, type LaunchOperation } from '../../src/main/hosts/launchScript'

const directories: string[] = [], children: ChildProcess[] = [], hosts: number[] = []
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill()
  for (const pid of hosts.splice(0)) { try { process.kill(pid, 'SIGTERM') } catch { /* already exited */ } }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})
const HOST_ID = '11111111-1111-4111-8111-111111111111'
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-launch-script-')); directories.push(directory)
  const installPath = join(directory, "installed host's $(literal)")
  await mkdir(join(installPath, 'host'), { recursive: true })
  await writeFile(join(installPath, 'package.json'), JSON.stringify({ type: 'module' }))
  await copyFile(resolve('tests/fixtures/fakeSshHost.mjs'), join(installPath, 'host/index.js'))
  return { directory, installPath, dataDirectory: join(directory, 'data'), remotePort: 0, readyTimeoutMs: 5000, stopDrainMs: HOST_STOP_DRAIN_MS }
}
type Configuration = Awaited<ReturnType<typeof fixture>>
interface Outcome { readonly messages: Record<string, unknown>[]; readonly code: number | null; readonly errors: string }
/** One operation the way the desktop sends it: the script on stdin, the configuration as an argument. */
function run(configuration: Configuration, operation: LaunchOperation, env: NodeJS.ProcessEnv = process.env): Promise<Outcome> {
  const child = spawn(process.execPath, ['--input-type=commonjs', '-', JSON.stringify({ ...configuration, ...operation })], { shell: false, windowsHide: true, env })
  children.push(child)
  child.stdin.end(LAUNCH_SCRIPT_SOURCE)
  return collect(child)
}
function collect(child: ChildProcess): Promise<Outcome> {
  let output = '', errors = ''
  child.stdout!.on('data', chunk => { output += String(chunk) })
  child.stderr!.on('data', chunk => { errors += String(chunk) })
  return new Promise(resolve => child.once('close', code => resolve({ code, errors,
    messages: output.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line) as Record<string, unknown>) })))
}
async function launch(configuration: Configuration, env?: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const outcome = await run(configuration, { op: 'launch' }, env)
  const ready = outcome.messages.at(-1)!
  if (typeof ready.pid === 'number') hosts.push(ready.pid)
  return ready
}
async function startedByHand(configuration: Configuration): Promise<ChildProcess> {
  const existing = spawn(process.execPath, [join(configuration.installPath, 'host/index.js'), '--data', configuration.dataDirectory, '--port', '0'], { shell: false, windowsHide: true })
  children.push(existing)
  await vi.waitFor(async () => expect(JSON.parse(await readFile(join(configuration.dataDirectory, 'host-listener.json'), 'utf8')).pid).toBe(existing.pid))
  return existing
}

it('starts an owned host, issues a code and a revocation, and exits after each result with the host still running', async () => {
  const configuration = await fixture()
  const ready = await launch(configuration)
  expect(ready).toMatchObject({ type: 'ready', owned: true, hostId: HOST_ID })
  expect(JSON.stringify(ready)).not.toContain('remote-only-secret')
  const pairing = await run(configuration, { op: 'pairing-code', hostId: HOST_ID })
  expect(pairing).toMatchObject({ code: 0, errors: '' })
  expect(pairing.messages.at(-1)).toMatchObject({ type: 'pairing-code', code: 'ABC123', hostId: HOST_ID })
  expect((await run(configuration, { op: 'revoke-client', hostId: HOST_ID, clientId: 'client' })).messages.at(-1)).toMatchObject({ type: 'revoked', revoked: true })
  expect(() => process.kill(ready.pid as number, 0)).not.toThrow()
  // The host wrote the mark itself; the launch script keeps no record of its own.
  expect(JSON.parse(await readFile(join(configuration.dataDirectory, 'host-listener.json'), 'utf8'))).toMatchObject({ startedBy: 'launch-script', pid: ready.pid })
  await expect(readFile(join(configuration.dataDirectory, 'host-launcher.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
})
it('refuses a request for a different host ID', async () => {
  const configuration = await fixture()
  await launch(configuration)
  expect((await run(configuration, { op: 'pairing-code', hostId: '22222222-2222-4222-8222-222222222222' })).messages.at(-1)).toEqual({ type: 'failed' })
})
it('finds a host it started earlier, still owned, and stops it on stop-host', async () => {
  const configuration = await fixture()
  const ready = await launch(configuration)
  const again = await launch(configuration)
  expect(again).toMatchObject({ owned: true, pid: ready.pid, hostId: ready.hostId })
  const stopped = await run(configuration, { op: 'stop-host', hostId: HOST_ID })
  expect(stopped.messages.at(-1)).toEqual({ type: 'host-stopped', stopped: true, hostId: HOST_ID })
  expect(() => process.kill(ready.pid as number, 0)).toThrow()
})
it('keeps a host owned when two launches race to start it, so Stop host works after a reconnect', async () => {
  const configuration = await fixture()
  const env = { ...process.env, FAKE_HOST_START_DELAY_MS: '400' }
  const [first, second] = await Promise.all([launch(configuration, env), launch(configuration, env)])
  expect(first).toMatchObject({ type: 'ready', owned: true })
  expect(second).toMatchObject({ type: 'ready', owned: true, pid: first.pid })
  // A reconnect after the race still finds the host Sotto started, and can stop it.
  expect(await launch(configuration)).toMatchObject({ owned: true, pid: first.pid })
  expect((await run(configuration, { op: 'stop-host', hostId: HOST_ID })).messages.at(-1)).toMatchObject({ stopped: true })
})
it('never stops a host it did not start, even beside a launcher record naming another process', async () => {
  const configuration = await fixture()
  const existing = await startedByHand(configuration)
  await writeFile(join(configuration.dataDirectory, 'host-launcher.json'), JSON.stringify({ v: 1, pid: existing.pid! + 1 }))
  expect(await launch(configuration)).toMatchObject({ owned: false, pid: existing.pid })
  expect((await run(configuration, { op: 'stop-host', hostId: HOST_ID })).messages.at(-1)).toEqual({ type: 'host-stopped', stopped: false, hostId: HOST_ID })
  expect(existing.exitCode).toBeNull()
})
it('still stops a host an earlier launch script recorded in host-launcher.json', async () => {
  const configuration = await fixture()
  const existing = await startedByHand(configuration)
  await writeFile(join(configuration.dataDirectory, 'host-launcher.json'), JSON.stringify({ v: 1, pid: existing.pid }))
  expect(await launch(configuration)).toMatchObject({ owned: true, pid: existing.pid })
  expect((await run(configuration, { op: 'stop-host', hostId: HOST_ID })).messages.at(-1)).toMatchObject({ stopped: true })
  await expect(readFile(join(configuration.dataDirectory, 'host-launcher.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
})
it('waits for a host another client is starting and reports host-busy if it never answers', async () => {
  const configuration = { ...await fixture(), readyTimeoutMs: 600 }
  await mkdir(configuration.dataDirectory, { recursive: true })
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: 'ignore', windowsHide: true })
  children.push(holder)
  await new Promise(resolve => holder.once('spawn', resolve))
  await writeFile(join(configuration.dataDirectory, 'host-listener.lock'), JSON.stringify({ pid: holder.pid, nonce: 'other-client' }))
  const outcome = await run(configuration, { op: 'launch' })
  expect(outcome.messages).toEqual([{ type: 'starting' }, { type: 'error', reason: 'host-busy' }])
  expect(outcome.code).toBe(0)
})
it('starts a host over a lock whose holder is gone', async () => {
  const configuration = await fixture()
  await mkdir(configuration.dataDirectory, { recursive: true })
  const gone = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true })
  await new Promise(resolve => gone.once('exit', resolve))
  await writeFile(join(configuration.dataDirectory, 'host-listener.lock'), JSON.stringify({ pid: gone.pid, nonce: 'stale' }))
  expect(await launch(configuration)).toMatchObject({ type: 'ready', owned: true })
})
it('treats a lock held by another account (EPERM) as held, the way the host does', () => {
  expect(LAUNCH_SCRIPT_SOURCE).toContain("error.code === 'EPERM'")
})
it('reports an absent installed archive without leaking its path or starting a host', async () => {
  const configuration = await fixture()
  configuration.installPath = join(configuration.installPath, 'missing')
  const outcome = await run(configuration, { op: 'launch' })
  expect(outcome.messages).toEqual([{ type: 'error', reason: 'archive-missing' }])
  expect(outcome.errors).toBe('')
})

// The Node probe: the version check runs everywhere; the shell around it needs a POSIX machine.
const major = Number(process.versions.node.split('.')[0])
function check(configuration: Record<string, unknown>) { return spawnSync(process.execPath, ['-e', NODE_CHECK_SOURCE, JSON.stringify(configuration)], { encoding: 'utf8', windowsHide: true }) }
it('checks Node against the range the installed archive declares, falling back to the desktop range', async () => {
  const configuration = await fixture()
  expect(check({ installPath: configuration.installPath, nodeRange: `>=${major} <${major + 1}` })).toMatchObject({ status: 0, stdout: process.versions.node })
  await writeFile(join(configuration.installPath, 'runtime-manifest.json'), JSON.stringify({ node: '>=99 <100' }))
  expect(check({ installPath: configuration.installPath, nodeRange: `>=${major}` })).toMatchObject({ status: 3, stdout: process.versions.node })
  await writeFile(join(configuration.installPath, 'runtime-manifest.json'), JSON.stringify({ node: '>=1 <2' }))
  expect(check({ installPath: configuration.installPath })).toMatchObject({ status: 4, stdout: process.versions.node })
})
const posix = process.platform !== 'win32'
function probe(configuration: Configuration, env: NodeJS.ProcessEnv): Promise<Outcome> {
  const child = spawn('/bin/sh', ['-c', NODE_PROBE_SOURCE, 'sotto-launch', JSON.stringify({ ...configuration, op: 'launch', nodeRange: `>=${major} <${major + 1}` }), NODE_CHECK_SOURCE], { env })
  children.push(child)
  child.stdin.end(LAUNCH_SCRIPT_SOURCE)
  return collect(child)
}
it.skipIf(!posix)('finds a Node that only a version manager puts on the path, then runs the launch script on it', async () => {
  const configuration = await fixture()
  const home = join(configuration.directory, 'home'), bin = join(home, '.nvm', 'versions', 'node', `v${process.versions.node}`, 'bin')
  await mkdir(bin, { recursive: true })
  const mark = join(configuration.directory, 'nvm-node-ran')
  await writeFile(join(bin, 'node'), `#!/bin/sh\n: > '${mark}'\nexec '${process.execPath}' "$@"\n`)
  await chmod(join(bin, 'node'), 0o755)
  const outcome = await probe(configuration, { HOME: home, PATH: '/nonexistent', SHELL: '/nonexistent' })
  expect(outcome.messages.at(-1)).toMatchObject({ type: 'ready', owned: true })
  hosts.push(outcome.messages.at(-1)!.pid as number)
  await expect(readFile(mark, 'utf8')).resolves.toBe('')
})
it.skipIf(!posix)('reports a Node too old for the archive as node-too-old with its version, and starts nothing', async () => {
  const configuration = await fixture()
  await writeFile(join(configuration.installPath, 'runtime-manifest.json'), JSON.stringify({ node: '>=99 <100' }))
  const home = join(configuration.directory, 'home'); await mkdir(home)
  await symlink(process.execPath, join(configuration.directory, 'node'))
  const outcome = await probe(configuration, { HOME: home, PATH: configuration.directory, SHELL: '/nonexistent' })
  expect(outcome.messages).toEqual([{ type: 'error', reason: 'node-too-old', version: process.versions.node }])
  await expect(readFile(join(configuration.dataDirectory, 'host-listener.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
})
