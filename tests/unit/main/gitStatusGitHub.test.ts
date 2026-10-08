// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { GitStatusReader, type RunGitCommand } from '../../../src/main/agents/gitStatus'

/**
 * What the status reader asks GitHub (#820), over a scripted Git and a scripted gh: every folder is a line in a table,
 * so ten or thirty worktrees cost nothing to set up, and the count of gh processes is exact.
 */
const SHA = 'a'.repeat(40)
interface Folder {
  readonly common: string; readonly branch: string; readonly upstream?: string | null; readonly oid?: string
  /** Remote name to URL, as `git config` lists them; origin on GitHub's sotto-fixture/owned when absent. */
  readonly remotes?: Readonly<Record<string, string>>
  /** Where Git pushes the branch; its upstream's remote when absent. */
  readonly pushRemote?: string
}
interface Pull { readonly head: string; readonly number: number; readonly state?: 'OPEN' | 'CLOSED' | 'MERGED'; readonly owner?: string; readonly cross?: boolean; readonly updatedAt?: string }
type GhAnswer = string | Error | Promise<string>

/** GitHub's answer to the batched head query: each aliased head gets the pull requests whose head has its name. */
function headsAnswer(args: readonly string[], pulls: readonly Pull[], extra: Record<string, unknown> = {}): string {
  const repository: Record<string, unknown> = {}
  for (const argument of args) {
    const match = /^(h\d+)=(.*)$/su.exec(argument)
    if (!match) continue
    repository[match[1]!] = { nodes: pulls.filter(pull => pull.head === match[2]).map(pull => ({
      number: pull.number, title: `Pull ${pull.number}`, url: `https://github.com/sotto-fixture/owned/pull/${pull.number}`, state: pull.state ?? 'OPEN', isDraft: false,
      updatedAt: pull.updatedAt ?? '2026-10-07T00:00:00Z', headRefName: pull.head, isCrossRepository: pull.cross ?? false, headRepositoryOwner: { login: pull.owner ?? 'sotto-fixture' },
    })) }
  }
  return JSON.stringify({ data: { ...extra, repository } })
}

function harness(folders: Record<string, Folder>, gh: (args: readonly string[]) => GhAnswer, options: { gatherMs?: number } = {}) {
  let now = 1_000_000
  const calls: string[][] = []
  const git: string[][] = []
  const run: RunGitCommand = async (cwd, command, args) => {
    if (command === 'gh') {
      calls.push([...args])
      const answer = await gh(args)
      if (answer instanceof Error) throw answer
      return answer
    }
    git.push([cwd, ...args])
    const folder = folders[cwd]
    if (!folder) throw new Error('fatal: not a git repository')
    const upstream = folder.upstream === undefined ? `origin/${folder.branch}` : folder.upstream
    const remotes = folder.remotes ?? { origin: 'https://github.com/sotto-fixture/owned' }
    const pushRemote = folder.pushRemote ?? upstream?.split('/')[0] ?? 'origin'
    switch (args[0]) {
      case 'rev-parse':
        if (args.includes('--git-common-dir')) return `${folder.common}\n`
        if (args.includes('--verify')) return `${SHA}\n`
        return '\n'
      case 'remote': return `${Object.keys(remotes).join('\n')}\n`
      case 'fetch': return ''
      case 'status': return [`# branch.oid ${folder.oid ?? SHA}`, `# branch.head ${folder.branch}`, ...upstream ? [`# branch.upstream ${upstream}`, '# branch.ab +0 -0'] : [], ''].join('\0')
      case 'diff': return ''
      case 'symbolic-ref': return 'origin/main\n'
      case 'rev-list': return '1\n'
      case 'for-each-ref': return `refs/heads/${folder.branch}\t\t${pushRemote}\n${upstream ? `refs/remotes/${pushRemote}/${folder.branch}\t\t\n` : ''}`
      case 'config': return Object.entries(remotes).map(([name, url]) => `remote.${name}.url ${url}`).join('\n') + '\n'
      default: return ''
    }
  }
  const gatherMs = options.gatherMs ?? 5
  const reader = new GitStatusReader({ run, now: () => now, fetchIntervalMs: () => 30_000, headGatherMs: { user: gatherMs, background: gatherMs } })
  /** The workspace's round for one folder: a local read, its remote half, then the read that takes what it brought. */
  const round = async (folder: string, background = false) => {
    await reader.read(folder, { remote: false })
    await reader.readRemote(folder, { background })
    return reader.read(folder, { remote: false, fresh: true })
  }
  return { reader, calls, git, round, graphql: () => calls.filter(call => call[0] === 'api' && call[1] === 'graphql').length, advance: (ms: number) => { now += ms }, now: () => now }
}

