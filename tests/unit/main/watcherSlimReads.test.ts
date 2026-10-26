// @vitest-environment node
import { expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { WATCHER_READ_BYTES_MAX, watcherToolSchemas, type WatcherEvidence, type WatcherToolOutput } from '../../../src/shared/watcher'
import { watcherEndedPullRequests, watcherHostInput, watcherPullRequestSummaries, watcherSlimRead } from '../../../src/main/agents/watcherSlimReads'

const hostId = randomUUID(), at = '2026-10-19T10:00:00.000Z'
const target = (threadId: string) => ({ hostId, threadId })
const prUrl = (n: number) => `https://github.com/synthetic/project/pull/${n}`
/** The facts a pull request leaves in a thread's evidence: its link, state, checks, review and auto-merge. */
function prFacts(threadId: string, n: number, checks: 'passed' | 'failed' | 'pending' = 'passed'): WatcherEvidence[] {
  const common = { target: target(threadId), source: 'github' as const, observedAt: at, freshness: 'fresh' as const, availability: 'available' as const, url: prUrl(n), headId: `head-${n}` }
  return [
    { ...common, id: randomUUID(), fact: 'pull-request-observed' },
    { ...common, id: randomUUID(), fact: checks === 'failed' ? 'checks-failed' : checks === 'passed' ? 'checks-passed' : 'pull-request-observed', checksState: checks, checkCount: 12 },
    { ...common, id: randomUUID(), fact: 'pull-request-observed', pullRequestState: 'open' },
    { ...common, id: randomUUID(), fact: 'pull-request-observed', githubReviewApproved: false },
    { ...common, id: randomUUID(), fact: 'pull-request-observed', githubAutoMergeEnabled: false },
  ]
}
type FullRows = Extract<WatcherToolOutput<'list_threads'>, { status: 'ok' }>['rows']
/** A roster like the October 19 session's: threads with several open pull requests each, and their facts on every row. */
function roster(threads: number, prsEach: number) {
  const rows = Array.from({ length: threads }, (_, index) => {
    const id = `thread-${index}`, numbers = Array.from({ length: prsEach }, (_, n) => 1_000 + index * 10 + n)
    return { target: target(id), title: `Synthetic thread ${index}`, projectId: 'project', provider: 'codex' as const, modelId: 'native:codex:model:gpt-6.1-sol', reasoningEffort: 'xhigh',
      status: 'idle' as const, group: 'Ready for review' as const, waitsOn: [], branch: `sotto/${id}`, workingCopy: { kind: 'new-worktree' as const },
      pullRequests: numbers.map(number => ({ number, url: prUrl(number), title: `Synthetic pull request ${number}`, state: 'open' as const, draft: false })),
      evidence: [...numbers.flatMap(number => prFacts(id, number)), { id: randomUUID(), target: target(id), source: 'working-copy' as const, observedAt: at, freshness: 'fresh' as const,
        availability: 'available' as const, fact: 'files-changed' as const, branch: `sotto/${id}`, changedFiles: 4, insertions: 120, deletions: 30, ahead: 2, behind: 0, fetchedAt: at }],
      lastActivityAt: at, observedAt: at, connected: true, freshness: 'fresh' as const, userReadAt: null, watcherReadAt: at,
      participation: [{ requestId: randomUUID(), startedBy: 'watcher' as const, generation: 0, state: 'participating' as const }], protected: false }
  })
  return { status: 'ok' as const, rows: rows as FullRows, snapshotRevision: randomUUID(), nextCursor: null, observedAt: at, staleHosts: [],
    counts: { 'Needs you': 0, 'Ready for review': threads, Working: 0, Landing: 0, Quiet: 0, Idle: 0 } }
}
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))

it('never sends a paired host the keys only the desktop reads', () => {
  expect(watcherHostInput('list_threads', { includeSettled: true, limit: 100, watchedOnly: true, detail: 'slim' })).toEqual({ includeSettled: true, limit: 100 })
  expect(watcherHostInput('read_thread', { target: target('a'), limit: 1, includeActivities: false, evidence: 'full' })).toEqual({ target: target('a'), limit: 1, includeActivities: false })
  expect(watcherHostInput('list_projects', { hostId, projectId: 'p', query: 'sotto', includeModels: true, limit: 100 })).toEqual({ hostId, limit: 100 })
  const unchanged = { includeSettled: true, limit: 100 }
  expect(watcherHostInput('list_threads', unchanged)).toBe(unchanged)
})

