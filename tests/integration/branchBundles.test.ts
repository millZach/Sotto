// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BranchBundles, IncomingBundle, type AlreadyPresent, type PreparedBundle } from '../../src/main/agents/branchBundles'
import { runGitStatusCommand, type RunGitCommand } from '../../src/main/agents/gitStatus'
import { branchMoveWords, incomingRef, type BranchMoveRefusal } from '../../src/shared/branchMoves'
import { commitFile, git, incompressible, twoMachines } from '../fixtures/branchRepositories'

let machines: Awaited<ReturnType<typeof twoMachines>>
beforeEach(async () => { machines = await twoMachines() })
afterEach(async () => { await machines.close() })

const sending = (value: PreparedBundle | AlreadyPresent | BranchMoveRefusal): PreparedBundle => { expect(value.type).toBe('sending'); return value as PreparedBundle }
const incoming = (value: unknown): IncomingBundle => { expect(value).toBeInstanceOf(IncomingBundle); return value as IncomingBundle }

/** Carries a staged bundle into `receiver` in chunks, as the socket would. */
async function carry(sender: BranchBundles, prepared: PreparedBundle, receiver: IncomingBundle): Promise<void> {
  for (let offset = 0; offset < prepared.size;) {
    const chunk = await sender.readChunk(prepared.path, offset)
    expect(await receiver.write(offset, chunk)).toBe(true)
    offset += chunk.byteLength
  }
}

/** A feature branch on the laptop with two commits, checked out there. */
async function featureBranch(): Promise<string> {
  git(machines.laptop, 'switch', '-q', '-c', 'feature/login')
  await commitFile(machines.laptop, 'login.txt', 'form\n')
  return commitFile(machines.laptop, 'login.txt', 'form\nsubmit\n')
}

