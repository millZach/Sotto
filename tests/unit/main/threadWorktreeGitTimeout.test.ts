// @vitest-environment node
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return { ...original, execFile: vi.fn(original.execFile) }
})
import { runWorktreeGitProcess } from '../../../src/main/agents/threadWorktrees'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-git-timeout-')) throw new Error('Unsafe fixture cleanup')
    await rm(root, { recursive: true, force: true })
  }
})
describe('worktree Git process deadlines', () => {
  it('gives a checkout five minutes and ordinary commands thirty seconds', async () => {
    const timer = vi.spyOn(globalThis, 'setTimeout')
    await runWorktreeGitProcess('.', ['worktree', 'add'], { executable: process.execPath, prefix: ['-e', 'process.exit(0)', '--'] })
    expect(timer.mock.calls.some(call => call[1] === 300_000)).toBe(true)
    await runWorktreeGitProcess('.', ['status'], { executable: process.execPath, prefix: ['-e', 'process.exit(0)', '--'] })
    expect(timer.mock.calls.some(call => call[1] === 30_000)).toBe(true)
  })
  it('stops a fake Git launcher and its writing grandchild before returning a timeout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-git-timeout-')); roots.push(root)
    const pidFile = join(root, 'writer.pid'), checkout = join(root, 'checkout')
    const childPidFile = join(root, 'child.pid')
    const writer = join(root, 'writer.cjs'), child = join(root, 'child.cjs'), launcher = join(root, 'git.cjs')
    await writeFile(writer, `const fs = require('node:fs'); const folder = ${JSON.stringify(checkout)}; function write() { fs.mkdirSync(folder, {recursive:true}); fs.writeFileSync(folder + '/still-writing.txt', String(Date.now())); } write(); fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(write, 10);`)
    await writeFile(child, `require('node:fs').writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid)); require('node:child_process').spawn(process.execPath, [${JSON.stringify(writer)}], {stdio:'ignore', detached:process.platform === 'win32'}); setInterval(() => {}, 1000);`)
    await writeFile(launcher, `require('node:child_process').spawn(process.execPath, [${JSON.stringify(child)}], {stdio:'ignore', detached:process.platform === 'win32'}); setInterval(() => {}, 1000);`)
    let deadline: (() => void) | undefined
    const realTimer = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay?: number, ...args: unknown[]) => {
      if (delay === 300_000) deadline = callback
      return realTimer(callback, delay, ...args)
    }) as typeof setTimeout)
    const result = runWorktreeGitProcess(root, ['worktree', 'add'], { executable: process.execPath, prefix: [launcher] })
    const outcome = result.catch(error => error as Error)
    let pid: number | undefined
    try {
      await expect.poll(async () => readFile(pidFile, 'utf8').catch(() => '')).not.toBe('')
      pid = Number(await readFile(pidFile, 'utf8'))
      expect(deadline).toBeTypeOf('function')
      deadline!()
      expect(await outcome).toMatchObject({ timedOut: true })
      // If only the launcher died, this writer is still alive and can recreate the removed folder.
      expect(() => process.kill(pid!, 0)).toThrow()
      await rm(checkout, { recursive: true })
      await expect(readFile(join(checkout, 'still-writing.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      for (const cleanupPid of [pid, Number(await readFile(childPidFile, 'utf8').catch(() => '0'))]) {
        if (!cleanupPid) continue
        try {
          process.kill(cleanupPid, 0)
          if (process.platform === 'win32') await new Promise<void>(done => execFile('taskkill', ['/pid', String(cleanupPid), '/T', '/F'], { windowsHide: true }, () => done()))
          else process.kill(cleanupPid, 'SIGKILL')
        } catch { /* The regression already stopped it. */ }
      }
    }
  })
  it.skipIf(process.platform !== 'win32')('refuses promptly if taskkill fails and leaves the running folder alone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-git-timeout-')); roots.push(root)
    const launcher = join(root, 'git.cjs'), pidFile = join(root, 'launcher.pid')
    await writeFile(launcher, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`)
    let deadline: (() => void) | undefined
    const realTimer = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay?: number, ...args: unknown[]) => {
      if (delay === 300_000) deadline = callback
      return realTimer(callback, delay, ...args)
    }) as typeof setTimeout)
    vi.mocked(execFile).mockImplementationOnce(((_file: string, _args: string[], _options: unknown, callback: (error: Error) => void) => {
      callback(new Error('Synthetic taskkill failure'))
      return {} as ReturnType<typeof execFile>
    }) as typeof execFile)
    const result = runWorktreeGitProcess(root, ['worktree', 'add'], { executable: process.execPath, prefix: [launcher] }).catch(error => error as Error)
    try {
      await expect.poll(async () => readFile(pidFile, 'utf8').catch(() => '')).not.toBe('')
      deadline!()
      expect(await result).toMatchObject({ message: expect.stringContaining('could not be stopped') })
      const pid = Number(await readFile(pidFile, 'utf8'))
      expect(() => process.kill(pid, 0)).not.toThrow()
      expect(await readFile(pidFile, 'utf8')).toBe(String(pid))
    } finally {
      // Use the real taskkill executable through spawn; the synthetic failure must not affect cleanup.
      const pid = await readFile(pidFile, 'utf8')
      await new Promise<void>(done => spawn('taskkill', ['/pid', pid, '/T', '/F'], { windowsHide: true }).on('close', () => done()))
    }
  })
  it('reports unavailable executables without marking them as timed-out checkouts', async () => {
    await expect(runWorktreeGitProcess('.', [], { executable: 'sotto-no-such-git-executable' })).rejects.toMatchObject({ timedOut: false, message: expect.stringContaining('Git is unavailable') })
  })
})

describe('worktree Git process environment', () => {
  // A status read can run beside an agent's own commit in the same folder (issue #766). Without optional locks it
  // never takes the index lock to write back what it refreshed, so the commit never finds the lock taken.
  it('runs every worktree Git command without optional locks', async () => {
    const said = await runWorktreeGitProcess('.', ['status'], { executable: process.execPath, prefix: ['-e', 'process.stdout.write(process.env.GIT_OPTIONAL_LOCKS ?? "unset")', '--'] })
    expect(said).toBe('0')
  })
})