it('sums up each pull request from its facts, leaving out what was never read', () => {
  const facts = [...prFacts('a', 7, 'failed'), { ...prFacts('a', 8)[0]!, freshness: 'stale' as const }]
  expect(watcherPullRequestSummaries(facts)).toEqual([
    { number: 7, url: prUrl(7), state: 'open', checks: 'failed' },
    { number: 8, url: prUrl(8), stale: true }])
})

it('gives a slim roster by default, a full one when asked, and only the watched threads when asked', () => {
  const full = roster(3, 2), watched = (item: { threadId: string }) => item.threadId === 'thread-1'
  const slim = watcherSlimRead('list_threads', {}, full, watched) as typeof full
  expect(watcherToolSchemas.list_threads.output.parse(slim)).toBeTruthy()
  expect(slim.rows[1]).toEqual({ target: target('thread-1'), title: 'Synthetic thread 1', projectId: 'project', status: 'idle', group: 'Ready for review', waitsOn: [],
    watched: true, connected: true, pullRequests: [
      { number: 1010, state: 'open', checks: 'passed' }, { number: 1011, state: 'open', checks: 'passed' }] })
  expect(watcherSlimRead('list_threads', { detail: 'full' }, full, watched)).toEqual({ ...full, rows: full.rows.map(row => ({ ...row, watched: watched(row.target) })) })
  expect((watcherSlimRead('list_threads', { watchedOnly: true }, full, watched) as typeof full).rows.map(row => row.target.threadId)).toEqual(['thread-1'])
  const refused = { status: 'refused', code: 'HOST_DISCONNECTED', message: 'Reconnect.', retryable: true }
  expect(watcherSlimRead('list_threads', {}, refused, watched)).toBe(refused)
})

it('reads a thread with its pull requests summed up unless every fact is asked for', () => {
  const evidence = prFacts('a', 7, 'failed')
  const read = { status: 'ok', target: target('a'), messages: [], waitsOn: [], activities: [], evidence, historyEpoch: 'epoch', firstPosition: null, lastPosition: null,
    nextPosition: null, truncated: false, earlierAvailable: false, observedAt: at }
  const slim = watcherSlimRead('read_thread', {}, read, () => false)
  expect(slim).toMatchObject({ evidence: [], pullRequests: [{ number: 7, checks: 'failed' }] })
  expect(watcherToolSchemas.read_thread.output.parse(slim)).toBeTruthy()
  expect(watcherSlimRead('read_thread', { evidence: 'full' }, read, () => false)).toBe(read)
})

it('lists projects without their models unless asked, narrowed by project or a query', () => {
  const workers = [{ provider: 'codex' as const, modelId: 'model', reasoningEfforts: ['high'], defaultPermission: null, permissionComparable: false }]
  const project = (projectId: string, title: string) => ({ target: { hostId, projectId }, title, displayRoot: `C:\\work\\${title}`, workers,
    controlAvailable: true, readsAvailable: true, readOnlyProfileAvailable: true, freshness: 'fresh' as const })
  const result = { status: 'ok', projects: [project('a', 'Sotto'), project('b', 'Forge')], nextCursor: null, observedAt: at, staleHosts: [] }
  const slim = watcherSlimRead('list_projects', {}, result, () => false) as typeof result
  expect(slim.projects.map(item => 'workers' in item)).toEqual([false, false])
  expect(watcherToolSchemas.list_projects.output.parse(slim)).toBeTruthy()
  expect((watcherSlimRead('list_projects', { query: 'forge' }, result, () => false) as typeof result).projects.map(item => item.title)).toEqual(['Forge'])
  expect((watcherSlimRead('list_projects', { projectId: 'a', includeModels: true }, result, () => false) as typeof result).projects).toEqual([project('a', 'Sotto')])
})

