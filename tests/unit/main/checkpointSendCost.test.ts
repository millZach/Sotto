// @vitest-environment node
import * as fsPromises from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as worktrees from '../../../src/main/agents/threadWorktrees'
import { FilesService } from '../../../src/main/files/service'
import { CheckpointService } from '../../../src/main/tools/checkpoints'
import type { CheckpointDependencies, CheckpointThread } from '../../../src/main/tools/checkpointTypes'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual }
})

/** Taken before any test replaces it. */
const realUnlink = fsPromises.unlink
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const dispose of cleanup.splice(0).reverse()) await dispose() })
const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => { if (!result.ok) throw new Error(JSON.stringify(result)); return result.value }
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' })

async function fixture(files: Record<string, string | Buffer> = { 'app.txt': 'before\n', 'notes.txt': 'original notes\n' }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sotto-checkpoint-send-')))
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const repo = join(root, 'repo'); await mkdir(repo)
  git(repo, 'init', '-q'); git(repo, 'config', 'core.autocrlf', 'false'); git(repo, 'config', 'user.name', 'Sotto checkpoint fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid')
  for (const [path, contents] of Object.entries(files)) await writeFile(join(repo, path), contents)
  git(repo, 'add', '.'); git(repo, '-c', 'commit.gpgSign=false', 'commit', '-qm', 'Fixture')
  const state: CheckpointThread = { threadId: 'thread-a', providerId: 'codex', bindingId: 'native-a', userMessageIds: [], busy: false, running: false, rollbackSupported: true }
  const filesService = new FilesService({ resolveBinding: threadId => ({ threadId, projectId: 'project', workingDirectory: repo }), copyPath: vi.fn(), reveal: vi.fn() })
  const dependencies: CheckpointDependencies = { files: filesService, directory: join(root, 'checkpoints'), report: vi.fn(),
    resolveThread: async id => id === state.threadId ? { ...state } : null, rollback: vi.fn(async () => ({ accepted: true })), refresh: vi.fn(async () => undefined) }
  const start = () => { const service = new CheckpointService(dependencies); cleanup.push(async () => service.dispose()); return service }
  const service = start()
  const owner = unwrap(await filesService.resolveWorkspace(state.threadId))
  const target = { threadId: state.threadId, workspaceId: owner.workspaceId }
  const reads = vi.spyOn(fsPromises, 'readFile')
  const readsInRepo = () => reads.mock.calls.filter(([path]) => typeof path === 'string' && path.startsWith(repo)).length
  const stored = join(dependencies.directory, 'checkpoints.json'), journal = join(dependencies.directory, 'checkpoints.journal')
  const turn = async (service: CheckpointService, edit?: () => Promise<void>) => {
    await service.beforeTurn(state.threadId)
    await edit?.()
    state.userMessageIds = [...state.userMessageIds, `user-${state.userMessageIds.length + 1}`]
    await service.afterTurn(state.threadId)
  }
  return { root, repo, state, dependencies, service, start, target, reads, readsInRepo, stored, journal, turn }
}

