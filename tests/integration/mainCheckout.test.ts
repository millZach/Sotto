// @vitest-environment node

import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { GitActions } from '../../src/main/agents/gitActions'
import { GitStatusReader } from '../../src/main/agents/gitStatus'
import { MainCheckoutKeeper, type MainCheckoutHost } from '../../src/main/agents/mainCheckout'
import { ownedGitRepository, runFixtureGit } from '../fixtures/gitRepository'

type Repository = Awaited<ReturnType<typeof ownedGitRepository>>
const owned: Array<() => Promise<void>> = []
afterEach(async () => { while (owned.length) await owned.pop()!() })

/** A project checkout behind its remote: `other` pushes `commits` commits the project has not fetched. */
async function behind(commits: ReadonlyArray<Readonly<Record<string, string>>> = [{ 'incoming.txt': 'incoming' }]): Promise<Repository> {
  const repository = await ownedGitRepository({ secondClone: true })
  owned.push(repository.dispose)
  commits.forEach((files, index) => push(repository, files, `Incoming ${index + 1}`))
  return repository
}

function push(repository: Repository, files: Readonly<Record<string, string>>, message: string): void {
  for (const [path, contents] of Object.entries(files)) {
    const parts = path.split('/')
    mkdirSync(join(repository.other, ...parts.slice(0, -1)), { recursive: true })
    writeFileSync(join(repository.other, ...parts), contents)
  }
  runFixtureGit(repository.other, 'add', '-A')
  runFixtureGit(repository.other, 'commit', '-qm', message)
  runFixtureGit(repository.other, 'push', '-q', 'origin', 'main')
}