it('measures what the slim reads save on a roster the size of the October 19 session', () => {
  // Fifty threads with four or five open pull requests each gave list_threads results of 50 to 130 thousand characters.
  const full = roster(50, 5), slim = watcherSlimRead('list_threads', {}, full, () => true)
  const read = { status: 'ok', target: target('thread-0'), messages: [{ id: 'm', position: 0, role: 'assistant', text: 'Done.', createdAt: at }], waitsOn: [], activities: [],
    evidence: (full.rows[0] as Extract<FullRows[number], { evidence: unknown }>).evidence, historyEpoch: 'epoch', firstPosition: 0, lastPosition: 0, nextPosition: null, truncated: false, earlierAvailable: false, observedAt: at }
  // A hundred projects on a computer offering a hundred models gave list_projects about half a million characters.
  const workers = Array.from({ length: 100 }, (_, n) => ({ provider: 'codex' as const, modelId: `native:codex:model:synthetic-${n}`, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultPermission: 'approval-required' as const, permissionComparable: true }))
  const projects = { status: 'ok', nextCursor: null, observedAt: at, staleHosts: [], projects: Array.from({ length: 100 }, (_, n) => ({ target: { hostId, projectId: `project-${n}` },
    title: `Project ${n}`, displayRoot: `C:/Users/synthetic/work/project-${n}`, workers, controlAvailable: true, readsAvailable: true, readOnlyProfileAvailable: true, freshness: 'fresh' as const })) }
  const sizes = { listThreads: [bytes(full), bytes(slim)], readThread: [bytes(read), bytes(watcherSlimRead('read_thread', {}, read, () => true))],
    listProjects: [bytes(projects), bytes(watcherSlimRead('list_projects', {}, projects, () => true))] }
  // docs/perf/2026-10-19-watcher-tool-results.md reports these; SOTTO_PERF_REPORT=1 prints them.
  expect(sizes.listThreads[1]! * 10).toBeLessThan(sizes.listThreads[0]!)
  expect(sizes.readThread[1]! * 5).toBeLessThan(sizes.readThread[0]!)
  expect(sizes.listProjects[1]! * 50).toBeLessThan(sizes.listProjects[0]!)
  if (process.env.SOTTO_PERF_REPORT === '1') console.info(JSON.stringify(sizes))
})

it('keeps the address of pull requests that share a number, so Watcher can tell them apart', () => {
  const api = 'https://github.com/synthetic/api/pull/42', ui = 'https://github.com/synthetic/ui/pull/42'
  const facts = (url: string, checks: 'passed' | 'failed') => prFacts('a', 42, checks).map(fact => ({ ...fact, url }))
  // A read keeps every address, since the other #42 may be past the facts it sees.
  expect(watcherPullRequestSummaries([...facts(api, 'failed'), ...prFacts('a', 7)])).toEqual([
    { number: 42, url: api, state: 'open', checks: 'failed' }, { number: 7, url: prUrl(7), state: 'open', checks: 'passed' }])
  const full = roster(1, 0), row = full.rows[0] as Extract<FullRows[number], { evidence: unknown }>
  row.pullRequests = [{ number: 42, url: api, title: 'API', state: 'open', draft: false }, { number: 42, url: ui, title: 'UI', state: 'open', draft: false }]
  row.evidence = [...facts(api, 'failed'), ...facts(ui, 'passed')]
  const slim = watcherSlimRead('list_threads', {}, full, () => true) as typeof full
  expect(slim.rows[0]).toMatchObject({ pullRequests: [{ number: 42, url: api, checks: 'failed' }, { number: 42, url: ui, checks: 'passed' }] })
})

it('says in a slim row why a thread needs the user or is not watched, and carries what it waits on', () => {
  const full = roster(3, 1)
  const [failed, takenOver, quiet] = full.rows as Extract<FullRows[number], { evidence: unknown }>[]
  failed!.evidence.push({ id: randomUUID(), target: failed!.target, source: 'native-turn', observedAt: at, freshness: 'fresh', availability: 'available', turnId: 'turn-1',
    fact: 'turn-failed', failureCategory: 'provider-turn-failed' })
  failed!.waitsOn = [{ id: 'card', kind: 'permission', label: 'Open to answer permission', openTarget: failed!.target }]
  takenOver!.participation = [{ requestId: randomUUID(), startedBy: 'watcher', generation: 0, state: 'taken-over', takeover: { reason: 'user-send', at }, automationStopped: true }]
  quiet!.connected = false
  const slim = watcherSlimRead('list_threads', {}, full, item => item.threadId === 'thread-0', item => item.threadId === 'thread-0') as typeof full
  expect(watcherToolSchemas.list_threads.output.parse(slim)).toBeTruthy()
  expect(slim.rows[0]).toMatchObject({ watched: true, turnFailed: true, waitsOn: [{ id: 'card', kind: 'permission' }] })
  expect(slim.rows[1]).toMatchObject({ watched: false, takenOver: true, automationStopped: true })
  expect(slim.rows[2]).toMatchObject({ watched: false, connected: false })
  expect(slim.rows[2]).not.toHaveProperty('turnFailed')
  // A full row says whether Watcher watches the thread too.
  const whole = watcherSlimRead('list_threads', { detail: 'full' }, full, item => item.threadId === 'thread-0') as typeof full
  expect(whole.rows.map(row => (row as { watched?: boolean }).watched)).toEqual([true, false, false])
  expect(watcherToolSchemas.list_threads.output.parse(whole)).toBeTruthy()
})