const worktrees = (count: number, common = 'C:/fixture/owned/.git'): Record<string, Folder> =>
  Object.fromEntries(Array.from({ length: count }, (_, index) => [`C:/fixture/worktrees/thread-${index + 1}`, { common, branch: `feature/thread-${index + 1}` }]))

describe('one question per repository', () => {
  it('asks about ten branches of one repository in one gh api graphql call, each head a variable', async () => {
    const folders = worktrees(10)
    const pulls = Object.values(folders).map((folder, index) => ({ head: folder.branch, number: 100 + index }))
    const f = harness(folders, args => headsAnswer(args, pulls))
    const statuses = await Promise.all(Object.keys(folders).map(folder => f.round(folder, true)))
    expect(f.calls).toHaveLength(1)
    expect(f.graphql()).toBe(1)
    expect(statuses.map(status => status.pullRequest?.number)).toEqual(pulls.map(pull => pull.number))
    const call = f.calls[0]!
    const query = call.find(arg => arg.startsWith('query='))!
    // Each branch name travels as a variable; none is written into the query.
    expect(query).toContain('h9: pullRequests(headRefName: $h9')
    for (const folder of Object.values(folders)) { expect(query).not.toContain(folder.branch); expect(call).toContain(`h${Object.values(folders).indexOf(folder)}=${folder.branch}`) }
    expect(call).toEqual(expect.arrayContaining(['owner=sotto-fixture', 'name=owned']))
  })
  it('splits thirty branches into queries of at most 25', async () => {
    const folders = worktrees(30)
    const f = harness(folders, args => headsAnswer(args, []))
    await Promise.all(Object.keys(folders).map(folder => f.round(folder, true)))
    expect(f.calls.map(call => call.filter(arg => /^h\d+=/u.test(arg)).length).sort((a, b) => a - b)).toEqual([5, 25])
  })
  it('asks once for one repository and branch read through two clones at once', async () => {
    const folders: Record<string, Folder> = { 'C:/one': { common: 'C:/one/.git', branch: 'feature/shared' }, 'C:/two': { common: 'C:/two/.git', branch: 'feature/shared' } }
    const f = harness(folders, args => headsAnswer(args, [{ head: 'feature/shared', number: 7 }]))
    const [one, two] = await Promise.all([f.round('C:/one'), f.round('C:/two')])
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]!.filter(arg => /^h\d+=/u.test(arg))).toEqual(['h0=feature/shared'])
    expect([one.pullRequest?.number, two.pullRequest?.number]).toEqual([7, 7])
  })
  it('asks nothing about a branch nobody has pushed or a repository not on GitHub', async () => {
    const f = harness({
      'C:/local': { common: 'C:/local/.git', branch: 'feature/unpushed', upstream: null },
      'C:/elsewhere': { common: 'C:/elsewhere/.git', branch: 'feature/x', remotes: { origin: 'https://git.example.com/o/r.git' } },
    }, () => new Error('unexpected'))
    expect((await f.round('C:/local')).pullRequest).toBeNull()
    expect((await f.round('C:/elsewhere')).pullRequest).toBeNull()
    expect(f.calls).toHaveLength(0)
  })
})

