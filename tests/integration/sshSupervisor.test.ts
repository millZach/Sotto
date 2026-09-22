// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { SSH_SUPERVISOR_SOURCE } from '../../src/main/hosts/sshSupervisor'
const directories: string[] = [], children: ChildProcess[] = []
afterEach(async () => { for (const child of children.splice(0)) if (child.exitCode === null) child.kill(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-ssh-supervisor-')); directories.push(directory)
  const installPath = join(directory, "installed host's $(literal)")
  await mkdir(join(installPath, 'host'), { recursive: true })
  await writeFile(join(installPath, 'package.json'), JSON.stringify({ type: 'module' }))
  await copyFile(resolve('tests/fixtures/fakeSshHost.mjs'), join(installPath, 'host/index.js'))
  return { installPath, dataDirectory: join(directory, 'data'), remotePort: 0, marker: 'SOTTO_SSH_test:', readyTimeoutMs: 5000 }
}
function supervise(configuration: Awaited<ReturnType<typeof fixture>>) {
  const child = spawn(process.execPath, ['--input-type=commonjs', '-e', SSH_SUPERVISOR_SOURCE, JSON.stringify(configuration)], { shell: false, windowsHide: true })
  children.push(child)
  const messages: Record<string, unknown>[] = []; let buffer = '', errors = ''
  child.stdout.on('data', chunk => {
    buffer += String(chunk)
    let at: number
    while ((at = buffer.indexOf('\n')) !== -1) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (line.startsWith(configuration.marker)) messages.push(JSON.parse(line.slice(configuration.marker.length)) as Record<string, unknown>) }
  })
  child.stderr.on('data', chunk => { errors += String(chunk) })
  return { child, messages, errors: () => errors, send: (value: unknown) => child.stdin.write(configuration.marker + JSON.stringify(value) + '\n') }
}
it('runs the fixed remote supervisor, starts an owned host, issues explicit code and revocation, then stops its own child', async () => {
  const configuration = await fixture(), remote = supervise(configuration)
  await vi.waitFor(() => expect(remote.messages.some(message => message.type === 'ready')).toBe(true))
  const ready = remote.messages.find(message => message.type === 'ready')!
  expect(ready.owned).toBe(true)
  expect(remote.errors()).toBe('')
  expect(JSON.stringify(remote.messages)).not.toContain('remote-only-secret')
  remote.send({ type: 'pairing-code', id: 'pair' })
  await vi.waitFor(() => expect(remote.messages.find(message => message.type === 'pairing-code')).toMatchObject({ id: 'pair', code: 'ABC123' }))
  remote.send({ type: 'revoke-client', id: 'revoke', clientId: 'client' })
  await vi.waitFor(() => expect(remote.messages.find(message => message.type === 'revoked')).toMatchObject({ id: 'revoke', revoked: true }))
  remote.send({ type: 'close' })
  await vi.waitFor(() => expect(remote.child.exitCode).toBe(0))
  expect(() => process.kill(ready.pid as number, 0)).not.toThrow()
  try { process.kill(ready.pid as number, 'SIGTERM') } catch { /* already exited */ }
})
it('keeps an owned host alive after the supervisor connection ends', async () => {
  const configuration = await fixture(), remote = supervise(configuration)
  await vi.waitFor(() => expect(remote.messages.some(message => message.type === 'ready')).toBe(true))
  const ready = remote.messages.find(message => message.type === 'ready')!
  expect(ready.owned).toBe(true)
  remote.child.stdin.end()
  await vi.waitFor(() => expect(remote.child.exitCode).toBe(0))
  const descriptor = JSON.parse(await readFile(join(configuration.dataDirectory, 'host-listener.json'), 'utf8'))
  const health = await fetch(`http://127.0.0.1:${descriptor.port}/v1/health`).then(response => response.json())
  expect(health).toMatchObject({ status: 'ready', pid: ready.pid })
  const launcher = JSON.parse(await readFile(join(configuration.dataDirectory, 'host-launcher.json'), 'utf8'))
  expect(launcher).toMatchObject({ v: 1, pid: ready.pid })
  try { process.kill(ready.pid as number, 'SIGTERM') } catch { /* already exited */ }
})
it('reconnects to a host it started earlier, reports owned, and stops it on stop-host', async () => {
  const configuration = await fixture(), first = supervise(configuration)
  await vi.waitFor(() => expect(first.messages.some(message => message.type === 'ready')).toBe(true))
  const ready = first.messages.find(message => message.type === 'ready')!
  first.child.stdin.end()
  await vi.waitFor(() => expect(first.child.exitCode).toBe(0))
  const second = supervise(configuration)
  await vi.waitFor(() => expect(second.messages.some(message => message.type === 'ready')).toBe(true))
  const again = second.messages.find(message => message.type === 'ready')!
  expect(again).toMatchObject({ owned: true, pid: ready.pid, hostId: ready.hostId })
  second.send({ type: 'stop-host', id: '00000000-0000-4000-8000-000000000001' })
  await vi.waitFor(() => expect(second.messages.find(message => message.type === 'host-stopped')).toMatchObject({ id: '00000000-0000-4000-8000-000000000001', stopped: true, hostId: ready.hostId }))
  await vi.waitFor(() => expect(second.child.exitCode).toBe(0))
  await vi.waitFor(() => expect(() => process.kill(ready.pid as number, 0)).toThrow())
  await expect(readFile(join(configuration.dataDirectory, 'host-launcher.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
})
it('refuses to stop a host it did not start', async () => {
  const configuration = await fixture()
  const existing = spawn(process.execPath, [join(configuration.installPath, 'host/index.js'), '--data', configuration.dataDirectory, '--port', '0'], { shell: false, windowsHide: true })
  children.push(existing)
  await vi.waitFor(async () => expect(JSON.parse(await readFile(join(configuration.dataDirectory, 'host-listener.json'), 'utf8')).pid).toBe(existing.pid))
  const remote = supervise(configuration)
  await vi.waitFor(() => expect(remote.messages.find(message => message.type === 'ready')).toMatchObject({ owned: false, pid: existing.pid }))
  remote.send({ type: 'stop-host', id: '00000000-0000-4000-8000-000000000002' })
  await vi.waitFor(() => expect(remote.messages.find(message => message.type === 'host-stopped')).toMatchObject({ stopped: false }))
  await vi.waitFor(() => expect(remote.child.exitCode).toBe(0))
  expect(existing.exitCode).toBeNull()
  expect(() => process.kill(existing.pid!, 0)).not.toThrow()
})
it('discovers an existing host and leaves it alive after the SSH supervisor closes', async () => {
  const configuration = await fixture()
  const existing = spawn(process.execPath, [join(configuration.installPath, 'host/index.js'), '--data', configuration.dataDirectory, '--port', '0'], { shell: false, windowsHide: true })
  children.push(existing)
  await vi.waitFor(async () => expect(JSON.parse(await readFile(join(configuration.dataDirectory, 'host-listener.json'), 'utf8')).pid).toBe(existing.pid))
  const remote = supervise(configuration)
  await vi.waitFor(() => expect(remote.messages.find(message => message.type === 'ready')).toMatchObject({ owned: false, pid: existing.pid }))
  remote.child.stdin.end()
  await vi.waitFor(() => expect(remote.child.exitCode).toBe(0))
  expect(existing.exitCode).toBeNull()
  expect(() => process.kill(existing.pid!, 0)).not.toThrow()
})
it('waits for a host another client is starting and reports host-busy if it never answers', async () => {
  const configuration = { ...await fixture(), readyTimeoutMs: 600 }
  await mkdir(configuration.dataDirectory, { recursive: true })
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: 'ignore', windowsHide: true })
  children.push(holder)
  await new Promise(resolve => holder.once('spawn', resolve))
  await writeFile(join(configuration.dataDirectory, 'host-listener.lock'), JSON.stringify({ pid: holder.pid, nonce: 'other-client' }))
  const remote = supervise(configuration)
  await vi.waitFor(() => expect(remote.messages).toContainEqual({ type: 'error', reason: 'host-busy' }), { timeout: 5000 })
  expect(remote.messages).toContainEqual({ type: 'starting' })
  await vi.waitFor(() => expect(remote.child.exitCode).toBe(0))
  await expect(readFile(join(configuration.dataDirectory, 'host-launcher.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
})
it('starts a host over a lock whose holder is gone', async () => {
  const configuration = await fixture()
  await mkdir(configuration.dataDirectory, { recursive: true })
  const gone = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true })
  await new Promise(resolve => gone.once('exit', resolve))
  await writeFile(join(configuration.dataDirectory, 'host-listener.lock'), JSON.stringify({ pid: gone.pid, nonce: 'stale' }))
  const remote = supervise(configuration)
  await vi.waitFor(() => expect(remote.messages.find(message => message.type === 'ready')).toMatchObject({ owned: true }))
  try { process.kill(remote.messages.find(message => message.type === 'ready')!.pid as number, 'SIGTERM') } catch { /* already exited */ }
})
it('reports an absent installed archive without leaking path or starting a host', async () => {
  const configuration = await fixture()
  configuration.installPath = join(configuration.installPath, 'missing')
  const remote = supervise(configuration)
  await vi.waitFor(() => expect(remote.messages).toContainEqual({ type: 'error', reason: 'archive-missing' }))
  await vi.waitFor(() => expect(remote.child.exitCode).toBe(0))
  expect(remote.errors()).toBe('')
})
