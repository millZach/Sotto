// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HostLockError, startHeadlessHost } from '../../src/host'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'

let root: string, data: string
const hosts: Awaited<ReturnType<typeof startHeadlessHost>>[] = [], children: ChildProcess[] = [], events: string[] = []
const start = async () => {
  const host = await startHeadlessHost({ dataDirectory: data, port: 0, providers: { codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost() }, reasoner: e2eAgentReasoner, log: event => events.push(event) })
  hosts.push(host)
  return host
}
const lock = () => readFile(join(data, 'host-listener.lock'), 'utf8')
/** A process that stays alive until the test ends, standing in for a host that crashed without releasing anything. */
const sleeper = (): ChildProcess => { const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: 'ignore', windowsHide: true }); children.push(child); return child }
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'sotto-headless-lock-')); data = join(root, 'data'); await mkdir(data); events.length = 0 })
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill()
  if (root && dirname(root) === tmpdir() && root.includes('sotto-headless-lock-')) await rm(root, { recursive: true, force: true })
})

describe('the host data folder lock', () => {
  it('reclaims a lock left by a host that no longer runs, so a reconnect after a crash needs no hand cleanup', async () => {
    const dead = sleeper()
    await new Promise(resolve => dead.once('spawn', resolve))
    dead.kill(); await new Promise(resolve => dead.once('exit', resolve))
    await writeFile(join(data, 'host-listener.lock'), JSON.stringify({ pid: dead.pid, nonce: 'stale' }))
    const host = await start()
    expect(JSON.parse(await lock())).toMatchObject({ pid: process.pid })
    expect(events).toContain('host-lock-reclaimed')
    await host.close()
    await expect(lock()).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('refuses a data folder whose host still runs, naming the process, and leaves its lock alone', async () => {
    const alive = sleeper()
    await new Promise(resolve => alive.once('spawn', resolve))
    const held = JSON.stringify({ pid: alive.pid, nonce: 'live' })
    await writeFile(join(data, 'host-listener.lock'), held)
    await expect(start()).rejects.toThrow(HostLockError)
    await expect(start()).rejects.toThrow(`Another host (process ${alive.pid}) is still running`)
    expect(await lock()).toBe(held)
    expect(events).not.toContain('host-lock-reclaimed')
  })
  it('refuses a second host in the same folder while the first runs', async () => {
    await start()
    await expect(start()).rejects.toThrow(`Another host (process ${process.pid}) is still running`)
  })
  it('refuses a lock it cannot read rather than removing a file it does not understand', async () => {
    await writeFile(join(data, 'host-listener.lock'), 'not json')
    await expect(start()).rejects.toThrow('could not be read')
    expect(await lock()).toBe('not json')
  })
})
