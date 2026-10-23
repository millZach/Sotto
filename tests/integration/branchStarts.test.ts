// @vitest-environment node
// #1033: a worker starts from a thread's branch. The branch goes to the machine the worker starts on, over the host socket
// the desktop keeps (ADR-0082 as amended by ADR-0105 decision 8), and the worker's new worktree is made from the move's
// incoming ref, which goes with the worktree. A test run carries uncommitted work as a snapshot instead of refusing it.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HostBranchMoves } from '../../src/host/branchMoves'
import { startSocketServer } from '../../src/host/socketServer'
import { BranchBundles } from '../../src/main/agents/branchBundles'
import { DesktopBranchMoves, type BranchMoveFolders, type BranchMoveHost } from '../../src/main/agents/branchMoves'
import type { HostService } from '../../src/main/agents/hostService'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { movedBranchRef, ThreadWorktrees } from '../../src/main/agents/threadWorktrees'
import { branchMoveWords, branchStartWords, incomingRef, type BranchMoved, type BranchMoveReceipt } from '../../src/shared/branchMoves'
import type { AgentWorktree } from '../../src/shared/agents'
import { commitFile, git, twoMachines } from '../fixtures/branchRepositories'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'

const fixture = useSocketHostFixture()
let machines: Awaited<ReturnType<typeof twoMachines>>
beforeEach(async () => { machines = await twoMachines() })
afterEach(async () => { await machines.close() })
const LAPTOP = 'laptop-id', FORGE = 'forge-id', MAC = 'mac-id'

function service(): HostService {
  const base = fixture.host.service
  return { shell: () => base.shell(), state: () => base.state(), threadDetail: id => base.threadDetail(id), events: () => [],
    command: (command, identity) => base.command(command, identity), subscribe: listener => base.subscribe(listener) }
}

/** A host behind a socket stand-in that moves branches with this desktop, with its threads and projects in `folders`. */
async function hostOf(folders: BranchMoveFolders, data: { stagingDirectory: string; recordsPath: string }) {
  const server = await startSocketServer({ service: service(), pairing: fixture.host.pairing,
    watcherDesktops: { refresh: async () => undefined, has: () => true }, branchMoves: new HostBranchMoves(new BranchBundles(data), folders) })
  const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Laptop')
  const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token }); fixture.clients.push(client)
  await client.connect()
  return { server, client }
}
/** Forge: its `forge-project` is the forge clone, and its `forge-thread` works in `threadFolder`. */
const forgeHost = (threadFolder?: string) => hostOf({ projectFolder: id => id === 'forge-project' ? machines.forge : undefined,
  threadFolder: id => id === 'forge-thread' ? threadFolder ?? machines.forge : undefined }, machines.data('forge'))

/** The laptop's mover: its `laptop-thread` works in `threadFolder`, and `laptop-project` is the laptop clone. */
function laptop(hosts: Record<string, BranchMoveHost>, threadFolder?: string): DesktopBranchMoves {
  return new DesktopBranchMoves({ bundles: new BranchBundles(machines.data('laptop')), hostName: id => id === FORGE ? 'forge' : 'mac', host: id => hosts[id],
    folders: { threadFolder: id => id === 'laptop-thread' ? threadFolder ?? machines.laptop : undefined, projectFolder: id => id === 'laptop-project' ? machines.laptop : undefined } })
}

/** The worker's worktree on the machine that holds `project`, made as the workspace makes it on the worker's first send. */
async function workerWorktree(machine: 'laptop' | 'forge', project: string, moveId: string): Promise<{ worktrees: ThreadWorktrees; made: AgentWorktree }> {
  const directory = join(machines.root, machine + '-sotto'); await mkdir(directory, { recursive: true })
  const worktrees = new ThreadWorktrees(directory)
  const allocated = await worktrees.allocate(project, 'independent', { incomingRef: await movedBranchRef(project, moveId) })
  return { worktrees, made: await worktrees.ensure(allocated) }
}
/** A checkout's text as committed: this computer's own `core.autocrlf` may give it CRLF on the way out. */
const lf = (text: string): string => text.replace(/\r\n/gu, '\n')
const moved = (receipt: BranchMoveReceipt): BranchMoved => { if (receipt.type !== 'moved') throw new Error(receipt.message); return receipt }

