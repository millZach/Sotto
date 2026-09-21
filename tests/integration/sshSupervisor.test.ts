// @vitest-environment node
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { SSH_SUPERVISOR_SOURCE } from '../../src/main/hosts/sshSupervisor'
const directories: string[] = [], children: ChildProcessWithoutNullStreams[] = []
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
  expect(() => process.kill(ready.pid as number, 0)).toThrow()
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
it('reports an absent installed archive without leaking path or starting a host', async () => {
  const configuration = await fixture()
  configuration.installPath = join(configuration.installPath, 'missing')
  const remote = supervise(configuration)
  await vi.waitFor(() => expect(remote.messages).toContainEqual({ type: 'error', reason: 'archive-missing' }))
  await vi.waitFor(() => expect(remote.child.exitCode).toBe(0))
  expect(remote.errors()).toBe('')
})
