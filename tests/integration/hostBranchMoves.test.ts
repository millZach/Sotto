// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto'
import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostBranchMoves } from '../../src/host/branchMoves'
import { BranchBundles, IncomingBundle, type PreparedBundle } from '../../src/main/agents/branchBundles'
import type { BranchMoveFolders } from '../../src/main/agents/branchMoves'
import { runGitStatusCommand, type RunGitCommand } from '../../src/main/agents/gitStatus'
import { BRANCH_TRANSFERS_MAX, branchMoveWords, incomingRef } from '../../src/shared/branchMoves'
import { commitFile, git, twoMachines } from '../fixtures/branchRepositories'

let machines: Awaited<ReturnType<typeof twoMachines>>
beforeEach(async () => { machines = await twoMachines() })
afterEach(async () => { await machines.close() })

/** Forge's side of a move, driven directly: `forge-project` is the forge clone and `forge-thread` works in it. */
function forge(run?: RunGitCommand): HostBranchMoves {
  const folders: BranchMoveFolders = {
    projectFolder: id => id === 'forge-project' ? machines.forge : undefined,
    threadFolder: id => id === 'forge-thread' ? machines.forge : undefined,
  }
  return new HostBranchMoves(new BranchBundles({ ...machines.data('forge'), ...(run ? { run } : {}) }), folders)
}

/** Git as the host runs it, except that `step` answers only once `release` is called. `reached` resolves when it has run. */
function held(step: (args: readonly string[]) => boolean) {
  let reach!: () => void, release!: () => void
  const reached = new Promise<void>(resolve => { reach = resolve }), released = new Promise<void>(resolve => { release = resolve })
  const run: RunGitCommand = async (cwd, command, args, options) => {
    const output = await runGitStatusCommand(cwd, command, args, options)
    if (step(args)) { reach(); await released }
    return output
  }
  return { run, reached, release }
}

/** A step held before Git runs it, until `release`; `reached` resolves when it is waiting. Gates combine with `gated`. */
function gate(step: (args: readonly string[]) => boolean) {
  let reach!: () => void, release!: () => void
  const reached = new Promise<void>(resolve => { reach = resolve }), released = new Promise<void>(resolve => { release = resolve })
  return { step, reached, release, async wait(args: readonly string[]) { if (step(args)) { reach(); await released } } }
}
function gated(...gates: ReturnType<typeof gate>[]): RunGitCommand {
  return async (cwd, command, args, options) => {
    for (const each of gates) await each.wait(args)
    return runGitStatusCommand(cwd, command, args, options)
  }
}

/** A feature branch on the laptop, bundled for `moveId` against nothing. */
async function laptopBundle(moveId: string): Promise<{ laptop: BranchBundles; prepared: PreparedBundle; commit: string }> {
  git(machines.laptop, 'switch', '-q', '-c', 'feature/login')
  const commit = await commitFile(machines.laptop, 'login.txt', 'form\n')
  const laptop = new BranchBundles(machines.data('laptop'))
  const prepared = await laptop.prepare({ repository: machines.laptop, moveId, commit, bases: [] })
  if (prepared.type !== 'sending') throw new Error('The laptop could not bundle its branch.')
  return { laptop, prepared, commit }
}

/** A connection as the socket server hands one over: an owner object and the signal that ends when it closes. */
function connection() { const closed = new AbortController(); return { owner: {}, gone: closed.signal, close: () => closed.abort() } }

