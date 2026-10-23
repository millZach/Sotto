// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HostBranchMoves } from '../../src/host/branchMoves'
import { BranchBundles, type PreparedBundle } from '../../src/main/agents/branchBundles'
import type { BranchMoveFolders } from '../../src/main/agents/branchMoves'
import { runGitStatusCommand, type RunGitCommand } from '../../src/main/agents/gitStatus'
import { BRANCH_TRANSFERS_MAX, branchMoveWords } from '../../src/shared/branchMoves'
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
})
