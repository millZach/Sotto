// @vitest-environment node
import * as fsPromises from 'node:fs/promises'
import { execFile, execFileSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as worktrees from '../../../src/main/agents/threadWorktrees'
import { CheckpointCapture } from '../../../src/main/tools/checkpointCapture'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual }
})

/** Taken before any test replaces it. */
const realReadFile = fsPromises.readFile
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const dispose of cleanup.splice(0).reverse()) await dispose() })
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' })
/** The clock a snapshot compares file times with; ahead of the files, so none is too recent to trust. */
const later = () => Date.now() + 60_000

async function fixture(options: { files?: Record<string, string | Buffer>; repository?: boolean; now?: () => number } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sotto-checkpoint-capture-')))
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const repo = join(root, 'repo'); await mkdir(repo)
  if (options.repository !== false) {
    git(repo, 'init', '-q'); git(repo, 'config', 'core.autocrlf', 'false'); git(repo, 'config', 'user.name', 'Sotto capture fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid')
  }
  for (const [path, contents] of Object.entries(options.files ?? { 'app.txt': 'before\n', 'notes.txt': 'original notes\n' })) {
    await mkdir(join(repo, path, '..'), { recursive: true }); await writeFile(join(repo, path), contents)
  }
  if (options.repository !== false) { git(repo, 'add', '.'); git(repo, '-c', 'commit.gpgSign=false', 'commit', '-qm', 'Fixture') }
  const commands: string[][] = []
  const blobSizes = new Map<string, number>()
  const capture = new CheckpointCapture({ blobDirectory: join(root, 'blobs'), blobSizes, now: options.now ?? later,
    git: (cwd, args) => { commands.push(args); return new Promise((done, reject) => execFile('git', args, { cwd, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (error, output) => error ? reject(error) : done(output))) } })
  const reads = vi.spyOn(fsPromises, 'readFile')
  const readsInRepo = () => reads.mock.calls.filter(([path]) => typeof path === 'string' && path.startsWith(repo)).map(([path]) => path as string)
  return { root, repo, capture, commands, blobSizes, reads, readsInRepo }
}

describe('checkpoint capture', () => {
  it('reads only the files whose lstat changed since the folder was last captured', async () => {
    const f = await fixture()
    const first = await f.capture.snapshot(f.repo, { reuse: true })
    expect(f.readsInRepo()).toHaveLength(2)
    f.reads.mockClear()
    expect(await f.capture.snapshot(f.repo, { reuse: true })).toEqual(first)
    expect(f.readsInRepo()).toEqual([])
    await writeFile(join(f.repo, 'app.txt'), 'changed contents\n')
    const third = await f.capture.snapshot(f.repo, { reuse: true })
    expect(f.readsInRepo()).toEqual([join(f.repo, 'app.txt')])
    expect(third.files['app.txt']!.hash).not.toBe(first.files['app.txt']!.hash)
    expect(third.files['notes.txt']).toEqual(first.files['notes.txt'])
  })

  it('reads every file again when asked not to reuse, as a revert check does', async () => {
    const f = await fixture()
    await f.capture.snapshot(f.repo, { reuse: true }); f.reads.mockClear()
    await f.capture.snapshot(f.repo, { reuse: false })
    expect(f.readsInRepo()).toHaveLength(2)
  })

  it('never reuses a hash for an edit that keeps the size and lands in the same timestamp tick', async () => {
    // A snapshot taken right after the write cannot tell a later write in the same tick from this one.
    const f = await fixture({ now: Date.now })
    const path = join(f.repo, 'app.txt')
    const first = await f.capture.snapshot(f.repo, { reuse: true })
    const seen = await lstat(path, { bigint: true })
    await writeFile(path, 'BEFORE\n')
    // The file system reports exactly what it reported before the edit: same size, times, inode and mode.
    const actual = fsPromises.lstat
    vi.spyOn(fsPromises, 'lstat').mockImplementation(((target: string, options?: { bigint?: boolean }) => target === path && options?.bigint ? Promise.resolve(seen) : actual(target, options as never)) as typeof fsPromises.lstat)
    f.reads.mockClear()
    const second = await f.capture.snapshot(f.repo, { reuse: true })
    expect(f.readsInRepo()).toContain(path)
    expect(second.files['app.txt']!.hash).not.toBe(first.files['app.txt']!.hash)
  })

  it('reuses a hash only while every lstat field it was recorded with still matches', async () => {
    const f = await fixture()
    const path = join(f.repo, 'app.txt')
    const first = await f.capture.snapshot(f.repo, { reuse: true })
    const seen = await lstat(path, { bigint: true })
    const actual = fsPromises.lstat
    for (const field of ['size', 'mtimeNs', 'ctimeNs', 'ino', 'mode'] as const) {
      const changed = Object.assign(Object.create(Object.getPrototypeOf(seen) as object) as BigIntStats, seen, { [field]: seen[field] + 1n })
      const spy = vi.spyOn(fsPromises, 'lstat').mockImplementation(((target: string, options?: { bigint?: boolean }) => target === path && options?.bigint ? Promise.resolve(changed) : actual(target, options as never)) as typeof fsPromises.lstat)
      f.reads.mockClear()
      expect((await f.capture.snapshot(f.repo, { reuse: true })).files['app.txt']!.hash).toBe(first.files['app.txt']!.hash)
      expect(f.readsInRepo(), field).toEqual([path])
      spy.mockRestore()
    }
  })

  it('reads a file whose content changed but whose modification time was put back', async () => {
    const f = await fixture()
    const path = join(f.repo, 'app.txt')
    const first = await f.capture.snapshot(f.repo, { reuse: true })
    const seen = await lstat(path)
    await writeFile(path, 'BEFORE\n')
    await utimes(path, seen.atime, seen.mtime)
    f.reads.mockClear()
    const second = await f.capture.snapshot(f.repo, { reuse: true })
    expect(f.readsInRepo()).toEqual([path])
    expect(second.files['app.txt']!.hash).not.toBe(first.files['app.txt']!.hash)
  })

  it('reads a file again when its backup is gone', async () => {
    const f = await fixture()
    const first = await f.capture.snapshot(f.repo, { reuse: true })
    f.blobSizes.delete(first.files['app.txt']!.hash)
    f.reads.mockClear()
    await f.capture.snapshot(f.repo, { reuse: true })
    expect(f.readsInRepo()).toEqual([join(f.repo, 'app.txt')])
  })

  it('fails a working copy over the size limit from lstat alone, before reading any file', async () => {
    const f = await fixture({ files: { 'a.txt': 'small\n', 'z.bin': Buffer.alloc(8 * 1024 * 1024 + 1) } })
    await expect(f.capture.snapshot(f.repo, { reuse: true })).rejects.toThrow('This working copy exceeds the checkpoint size limit (64 MiB total, 8 MiB per file).')
    expect(f.readsInRepo()).toEqual([])
  })

  it('keeps a too-large verdict without Git or reads until the folder visibly changes', async () => {
    const f = await fixture({ files: { 'a.txt': 'small\n', 'big.bin': Buffer.alloc(8 * 1024 * 1024 + 1) } })
    await expect(f.capture.snapshot(f.repo, { reuse: true })).rejects.toThrow('size limit')
    f.commands.length = 0
    const message = 'This working copy exceeds the checkpoint size limit (64 MiB total, 8 MiB per file).'
    expect(await f.capture.heldVerdict(f.repo)).toBe(message)
    expect(f.commands).toEqual([])
    expect(f.readsInRepo()).toEqual([])
    // A file added at the top of the folder changes its listing.
    await writeFile(join(f.repo, 'nested.txt'), 'x'); await rm(join(f.repo, 'nested.txt'))
    expect(await f.capture.heldVerdict(f.repo)).toBeUndefined()
    await expect(f.capture.snapshot(f.repo, { reuse: true })).rejects.toThrow('size limit')
    await mkdir(join(f.repo, 'deep')); await expect(f.capture.snapshot(f.repo, { reuse: true })).rejects.toThrow('size limit')
    expect(await f.capture.heldVerdict(f.repo)).toBe(message)
    await writeFile(join(f.repo, 'deep', 'staged.txt'), 'staged'); git(f.repo, 'add', 'deep/staged.txt')
    expect(await f.capture.heldVerdict(f.repo)).toBeUndefined()
    await expect(f.capture.snapshot(f.repo, { reuse: true })).rejects.toThrow('size limit')
    // A commit moves HEAD's reflog even when the index keeps its size.
    git(f.repo, '-c', 'commit.gpgSign=false', 'commit', '-qm', 'Staged')
    expect(await f.capture.heldVerdict(f.repo)).toBeUndefined()
    await expect(f.capture.snapshot(f.repo, { reuse: true })).rejects.toThrow('size limit')
    // Removing the large file changes the folder's own listing, and the next capture succeeds.
    await rm(join(f.repo, 'big.bin'))
    expect(await f.capture.heldVerdict(f.repo)).toBeUndefined()
    await expect(f.capture.snapshot(f.repo, { reuse: true })).resolves.toMatchObject({ files: { 'a.txt': expect.anything() } })
    expect(await f.capture.heldVerdict(f.repo)).toBeUndefined()
  })

  it('keeps a failed listing verdict for a folder Git does not know until it becomes a repository', async () => {
    const f = await fixture({ repository: false })
    await expect(f.capture.snapshot(f.repo, { reuse: true })).rejects.toThrow()
    const verdict = await f.capture.heldVerdict(f.repo)
    expect(verdict).toMatch(/not a git repository/i)
    f.commands.length = 0
    expect(await f.capture.heldVerdict(f.repo)).toBe(verdict)
    expect(f.commands).toEqual([])
    git(f.repo, 'init', '-q')
    expect(await f.capture.heldVerdict(f.repo)).toBeUndefined()
  })

  it('holds no verdict over a listing that timed out or could not be started, which may pass', async () => {
    const f = await fixture({ repository: false })
    const failures = [Object.assign(new Error('Command failed: git ls-files'), { killed: true, code: null, signal: 'SIGTERM' }),
      Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' })]
    for (const failure of failures) {
      const capture = new CheckpointCapture({ blobDirectory: join(f.root, 'blobs'), blobSizes: new Map(), now: later,
        git: async (_cwd, args) => { if (args[0] === 'ls-files') throw failure; throw Object.assign(new Error('not a repository'), { code: 128 }) } })
      await expect(capture.snapshot(f.repo, { reuse: true })).rejects.toBe(failure)
      expect(await capture.heldVerdict(f.repo)).toBeUndefined()
    }
  })

  it('forgets every folder\'s verdict and remembered files', async () => {
    const f = await fixture({ files: { 'a.txt': 'small\n', 'big.bin': Buffer.alloc(8 * 1024 * 1024 + 1) } })
    await expect(f.capture.snapshot(f.repo, { reuse: true })).rejects.toThrow('size limit')
    await rm(join(f.repo, 'big.bin'))
    await f.capture.snapshot(f.repo, { reuse: true })
    await writeFile(join(f.repo, 'big.bin'), Buffer.alloc(8 * 1024 * 1024 + 1))
    await expect(f.capture.snapshot(f.repo, { reuse: true })).rejects.toThrow('size limit')
    expect(await f.capture.heldVerdict(f.repo)).toMatch('size limit')
    f.capture.forget()
    expect(await f.capture.heldVerdict(f.repo)).toBeUndefined()
    await rm(join(f.repo, 'big.bin')); f.reads.mockClear()
    await f.capture.snapshot(f.repo, { reuse: true })
    expect(f.readsInRepo()).toEqual([join(f.repo, 'a.txt')])
  })

  it('does not hold a verdict for a failure that may pass, such as a file that could not be read', async () => {
    const f = await fixture()
    vi.spyOn(fsPromises, 'readFile').mockImplementationOnce((...args) => typeof args[0] === 'string' && args[0].startsWith(f.repo)
      ? Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY' })) : realReadFile(...args))
    await expect(f.capture.snapshot(f.repo, { reuse: true })).rejects.toThrow('busy')
    expect(await f.capture.heldVerdict(f.repo)).toBeUndefined()
  })

  it('checks each directory once and refuses a directory junction', async () => {
    const files = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`deep/inner/file-${index}.txt`, `${index}\n`]))
    const f = await fixture({ files })
    const stats = vi.spyOn(fsPromises, 'lstat')
    await f.capture.snapshot(f.repo, { reuse: true })
    const calls = stats.mock.calls.map(([path]) => path)
    expect(calls.filter(path => path === join(f.repo, 'deep'))).toHaveLength(1)
    expect(calls.filter(path => path === join(f.repo, 'deep', 'inner'))).toHaveLength(1)
    const outside = join(f.root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'secret.txt'), 'outside\n')
    await symlink(outside, join(f.repo, 'linked'), 'junction')
    // Git lists the untracked junction as a file or as the files inside it; either way it is refused.
    await expect(f.capture.snapshot(f.repo, { reuse: true })).rejects.toThrow('Checkpoint paths cannot follow symbolic links or directory junctions.')
  })

  it('reads at most eight files at once', async () => {
    const files = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`file-${index}.txt`, `${index}\n`]))
    const f = await fixture({ files })
    // Every read is held open until eight are, then released together; a ninth would show in `most`.
    const held: (() => void)[] = []
    let hold = true, active = 0, most = 0
    vi.spyOn(fsPromises, 'readFile').mockImplementation(async (...args) => {
      active++; most = Math.max(most, active)
      try { if (hold) await new Promise<void>(resolve => held.push(resolve)); return await realReadFile(...args) } finally { active-- }
    })
    const snapshot = f.capture.snapshot(f.repo, { reuse: true })
    await expect.poll(() => held.length).toBe(8)
    hold = false
    for (const release of held.splice(0)) release()
    await snapshot
    expect(most).toBe(8)
  })

  it('starts no read after one fails, and settles the reads already started before it throws', async () => {
    const files = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`file-${index}.txt`, `${index}\n`]))
    const f = await fixture({ files })
    let started = 0, finished = 0
    vi.spyOn(fsPromises, 'readFile').mockImplementation(async (...args) => {
      if (typeof args[0] !== 'string' || !args[0].startsWith(f.repo)) return realReadFile(...args)
      if (started++ === 0) throw Object.assign(new Error('locked'), { code: 'EBUSY' })
      try { return await realReadFile(...args) } finally { finished++ }
    })
    await expect(f.capture.snapshot(f.repo, { reuse: true })).rejects.toThrow('locked')
    expect(started).toBeLessThanOrEqual(8)
    expect(finished).toBe(started - 1)
  })

  it('leaves out a file removed between its lstat and its read', async () => {
    const f = await fixture()
    vi.spyOn(fsPromises, 'readFile').mockImplementation(async (...args) => args[0] === join(f.repo, 'notes.txt')
      ? Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' })) : realReadFile(...args))
    expect(Object.keys((await f.capture.snapshot(f.repo, { reuse: true })).files)).toEqual(['app.txt'])
  })

  it('asks Git for a folder\'s checkout once', async () => {
    const f = await fixture()
    const lookup = vi.spyOn(worktrees, 'checkoutIdentity')
    expect(await f.capture.checkout(f.repo)).toBe(await f.capture.checkout(f.repo))
    expect(lookup).toHaveBeenCalledOnce()
  })
})