describe('a worker started from a thread’s branch (#1033)', () => {
  it('starts on forge from a laptop thread’s branch, in a new worktree on that branch, and the incoming ref goes with the worktree', async () => {
    git(machines.laptop, 'switch', '-q', '-c', 'feat/x')
    const commit = await commitFile(machines.laptop, 'x.txt', 'x\n')
    const { server, client } = await forgeHost()
    try {
      const before = machines.untouched(machines.forge), moveId = randomUUID()
      const receipt = moved(await laptop({ [FORGE]: client }).forStart({ from: { hostId: LAPTOP, threadId: 'laptop-thread' }, to: { hostId: FORGE, projectId: 'forge-project' },
        here: LAPTOP, moveId, snapshot: false }))
      expect(receipt).toEqual({ type: 'moved', moveId, branch: 'feat/x', commit, ref: incomingRef(moveId, 'feat/x') })
      expect(branchStartWords('forge', receipt.branch, receipt.snapshot)).toBe('Started on forge from feat/x.')
      const { worktrees, made } = await workerWorktree('forge', machines.forge, moveId)
      expect(made).toMatchObject({ status: 'ready', branch: 'feat/x', baseCommit: commit, incomingRef: receipt.ref, temporaryBranch: false })
      expect(git(made.path!, 'symbolic-ref', '--short', 'HEAD')).toBe('feat/x')
      expect(git(made.path!, 'rev-parse', 'HEAD')).toBe(commit)
      // Forge's own checkout, its checked-out branch and its index are as they were.
      expect(machines.untouched(machines.forge)).toEqual({ ...before, branches: expect.stringContaining('refs/heads/feat/x ' + commit) })
      const reclaimed = await worktrees.reclaim(made, { automatic: true })
      expect(reclaimed.incomingRef).toBeUndefined()
      expect(git(machines.forge, 'for-each-ref', 'refs/sotto')).toBe('')
      // The worker's branch stays, with its commit, so its folder can be put back.
      expect(git(machines.forge, 'rev-parse', 'refs/heads/feat/x')).toBe(commit)
    } finally { await server.close() }
  })

  it('starts on the laptop from a forge thread’s branch, the other way', async () => {
    const worktree = join(machines.root, 'forge-work')
    git(machines.forge, 'worktree', 'add', '-q', '-b', 'fix/sync', worktree)
    const commit = await commitFile(worktree, 'sync.txt', 'fixed\n')
    const { server, client } = await forgeHost(worktree)
    try {
      const moveId = randomUUID()
      const receipt = moved(await laptop({ [FORGE]: client }).forStart({ from: { hostId: FORGE, threadId: 'forge-thread' }, to: { hostId: LAPTOP, projectId: 'laptop-project' },
        here: LAPTOP, moveId, snapshot: false }))
      expect(receipt).toMatchObject({ branch: 'fix/sync', commit, ref: incomingRef(moveId, 'fix/sync') })
      const { made } = await workerWorktree('laptop', machines.laptop, moveId)
      expect(made).toMatchObject({ branch: 'fix/sync', baseCommit: commit })
      expect(git(made.path!, 'rev-parse', 'HEAD')).toBe(commit)
    } finally { await server.close() }
  })

  it('starts on the same machine from a thread that holds the branch, on the next free name, and moves nothing else', async () => {
    git(machines.laptop, 'switch', '-q', '-c', 'feat/here')
    const commit = await commitFile(machines.laptop, 'here.txt', 'here\n')
    const before = machines.untouched(machines.laptop), moveId = randomUUID()
    const receipt = moved(await laptop({}).forStart({ from: { hostId: LAPTOP, threadId: 'laptop-thread' }, to: { hostId: LAPTOP, projectId: 'laptop-project' },
      here: LAPTOP, moveId, snapshot: false }))
    expect(receipt).toMatchObject({ branch: 'feat/here', commit })
    const { made } = await workerWorktree('laptop', machines.laptop, moveId)
    // The thread's own feat/here is checked out where it was, so the worker's branch takes the next name.
    expect(made).toMatchObject({ branch: 'feat/here-2', baseCommit: commit })
    expect(machines.untouched(machines.laptop)).toEqual({ ...before, branches: expect.stringContaining('refs/heads/feat/here-2 ' + commit) })
    expect(git(machines.laptop, 'rev-parse', 'refs/heads/feat/here')).toBe(commit)
  })

  it('gives two starts beside the same branch a name each, even when both read the same free name', async () => {
    git(machines.laptop, 'switch', '-q', '-c', 'feat/here')
    const commit = await commitFile(machines.laptop, 'here.txt', 'here')
    const moves = [randomUUID(), randomUUID()]
    for (const moveId of moves) {
      moved(await laptop({}).forStart({ from: { hostId: LAPTOP, threadId: 'laptop-thread' }, to: { hostId: LAPTOP, projectId: 'laptop-project' }, here: LAPTOP, moveId, snapshot: false }))
    }
    const directory = join(machines.root, 'laptop-sotto'); await mkdir(directory, { recursive: true })
    const worktrees = new ThreadWorktrees(directory)
    // Both allocations read feat/here-2 as free before either worktree is made.
    const allocated = await Promise.all(moves.map(async moveId => worktrees.allocate(machines.laptop, 'independent', { incomingRef: await movedBranchRef(machines.laptop, moveId) })))
    expect(allocated.map(record => record.branch)).toEqual(['feat/here-2', 'feat/here-2'])
    const made = await Promise.all(allocated.map(record => worktrees.ensure(record)))
    expect(made.map(record => record.branch).sort()).toEqual(['feat/here-2', 'feat/here-3'])
    for (const record of made) expect(git(record.path!, 'rev-parse', 'HEAD')).toBe(commit)
    expect(git(machines.laptop, 'rev-parse', 'refs/heads/feat/here')).toBe(commit)
  })

  it('refuses uncommitted work for a start that is not a test run, either way, in the move’s words, and lands nothing', async () => {
    await writeFile(join(machines.laptop, 'app.txt'), 'half done here\n')
    await writeFile(join(machines.forge, 'app.txt'), 'half done there\n')
    const { server, client } = await forgeHost()
    try {
      const moves = laptop({ [FORGE]: client })
      for (const [from, to] of [[{ hostId: LAPTOP, threadId: 'laptop-thread' }, { hostId: FORGE, projectId: 'forge-project' }],
        [{ hostId: FORGE, threadId: 'forge-thread' }, { hostId: LAPTOP, projectId: 'laptop-project' }]] as const) {
        expect(await moves.forStart({ from, to, here: LAPTOP, moveId: randomUUID(), snapshot: false }))
          .toEqual({ type: 'refused', reason: 'uncommitted', message: branchMoveWords.uncommitted })
      }
      expect(git(machines.laptop, 'for-each-ref', 'refs/sotto')).toBe('')
      expect(git(machines.forge, 'for-each-ref', 'refs/sotto')).toBe('')
    } finally { await server.close() }
  })

  it('carries a test run’s uncommitted work as a snapshot: the untracked files listed, ignored files left out, the working tree and index untouched', async () => {
    git(machines.laptop, 'switch', '-q', '-c', 'feat/t')
    await commitFile(machines.laptop, '.gitignore', '*.log\n')
    const head = await commitFile(machines.laptop, 'app.txt', 'committed\n')
    await writeFile(join(machines.laptop, 'app.txt'), 'edited, not staged\n')
    await writeFile(join(machines.laptop, 'README.md'), '# Staged\n'); git(machines.laptop, 'add', 'README.md')
    await mkdir(join(machines.laptop, 'notes'))
    await writeFile(join(machines.laptop, 'new.txt'), 'untracked\n'); await writeFile(join(machines.laptop, 'notes', 'todo.txt'), 'untracked too\n')
    await writeFile(join(machines.laptop, 'debug.log'), 'ignored\n')
    // Read once so Git's own stat refresh is behind us: from here, the index file must not change by a byte.
    const status = git(machines.laptop, 'status', '--porcelain', '--untracked-files=all')
    const index = await readFile(join(machines.laptop, '.git', 'index'))
    const refs = git(machines.laptop, 'for-each-ref', '--format=%(refname) %(objectname)')
    const { server, client } = await forgeHost()
    try {
      const moveId = randomUUID()
      const receipt = moved(await laptop({ [FORGE]: client }).forStart({ from: { hostId: LAPTOP, threadId: 'laptop-thread' }, to: { hostId: FORGE, projectId: 'forge-project' },
        here: LAPTOP, moveId, snapshot: true }))
      expect(await readFile(join(machines.laptop, '.git', 'index'))).toEqual(index)
      expect(receipt.snapshot).toEqual({ untracked: ['new.txt', 'notes/todo.txt'], untrackedCount: 2 })
      expect(branchStartWords('forge', receipt.branch, receipt.snapshot)).toBe('Started on forge from feat/t with your uncommitted changes (2 untracked files).')
      // The snapshot is a commit on no branch, with the branch's commit as its parent, holding the work as it stood.
      expect(receipt).toMatchObject({ branch: 'feat/t', ref: incomingRef(moveId, 'feat/t') })
      expect(receipt.commit).not.toBe(head)
      expect(git(machines.forge, 'rev-parse', receipt.commit + '^')).toBe(head)
      expect(git(machines.forge, 'ls-tree', '-r', '--name-only', receipt.commit).split('\n').sort()).toEqual(['.gitignore', 'README.md', 'app.txt', 'new.txt', 'notes/todo.txt'])
      expect(git(machines.forge, 'show', receipt.commit + ':app.txt')).toBe('edited, not staged')
      expect(git(machines.forge, 'show', receipt.commit + ':README.md')).toBe('# Staged')
      // Nothing on the laptop changed: no branch, no stash, the same status and refs.
      expect(git(machines.laptop, 'status', '--porcelain', '--untracked-files=all')).toBe(status)
      expect(git(machines.laptop, 'for-each-ref', '--format=%(refname) %(objectname)')).toBe(refs)
      expect(git(machines.laptop, 'stash', 'list')).toBe('')
      expect(await readFile(join(machines.laptop, 'debug.log'), 'utf8')).toBe('ignored\n')
      // The worker's worktree on forge is made from the snapshot, on the branch's name.
      const { made } = await workerWorktree('forge', machines.forge, moveId)
      expect(made).toMatchObject({ branch: 'feat/t', baseCommit: receipt.commit })
      expect(lf(await readFile(join(made.path!, 'notes', 'todo.txt'), 'utf8'))).toBe('untracked too\n')
    } finally { await server.close() }
  })

  it('carries a forge thread’s test run to the laptop as a snapshot, leaving forge’s index as it was', async () => {
    const worktree = join(machines.root, 'forge-work')
    git(machines.forge, 'worktree', 'add', '-q', '-b', 'fix/t', worktree)
    await writeFile(join(worktree, 'app.txt'), 'forge edit\n'); await writeFile(join(worktree, 'scratch.txt'), 'new\n')
    git(worktree, 'status', '--porcelain')
    const index = await readFile(git(worktree, 'rev-parse', '--path-format=absolute', '--git-path', 'index'))
    const { server, client } = await forgeHost(worktree)
    try {
      const receipt = moved(await laptop({ [FORGE]: client }).forStart({ from: { hostId: FORGE, threadId: 'forge-thread' }, to: { hostId: LAPTOP, projectId: 'laptop-project' },
        here: LAPTOP, moveId: randomUUID(), snapshot: true }))
      expect(await readFile(git(worktree, 'rev-parse', '--path-format=absolute', '--git-path', 'index'))).toEqual(index)
      expect(receipt).toMatchObject({ branch: 'fix/t', snapshot: { untracked: ['scratch.txt'], untrackedCount: 1 } })
      expect(branchStartWords('forge', receipt.branch, receipt.snapshot)).toBe('Started on forge from fix/t with your uncommitted changes (1 untracked file).')
      expect(git(machines.laptop, 'show', receipt.commit + ':scratch.txt')).toBe('new')
    } finally { await server.close() }
  })

  it('relays a branch from one host to another, and lands one on the host its thread is on, writing nothing on the laptop', async () => {
    const worktree = join(machines.root, 'forge-work')
    git(machines.forge, 'worktree', 'add', '-q', '-b', 'feat/relay', worktree)
    const commit = await commitFile(worktree, 'relay.txt', 'relay\n')
    const forge = await forgeHost(worktree)
    // The Mac's copy of the project is the laptop clone here, behind a socket of its own.
    const mac = await hostOf({ projectFolder: id => id === 'mac-project' ? machines.laptop : undefined, threadFolder: () => undefined },
      { stagingDirectory: join(machines.root, 'mac-data', 'branch-moves'), recordsPath: join(machines.root, 'mac-data', 'branch-moves.json') })
    try {
      const moves = laptop({ [FORGE]: forge.client, [MAC]: mac.client })
      const relayed = moved(await moves.forStart({ from: { hostId: FORGE, threadId: 'forge-thread' }, to: { hostId: MAC, projectId: 'mac-project' }, here: LAPTOP, moveId: randomUUID(), snapshot: false }))
      expect(git(machines.laptop, 'rev-parse', relayed.ref)).toBe(commit)
      const onForge = moved(await moves.forStart({ from: { hostId: FORGE, threadId: 'forge-thread' }, to: { hostId: FORGE, projectId: 'forge-project' }, here: LAPTOP, moveId: randomUUID(), snapshot: false }))
      expect(git(machines.forge, 'rev-parse', onForge.ref)).toBe(commit)
      expect(await moves.forStart({ from: { hostId: FORGE, threadId: 'forge-thread' }, to: { hostId: 'gone-id', projectId: 'x' }, here: LAPTOP, moveId: randomUUID(), snapshot: false }))
        .toEqual({ type: 'refused', reason: 'unsupported', message: branchMoveWords.notConnected('mac') })
    } finally { await forge.server.close(); await mac.server.close() }
  })
})
