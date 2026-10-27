// @vitest-environment node
// #1030: a child on another machine brings its commits back to the branch of the thread it began from. Its committed
// branch crosses first as a branch move over the host socket the desktop keeps (ADR-0105), into an incoming ref in the
// parent's project, and the parent's machine then fast-forwards the parent's branch, or makes a merge commit after asking,
// exactly as for a child on its own machine. Two real clones behind a real socket server; nothing is forced.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HostBranchMoves } from '../../src/host/branchMoves'
import { startSocketServer } from '../../src/host/socketServer'
import { BranchBundles } from '../../src/main/agents/branchBundles'
import { DesktopBranchMoves } from '../../src/main/agents/branchMoves'
import { BringBackRefusal, GitActions } from '../../src/main/agents/gitActions'
import { GitStatusReader } from '../../src/main/agents/gitStatus'
import type { HostService } from '../../src/main/agents/hostService'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { incomingRefBranch, MERGE_FALLBACK_AUTHOR } from '../../src/shared/bringChangesBack'
import type { BranchMoved, BranchMoveReceipt } from '../../src/shared/branchMoves'
import { commitFile, git, twoMachines } from '../fixtures/branchRepositories'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'

const fixture = useSocketHostFixture()
let machines: Awaited<ReturnType<typeof twoMachines>>
beforeEach(async () => { machines = await twoMachines() })
afterEach(async () => { await machines.close() })
const LAPTOP = 'laptop-id', FORGE = 'forge-id'

function service(): HostService {
  const base = fixture.host.service
  return { shell: () => base.shell(), state: () => base.state(), threadDetail: id => base.threadDetail(id), events: () => [],
    command: (command, identity) => base.command(command, identity), subscribe: listener => base.subscribe(listener) }
}

/**
 * Forge behind a real socket server, with its `forge-thread`, the child, in a worktree of its own on `sotto/child` made from
 * `main`; and the laptop's mover, whose `laptop-project` is the clone the parent works in on `main`.
 */
async function across() {
  const child = join(machines.root, 'forge-child')
  git(machines.forge, 'worktree', 'add', '-q', '-b', 'sotto/child', child, 'main')
  const server = await startSocketServer({ service: service(), pairing: fixture.host.pairing,
    watcherDesktops: { refresh: async () => undefined, has: () => true },
    branchMoves: new HostBranchMoves(new BranchBundles(machines.data('forge')), {
      projectFolder: id => id === 'forge-project' ? machines.forge : undefined, threadFolder: id => id === 'forge-thread' ? child : undefined }) })
  const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Laptop')
  const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token }); fixture.clients.push(client)
  await client.connect()
  const moves = new DesktopBranchMoves({ bundles: new BranchBundles(machines.data('laptop')), hostName: () => 'forge', host: id => id === FORGE ? client : undefined,
    folders: { threadFolder: () => undefined, projectFolder: id => id === 'laptop-project' ? machines.laptop : undefined } })
  const actions = new GitActions({ status: new GitStatusReader({ fetchIntervalMs: () => 0 }), writeCommitMessage: async () => null, writePullRequestText: async () => null })
  const parentCheckout = async (folder: string): Promise<boolean> => folder.replace(/\\/gu, '/').toLowerCase() === machines.laptop.replace(/\\/gu, '/').toLowerCase()
  /** The desktop's half: the child's branch moves from forge into the laptop project's incoming ref. */
  const move = (): Promise<BranchMoveReceipt> => moves.forStart({ from: { hostId: FORGE, threadId: 'forge-thread' }, to: { hostId: LAPTOP, projectId: 'laptop-project' },
    here: LAPTOP, moveId: randomUUID(), snapshot: false })
  /** The parent's machine's half, run in the parent's folder, after which the incoming ref goes, as the host does it. */
  const bring = async (moved: BranchMoved, mergeCommit?: { targetHead: string; branchHead: string }) => {
    try {
      return await actions.bringBack({ cwd: machines.laptop, target: 'main', arrived: { ref: moved.ref, branch: incomingRefBranch(moved.ref)! }, parentCheckout,
        ...mergeCommit ? { mergeCommit } : {} })
    } finally { git(machines.laptop, 'update-ref', '-d', '--no-deref', moved.ref) }
  }
  return { child, server, move, bring, main: () => git(machines.laptop, 'rev-parse', 'main') }
}
const landed = (receipt: BranchMoveReceipt): BranchMoved => { if (receipt.type !== 'moved') throw new Error(receipt.message); return receipt }
const refusal = async (promise: Promise<unknown>): Promise<BringBackRefusal> => {
  const error = await promise.then(() => undefined, (failure: unknown) => failure)
  expect(error).toBeInstanceOf(BringBackRefusal)
  return error as BringBackRefusal
}
const lf = (text: string): string => text.replace(/\r\n/gu, '\n')
/** `git status` as Sotto's own Git reads the folder: with this computer's `core.autocrlf`, which may check files out as CRLF. */
const clean = (folder: string): string => git(folder, '-c', 'core.autocrlf=true', 'status', '--porcelain')
const noIncoming = (): void => expect(git(machines.laptop, 'for-each-ref', 'refs/sotto/incoming')).toBe('')