describe('the head repository matches', () => {
  it('does not take a fork\'s pull request with the same head name for the branch\'s own', async () => {
    const f = harness({
      'C:/main': { common: 'C:/repo/.git', branch: 'main' },
      'C:/feature': { common: 'C:/repo/.git', branch: 'feature/greeting' },
    }, args => headsAnswer(args, [
      // A fork's main, open against this repository: never this checkout's main.
      { head: 'main', number: 40, owner: 'someone', cross: true },
      // A fork's branch of the same name, newer than this repository's own.
      { head: 'feature/greeting', number: 41, owner: 'someone', cross: true, updatedAt: '2026-10-07T02:00:00Z' },
      { head: 'feature/greeting', number: 42, updatedAt: '2026-10-07T01:00:00Z' },
    ]))
    const [main, feature] = await Promise.all([f.round('C:/main'), f.round('C:/feature')])
    expect(main.pullRequest).toBeNull()
    expect(feature.pullRequest?.number).toBe(42)
  })
  it('takes the pull request from the fork a triangular branch is pushed to', async () => {
    const f = harness({ 'C:/repo': { common: 'C:/repo/.git', branch: 'feature/fix', pushRemote: 'mine',
      remotes: { origin: 'https://github.com/sotto-fixture/owned.git', mine: 'git@github.com:me/owned.git' } } },
    args => headsAnswer(args, [{ head: 'feature/fix', number: 50 }, { head: 'feature/fix', number: 51, owner: 'me', cross: true }]))
    expect((await f.round('C:/repo')).pullRequest?.number).toBe(51)
    // Asked of the repository pull requests are opened against, not of the fork.
    expect(f.calls[0]).toEqual(expect.arrayContaining(['owner=sotto-fixture', 'name=owned']))
  })
  it('asks the upstream repository of a fork cloned as origin, as gh does without a default set', async () => {
    const f = harness({ 'C:/fork': { common: 'C:/fork/.git', branch: 'feature/fix',
      remotes: { origin: 'https://github.com/me/owned.git', upstream: 'https://github.com/sotto-fixture/owned.git' } } },
    args => headsAnswer(args, [{ head: 'feature/fix', number: 52, owner: 'me', cross: true }]))
    expect((await f.round('C:/fork')).pullRequest?.number).toBe(52)
    expect(f.calls[0]).toEqual(expect.arrayContaining(['owner=sotto-fixture', 'name=owned']))
  })
  it('asks github.com about a remote behind an SSH alias for it', async () => {
    const f = harness({ 'C:/work': { common: 'C:/work/.git', branch: 'feature/fix', remotes: { origin: 'git@github-work:sotto-fixture/owned.git' } } },
      args => headsAnswer(args, [{ head: 'feature/fix', number: 53 }]))
    expect((await f.round('C:/work')).pullRequest?.number).toBe(53)
    expect(f.calls[0]).not.toContain('--hostname')
  })
})