describe('what a send pays for its checkpoint', () => {
  it('skips a working copy over the limit on every send after the first, without Git or reads', async () => {
    const f = await fixture({ 'app.txt': 'before\n', 'big.bin': Buffer.alloc(8 * 1024 * 1024 + 1) })
    await f.service.initialize()
    const commands = vi.spyOn(f.service as unknown as { git(cwd: string, args: string[]): Promise<string> }, 'git')
    const identity = vi.spyOn(worktrees, 'checkoutIdentity')
    await f.turn(f.service)
    expect(commands).toHaveBeenCalled()
    commands.mockClear(); identity.mockClear(); f.reads.mockClear()
    const file = await readFile(f.stored, 'utf8')
    await f.turn(f.service); await f.turn(f.service)
    expect(commands).not.toHaveBeenCalled()
    expect(identity).not.toHaveBeenCalled()
    expect(f.readsInRepo()).toBe(0)
    // The sends were journaled; the file was not rewritten.
    expect(await readFile(f.stored, 'utf8')).toBe(file)
    expect((await readFile(f.journal, 'utf8')).trim().split('\n')).toHaveLength(3)
    const checkpoints = unwrap(await f.service.checkpoints(f.target)).checkpoints
    expect(checkpoints).toHaveLength(3)
    for (const checkpoint of checkpoints) expect(checkpoint).toMatchObject({ status: 'unavailable', reason: 'This working copy exceeds the checkpoint size limit (64 MiB total, 8 MiB per file).' })
  })

  it('reads no file contents for a send into a working copy unchanged since its last snapshot', async () => {
    const f = await fixture()
    // Every file is older than the snapshots, so none is too recent to trust.
    const now = Date.now() + 60_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    await f.service.initialize()
    await f.turn(f.service)
    expect(f.readsInRepo()).toBe(2)
    f.reads.mockClear()
    await f.turn(f.service, () => writeFile(join(f.repo, 'app.txt'), 'after\n'))
    // The turn's own edit is the only file read, by its completion snapshot.
    expect(f.reads.mock.calls.map(([path]) => path).filter(path => typeof path === 'string' && path.startsWith(f.repo))).toEqual([join(f.repo, 'app.txt')])
    f.reads.mockClear()
    await f.service.beforeTurn(f.state.threadId)
    expect(f.readsInRepo()).toBe(0)
    const [latest] = unwrap(await f.service.checkpoints(f.target)).checkpoints
    expect(latest).toMatchObject({ status: 'ready', files: [{ path: 'app.txt', change: 'modified' }] })
    const review = unwrap(await f.service.inspectCheckpoint({ ...f.target, checkpointId: latest!.id }))
    expect(review.patches).toEqual([{ path: 'app.txt', before: 'before\n', after: 'after\n', binary: false }])
  })

  it('keeps a send\'s capturing record through a restart from the journal alone', async () => {
    const f = await fixture()
    await f.service.initialize()
    const file = await readFile(f.stored, 'utf8')
    await f.service.beforeTurn(f.state.threadId)
    await writeFile(join(f.repo, 'app.txt'), 'native turn edit\n')
    f.state.userMessageIds = ['user-1']
    expect(await readFile(f.stored, 'utf8')).toBe(file)
    f.service.dispose()
    const restarted = f.start()
    await restarted.initialize()
    const [checkpoint] = unwrap(await restarted.checkpoints(f.target)).checkpoints
    expect(checkpoint).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('interrupted') })
    expect((JSON.parse(await readFile(f.stored, 'utf8')) as { records: { id: string }[] }).records.map(record => record.id)).toEqual([checkpoint!.id])
    expect(await readdir(f.dependencies.directory)).not.toContain('checkpoints.journal')
  })

  it('ignores an append cut short and sets aside a damaged journal line with the usual notice', async () => {
    const f = await fixture()
    await f.service.initialize()
    await f.service.beforeTurn(f.state.threadId)
    f.service.dispose()
    const lines = await readFile(f.journal, 'utf8')
    await writeFile(f.journal, `${lines}{"generation":`)
    const restarted = f.start()
    await restarted.initialize()
    expect(unwrap(await restarted.checkpoints(f.target)).checkpoints).toHaveLength(1)
    expect(f.dependencies.report).not.toHaveBeenCalled()
    expect((await readdir(f.dependencies.directory)).filter(name => name.startsWith('checkpoints.json.corrupt-'))).toEqual([])

    await restarted.beforeTurn(f.state.threadId)
    restarted.dispose()
    await writeFile(f.journal, `not a record\n${await readFile(f.journal, 'utf8')}`)
    const repaired = f.start()
    await repaired.initialize()
    const backup = (await readdir(f.dependencies.directory)).find(name => name.startsWith('checkpoints.json.corrupt-'))!
    expect(f.dependencies.report).toHaveBeenCalledWith(`Sotto set aside a checkpoint file it could not read as ${backup} and kept the rest.`)
    expect(unwrap(await repaired.checkpoints(f.target)).checkpoints).toHaveLength(2)
  })

  it('never brings back a forgotten thread\'s checkpoint from a journal that could not be removed', async () => {
    const f = await fixture()
    await f.service.initialize()
    await f.service.beforeTurn(f.state.threadId)
    vi.spyOn(fsPromises, 'unlink').mockImplementation(async path => {
      if (path === f.journal) throw Object.assign(new Error('private path'), { code: 'EACCES' })
      await realUnlink(path)
    })
    await f.service.forgetThread(f.state.threadId)
    expect(await readFile(f.journal, 'utf8')).toContain(f.state.threadId)
    vi.mocked(fsPromises.unlink).mockRestore()
    f.service.dispose()
    const restarted = f.start()
    await restarted.initialize()
    expect(unwrap(await restarted.checkpoints(f.target)).checkpoints).toEqual([])
    expect(await readdir(f.dependencies.directory)).not.toContain('checkpoints.journal')
  })

  it('folds the journal into the file once it outgrows it', async () => {
    const f = await fixture({ 'app.txt': 'before\n', 'big.bin': Buffer.alloc(8 * 1024 * 1024 + 1) })
    await f.service.initialize()
    let rewrites = 0, previous = await readFile(f.stored, 'utf8')
    for (let send = 0; send < 200; send++) {
      await f.service.beforeTurn(f.state.threadId)
      f.state.userMessageIds = [...f.state.userMessageIds, `user-${send}`]
      const current = await readFile(f.stored, 'utf8')
      if (current !== previous) { rewrites++; previous = current }
    }
    expect(rewrites).toBeGreaterThan(0)
    expect(rewrites).toBeLessThan(20)
    f.service.dispose()
    const restarted = f.start()
    await restarted.initialize()
    expect(unwrap(await restarted.checkpoints(f.target)).checkpoints).toHaveLength(200)
  }, 60_000)
})
