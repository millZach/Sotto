// @vitest-environment node
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireHostLock, HostLockError, processAlive, readBootId, releaseHostLock, type HostLease } from '../../../src/host/lock'

let root: string, path: string
const events: string[] = []
const log = (event: string): void => { events.push(event) }
const lease = (nonce: string, extra: Partial<HostLease> = {}): HostLease => ({ pid: process.pid, nonce, ...extra })
const lock = () => readFile(path, 'utf8')
/** A pid that belonged to a process which has since exited, standing in for a host that crashed. */
const deadPid = async (): Promise<number> => {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true })
  await new Promise(resolve => child.once('exit', resolve))
  return child.pid as number
}
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'sotto-host-lock-')); path = join(root, 'host-listener.lock'); events.length = 0 })
afterEach(async () => {
  vi.restoreAllMocks()
  if (root && dirname(root) === tmpdir() && root.includes('sotto-host-lock-')) await rm(root, { recursive: true, force: true })
})

describe('the host lock', () => {
  it('reclaims a lock whose holder has exited and leaves nothing else behind', async () => {
    await writeFile(path, JSON.stringify({ pid: await deadPid(), nonce: 'crashed' }))
    const mine = lease('mine')
    await acquireHostLock(path, mine, { log })
    expect(await lock()).toBe(JSON.stringify(mine))
    expect(events).toEqual(['host-lock-reclaimed'])
    expect(await readdir(root)).toEqual(['host-listener.lock'])
    await releaseHostLock(path, mine)
    expect(await readdir(root)).toEqual([])
  })

  it('refuses a live holder in plain words, naming its process, and leaves its lock alone', async () => {
    const held = JSON.stringify(lease('live'))
    await writeFile(path, held)
    const refusal = acquireHostLock(path, lease('mine'), { log })
    await expect(refusal).rejects.toThrow(HostLockError)
    await expect(acquireHostLock(path, lease('mine'))).rejects.toThrow(`Another host (process ${process.pid}) is using this data folder, so this host did not start. Nothing in the folder was changed. Stop that host, or wait for it to stop`)
    expect(await lock()).toBe(held)
    expect(events).toEqual([])
    expect(await readdir(root)).toEqual(['host-listener.lock'])
  })

  it('lets exactly one of two hosts own the folder when both judged the same crashed lock stale', async () => {
    await writeFile(path, JSON.stringify({ pid: await deadPid(), nonce: 'crashed' }))
    // A has judged the crashed lock stale and is about to move it aside; B starts, reclaims and owns the folder first.
    let judged!: () => void, resume!: () => void
    const aJudged = new Promise<void>(resolve => { judged = resolve })
    const aResumes = new Promise<void>(resolve => { resume = resolve })
    const a = acquireHostLock(path, lease('a'), { log, beforeReclaim: async () => { judged(); await aResumes } })
    const aOutcome = a.then(() => 'owner', (error: unknown) => error)
    await aJudged
    const b = lease('b', { pid: process.pid })
    await acquireHostLock(path, b, { log })
    resume()
    const outcome = await aOutcome
    expect(outcome).toBeInstanceOf(HostLockError)
    expect((outcome as Error).message).toContain(`Another host (process ${b.pid}) is using this data folder`)
    // B's lock is where it was, with B's lease, and A's move left nothing else behind.
    expect(await lock()).toBe(JSON.stringify(b))
    expect(await readdir(root)).toEqual(['host-listener.lock'])
    expect(events).toEqual(['host-lock-reclaimed'])
  })

  it('gives the folder to exactly one of two hosts started together over a crashed lock, however their steps interleave', async () => {
    const crashed = JSON.stringify({ pid: await deadPid(), nonce: 'crashed' })
    for (let round = 0; round < 25; round++) {
      await writeFile(path, crashed)
      const leases = [lease(`a-${round}`), lease(`b-${round}`)]
      const results = await Promise.allSettled(leases.map(each => acquireHostLock(path, each)))
      const owners = results.flatMap((result, index) => result.status === 'fulfilled' ? [leases[index]] : [])
      expect(owners).toHaveLength(1)
      expect(await lock()).toBe(JSON.stringify(owners[0]))
      expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: expect.any(HostLockError) })
      expect(await readdir(root)).toEqual(['host-listener.lock'])
    }
  })

  it('reclaims a lock from an earlier boot even when its pid now belongs to a running process', async () => {
    // process.pid is running, as a reused pid would be after a reboot; the boot identity says it is not the old holder.
    await writeFile(path, JSON.stringify(lease('before-reboot', { boot: 'boot-1' })))
    const mine = lease('mine', { boot: 'boot-2' })
    await acquireHostLock(path, mine, { boot: 'boot-2', log })
    expect(await lock()).toBe(JSON.stringify(mine))
    expect(events).toEqual(['host-lock-reclaimed'])
  })

  it('judges a lock from this boot, or one with no boot recorded, by its pid alone', async () => {
    const sameBoot = JSON.stringify(lease('this-boot', { boot: 'boot-2' }))
    await writeFile(path, sameBoot)
    await expect(acquireHostLock(path, lease('mine'), { boot: 'boot-2' })).rejects.toThrow(HostLockError)
    expect(await lock()).toBe(sameBoot)
    const older = JSON.stringify(lease('before-boot-ids'))
    await writeFile(path, older)
    await expect(acquireHostLock(path, lease('mine'), { boot: 'boot-2' })).rejects.toThrow(HostLockError)
    expect(await lock()).toBe(older)
  })

  it('refuses a lock it cannot read without changing it', async () => {
    await writeFile(path, 'not json')
    await expect(acquireHostLock(path, lease('mine'))).rejects.toThrow('could not be read')
    expect(await lock()).toBe('not json')
  })

  it('never removes a lock another host holds when stopping', async () => {
    const other = JSON.stringify(lease('other'))
    await writeFile(path, other)
    await releaseHostLock(path, lease('mine'))
    expect(await lock()).toBe(other)
  })
})

describe('process liveness', () => {
  it('counts a process another account owns as running, and only a missing process as gone', () => {
    const kill = vi.spyOn(process, 'kill')
    kill.mockImplementationOnce(() => { throw Object.assign(new Error('not permitted'), { code: 'EPERM' }) })
    expect(processAlive(4242)).toBe(true)
    kill.mockImplementationOnce(() => { throw Object.assign(new Error('no such process'), { code: 'ESRCH' }) })
    expect(processAlive(4242)).toBe(false)
    kill.mockImplementationOnce(() => true)
    expect(processAlive(4242)).toBe(true)
  })

  it.runIf(['win32', 'linux', 'darwin'].includes(process.platform))('reads the same boot identity twice within one boot', async () => {
    const first = await readBootId()
    expect(first).toMatch(new RegExp(`^${process.platform}:.+`))
    expect(await readBootId()).toBe(first)
  })
})