describe('the rate limit is read and respected', () => {
  const reading = (f: { now: () => number }, remaining: number, resetInMs: number) => ({ rateLimit: { limit: 5000, remaining, resetAt: new Date(f.now() + resetInMs).toISOString() }, viewer: { login: 'sotto-fixture' } })
  it('pauses background reads until the reset after a rate-limited answer, keeps the last answer, and still asks for a refresh', async () => {
    let refuse: string | null = null
    const folders = { 'C:/repo': { common: 'C:/repo/.git', branch: 'feature/open' } }
    // Every answer gives the same reset, thirty minutes after the harness's clock starts.
    const f = harness(folders, args => refuse !== null ? new Error(refuse) : headsAnswer(args, [{ head: 'feature/open', number: 9 }], reading({ now: () => 1_000_000 }, 4000, 30 * 60_000)))
    expect((await f.round('C:/repo', true)).pullRequest?.number).toBe(9)
    expect(f.calls[0]!.find(arg => arg.startsWith('query='))).toContain('rateLimit { limit remaining resetAt }')
    refuse = 'GraphQL: API rate limit exceeded for user ID 1. (HTTP 403)'
    f.advance(61_000)
    // GitHub refuses: the last answer stands.
    expect((await f.round('C:/repo', true)).pullRequest?.number).toBe(9)
    expect(f.calls).toHaveLength(2)
    // The timer asks nothing until the reset GitHub gave, not even Git where the branch is pushed.
    const listings = () => f.git.filter(call => call[1] === 'for-each-ref').length
    const before = listings()
    for (let minute = 0; minute < 25; minute++) { f.advance(60_000); expect((await f.round('C:/repo', true)).pullRequest?.number).toBe(9) }
    expect(f.calls).toHaveLength(2)
    expect(listings()).toBe(before)
    // A refresh is the user's: it goes through the pause.
    refuse = null
    await f.round('C:/repo')
    expect(f.calls).toHaveLength(3)
    // GitHub answered, so the pause is over for the timer too.
    f.advance(61_000)
    await f.round('C:/repo', true)
    expect(f.calls).toHaveLength(4)
  })
  it('pauses for 30 seconds, doubling, when GitHub gives no reset, as for a secondary limit', async () => {
    const f = harness({ 'C:/repo': { common: 'C:/repo/.git', branch: 'feature/x' } }, () => new Error('gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)'))
    await f.round('C:/repo', true)
    expect(f.calls).toHaveLength(1)
    f.advance(29_000); await f.round('C:/repo', true)
    expect(f.calls).toHaveLength(1)
    f.advance(2_000); await f.round('C:/repo', true)
    expect(f.calls).toHaveLength(2)
    // The second refusal doubles the pause.
    f.advance(59_000); await f.round('C:/repo', true)
    expect(f.calls).toHaveLength(2)
    f.advance(2_000); await f.round('C:/repo', true)
    expect(f.calls).toHaveLength(3)
  })
  it('stops background reads while less than a tenth of the points remain, and lets the user spend the rest', async () => {
    // Every answer gives the same reset, twenty minutes after the harness's clock starts.
    const f = harness({ 'C:/repo': { common: 'C:/repo/.git', branch: 'feature/open' } }, args => headsAnswer(args, [{ head: 'feature/open', number: 9 }], reading({ now: () => 1_000_000 }, 499, 20 * 60_000)))
    await f.round('C:/repo', true)
    expect(f.calls).toHaveLength(1)
    for (let minute = 0; minute < 19; minute++) { f.advance(60_000); await f.round('C:/repo', true) }
    expect(f.calls).toHaveLength(1)
    await f.round('C:/repo')
    expect(f.calls).toHaveLength(2)
    // Past the reset the reading no longer holds, and the timer asks again.
    f.advance(2 * 60_000)
    await f.round('C:/repo', true)
    expect(f.calls).toHaveLength(3)
  })
})

describe('an action refreshes only its own repository', () => {
  const two = (): Record<string, Folder> => ({
    'C:/a': { common: 'C:/a/.git', branch: 'feature/a' },
    'C:/b': { common: 'C:/b/.git', branch: 'feature/b', remotes: { origin: 'https://github.com/sotto-fixture/other' } },
  })
  it('leaves another repository\'s fetch and pull request answers fresh', async () => {
    const f = harness(two(), args => headsAnswer(args, [{ head: 'feature/a', number: 1 }, { head: 'feature/b', number: 2 }]))
    await Promise.all([f.round('C:/a', true), f.round('C:/b', true)])
    const fetches = () => f.git.filter(call => call[1] === 'fetch').map(call => call[0])
    const asked = () => f.calls.flatMap(call => call.filter(arg => /^h\d+=/u.test(arg)))
    expect(asked()).toEqual(['h0=feature/a', 'h0=feature/b'])
    f.advance(1_000)
    // A Git action in a: its fetch is due again and its answer is asked again; b keeps both.
    f.reader.invalidate('C:/a')
    await Promise.all([f.round('C:/a', true), f.round('C:/b', true)])
    expect(fetches()).toEqual(['C:/a', 'C:/b', 'C:/a'])
    expect(asked()).toEqual(['h0=feature/a', 'h0=feature/b', 'h0=feature/a'])
    // Named by its common Git directory, the repository is found the same way.
    f.reader.invalidate('C:/b/.git')
    await Promise.all([f.round('C:/a', true), f.round('C:/b', true)])
    expect(asked()).toEqual(['h0=feature/a', 'h0=feature/b', 'h0=feature/a', 'h0=feature/b'])
  })
  it('lets an answer asked before an action in its own repository not stand, and one asked before an action elsewhere stand', async () => {
    let release: (() => void) | undefined
    const f = harness(two(), async args => {
      if (release === undefined && args.some(arg => arg === 'h0=feature/a')) await new Promise<void>(go => { release = go })
      return headsAnswer(args, [{ head: 'feature/a', number: 1 }])
    })
    await f.reader.read('C:/a', { remote: false })
    await f.reader.read('C:/b', { remote: false })
    // An action elsewhere while a's question is out: a's answer, when it comes, stands.
    const first = f.reader.readRemote('C:/a')
    await vi.waitFor(() => expect(release).toBeDefined())
    f.reader.invalidate('C:/b')
    release!()
    await first
    expect(await f.reader.readRemote('C:/a')).toBe(true)
    expect(f.calls).toHaveLength(1)
    expect((await f.reader.read('C:/a', { remote: false })).pullRequest?.number).toBe(1)
    // An action in a while its question is out: the answer lands, and is asked for again.
    f.advance(61_000)
    release = undefined
    const second = f.reader.readRemote('C:/a')
    await vi.waitFor(() => expect(release).toBeDefined())
    f.reader.invalidate('C:/a')
    release!()
    await second
    await f.reader.read('C:/a', { remote: false })
    await f.reader.readRemote('C:/a')
    expect(f.calls).toHaveLength(3)
  })
})

