// @vitest-environment node
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { HOST_STOP_DRAIN_MS, LAUNCH_SCRIPT_SOURCE, NODE_CHECK_SOURCE, NODE_PROBE_SOURCE, type LaunchOperation } from '../../src/main/hosts/launchScript'
import { readBootId } from '../../src/host/lock'
import { MemoryStore } from '../../src/main/memory/store'
import { PolicyStore } from '../../src/main/memory/policies'
import { PairedClients } from '../../src/main/agents/pairing'

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
  // Only a launch hands back the administrative token, for the desktop's phone routes (ADR-0050); no other result does.
  expect(ready).toMatchObject({ adminToken: 'remote-only-secret' })
  const pairing = await run(configuration, { op: 'pairing-code', hostId: HOST_ID })
  expect(pairing).toMatchObject({ code: 0, errors: '' })
  expect(pairing.messages.at(-1)).toMatchObject({ type: 'pairing-code', code: 'ABC123', hostId: HOST_ID })
  expect(JSON.stringify(pairing.messages)).not.toContain('remote-only-secret')
  const revoked = await run(configuration, { op: 'revoke-client', hostId: HOST_ID, clientId: 'client' })
  expect(revoked.messages.at(-1)).toMatchObject({ type: 'revoked', revoked: true })
  expect(JSON.stringify(revoked.messages)).not.toContain('remote-only-secret')
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

async function desktopPermissionFixture() {
  const configuration = await fixture()
  await launch(configuration)
  const memory = new MemoryStore(join(configuration.dataDirectory, 'memory.sqlite'))
  memory.open()
  const policies = new PolicyStore(memory)
  const pairing = new PairedClients(configuration.dataDirectory)
  await pairing.load()
  const { clientId } = await pairing.redeem(pairing.issuePairingCode().code, 'Sotto desktop')
  return { configuration, memory, policies, clientId, client: { clientId, user: 'Desktop fixture', transport: 'socket' as const },
    operation: { op: 'desktop-answers', hostId: HOST_ID, clientId } as const }
}

it('establishes the authenticated SSH desktop policy once, including concurrent setup, without a host upgrade', async () => {
  const { configuration, memory, policies, client, operation } = await desktopPermissionFixture()
  try {
    expect(policies.mayGrant(client).allowed).toBe(false)
    const results = await Promise.all([run(configuration, operation), run(configuration, operation), run(configuration, operation)])
    for (const result of results) expect(result.messages.at(-1)).toEqual({ type: 'desktop-answers', hostId: HOST_ID })
    expect(policies.mayGrant(client).allowed).toBe(true)
    const records = policies.list({ scope: 'client:' + client.clientId, includeInactive: true })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ action: 'remote-answer', resource: client.clientId, effect: 'allow', source: 'user' })
    expect(records[0]!.note).toContain('authenticated SSH session')
    await run(configuration, operation)
    expect(policies.list({ scope: 'client:' + client.clientId, includeInactive: true })).toEqual(records)
  } finally { memory.close() }
})

it.each(['revoked', 'expired', 'always-confirm'] as const)('preserves an existing %s desktop policy on reconnect', async kind => {
  const { configuration, memory, policies, client, operation } = await desktopPermissionFixture()
  try {
    if (kind === 'always-confirm') policies.grant({ action: 'remote-answer', resource: client.clientId, scope: 'client:' + client.clientId, effect: 'always-confirm', note: 'Fixture boundary' })
    else {
      const record = policies.grantRemoteAnswers(client.clientId, 'Fixture decision', kind === 'expired' ? '2000-01-01T00:00:00.000Z' : null)
      if (kind === 'revoked') policies.revoke(record.id)
    }
    const before = policies.list({ scope: 'client:' + client.clientId, includeInactive: true })
    expect((await run(configuration, operation)).messages.at(-1)).toEqual({ type: 'desktop-answers', hostId: HOST_ID })
    expect(policies.mayGrant(client).allowed).toBe(false)
    expect(policies.list({ scope: 'client:' + client.clientId, includeInactive: true })).toEqual(before)
  } finally { memory.close() }
})

