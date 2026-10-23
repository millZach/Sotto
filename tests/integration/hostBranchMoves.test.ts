// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HostBranchMoves } from '../../src/host/branchMoves'
import { BranchBundles } from '../../src/main/agents/branchBundles'
import type { BranchMoveFolders } from '../../src/main/agents/branchMoves'
import { BRANCH_TRANSFERS_MAX, branchMoveWords } from '../../src/shared/branchMoves'
import { git, twoMachines } from '../fixtures/branchRepositories'

let machines: Awaited<ReturnType<typeof twoMachines>>
beforeEach(async () => { machines = await twoMachines() })
afterEach(async () => { await machines.close() })

/** Forge's side of a move, driven directly: `forge-project` is the forge clone and `forge-thread` works in it. */
function forge(): HostBranchMoves {
  const folders: BranchMoveFolders = {
    projectFolder: id => id === 'forge-project' ? machines.forge : undefined,
    threadFolder: id => id === 'forge-thread' ? machines.forge : undefined,
  }
  return new HostBranchMoves(new BranchBundles(machines.data('forge')), folders)
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
})