describe('bringing changes back from a child on another machine (#1030)', () => {
  it('moves the child’s branch over the socket and fast-forwards the parent’s branch where the parent works', async () => {
    const { child, server, move, bring, main } = await across()
    try {
      const head = await commitFile(child, 'mid.txt', 'mid-chunk\n', 'Test a stream that ends mid-chunk')
      const moved = landed(await move())
      expect(moved).toMatchObject({ branch: 'sotto/child', commit: head })
      expect(await bring(moved)).toMatchObject({ kind: 'fast-forward', branch: 'sotto/child', commits: 1, head })
      expect(main()).toBe(head)
      expect(lf(await readFile(join(machines.laptop, 'mid.txt'), 'utf8'))).toBe('mid-chunk\n')
      expect(clean(machines.laptop)).toBe('')
      noIncoming()
      // Forge's child keeps its own branch as it was.
      expect(git(child, 'rev-parse', 'HEAD')).toBe(head)
    } finally { await server.close() }
  })

  it('asks before a merge commit, changes nothing, and merges on the yes once the branch has crossed again', async () => {
    const { child, server, move, bring, main } = await across()
    try {
      const ours = await commitFile(child, 'mid.txt', 'mid-chunk\n', 'Test')
      const theirs = await commitFile(machines.laptop, 'notes.txt', 'meanwhile\n', 'Meanwhile on the laptop')
      const asked = await bring(landed(await move()))
      expect(asked).toMatchObject({ kind: 'asks', commits: 1, targetCommits: 1, targetHead: theirs, branchHead: ours })
      expect(main()).toBe(theirs)
      noIncoming()
      if (asked.kind !== 'asks') throw new Error('Expected a question')
      const merged = await bring(landed(await move()), { targetHead: asked.targetHead, branchHead: asked.branchHead })
      expect(merged).toMatchObject({ kind: 'merge-commit', subject: 'Merge branch \'sotto/child\' into main' })
      expect(git(machines.laptop, 'rev-list', '--parents', '-n', '1', 'main').split(' ').slice(1)).toEqual([theirs, ours])
      noIncoming()
    } finally { await server.close() }
  })

  it('makes the merge commit as Sotto, never as a check snapshot, where Git has no identity of its own', async () => {
    const { child, server, move, bring } = await across()
    const saved = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_NOSYSTEM }
    try {
      const ours = await commitFile(child, 'mid.txt', 'mid-chunk\n', 'Test')
      const theirs = await commitFile(machines.laptop, 'notes.txt', 'meanwhile\n', 'Meanwhile on the laptop')
      // A headless host with no user.name or user.email anywhere, and none guessed from the machine's name.
      const empty = join(machines.root, 'no-identity.gitconfig')
      await writeFile(empty, '')
      process.env.GIT_CONFIG_GLOBAL = empty
      process.env.GIT_CONFIG_NOSYSTEM = '1'
      git(machines.laptop, 'config', '--unset', 'user.name')
      git(machines.laptop, 'config', '--unset', 'user.email')
      git(machines.laptop, 'config', 'user.useConfigOnly', 'true')
      const asked = await bring(landed(await move()))
      if (asked.kind !== 'asks') throw new Error('Expected a question')
      const merged = await bring(landed(await move()), { targetHead: asked.targetHead, branchHead: asked.branchHead })
      expect(merged).toMatchObject({ kind: 'merge-commit' })
      expect(git(machines.laptop, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', 'main'))
        .toBe(`${MERGE_FALLBACK_AUTHOR.name} <${MERGE_FALLBACK_AUTHOR.email}>|${MERGE_FALLBACK_AUTHOR.name} <${MERGE_FALLBACK_AUTHOR.email}>`)
      expect(git(machines.laptop, 'rev-list', '--parents', '-n', '1', 'main').split(' ').slice(1)).toEqual([theirs, ours])
    } finally {
      if (saved.global === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved.global
      if (saved.system === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = saved.system
      await server.close()
    }
  })

  it('makes no merge commit when the child moved on after the question', async () => {
    const { child, server, move, bring, main } = await across()
    try {
      await commitFile(child, 'mid.txt', 'mid-chunk\n', 'Test')
      const theirs = await commitFile(machines.laptop, 'notes.txt', 'meanwhile\n', 'Meanwhile')
      const asked = await bring(landed(await move()))
      if (asked.kind !== 'asks') throw new Error('Expected a question')
      await commitFile(child, 'later.txt', 'later\n', 'Later on forge')
      const refused = await refusal(bring(landed(await move()), { targetHead: asked.targetHead, branchHead: asked.branchHead }))
      expect(refused.reason).toBe('moved')
      expect(main()).toBe(theirs)
    } finally { await server.close() }
  })

  it('refuses a conflict in Git’s own words, and leaves the parent’s branch and folder as they were', async () => {
    const { child, server, move, bring, main } = await across()
    try {
      await commitFile(child, 'app.txt', 'ours\n', 'Change the app on forge')
      const theirs = await commitFile(machines.laptop, 'app.txt', 'theirs\n', 'Change the app on the laptop')
      const refused = await refusal(bring(landed(await move())))
      expect(refused.reason).toBe('conflict')
      expect(refused.detail.gitSaid).toBe('CONFLICT (content): Merge conflict in app.txt')
      expect(main()).toBe(theirs)
      expect(clean(machines.laptop)).toBe('')
      noIncoming()
    } finally { await server.close() }
  })

  it('refuses uncommitted work in the child before anything crosses', async () => {
    const { child, server, move, main } = await across()
    try {
      await commitFile(child, 'mid.txt', 'mid-chunk\n', 'Test')
      await writeFile(join(child, 'app.txt'), 'not committed\n')
      const before = main()
      expect(await move()).toMatchObject({ type: 'refused', reason: 'uncommitted' })
      expect(main()).toBe(before)
      noIncoming()
    } finally { await server.close() }
  })

  it('never brings back a test run’s snapshot that the child’s branch began from', async () => {
    const { child, server, move, bring, main } = await across()
    try {
      // The worker started from a snapshot of the parent's uncommitted work, a commit by Sotto (#1033), then committed its own.
      await writeFile(join(child, 'app.txt'), 'the parent’s uncommitted edit\n')
      git(child, 'add', 'app.txt')
      snapshotCommit(child)
      await commitFile(child, 'mid.txt', 'mid-chunk\n', 'Test')
      const before = main()
      const refused = await refusal(bring(landed(await move())))
      expect(refused.reason).toBe('snapshot')
      expect(main()).toBe(before)
      noIncoming()
    } finally { await server.close() }
  })
})

/** Commits what is staged as Sotto's test-run snapshot does: author and committer "Sotto <sotto@localhost>", unsigned. */
function snapshotCommit(cwd: string): void {
  const tree = git(cwd, 'write-tree'), parent = git(cwd, 'rev-parse', 'HEAD')
  const commit = gitAs(cwd, 'commit-tree', tree, '-p', parent, '-m', 'Sotto test-run snapshot')
  git(cwd, 'update-ref', 'HEAD', commit)
}
function gitAs(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_NAME: 'Sotto', GIT_AUTHOR_EMAIL: 'sotto@localhost', GIT_COMMITTER_NAME: 'Sotto', GIT_COMMITTER_EMAIL: 'sotto@localhost' } }).trim()
}