describe('branch bundles between two repositories (ADR-0082, ADR-0105 decision 8)', () => {
  it('carries only what the receiver lacks and lands it in an incoming ref of its own, leaving the checked-out branch alone', async () => {
    const commit = await featureBranch()
    const laptop = new BranchBundles(machines.data('laptop')), forge = new BranchBundles(machines.data('forge'))
    const before = machines.untouched(machines.forge)
    const source = await laptop.branchOf(machines.laptop)
    expect(source).toEqual({ branch: 'feature/login', commit })
    const tips = await forge.tips(machines.forge)
    expect(tips).toContain(git(machines.forge, 'rev-parse', 'main'))
    const moveId = randomUUID()
    const prepared = sending(await laptop.prepare({ repository: machines.laptop, moveId, commit, bases: tips as string[] }))
    // Two small commits against forge's main: far smaller than the whole history would be.
    expect(git(machines.laptop, 'bundle', 'list-heads', prepared.path)).toBe(`${commit} refs/sotto/outgoing/${moveId}`)
    expect(git(machines.laptop, 'rev-list', '--count', '--objects', commit, '--not', ...(tips as string[]))).not.toBe('0')
    // The outgoing ref is gone once the bundle is written.
    expect(git(machines.laptop, 'for-each-ref', 'refs/sotto')).toBe('')
    const receiving = incoming(await forge.receive({ repository: machines.forge, moveId, branch: 'feature/login', commit, size: prepared.size, sha256: prepared.sha256 }))
    await carry(laptop, prepared, receiving)
    expect(await forge.finish(receiving)).toEqual({ type: 'moved', moveId, branch: 'feature/login', commit, ref: incomingRef(moveId, 'feature/login') })
    expect(git(machines.forge, 'rev-parse', incomingRef(moveId, 'feature/login'))).toBe(commit)
    expect(machines.untouched(machines.forge)).toEqual(before)
    expect(await readdir(machines.data('forge').stagingDirectory)).toEqual([])
    // A new worktree on the moved branch is the receiving worker's start (ADR-0082 decision 4).
    git(machines.forge, 'worktree', 'add', '-q', '-b', 'feature/login', join(machines.root, 'forge-login'), incomingRef(moveId, 'feature/login'))
    expect(git(join(machines.root, 'forge-login'), 'log', '-1', '--format=%H')).toBe(commit)
  })

  it('counts what earlier moves left as the receiver’s, so moving a branch again carries only what is new', async () => {
    const first = await featureBranch()
    const laptop = new BranchBundles(machines.data('laptop')), forge = new BranchBundles(machines.data('forge'))
    const move = async (commit: string) => {
      const moveId = randomUUID()
      const prepared = sending(await laptop.prepare({ repository: machines.laptop, moveId, commit, bases: await forge.tips(machines.forge) as string[] }))
      const receiving = incoming(await forge.receive({ repository: machines.forge, moveId, branch: 'feature/login', commit, size: prepared.size, sha256: prepared.sha256 }))
      const required = git(machines.forge, 'bundle', 'verify', prepared.path)
      await carry(laptop, prepared, receiving)
      expect(await forge.finish(receiving)).toMatchObject({ type: 'moved', commit })
      return required
    }
    await move(first)
    expect(await forge.tips(machines.forge)).toContain(first)
    const second = await commitFile(machines.laptop, 'login.txt', 'form\nsubmit\nremember me\n')
    // The second bundle needs the first move's commit, which forge has only in its incoming ref.
    expect(await move(second)).toContain(first)
  })

  it('sends nothing when the receiver already has the commit, and only makes its incoming ref', async () => {
    const laptop = new BranchBundles(machines.data('laptop')), forge = new BranchBundles(machines.data('forge'))
    const commit = git(machines.laptop, 'rev-parse', 'main'), moveId = randomUUID()
    expect(await laptop.prepare({ repository: machines.laptop, moveId, commit, bases: await forge.tips(machines.forge) as string[] })).toEqual({ type: 'present' })
    expect(await readdir(machines.data('laptop').stagingDirectory)).toEqual([])
    expect(git(machines.laptop, 'for-each-ref', 'refs/sotto')).toBe('')
    expect(await forge.receiveRef({ repository: machines.forge, moveId, branch: 'main', commit }))
      .toEqual({ type: 'moved', moveId, branch: 'main', commit, ref: incomingRef(moveId, 'main') })
    expect(git(machines.forge, 'rev-parse', incomingRef(moveId, 'main'))).toBe(commit)
    // A retry is done from the record; a receiver that turns out not to have the commit refuses, and nothing lands.
    expect(await forge.receiveRef({ repository: machines.forge, moveId, branch: 'main', commit })).toMatchObject({ type: 'moved', commit })
    const missing = await featureBranch(), other = randomUUID()
    expect(await forge.receiveRef({ repository: machines.forge, moveId: other, branch: 'feature/login', commit: missing }))
      .toEqual({ type: 'refused', reason: 'not-whole', message: branchMoveWords.notWhole })
    expect(git(machines.forge, 'for-each-ref', '--format=%(refname)', 'refs/sotto')).toBe(incomingRef(moveId, 'main'))
  })

  it('lands only a commit: a blob or a tree the receiver has is refused before anything is recorded or created', async () => {
    const forge = new BranchBundles(machines.data('forge'))
    const blob = git(machines.forge, 'rev-parse', 'main:README.md'), tree = git(machines.forge, 'rev-parse', 'main^{tree}')
    for (const object of [blob, tree]) {
      const moveId = randomUUID()
      expect(await forge.receiveRef({ repository: machines.forge, moveId, branch: 'main', commit: object }))
        .toEqual({ type: 'refused', reason: 'not-whole', message: branchMoveWords.notWhole })
      const records = await readFile(machines.data('forge').recordsPath, 'utf8').catch(() => '{"moves":{}}')
      expect(JSON.parse(records).moves[moveId]).toBeUndefined()
    }
    expect(git(machines.forge, 'for-each-ref', 'refs/sotto')).toBe('')
  })

  it('records nothing for a bundle whose one ref names a blob, so a retry with a real commit still lands', async () => {
    const forge = new BranchBundles(machines.data('forge')), moveId = randomUUID()
    // A bundle Git verifies, with the expected outgoing ref, but naming a blob only the laptop had.
    await writeFile(join(machines.laptop, 'loose.txt'), 'not a commit\n')
    const blob = git(machines.laptop, 'hash-object', '-w', 'loose.txt')
    git(machines.laptop, 'update-ref', `refs/sotto/outgoing/${moveId}`, blob)
    const path = join(machines.root, 'blob.bundle')
    git(machines.laptop, 'bundle', 'create', '--quiet', path, `refs/sotto/outgoing/${moveId}`)
    git(machines.laptop, 'update-ref', '-d', `refs/sotto/outgoing/${moveId}`)
    git(machines.laptop, 'clean', '-qf')
    const bytes = await readFile(path)
    const blobbed = incoming(await forge.receive({ repository: machines.forge, moveId, branch: 'feature/login', commit: blob, size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex') }))
    expect(await blobbed.write(0, bytes)).toBe(true)
    expect(await forge.finish(blobbed)).toEqual({ type: 'refused', reason: 'not-whole', message: branchMoveWords.notWhole })
    const records = await readFile(machines.data('forge').recordsPath, 'utf8').catch(() => '{"moves":{}}')
    expect(JSON.parse(records).moves[moveId]).toBeUndefined()
    expect(git(machines.forge, 'for-each-ref', 'refs/sotto')).toBe('')
    // The retry carries a real commit for the same move, and nothing that arrived before stands in its way.
    const commit = await featureBranch(), laptop = new BranchBundles(machines.data('laptop'))
    const prepared = sending(await laptop.prepare({ repository: machines.laptop, moveId, commit, bases: [] }))
    const retry = incoming(await forge.receive({ repository: machines.forge, moveId, branch: 'feature/login', commit, size: prepared.size, sha256: prepared.sha256 }))
    await carry(laptop, prepared, retry)
    expect(await forge.finish(retry)).toMatchObject({ type: 'moved', moveId, commit })
    expect(git(machines.forge, 'rev-parse', incomingRef(moveId, 'feature/login'))).toBe(commit)
  })

  it('refuses uncommitted work and a working copy on no branch, and moves nothing', async () => {
    await featureBranch()
    const laptop = new BranchBundles(machines.data('laptop'))
    await writeFile(join(machines.laptop, 'login.txt'), 'changed\n')
    expect(await laptop.branchOf(machines.laptop)).toEqual({ type: 'refused', reason: 'uncommitted', message: branchMoveWords.uncommitted })
    git(machines.laptop, 'checkout', '-q', '--', 'login.txt')
    await writeFile(join(machines.laptop, 'notes.txt'), 'untracked\n')
    expect(await laptop.branchOf(machines.laptop)).toMatchObject({ reason: 'uncommitted' })
    git(machines.laptop, 'clean', '-qf')
    git(machines.laptop, 'switch', '-q', '--detach')
    expect(await laptop.branchOf(machines.laptop)).toEqual({ type: 'refused', reason: 'not-on-branch', message: branchMoveWords.notOnBranch })
    expect(await laptop.branchOf(machines.root)).toMatchObject({ reason: 'not-a-repository' })
    expect(git(machines.laptop, 'for-each-ref', 'refs/sotto')).toBe('')
  })

  it('never forces: a retry of a landed move is done and writes nothing, and another commit for it or an existing ref is refused', async () => {
    const commit = await featureBranch()
    const laptop = new BranchBundles(machines.data('laptop')), forge = new BranchBundles(machines.data('forge'))
    const moveId = randomUUID()
    const move = async (id: string, at: string) => {
      const prepared = sending(await laptop.prepare({ repository: machines.laptop, moveId: id, commit: at, bases: [] }))
      const begun = await forge.receive({ repository: machines.forge, moveId: id, branch: 'feature/login', commit: at, size: prepared.size, sha256: prepared.sha256 })
      if (!(begun instanceof IncomingBundle)) return begun
      await carry(laptop, prepared, begun)
      return forge.finish(begun)
    }
    expect(await move(moveId, commit)).toMatchObject({ type: 'moved', commit })
    // The answer was lost and the same move comes again: done, from the record.
    expect(await move(moveId, commit)).toMatchObject({ type: 'moved', commit })
    const earlier = git(machines.laptop, 'rev-parse', 'HEAD~1')
    expect(await move(moveId, earlier)).toEqual({ type: 'refused', reason: 'move-differs', message: branchMoveWords.moveDiffers })
    expect(git(machines.forge, 'rev-parse', incomingRef(moveId, 'feature/login'))).toBe(commit)
    // A ref this receiver has no record of is never overwritten either.
    const other = randomUUID()
    git(machines.forge, 'update-ref', incomingRef(other, 'feature/login'), git(machines.forge, 'rev-parse', 'main'))
    expect(await move(other, commit)).toMatchObject({ reason: 'move-differs' })
    expect(git(machines.forge, 'rev-parse', incomingRef(other, 'feature/login'))).toBe(git(machines.forge, 'rev-parse', 'main'))
  })

  it('never writes through a symbolic ref in the incoming ref’s place, even one that points nowhere', async () => {
    const commit = await featureBranch()
    const laptop = new BranchBundles(machines.data('laptop')), forge = new BranchBundles(machines.data('forge'))
    const main = git(machines.forge, 'rev-parse', 'main')
    for (const target of ['refs/heads/unborn', 'refs/heads/main']) {
      const moveId = randomUUID(), ref = incomingRef(moveId, 'feature/login')
      git(machines.forge, 'symbolic-ref', ref, target)
      const prepared = sending(await laptop.prepare({ repository: machines.laptop, moveId, commit, bases: [] }))
      expect(await forge.receive({ repository: machines.forge, moveId, branch: 'feature/login', commit, size: prepared.size, sha256: prepared.sha256 }))
        .toEqual({ type: 'refused', reason: 'move-differs', message: branchMoveWords.moveDiffers })
      expect(await forge.receiveRef({ repository: machines.forge, moveId, branch: 'feature/login', commit })).toMatchObject({ reason: 'move-differs' })
      expect(git(machines.forge, 'symbolic-ref', ref)).toBe(target)
      await laptop.discard(prepared)
    }
    expect(git(machines.forge, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads')).toBe(`refs/heads/main ${main}`)
    // Should one appear between the check and the write, the write is to the ref itself and never where it points.
    const moveId = randomUUID(), ref = incomingRef(moveId, 'feature/login')
    const racing: RunGitCommand = (cwd, command, args, options) => {
      if (args[0] === 'update-ref' && args.includes(ref)) git(machines.forge, 'symbolic-ref', ref, 'refs/heads/unborn')
      return runGitStatusCommand(cwd, command, args, options)
    }
    const raced = new BranchBundles({ ...machines.data('forge'), run: racing })
    expect(await raced.receiveRef({ repository: machines.forge, moveId, branch: 'feature/login', commit: main })).not.toMatchObject({ type: 'refused', reason: 'failed' })
    expect(git(machines.forge, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads')).toBe(`refs/heads/main ${main}`)
  })

  it('never writes through or removes a symbolic ref in the outgoing ref’s place', async () => {
    const commit = await featureBranch()
    const laptop = new BranchBundles(machines.data('laptop')), moveId = randomUUID()
    const main = git(machines.laptop, 'rev-parse', 'main'), ref = `refs/sotto/outgoing/${moveId}`
    git(machines.laptop, 'symbolic-ref', ref, 'refs/heads/main')
    expect(await laptop.prepare({ repository: machines.laptop, moveId, commit, bases: [] }))
      .toEqual({ type: 'refused', reason: 'failed', message: 'Something other than Sotto changed this project\'s refs/sotto folder, so the branch can\'t move safely. Nothing was moved.' })
    expect(git(machines.laptop, 'rev-parse', 'refs/heads/main')).toBe(main)
    expect(git(machines.laptop, 'symbolic-ref', ref)).toBe('refs/heads/main')
    expect(await readdir(machines.data('laptop').stagingDirectory)).toEqual([])
  })

  it('refuses a bundle over the cap on both sides, in plain words, and keeps nothing staged', async () => {
    git(machines.laptop, 'switch', '-q', '-c', 'big')
    const commit = await commitFile(machines.laptop, 'blob.bin', incompressible(64 * 1024))
    const laptop = new BranchBundles({ ...machines.data('laptop'), maxBytes: 32 * 1024 }), forge = new BranchBundles({ ...machines.data('forge'), maxBytes: 32 * 1024 })
    const refusal = await laptop.prepare({ repository: machines.laptop, moveId: randomUUID(), commit, bases: [] })
    expect(refusal).toMatchObject({ type: 'refused', reason: 'too-large' })
    expect((refusal as BranchMoveRefusal).message).toMatch(/^This branch needs 1 MiB to move, and one move carries at most 1 MiB\. Nothing was moved\.$/u)
    expect(await readdir(machines.data('laptop').stagingDirectory)).toEqual([])
    expect(await forge.receive({ repository: machines.forge, moveId: randomUUID(), branch: 'big', commit, size: 64 * 1024, sha256: '0'.repeat(64) })).toMatchObject({ reason: 'too-large' })
    expect(branchMoveWords.tooLarge(300 * 1024 * 1024)).toBe('This branch needs 300 MiB to move, and one move carries at most 256 MiB. Nothing was moved.')
  })

  it('refuses a branch over the cap before writing any bundle, from what its objects take on disk', async () => {
    git(machines.laptop, 'switch', '-q', '-c', 'big')
    const commit = await commitFile(machines.laptop, 'blob.bin', incompressible(256 * 1024))
    const ran: string[][] = []
    const run: RunGitCommand = (cwd, command, args, options) => { ran.push([...args]); return runGitStatusCommand(cwd, command, args, options) }
    const laptop = new BranchBundles({ ...machines.data('laptop'), maxBytes: 32 * 1024, run })
    const refusal = await laptop.prepare({ repository: machines.laptop, moveId: randomUUID(), commit, bases: [] })
    expect(refusal).toMatchObject({ type: 'refused', reason: 'too-large' })
    // Nothing was bundled: `git bundle create` never ran, so the data folder was never filled first.
    expect(ran.some(args => args[0] === 'bundle')).toBe(false)
    expect(await readdir(machines.data('laptop').stagingDirectory)).toEqual([])
  })

  it('discards a transfer cut off, or one that did not arrive whole, and lands nothing', async () => {
    git(machines.laptop, 'switch', '-q', '-c', 'big')
    const commit = await commitFile(machines.laptop, 'blob.bin', incompressible(3 * 1024 * 1024))
    const laptop = new BranchBundles(machines.data('laptop')), forge = new BranchBundles(machines.data('forge'))
    const moveId = randomUUID()
    const prepared = sending(await laptop.prepare({ repository: machines.laptop, moveId, commit, bases: [] }))
    const cut = incoming(await forge.receive({ repository: machines.forge, moveId, branch: 'big', commit, size: prepared.size, sha256: prepared.sha256 }))
    expect(await cut.write(0, await laptop.readChunk(prepared.path, 0))).toBe(true)
    // Out of order and past the end are both refused.
    expect(await cut.write(0, Buffer.from('again'))).toBe(false)
    await forge.abandon(cut)
    expect(await readdir(machines.data('forge').stagingDirectory)).toEqual([])
    // A whole transfer whose digest is not the one named is discarded too.
    const wrong = incoming(await forge.receive({ repository: machines.forge, moveId, branch: 'big', commit, size: prepared.size, sha256: 'f'.repeat(64) }))
    await carry(laptop, prepared, wrong)
    expect(await forge.finish(wrong)).toEqual({ type: 'refused', reason: 'not-whole', message: branchMoveWords.notWhole })
    expect(await readdir(machines.data('forge').stagingDirectory)).toEqual([])
    expect(git(machines.forge, 'for-each-ref', 'refs/sotto')).toBe('')
    // A bundle a crash left behind is cleared when the next run starts; other files stay.
    const staging = machines.data('forge').stagingDirectory
    await mkdir(staging, { recursive: true })
    await writeFile(join(staging, `${randomUUID()}.${randomUUID()}.in.bundle`), 'partial')
    await writeFile(join(staging, 'keep.txt'), 'not ours')
    await new BranchBundles(machines.data('forge')).start()
    expect(await readdir(staging)).toEqual(['keep.txt'])
  })

  it('clears a snapshot index and the lock a killed git add -A left beside it when the next run starts', async () => {
    const staging = machines.data('laptop').stagingDirectory
    await mkdir(staging, { recursive: true })
    const attempt = randomUUID()
    await writeFile(join(staging, `${attempt}.snapshot.index`), 'partial')
    await writeFile(join(staging, `${attempt}.snapshot.index.lock`), 'partial')
    await writeFile(join(staging, 'keep.snapshot.index.lock'), 'not ours')
    await new BranchBundles(machines.data('laptop')).start()
    expect(await readdir(staging)).toEqual(['keep.snapshot.index.lock'])
  })

  it('keeps every move’s record when moves finish together', async () => {
    const commit = await featureBranch()
    const laptop = new BranchBundles(machines.data('laptop'))
    const together = 4
    // Once armed, the read of each move's incoming ref answers only when all of them have, so every finish reaches its
    // record in the same turn.
    const gate: { armed?: Array<() => void> } = {}
    const run: RunGitCommand = async (cwd, command, args, options) => {
      const output = await runGitStatusCommand(cwd, command, args, options)
      const waiting = gate.armed
      if (waiting && args[0] === 'rev-parse' && args.includes('--quiet')) {
        await new Promise<void>(resolve => { waiting.push(resolve); if (waiting.length === together) for (const release of waiting) release() })
      }
      return output
    }
    const forge = new BranchBundles({ ...machines.data('forge'), run })
    const moves = await Promise.all(Array.from({ length: together }, async () => {
      const moveId = randomUUID()
      const prepared = sending(await laptop.prepare({ repository: machines.laptop, moveId, commit, bases: [] }))
      const receiving = incoming(await forge.receive({ repository: machines.forge, moveId, branch: 'feature/login', commit, size: prepared.size, sha256: prepared.sha256 }))
      await carry(laptop, prepared, receiving)
      return { moveId, receiving }
    }))
    gate.armed = []
    for (const receipt of await Promise.all(moves.map(({ receiving }) => forge.finish(receiving)))) expect(receipt).toMatchObject({ type: 'moved', commit })
    const records = JSON.parse(await readFile(machines.data('forge').recordsPath, 'utf8')) as { moves: Record<string, unknown> }
    expect(Object.keys(records.moves).sort()).toEqual(moves.map(({ moveId }) => moveId).sort())
  })

  it('abandons what a same-machine copy staged when reading or writing it fails, and lands nothing', async () => {
    await writeFile(join(machines.laptop, 'notes.txt'), 'draft\n')
    const laptop = new BranchBundles(machines.data('laptop'))
    const source = await laptop.snapshotOf(machines.laptop)
    if ('type' in source) throw new Error('The laptop could not snapshot its work.')
    for (const failing of ['read', 'write'] as const) {
      const spy = failing === 'read'
        ? vi.spyOn(laptop, 'readChunk').mockRejectedValueOnce(new Error('read failed'))
        : vi.spyOn(IncomingBundle.prototype, 'write').mockRejectedValueOnce(new Error('write failed'))
      expect(await laptop.copy({ from: machines.laptop, source, repository: machines.forge, moveId: randomUUID() }))
        .toEqual({ type: 'refused', reason: 'failed', message: branchMoveWords.failed })
      spy.mockRestore()
      expect(await readdir(machines.data('laptop').stagingDirectory)).toEqual([])
    }
    expect(git(machines.forge, 'for-each-ref', 'refs/sotto')).toBe('')
  })

  it('refuses a test run whose submodule has changes of its own, in plain words, rather than leave them behind', async () => {
    const library = join(machines.root, 'library')
    git(machines.root, 'init', '-q', library)
    await commitFile(library, 'lib.txt', 'one')
    git(machines.laptop, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'lib')
    git(machines.laptop, 'commit', '-q', '-m', 'Add the library')
    const laptop = new BranchBundles(machines.data('laptop'))
    const refused = { type: 'refused', reason: 'uncommitted', message: branchMoveWords.submoduleChanges }
    await writeFile(join(machines.laptop, 'lib', 'lib.txt'), 'edited in the submodule')
    expect(await laptop.snapshotOf(machines.laptop)).toEqual(refused)
    git(join(machines.laptop, 'lib'), 'checkout', '-q', '--', 'lib.txt')
    await writeFile(join(machines.laptop, 'lib', 'new.txt'), 'untracked in the submodule')
    expect(await laptop.snapshotOf(machines.laptop)).toEqual(refused)
    git(join(machines.laptop, 'lib'), 'clean', '-qf')
    // The parent's own uncommitted work beside a clean submodule still goes as a snapshot.
    await writeFile(join(machines.laptop, 'app.txt'), 'edited in the parent')
    expect(await laptop.snapshotOf(machines.laptop)).toMatchObject({ branch: 'main', snapshot: { untrackedCount: 0 } })
    expect(await readdir(machines.data('laptop').stagingDirectory)).toEqual([])
  })

  it('still sees a changed submodule when the repository tells Git to ignore it', async () => {
    const library = join(machines.root, 'library')
    git(machines.root, 'init', '-q', library)
    await commitFile(library, 'lib.txt', 'one')
    git(machines.laptop, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'lib')
    git(machines.laptop, 'commit', '-q', '-m', 'Add the library')
    const laptop = new BranchBundles(machines.data('laptop'))
    await writeFile(join(machines.laptop, 'lib', 'lib.txt'), 'edited in the submodule')
    for (const ignore of ['dirty', 'all']) {
      git(machines.laptop, 'config', 'submodule.lib.ignore', ignore)
      expect(await laptop.snapshotOf(machines.laptop), ignore).toEqual({ type: 'refused', reason: 'uncommitted', message: branchMoveWords.submoduleChanges })
      expect(await laptop.branchOf(machines.laptop), ignore).toEqual({ type: 'refused', reason: 'uncommitted', message: branchMoveWords.uncommitted })
    }
    expect(await readdir(machines.data('laptop').stagingDirectory)).toEqual([])
  })
})