describe('a host’s side of branch moves (ADR-0105 decision 8)', () => {
  it('admits four begins that arrive together and refuses the fifth with the busy sentence', async () => {
    const host = forge(), peer = connection()
    const commit = git(machines.forge, 'rev-parse', 'main')
    const answers = await Promise.all(Array.from({ length: BRANCH_TRANSFERS_MAX + 1 }, () => host.handle({ action: 'receive-begin', moveId: randomUUID(),
      projectId: 'forge-project', branch: 'main', commit, size: 100, sha256: '0'.repeat(64) }, peer.owner, peer.gone)))
    expect(answers.filter(answer => (answer as { type: string }).type === 'receiving')).toHaveLength(BRANCH_TRANSFERS_MAX)
    expect(answers.filter(answer => (answer as { type: string }).type === 'refused')).toEqual([{ type: 'refused', reason: 'busy', message: branchMoveWords.busy }])
    expect(host.staged).toBe(BRANCH_TRANSFERS_MAX)
    peer.close()
    await expect.poll(() => host.staged).toBe(0)
    await expect.poll(() => readdir(machines.data('forge').stagingDirectory)).toEqual([])
  })

  it('creates no ref once a move is ended or its connection drops, even when its import was already under way', async () => {
    for (const ending of ['end', 'drop'] as const) {
      const moveId = randomUUID()
      const { laptop, prepared, commit } = await laptopBundle(moveId)
      const importing = held(args => args[0] === 'bundle' && args[1] === 'unbundle')
      const host = forge(importing.run), peer = connection()
      expect(await host.handle({ action: 'receive-begin', moveId, projectId: 'forge-project', branch: 'feature/login', commit, size: prepared.size, sha256: prepared.sha256 }, peer.owner, peer.gone))
        .toEqual({ type: 'receiving' })
      expect(await host.handle({ action: 'receive-chunk', moveId, offset: 0, data: (await laptop.readChunk(prepared.path, 0)).toString('base64') }, peer.owner, peer.gone))
        .toEqual({ type: 'received', bytes: prepared.size })
      const finished = host.handle({ action: 'receive-finish', moveId }, peer.owner, peer.gone)
      await importing.reached
      if (ending === 'end') expect(await host.handle({ action: 'end', moveId }, peer.owner, peer.gone)).toBeNull()
      else peer.close()
      importing.release()
      expect(await finished).toEqual({ type: 'refused', reason: 'cut-off', message: branchMoveWords.cutOff })
      expect(git(machines.forge, 'for-each-ref', 'refs/sotto')).toBe('')
      await expect.poll(() => host.staged).toBe(0)
      await laptop.discard(prepared)
      git(machines.laptop, 'switch', '-q', 'main')
      git(machines.laptop, 'branch', '-q', '-D', 'feature/login')
    }
  })

  it('drops only its own attempt when a refused chunk finishes after end and a retry on a new connection', async () => {
    const moveId = randomUUID()
    const { laptop, prepared, commit } = await laptopBundle(moveId)
    const host = forge(), old = connection(), fresh = connection()
    const begin = { action: 'receive-begin', moveId, projectId: 'forge-project', branch: 'feature/login', commit, size: prepared.size, sha256: prepared.sha256 } as const
    expect(await host.handle(begin, old.owner, old.gone)).toEqual({ type: 'receiving' })
    // The old connection's chunk is out of order, and its write is held until the move has ended and been retried.
    let reach!: () => void, release!: () => void
    const reached = new Promise<void>(resolve => { reach = resolve }), released = new Promise<void>(resolve => { release = resolve })
    const write = IncomingBundle.prototype.write
    const spy = vi.spyOn(IncomingBundle.prototype, 'write').mockImplementation(async function (this: IncomingBundle, offset, bytes) {
      if (offset === 1) { reach(); await released }
      return write.call(this, offset, bytes)
    })
    try {
      const chunk = (await laptop.readChunk(prepared.path, 0)).toString('base64')
      const stale = host.handle({ action: 'receive-chunk', moveId, offset: 1, data: chunk }, old.owner, old.gone)
      await reached
      expect(await host.handle({ action: 'end', moveId }, old.owner, old.gone)).toBeNull()
      expect(await host.handle(begin, fresh.owner, fresh.gone)).toEqual({ type: 'receiving' })
      release()
      expect(await stale).toEqual({ type: 'refused', reason: 'not-whole', message: branchMoveWords.notWhole })
      // The retry keeps its place and its staged file, and lands.
      expect(host.staged).toBe(1)
      expect(await readdir(machines.data('forge').stagingDirectory)).toHaveLength(1)
      expect(await host.handle({ action: 'receive-chunk', moveId, offset: 0, data: chunk }, fresh.owner, fresh.gone)).toEqual({ type: 'received', bytes: prepared.size })
      expect(await host.handle({ action: 'receive-finish', moveId }, fresh.owner, fresh.gone)).toMatchObject({ type: 'moved', moveId, commit })
      expect(git(machines.forge, 'rev-parse', incomingRef(moveId, 'feature/login'))).toBe(commit)
    } finally { spy.mockRestore(); await laptop.discard(prepared) }
  })

  it('lets an attempt left by a dropped connection clean up only its own, not the retry on the new connection', async () => {
    let bundled = 0
    // The first attempt's bundle is written, then held there while its connection drops and the retry takes the move.
    const first = held(args => args[0] === 'bundle' && args[1] === 'create' && ++bundled === 1)
    const host = forge(first.run), old = connection(), fresh = connection()
    const moveId = randomUUID(), commit = git(machines.forge, 'rev-parse', 'main')
    const stale = host.handle({ action: 'send-begin', moveId, threadId: 'forge-thread', bases: [] }, old.owner, old.gone)
    await first.reached
    old.close()
    await expect.poll(() => host.staged).toBe(0)
    const retry = host.handle({ action: 'send-begin', moveId, threadId: 'forge-thread', bases: [] }, fresh.owner, fresh.gone)
    first.release()
    expect(await stale).toEqual({ type: 'refused', reason: 'cut-off', message: branchMoveWords.cutOff })
    const sending = await retry as { type: string; commit: string; size: number }
    expect(sending).toMatchObject({ type: 'sending', branch: 'main', commit })
    expect(host.staged).toBe(1)
    // The retry's bundle is still there to read, whole.
    let bytes = 0
    while (bytes < sending.size) {
      const chunk = await host.handle({ action: 'send-chunk', moveId, offset: bytes }, fresh.owner, fresh.gone) as { type: string; data: string }
      expect(chunk.type).toBe('chunk')
      bytes += Buffer.from(chunk.data, 'base64').byteLength
    }
    expect(bytes).toBe(sending.size)
    expect(await readdir(machines.data('forge').stagingDirectory)).toHaveLength(1)
    expect(await host.handle({ action: 'end', moveId }, fresh.owner, fresh.gone)).toBeNull()
    expect(await readdir(machines.data('forge').stagingDirectory)).toEqual([])
    expect(git(machines.forge, 'for-each-ref', 'refs/sotto')).toBe('')
  })

  it('drops only the attempts a closed connection held, never a retry that took one of their places meanwhile', async () => {
    const first = randomUUID(), second = randomUUID()
    const { laptop, prepared, commit } = await laptopBundle(first)
    let verified = 0
    // The first move's ref is held as it is created, so the closed connection's cleanup waits on it.
    const landing = gate(args => args[0] === 'update-ref' && args.includes(incomingRef(first, 'feature/login')))
    // The second move's first check is held, then fails: it did not arrive whole, so its place comes free on its own.
    const checking = gate(args => args[0] === 'bundle' && args[1] === 'verify' && args.some(arg => arg.includes(second)) && ++verified === 1)
    const host = forge(gated(landing, checking)), old = connection(), fresh = connection()
    const send = async (moveId: string, bytes: Buffer, sha256: string, peer: ReturnType<typeof connection>) => {
      expect(await host.handle({ action: 'receive-begin', moveId, projectId: 'forge-project', branch: 'feature/login', commit, size: bytes.byteLength, sha256 }, peer.owner, peer.gone))
        .toEqual({ type: 'receiving' })
      expect(await host.handle({ action: 'receive-chunk', moveId, offset: 0, data: bytes.toString('base64') }, peer.owner, peer.gone)).toEqual({ type: 'received', bytes: bytes.byteLength })
      return host.handle({ action: 'receive-finish', moveId }, peer.owner, peer.gone)
    }
    const firstFinished = send(first, await laptop.readChunk(prepared.path, 0), prepared.sha256, old)
    await landing.reached
    const garbage = Buffer.from('not a bundle')
    const secondFinished = send(second, garbage, createHash('sha256').update(garbage).digest('hex'), old)
    await checking.reached
    old.close()
    checking.release()
    expect(await secondFinished).toMatchObject({ type: 'refused', reason: 'not-whole' })
    // The retry of the second move, on a new connection, takes the place the old attempt left.
    const retry = await laptop.prepare({ repository: machines.laptop, moveId: second, commit, bases: [] })
    if (retry.type !== 'sending') throw new Error('The laptop could not bundle its branch again.')
    expect(await host.handle({ action: 'receive-begin', moveId: second, projectId: 'forge-project', branch: 'feature/login', commit, size: retry.size, sha256: retry.sha256 }, fresh.owner, fresh.gone))
      .toEqual({ type: 'receiving' })
    landing.release()
    await firstFinished
    // The old connection's cleanup has run past the first move; the retry is still the host's to finish.
    expect(await host.handle({ action: 'receive-chunk', moveId: second, offset: 0, data: (await laptop.readChunk(retry.path, 0)).toString('base64') }, fresh.owner, fresh.gone))
      .toEqual({ type: 'received', bytes: retry.size })
    expect(await host.handle({ action: 'receive-finish', moveId: second }, fresh.owner, fresh.gone))
      .toEqual({ type: 'moved', moveId: second, branch: 'feature/login', commit, ref: incomingRef(second, 'feature/login') })
    await laptop.discard(prepared)
    await laptop.discard(retry)
  })

  it('creates no ref for a move of a commit the host already has once it is ended or its connection drops', async () => {
    for (const ending of ['end', 'drop'] as const) {
      const moveId = randomUUID(), commit = git(machines.forge, 'rev-parse', 'main')
      const checking = gate(args => args[0] === 'rev-list' && args.includes(commit))
      const host = forge(gated(checking)), peer = connection()
      const landed = host.handle({ action: 'receive-ref', moveId, projectId: 'forge-project', branch: 'main', commit }, peer.owner, peer.gone)
      await checking.reached
      if (ending === 'end') expect(await host.handle({ action: 'end', moveId }, peer.owner, peer.gone)).toBeNull()
      else peer.close()
      checking.release()
      expect(await landed).toEqual({ type: 'refused', reason: 'cut-off', message: branchMoveWords.cutOff })
      expect(git(machines.forge, 'for-each-ref', 'refs/sotto')).toBe('')
      await expect.poll(() => host.staged).toBe(0)
    }
  })

  it('creates no ref for a copy on the same host once it is ended or its connection drops, however far it had got', async () => {
    // Held while the thread's working copy is read, before anything is copied; and, for a test run's snapshot that has to
    // go across as a bundle, while that bundle is imported.
    const cases = [
      { snapshot: false, step: (args: readonly string[]) => args[0] === 'status' },
      { snapshot: true, step: (args: readonly string[]) => args[0] === 'bundle' && args[1] === 'unbundle' },
    ]
    for (const { snapshot, step } of cases) {
      for (const ending of ['end', 'drop'] as const) {
        if (snapshot) await writeFile(join(machines.forge, 'notes.txt'), 'draft')
        const moveId = randomUUID(), held = gate(step)
        const host = forge(gated(held)), peer = connection()
        const copied = host.handle({ action: 'copy', moveId, threadId: 'forge-thread', projectId: 'forge-project', snapshot }, peer.owner, peer.gone)
        await held.reached
        if (ending === 'end') expect(await host.handle({ action: 'end', moveId }, peer.owner, peer.gone)).toBeNull()
        else peer.close()
        held.release()
        expect(await copied).toEqual({ type: 'refused', reason: 'cut-off', message: branchMoveWords.cutOff })
        expect(git(machines.forge, 'for-each-ref', 'refs/sotto')).toBe('')
        await expect.poll(() => host.staged).toBe(0)
        await expect.poll(() => readdir(machines.data('forge').stagingDirectory).catch(() => [])).toEqual([])
      }
    }
  })
})