describe('answers last as long as they safely can', () => {
  it('keeps an open answer a minute, none five minutes, and a merged one fifteen minutes or until the branch moves', async () => {
    let pulls: Pull[] = [{ head: 'feature/open', number: 1 }, { head: 'feature/merged', number: 2, state: 'MERGED' }]
    const folders: Record<string, Folder> = {
      'C:/open': { common: 'C:/repo/.git', branch: 'feature/open' },
      'C:/none': { common: 'C:/repo/.git', branch: 'feature/none' },
      'C:/merged': { common: 'C:/repo/.git', branch: 'feature/merged' },
    }
    const f = harness(folders, args => headsAnswer(args, pulls))
    const asked = () => f.calls.flatMap(call => call.filter(arg => /^h\d+=/u.test(arg)).map(arg => arg.slice(arg.indexOf('=') + 1))).sort()
    const all = () => Promise.all(Object.keys(folders).map(folder => f.round(folder, true)))
    await all()
    expect(asked()).toEqual(['feature/merged', 'feature/none', 'feature/open'])
    f.calls.length = 0
    f.advance(60_000); await all()
    expect(asked()).toEqual(['feature/open'])
    f.calls.length = 0
    f.advance(4 * 60_000); await all()
    expect(asked()).toEqual(['feature/none', 'feature/open'])
    f.calls.length = 0
    // The merged branch moves on: its answer is asked again before the fifteen minutes are up.
    folders['C:/merged'] = { ...folders['C:/merged']!, oid: 'b'.repeat(40) }
    pulls = [...pulls, { head: 'feature/merged', number: 3, updatedAt: '2026-10-07T03:00:00Z' }]
    f.advance(60_000)
    const statuses = await all()
    expect(asked()).toEqual(['feature/merged', 'feature/open'])
    expect(statuses[2]!.pullRequest?.number).toBe(3)
  })
})

/**
 * The measurement behind docs/verification/2026-10-07-github-rate-limit.md: ten threads, each in its own worktree of one
 * repository on its own pushed branch, read by the workspace's timer every 30 seconds (the default Git fetch interval)
 * with the window in front, for one simulated hour. Before #820 the same hour cost 600 gh processes whatever GitHub
 * answered: one `gh pr list --head` per branch a minute.
 */
describe('gh calls for ten threads on ten branches over one hour with the window in front', () => {
  const hour = async (open: (branch: string) => boolean): Promise<number> => {
    const folders = worktrees(10)
    const pulls = Object.values(folders).filter(folder => open(folder.branch)).map((folder, index) => ({ head: folder.branch, number: 100 + index }))
    const f = harness(folders, args => headsAnswer(args, pulls))
    for (let elapsed = 0; elapsed < 3_600_000; elapsed += 30_000) {
      await Promise.all(Object.keys(folders).map(folder => f.round(folder, true)))
      f.advance(30_000)
    }
    return f.calls.length
  }
  it('asks once a minute for ten open pull requests, in one query', async () => { expect(await hour(() => true)).toBe(60) })
  it('asks once every five minutes for ten branches with no pull request', async () => { expect(await hour(() => false)).toBe(12) })
  it('asks once a minute when half have an open pull request, the rest riding along every fifth time', async () => { expect(await hour(branch => Number(/\d+$/u.exec(branch)![0]) <= 5)).toBe(60) })
})