it('refuses unpaired clients and another host without writing policies', async () => {
  const { configuration, memory, policies, operation } = await desktopPermissionFixture()
  try {
    for (const invalid of [{ ...operation, clientId: 'not-paired' }, { ...operation, hostId: '22222222-2222-4222-8222-222222222222' }]) {
      expect((await run(configuration, invalid)).messages.at(-1)).toEqual({ type: 'failed' })
    }
    expect(policies.list({ includeInactive: true })).toEqual([])
    // Nor is either recorded as a desktop: only a paired client of this host is.
    await expect(readFile(join(configuration.dataDirectory, 'desktop-clients.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { memory.close() }
})

const desktops = async (configuration: Configuration): Promise<unknown> => JSON.parse(await readFile(join(configuration.dataDirectory, 'desktop-clients.json'), 'utf8'))

it('records the desktop on every SSH connect, a desktop paired before the record existed and one that may already answer included', async () => {
  const { configuration, memory, policies, client, clientId, operation } = await desktopPermissionFixture()
  try {
    // Paired, granted and connected before this build: no record of desktops exists on the host yet.
    expect((await run(configuration, operation)).messages.at(-1)).toEqual({ type: 'desktop-answers', hostId: HOST_ID })
    expect(policies.mayGrant(client).allowed).toBe(true)
    await rm(join(configuration.dataDirectory, 'desktop-clients.json'))
    // Its next connect records it, though its grant is already there and is left as it is.
    const before = policies.list({ scope: 'client:' + clientId, includeInactive: true })
    expect((await run(configuration, operation)).messages.at(-1)).toEqual({ type: 'desktop-answers', hostId: HOST_ID })
    expect(await desktops(configuration)).toEqual([clientId])
    expect(policies.list({ scope: 'client:' + clientId, includeInactive: true })).toEqual(before)
    // Once, however often it connects.
    await run(configuration, operation)
    expect(await desktops(configuration)).toEqual([clientId])
  } finally { memory.close() }
})

it('records two desktops connecting at once, and keeps the desktops already recorded', async () => {
  const { configuration, memory, clientId, operation } = await desktopPermissionFixture()
  try {
    await writeFile(join(configuration.dataDirectory, 'desktop-clients.json'), JSON.stringify(['laptop-recorded-earlier']))
    const pairing = new PairedClients(configuration.dataDirectory)
    await pairing.load()
    const other = await pairing.redeem(pairing.issuePairingCode().code, 'Second desktop')
    const results = await Promise.all([run(configuration, operation), run(configuration, { ...operation, clientId: other.clientId }), run(configuration, operation)])
    for (const result of results) expect(result.messages.at(-1)).toEqual({ type: 'desktop-answers', hostId: HOST_ID })
    expect(new Set(await desktops(configuration) as string[])).toEqual(new Set(['laptop-recorded-earlier', clientId, other.clientId]))
  } finally { memory.close() }
})

it('records a confirmed desktop even when its grant cannot be written, since the grant and the record are separate', async () => {
  const { configuration, memory, clientId, operation } = await desktopPermissionFixture()
  memory.close()
  await rm(join(configuration.dataDirectory, 'memory.sqlite'))
  expect((await run(configuration, operation)).messages.at(-1)).toEqual({ type: 'failed' })
  expect(await desktops(configuration)).toEqual([clientId])
})

it('reports the tailnet address and who started the host, as its descriptor records them, and only a well-formed address', async () => {
  const configuration = await fixture()
  const ready = await launch(configuration, { ...process.env, FAKE_HOST_TAILNET_ADDRESS: 'https://forge.tail5728ca.ts.net:8443' })
  expect(ready).toMatchObject({ type: 'ready', owned: true, startedBy: 'launch-script', tailnetAddress: 'https://forge.tail5728ca.ts.net:8443' })
  for (const address of ['http://forge.tail5728ca.ts.net:8443', 'https://forge.example.com:8443', 'https://forge.tail5728ca.ts.net', 'https://forge.tail5728ca.ts.net:8443/x']) {
    const descriptor = JSON.parse(await readFile(join(configuration.dataDirectory, 'host-listener.json'), 'utf8')) as Record<string, unknown>
    await writeFile(join(configuration.dataDirectory, 'host-listener.json'), JSON.stringify({ ...descriptor, tailnetAddress: address }))
    const again = await launch(configuration)
    expect(again).toMatchObject({ type: 'ready', pid: ready.pid, startedBy: 'launch-script' })
    expect(again).not.toHaveProperty('tailnetAddress')
  }
})

it('reports no tailnet address or starter for a host its owner started by hand with Serve off', async () => {
  const configuration = await fixture()
  await startedByHand(configuration)
  const ready = await launch(configuration)
  expect(ready).toMatchObject({ type: 'ready', owned: false })
  expect(ready).not.toHaveProperty('tailnetAddress')
  expect(ready).not.toHaveProperty('startedBy')
})

it('refuses missing or corrupt policy stores without creating or replacing them', async () => {
  const { configuration, memory, operation } = await desktopPermissionFixture()
  memory.close()
  const file = join(configuration.dataDirectory, 'memory.sqlite')
  await rm(file)
  expect((await run(configuration, operation)).messages.at(-1)).toEqual({ type: 'failed' })
  await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
  const original = 'Fixture unreadable policy database'
  await writeFile(file, original)
  expect((await run(configuration, operation)).messages.at(-1)).toEqual({ type: 'failed' })
  expect(await readFile(file, 'utf8')).toBe(original)
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
it('starts over a previous-boot lock even when its PID now belongs to a live process', async () => {
  const configuration = await fixture()
  await mkdir(configuration.dataDirectory, { recursive: true })
  const boot = await readBootId()
  expect(boot).toBeDefined()
  // The installed fixture stands in for the host's boot-aware reclaim, without ever signalling this PID.
  await writeFile(join(configuration.dataDirectory, 'host-listener.lock'), JSON.stringify({ pid: process.pid, nonce: 'stale', boot: 'previous-boot' }))
  const ready = await launch(configuration, { ...process.env, FAKE_HOST_BOOT: boot })
  expect(ready).toMatchObject({ type: 'ready', owned: true })
  expect(() => process.kill(process.pid, 0)).not.toThrow()
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
  // The probe's first line says SSH signed in; the reason follows.
  expect(outcome.messages).toEqual([{ type: 'signed-in' }, { type: 'error', reason: 'node-too-old', version: process.versions.node }])
  await expect(readFile(join(configuration.dataDirectory, 'host-listener.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
})