it('says on a row and a read that a prototype waits for the user’s review, from the thread itself (ADR-0108)', () => {
  const full = roster(2, 0), ready = (item: { threadId: string }) => item.threadId === 'thread-0'
  for (const input of [{}, { detail: 'full' as const }]) {
    const rows = (watcherSlimRead('list_threads', input, full, () => true, () => false, ready) as typeof full).rows
    expect(watcherToolSchemas.list_threads.output.parse({ ...full, rows })).toBeTruthy()
    expect(rows[0]).toMatchObject({ prototypeReady: true })
    expect(rows[1]).not.toHaveProperty('prototypeReady')
  }
  const read = { status: 'ok', target: target('thread-0'), messages: [], waitsOn: [], activities: [], evidence: [], historyEpoch: 'epoch',
    firstPosition: null, lastPosition: null, nextPosition: null, truncated: false, earlierAvailable: false, observedAt: at }
  for (const input of [{}, { evidence: 'full' as const }]) {
    const slim = watcherSlimRead('read_thread', input, read, () => true, () => false, ready)
    expect(watcherToolSchemas.read_thread.output.parse(slim)).toMatchObject({ prototypeReady: true })
  }
  expect(watcherSlimRead('read_thread', {}, read, () => true)).not.toHaveProperty('prototypeReady')
})

it('counts a watched-only page again from the rows left, as a paired host counted all of them', () => {
  const full = roster(3, 0)
  const only = watcherSlimRead('list_threads', { watchedOnly: true }, full, item => item.threadId === 'thread-2') as typeof full
  expect(only.rows).toHaveLength(1)
  expect(only.counts['Ready for review']).toBe(1)
})

it('keeps a read’s own facts, a failed turn or a takeover, and sums up only its pull request facts', () => {
  const failure = { id: randomUUID(), target: target('a'), source: 'native-turn' as const, observedAt: at, freshness: 'fresh' as const, availability: 'available' as const,
    turnId: 'turn-1', fact: 'turn-failed' as const, failureCategory: 'provider-turn-failed' as const }
  const read = { status: 'ok', target: target('a'), messages: [], waitsOn: [], activities: [], evidence: [...prFacts('a', 7, 'failed'), failure], historyEpoch: 'epoch',
    firstPosition: null, lastPosition: null, nextPosition: null, truncated: false, earlierAvailable: false, observedAt: at }
  expect(watcherSlimRead('read_thread', {}, read, () => false)).toMatchObject({ evidence: [failure], pullRequests: [{ number: 7, checks: 'failed' }] })
})

it('takes a slim row’s failure from the thread’s last turn, not from a turn fact that may be older', () => {
  const full = roster(2, 0), row = full.rows[0] as Extract<FullRows[number], { evidence: unknown }>
  // A paired host's failure fact can outlive the turn that followed it, or carry a later time from a skewed clock.
  row.evidence.push({ id: randomUUID(), target: row.target, source: 'native-turn', observedAt: '2026-10-19T11:00:00.000Z', freshness: 'fresh', availability: 'available',
    turnId: 'turn-1', fact: 'turn-failed', failureCategory: 'provider-turn-failed' })
  const slim = watcherSlimRead('list_threads', {}, full, () => true, item => item.threadId === 'thread-1') as typeof full
  expect(slim.rows[0]).not.toHaveProperty('turnFailed')
  expect(slim.rows[1]).toMatchObject({ turnFailed: true })
})

it('adds nothing to a read with no pull requests, so a read that fit its bound still does', () => {
  const failure = { id: randomUUID(), target: target('a'), source: 'native-turn' as const, observedAt: at, freshness: 'fresh' as const, availability: 'available' as const,
    turnId: 'turn-1', fact: 'turn-failed' as const, failureCategory: 'provider-turn-failed' as const }
  const read = { status: 'ok', target: target('a'), messages: [{ id: 'm', position: 0, role: 'assistant', text: 'x'.repeat(WATCHER_READ_BYTES_MAX - 1_000), createdAt: at }],
    waitsOn: [], activities: [], evidence: [failure], historyEpoch: 'epoch', firstPosition: 0, lastPosition: 0, nextPosition: null, truncated: false, earlierAvailable: false, observedAt: at }
  const slim = watcherSlimRead('read_thread', {}, read, () => false)
  expect(slim).not.toHaveProperty('pullRequests')
  expect(bytes(slim)).toBe(bytes(read))
  expect(watcherToolSchemas.read_thread.output.parse(slim)).toBeTruthy()
})