async function keeperFor(repository: Repository, options: { host?: Partial<MainCheckoutHost>; enabled?: () => boolean; retryMs?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-main-checkout-'))
  owned.push(() => rm(directory, { recursive: true, force: true }))
  const status = new GitStatusReader({ fetchIntervalMs: () => 0 })
  const actions = new GitActions({ status, writeCommitMessage: async () => null, writePullRequestText: async () => null })
  const host: MainCheckoutHost = {
    mainCheckoutProjects: () => [{ id: 'project', path: repository.repo, settled: false }],
    withProjectCheckout: async (_folder, work) => work(),
    ...options.host,
  }
  const keeper = new MainCheckoutKeeper({ host, status, actions, directory, enabled: options.enabled ?? (() => true), retryMs: options.retryMs ?? 60 * 60_000, mergeGatherMs: 0 })
  owned.push(() => keeper.close())
  return { keeper, directory }
}

const head = (repository: Repository): string => repository.git('rev-parse', 'HEAD').trim()
const remoteHead = (repository: Repository): string => runFixtureGit(repository.other, 'rev-parse', 'HEAD').trim()

describe('Keep main up to date (ADR-0142)', () => {
  it('fast-forwards a clean default branch to the remote and says nothing afterwards', async () => {
    const repository = await behind([{ 'one.txt': '1' }, { 'two.txt': '2' }])
    const { keeper } = await keeperFor(repository)
    await keeper.request('all')
    expect(head(repository)).toBe(remoteHead(repository))
    expect(keeper.state().projects).toEqual([])
  }, 30_000)

  it('says dependencies changed when the update changed a lockfile, until dismissed, across a restart', async () => {
    const repository = await behind([{ 'package-lock.json': '{}', 'packages/app/pnpm-lock.yaml': 'lock' }])
    const { keeper, directory } = await keeperFor(repository)
    await keeper.request('all')
    expect(keeper.state().projects).toEqual([{ projectId: 'project', branch: 'main', behind: 0, blocked: null, dependencies: ['package-lock.json', 'packages/app/pnpm-lock.yaml'] }])
    // A second keeper reads the notice back from the data folder, as Sotto does after a restart.
    const status = new GitStatusReader({ fetchIntervalMs: () => 0 })
    const again = new MainCheckoutKeeper({ host: { mainCheckoutProjects: () => [{ id: 'project', path: repository.repo, settled: false }], withProjectCheckout: async (_folder, work) => work() },
      status, actions: new GitActions({ status, writeCommitMessage: async () => null, writePullRequestText: async () => null }), directory, enabled: () => true })
    owned.push(() => again.close())
    await again.request([])
    expect(again.state().projects[0]?.dependencies).toEqual(['package-lock.json', 'packages/app/pnpm-lock.yaml'])
    await again.dismissDependencies('project')
    expect(again.state().projects).toEqual([])
  }, 30_000)

  it('leaves a default branch with local changes where it is and lists them for Show changes', async () => {
    const repository = await behind()
    await writeFile(join(repository.repo, 'tracked.txt'), 'edited')
    const before = head(repository)
    const { keeper } = await keeperFor(repository)
    await keeper.request('all')
    expect(head(repository)).toBe(before)
    expect(keeper.state().projects).toEqual([{ projectId: 'project', branch: 'main', behind: 1, blocked: { reason: 'changes' }, dependencies: null }])
    await expect(keeper.changes('project')).resolves.toEqual({ items: [{ kind: 'modified', text: 'tracked.txt' }], more: 0 })
  }, 30_000)

  it('leaves the folder alone when an untracked file would be overwritten, naming it', async () => {
    const repository = await behind([{ 'incoming.txt': 'theirs' }])
    await writeFile(join(repository.repo, 'incoming.txt'), 'mine')
    const before = head(repository)
    const { keeper } = await keeperFor(repository)
    await keeper.request('all')
    expect(head(repository)).toBe(before)
    expect(keeper.state().projects[0]?.blocked).toEqual({ reason: 'untracked' })
    await expect(keeper.changes('project')).resolves.toEqual({ items: [{ kind: 'untracked', text: 'incoming.txt' }], more: 0 })
  }, 30_000)

  it('never switches branches: another branch checked out is said, and main is not moved', async () => {
    const repository = await behind()
    repository.git('checkout', '-q', '-b', 'fix/tray-icon')
    const main = repository.git('rev-parse', 'refs/heads/main').trim()
    const { keeper } = await keeperFor(repository)
    await keeper.request('all')
    expect(repository.git('rev-parse', 'refs/heads/main').trim()).toBe(main)
    expect(keeper.state().projects[0]).toMatchObject({ behind: 1, blocked: { reason: 'branch', checkedOut: 'fix/tray-icon' } })
  }, 30_000)

  it('never merges: a default branch with commits of its own is said, with the commits for Show commits', async () => {
    const repository = await behind()
    await writeFile(join(repository.repo, 'local.txt'), 'local')
    repository.git('add', 'local.txt')
    repository.git('commit', '-qm', 'Local work')
    const before = head(repository)
    const { keeper } = await keeperFor(repository)
    await keeper.request('all')
    expect(head(repository)).toBe(before)
    expect(keeper.state().projects[0]?.blocked).toEqual({ reason: 'diverged', ahead: 1 })
    const changes = await keeper.changes('project')
    expect(changes.items).toEqual([{ kind: 'commit', text: expect.stringMatching(/ Local work$/u) }])
  }, 30_000)

  it('says a merge is in progress rather than touching it', async () => {
    const repository = await behind()
    await writeFile(join(repository.repo, '.git', 'MERGE_HEAD'), `${head(repository)}\n`)
    const before = head(repository)
    const { keeper } = await keeperFor(repository)
    await keeper.request('all')
    expect(head(repository)).toBe(before)
    expect(keeper.state().projects[0]?.blocked).toEqual({ reason: 'in-progress', operation: 'merge' })
  }, 30_000)

  it('waits for a thread working in the checkout, saying nothing, and tries again later', async () => {
    const repository = await behind()
    const before = head(repository)
    const withProjectCheckout = vi.fn(async () => null)
    const { keeper } = await keeperFor(repository, { host: { withProjectCheckout } })
    await keeper.request('all')
    expect(withProjectCheckout).toHaveBeenCalledOnce()
    expect(head(repository)).toBe(before)
    expect(keeper.state().projects).toEqual([])
  }, 30_000)

  it('says nothing of a working thread\'s own edits, and says what is in the way once the thread rests', async () => {
    const repository = await behind()
    await writeFile(join(repository.repo, 'tracked.txt'), 'edited by the thread')
    let working = true
    const withProjectCheckout: MainCheckoutHost['withProjectCheckout'] = async (_folder, work) => working ? null : work()
    const { keeper } = await keeperFor(repository, { host: { withProjectCheckout }, retryMs: 50 })
    await keeper.request('all')
    expect(keeper.state().projects).toEqual([])
    working = false
    await vi.waitFor(() => expect(keeper.state().projects[0]?.blocked).toEqual({ reason: 'changes' }))
  }, 30_000)

  it('never overwrites an ignored file the incoming commits track', async () => {
    const repository = await behind([{ 'built.txt': 'theirs' }])
    mkdirSync(join(repository.repo, '.git', 'info'), { recursive: true })
    await writeFile(join(repository.repo, '.git', 'info', 'exclude'), 'built.txt\n')
    await writeFile(join(repository.repo, 'built.txt'), 'mine')
    const before = head(repository)
    const { keeper } = await keeperFor(repository)
    await keeper.request('all')
    expect(head(repository)).toBe(before)
    expect(await readFile(join(repository.repo, 'built.txt'), 'utf8')).toBe('mine')
    expect(keeper.state().projects[0]?.blocked).toEqual({ reason: 'untracked' })
  }, 30_000)

  it('keeps the last line when the remote cannot be reached', async () => {
    const repository = await behind()
    await writeFile(join(repository.repo, 'tracked.txt'), 'edited')
    const { keeper } = await keeperFor(repository)
    await keeper.request('all')
    const said = keeper.state()
    await rename(repository.remote, `${repository.remote}.gone`)
    await keeper.request('all')
    expect(keeper.state()).toEqual(said)
  }, 30_000)

  it('does nothing for a project whose switch is off, and forgets its line', async () => {
    const repository = await behind()
    await writeFile(join(repository.repo, 'tracked.txt'), 'edited')
    let on = true
    const { keeper } = await keeperFor(repository, { enabled: () => on })
    await keeper.request('all')
    expect(keeper.state().projects).toHaveLength(1)
    on = false
    await keeper.request('all')
    expect(keeper.state().projects).toEqual([])
  }, 30_000)

  it('checks the projects of a repository whose pull request merged, once per pull request', async () => {
    const repository = await behind()
    repository.git('remote', 'set-url', 'origin', 'https://github.com/millZach/Sotto.git')
    const { keeper } = await keeperFor(repository)
    const request = vi.spyOn(keeper, 'request')
    keeper.pullRequestMerged('https://github.com/millzach/sotto/pull/1406')
    keeper.pullRequestMerged('https://github.com/millzach/sotto/pull/1406')
    keeper.pullRequestMerged('https://github.com/someone/else/pull/2')
    // The same name on another host is another repository.
    keeper.pullRequestMerged('https://github.example.com/millZach/Sotto/pull/7')
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(['project']))
    expect(request).toHaveBeenCalledOnce()
  }, 30_000)
})
