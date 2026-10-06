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
    // The clock is behind the files, so every file reads as written just now.
    const f = await fixture({ now: () => Date.now() - 60_000 })
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

  it('keeps a failed listing verdict for a folder Git does not know until it or a folder above becomes a repository', async () => {
    const f = await fixture({ repository: false })
    const home = join(f.root, 'home'); await mkdir(home)
    vi.stubEnv('HOME', home); vi.stubEnv('XDG_CONFIG_HOME', join(home, '.config'))
    cleanup.push(async () => { vi.unstubAllEnvs() })
    const unlisted = 'Git cannot list the files in this working copy, so no checkpoint was taken. Checkpoints need a folder inside a Git repository that Git trusts.'
    await expect(f.capture.snapshot(f.repo, { reuse: true })).rejects.toThrow(unlisted)
    expect(await f.capture.heldVerdict(f.repo)).toBe(unlisted)
    f.commands.length = 0
    expect(await f.capture.heldVerdict(f.repo)).toBe(unlisted)
    expect(f.commands).toEqual([])
    git(f.repo, 'init', '-q')
    expect(await f.capture.heldVerdict(f.repo)).toBeUndefined()
    await rm(join(f.repo, '.git'), { recursive: true, force: true })

    // A repository made in a folder above it.
    await expect(f.capture.snapshot(f.repo, { reuse: true })).rejects.toThrow(unlisted)
    expect(await f.capture.heldVerdict(f.repo)).toBe(unlisted)
    git(f.root, 'init', '-q')
    expect(await f.capture.heldVerdict(f.repo)).toBeUndefined()
    await rm(join(f.root, '.git'), { recursive: true, force: true })

    // Git told to trust it, as `git config --global --add safe.directory` does.
    await expect(f.capture.snapshot(f.repo, { reuse: true })).rejects.toThrow(unlisted)
    expect(await f.capture.heldVerdict(f.repo)).toBe(unlisted)
    await writeFile(join(home, '.gitconfig'), `[safe]\n\tdirectory = ${f.repo.replaceAll('\\', '/')}\n`)
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

  it('holds a listing that outgrew Git\'s buffer, in the file count\'s words, only until an ignore file changes', async () => {
    const f = await fixture({ files: { 'a.txt': 'small\n', '.gitignore': 'ignored/\n' } })
    const overflow = Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
    const capture = new CheckpointCapture({ blobDirectory: join(f.root, 'blobs'), blobSizes: new Map(), now: later,
      git: (cwd, args) => args[0] === 'ls-files' && args[1] === '-c' ? Promise.reject(overflow)
        : new Promise((done, reject) => execFile('git', args, { cwd, windowsHide: true, encoding: 'utf8' }, (error, output) => error ? reject(error) : done(output))) })
    await expect(capture.snapshot(f.repo, { reuse: true })).rejects.toThrow('This working copy exceeds the 10,000-file checkpoint limit.')
    expect(await capture.heldVerdict(f.repo)).toMatch('10,000-file')
    // Saved in place, as an editor does: nothing in Git's state or the top-level listing moves.
    await writeFile(join(f.repo, '.gitignore'), 'ignored/\nnode_modules/\n')
    expect(await capture.heldVerdict(f.repo)).toBeUndefined()

    await expect(capture.snapshot(f.repo, { reuse: true })).rejects.toThrow('10,000-file')
    expect(await capture.heldVerdict(f.repo)).toMatch('10,000-file')
    await writeFile(join(f.repo, '.git', 'info', 'exclude'), 'build/\n')
    expect(await capture.heldVerdict(f.repo)).toBeUndefined()
  })

  it('watches the ignore files Git reads for a linked worktree and for a folder below the top of the working tree', async () => {
    const big = Buffer.alloc(8 * 1024 * 1024 + 1)
    const f = await fixture({ files: { 'a.txt': 'small\n', 'app/b.txt': 'small\n' } })
    const worktree = join(f.root, 'worktree')
    git(f.repo, 'worktree', 'add', '-q', worktree)
    await writeFile(join(worktree, 'big.bin'), big)
    await expect(f.capture.snapshot(worktree, { reuse: true })).rejects.toThrow('size limit')
    expect(await f.capture.heldVerdict(worktree)).toMatch('size limit')
    // A linked worktree shares the main checkout's `info/exclude`.
    await writeFile(join(f.repo, '.git', 'info', 'exclude'), 'big.bin\n')
    expect(await f.capture.heldVerdict(worktree)).toBeUndefined()
    await expect(f.capture.snapshot(worktree, { reuse: true })).resolves.toBeDefined()

    const below = join(f.repo, 'app')
    await writeFile(join(below, 'big.bin'), big)
    await writeFile(join(f.repo, '.git', 'info', 'exclude'), '')
    await expect(f.capture.snapshot(below, { reuse: true })).rejects.toThrow('size limit')
    expect(await f.capture.heldVerdict(below)).toMatch('size limit')
    // The `.gitignore` at the top of the working tree, which the folder's own listing does not name.
    await writeFile(join(f.repo, '.gitignore'), 'big.bin\n')
    expect(await f.capture.heldVerdict(below)).toBeUndefined()
    await expect(f.capture.snapshot(below, { reuse: true })).resolves.toBeDefined()
  })

  it('holds an invalid listed path\'s verdict only until its directory changes', async () => {
    const f = await fixture({ files: { 'a.txt': 'small\n', 'deep/inner.txt': 'inner\n' } })
    // A name the checkpoint store cannot represent, as Git might list one from another platform.
    const capture = new CheckpointCapture({ blobDirectory: join(f.root, 'blobs'), blobSizes: new Map(), now: later,
      git: (cwd, args) => new Promise((done, reject) => execFile('git', args, { cwd, windowsHide: true, encoding: 'utf8' },
        (error, output) => error ? reject(error) : done(args[0] === 'ls-files' && args[1] === '-c' ? `${output}deep/trailing.\0` : output))) })
    await expect(capture.snapshot(f.repo, { reuse: true })).rejects.toThrow('This tool request is invalid.')
    expect(await capture.heldVerdict(f.repo)).toMatch('This tool request is invalid.')
    // Removing a file below the top level moves neither Git's state nor the top-level listing, only its directory's.
    await rm(join(f.repo, 'deep', 'inner.txt'))
    expect(await capture.heldVerdict(f.repo)).toBeUndefined()
  })

  it('watches the nearest directory that can be watched when a listed directory\'s own name is invalid', async () => {
    const f = await fixture({ files: { 'a.txt': 'small\n', 'deep/inner.txt': 'inner\n' } })
    const capture = new CheckpointCapture({ blobDirectory: join(f.root, 'blobs'), blobSizes: new Map(), now: later,
      git: (cwd, args) => new Promise((done, reject) => execFile('git', args, { cwd, windowsHide: true, encoding: 'utf8' },
        (error, output) => error ? reject(error) : done(args[0] === 'ls-files' && args[1] === '-c' ? `${output}deep/trailing./out.log\0` : output))) })
    await expect(capture.snapshot(f.repo, { reuse: true })).rejects.toThrow('This tool request is invalid.')
    expect(await capture.heldVerdict(f.repo)).toMatch('This tool request is invalid.')
    await rm(join(f.repo, 'deep', 'inner.txt'))
    expect(await capture.heldVerdict(f.repo)).toBeUndefined()
  })

  it('keeps watching the ignore files when the files behind a verdict are too many to watch', async () => {
    const f = await fixture({ files: { 'a.txt': 'small\n', '.gitignore': 'ignored/\n' } })
    await mkdir(join(f.repo, 'bulk'))
    // Over the total size in 1,100 files of 64 KiB, more than a verdict watches. They are listed and sized, not written.
    const bulk = Array.from({ length: 1_100 }, (_, index) => `bulk/part-${index}.bin`)
    const capture = new CheckpointCapture({ blobDirectory: join(f.root, 'blobs'), blobSizes: new Map(), now: later,
      git: (cwd, args) => new Promise((done, reject) => execFile('git', args, { cwd, windowsHide: true, encoding: 'utf8' },
        (error, output) => error ? reject(error) : done(args[0] === 'ls-files' && args[1] === '-c' ? `${output}${bulk.join('\0')}\0` : output))) })
    const small = await lstat(join(f.repo, 'a.txt'), { bigint: true })
    const sized = Object.assign(Object.create(Object.getPrototypeOf(small) as object) as BigIntStats, small, { size: 64n * 1024n })
    const actual = fsPromises.lstat
    vi.spyOn(fsPromises, 'lstat').mockImplementation(((target: string, options?: { bigint?: boolean }) =>
      target.includes(`${join('bulk', 'part-')}`) ? Promise.resolve(sized) : actual(target, options as never)) as typeof fsPromises.lstat)
    await expect(capture.snapshot(f.repo, { reuse: true })).rejects.toThrow('size limit')
    expect(await capture.heldVerdict(f.repo)).toMatch('size limit')
    await writeFile(join(f.repo, '.gitignore'), 'ignored/\nbulk/\n')
    expect(await capture.heldVerdict(f.repo)).toBeUndefined()
  })

  it('holds a verdict only while the paths that decided it are as they were', async () => {
    const big = Buffer.alloc(8 * 1024 * 1024 + 1)
    const f = await fixture({ files: { 'a.txt': 'small\n', 'assets/big.bin': big, '.gitignore': 'ignored/\n' } })
    // A tracked file removed below the top level: the listing at the top, HEAD and the index stay as they were.
    await expect(f.capture.snapshot(f.repo, { reuse: true })).rejects.toThrow('size limit')
    expect(await f.capture.heldVerdict(f.repo)).toMatch('size limit')
    await rm(join(f.repo, 'assets', 'big.bin'))
    expect(await f.capture.heldVerdict(f.repo)).toBeUndefined()
    await expect(f.capture.snapshot(f.repo, { reuse: true })).resolves.toBeDefined()

    // An untracked file cut down in place.
    await writeFile(join(f.repo, 'assets', 'loose.bin'), big)
    await expect(f.capture.snapshot(f.repo, { reuse: true })).rejects.toThrow('size limit')
    await writeFile(join(f.repo, 'assets', 'loose.bin'), 'small now')
    expect(await f.capture.heldVerdict(f.repo)).toBeUndefined()
    await expect(f.capture.snapshot(f.repo, { reuse: true })).resolves.toBeDefined()

    // `.gitignore` saved in place so that Git no longer lists the large file.
    await writeFile(join(f.repo, 'assets', 'loose.bin'), big)
    await expect(f.capture.snapshot(f.repo, { reuse: true })).rejects.toThrow('size limit')
    await writeFile(join(f.repo, '.gitignore'), 'ignored/\nassets/loose.bin\n')
    expect(await f.capture.heldVerdict(f.repo)).toBeUndefined()
    await expect(f.capture.snapshot(f.repo, { reuse: true })).resolves.toBeDefined()

    // A directory junction below the top level, then removed.
    const outside = join(f.root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'secret.txt'), 'outside\n')
    await symlink(outside, join(f.repo, 'assets', 'linked'), 'junction')
    await expect(f.capture.snapshot(f.repo, { reuse: true })).rejects.toThrow('Checkpoint paths cannot follow symbolic links or directory junctions.')
    expect(await f.capture.heldVerdict(f.repo)).toMatch('symbolic links')
    await rm(join(f.repo, 'assets', 'linked'), { force: true })
    expect(await f.capture.heldVerdict(f.repo)).toBeUndefined()
    await expect(f.capture.snapshot(f.repo, { reuse: true })).resolves.toBeDefined()
  })

  it('holds a file-count verdict while no directory holding a listed file gains or loses one', async () => {
    const f = await fixture({ files: { 'a.txt': 'small\n', 'deep/inner.txt': 'inner\n' } })
    const many = Array.from({ length: 10_000 }, (_, index) => `deep/listed-${index}.txt`).join('\0')
    const capture = new CheckpointCapture({ blobDirectory: join(f.root, 'blobs'), blobSizes: new Map(), now: later,
      git: (cwd, args) => new Promise((done, reject) => execFile('git', args, { cwd, windowsHide: true, encoding: 'utf8' },
        (error, output) => error ? reject(error) : done(args[0] === 'ls-files' && args[1] === '-c' ? `${output}${many}\0` : output))) })
    await expect(capture.snapshot(f.repo, { reuse: true })).rejects.toThrow('This working copy exceeds the 10,000-file checkpoint limit.')
    expect(await capture.heldVerdict(f.repo)).toMatch('10,000-file')
    await rm(join(f.repo, 'deep', 'inner.txt'))
    expect(await capture.heldVerdict(f.repo)).toBeUndefined()
  })

  it('holds no verdict over a path changed too recently to trust', async () => {
    // The clock is behind the files, so the large file reads as written just now.
    const f = await fixture({ files: { 'a.txt': 'small\n', 'big.bin': Buffer.alloc(8 * 1024 * 1024 + 1) }, now: () => Date.now() - 60_000 })
    await expect(f.capture.snapshot(f.repo, { reuse: true })).rejects.toThrow('size limit')
    expect(await f.capture.heldVerdict(f.repo)).toBeUndefined()
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