/** A pull request's facts once GitHub says it is merged or closed, and its checks no longer read. */
const endedFacts = (threadId: string, n: number, state: 'merged' | 'closed') => prFacts(threadId, n).map(fact => fact.pullRequestState
  ? { ...fact, fact: state === 'merged' ? 'merge-observed' as const : fact.fact, pullRequestState: state }
  : fact.checksState ? { ...fact, fact: 'pull-request-observed' as const, checksState: 'unknown' as const, reason: 'checks-unavailable' as const } : fact)
it('lists a roster row’s open pull requests by what GitHub last said, and counts the merged and closed ones (#1147)', () => {
  const full = roster(1, 4), row = full.rows[0] as Extract<FullRows[number], { evidence: unknown }>
  // Every link still says open, as a link keeps the state it was made in; GitHub has since merged two and closed one.
  row.evidence = [...prFacts('thread-0', 1000), ...endedFacts('thread-0', 1001, 'merged'), ...endedFacts('thread-0', 1002, 'merged'), ...endedFacts('thread-0', 1003, 'closed')]
  const slim = watcherSlimRead('list_threads', {}, full, () => true) as typeof full
  expect(watcherToolSchemas.list_threads.output.parse(slim)).toBeTruthy()
  expect(slim.rows[0]).toMatchObject({ pullRequests: [{ number: 1000, state: 'open' }], mergedPullRequests: 2, closedPullRequests: 1 })
  // A row with none merged or closed says neither.
  expect(watcherSlimRead('list_threads', {}, roster(1, 2), () => true)).not.toMatchObject({ rows: [{ mergedPullRequests: expect.anything() }] })
})

it('reads a thread with twenty-five merged pull requests in under 2 KB, summing up only one merged since the last read (#1147)', () => {
  const evidence = Array.from({ length: 25 }, (_, n) => endedFacts('a', 900 + n, 'merged')).flat()
  const messages = [0, 1].map(position => ({ id: `m-${position}`, position, role: 'assistant' as const, text: 'Synthetic reply about the merge order.', createdAt: at }))
  const read = (facts: WatcherEvidence[]) => ({ status: 'ok', target: target('a'), messages, waitsOn: [], activities: [], evidence: facts, historyEpoch: 'epoch',
    firstPosition: 0, lastPosition: 1, nextPosition: null, truncated: false, earlierAvailable: false, observedAt: at })
  // A first read, and one with nothing new, sum up none of them: the news told each merge as it came.
  for (const before of [undefined, watcherEndedPullRequests(evidence)]) {
    const slim = watcherSlimRead('read_thread', { limit: 2 }, read(evidence), () => false, undefined, undefined, () => before)
    expect(slim).not.toHaveProperty('pullRequests')
    expect(slim).toMatchObject({ mergedPullRequests: 25 })
    expect(bytes(slim)).toBeLessThan(2_048)
    expect(watcherToolSchemas.read_thread.output.parse(slim)).toBeTruthy()
  }
  // One merged since the last read is summed up; one still open always is.
  const later = [...evidence, ...endedFacts('a', 925, 'merged'), ...prFacts('a', 926)]
  const slim = watcherSlimRead('read_thread', { limit: 2 }, read(later), () => false, undefined, undefined, () => watcherEndedPullRequests(evidence))
  expect(slim).toMatchObject({ mergedPullRequests: 25, pullRequests: [{ number: 925, state: 'merged' }, { number: 926, state: 'open' }] })
  expect(watcherSlimRead('read_thread', { evidence: 'full' }, read(later), () => false)).toMatchObject({ evidence: later })
})

it('fits ten threads with three open and twenty-five merged pull requests each in 8 KiB of list_threads (#1147)', () => {
  const full = roster(10, 28)
  for (const row of full.rows as Extract<FullRows[number], { evidence: unknown }>[]) {
    const id = row.target.threadId, numbers = row.pullRequests.map(pr => pr.number)
    row.evidence = numbers.flatMap((number, n) => n < 3 ? prFacts(id, number) : endedFacts(id, number, 'merged'))
  }
  const slim = watcherSlimRead('list_threads', {}, full, () => true) as typeof full
  expect(slim.rows.every(row => row.pullRequests.length === 3 && (row as { mergedPullRequests?: number }).mergedPullRequests === 25)).toBe(true)
  expect(bytes(slim)).toBeLessThan(8 * 1_024)
  if (process.env.SOTTO_PERF_REPORT === '1') console.info(JSON.stringify({ full: bytes(full), slim: bytes(slim) }))
})
