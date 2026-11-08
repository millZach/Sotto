// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stopFakeSshHosts } from '../../fixtures/fakeSshHostCleanup'

const directories: string[] = [], children: ChildProcess[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const started = (child: ChildProcess): ChildProcess => { children.push(child); return child }
async function fakeHost(data: string): Promise<{ child: ChildProcess; port: number }> {
  const child = started(spawn(process.execPath, [resolve('tests/fixtures/fakeSshHost.mjs'), '--data', data, '--port', '0'], { stdio: 'ignore', windowsHide: true }))
  let port = 0
  await vi.waitFor(async () => {
    const descriptor = JSON.parse(await readFile(join(data, 'host-listener.json'), 'utf8')) as { pid: number; port: number }
    expect(descriptor.pid).toBe(child.pid)
    port = descriptor.port
  }, { timeout: 10_000 })
  return { child, port }
}
/** A port nothing listens on any more, as a stopped host's is. */
async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  await new Promise(done => server.close(done))
  return port
}
/** A descriptor a stopped host left behind, naming the PID it had. */
async function leftBehind(data: string, pid: number, port: number): Promise<void> {
  await mkdir(data, { recursive: true })
  await writeFile(join(data, 'host-listener.json'), JSON.stringify({ v: 1, fixture: 'sotto-fake-ssh-host', pid, instance: 'a-stopped-start', port }))
}

describe('stopping the fake SSH hosts a test saw start', () => {
  it("signals a host still serving its folder, and never a process that was handed a stopped host's PID", async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-fake-host-cleanup-')); directories.push(root)
    const live = join(root, 'live'), closed = join(root, 'closed'), answered = join(root, 'answered')
    const host = await fakeHost(live)
    // Stands in for the Git in the other test worker that Windows gave the stopped hosts' PID to.
    const reused = started(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true }))
    await once(reused, 'spawn')
    // One stopped host's port is closed now; another's has been taken by a host that answers as itself, not as it.
    await leftBehind(closed, reused.pid!, await closedPort())
    await leftBehind(answered, reused.pid!, host.port)
    const kill = vi.spyOn(process, 'kill')
    const exited = once(host.child, 'exit')
    await stopFakeSshHosts([host.child.pid!, reused.pid!], [answered, closed, join(root, 'never-started'), live])
    expect(kill.mock.calls).toEqual([[host.child.pid, 'SIGTERM']])
    await exited
    expect(reused.exitCode).toBeNull()
  })
})
