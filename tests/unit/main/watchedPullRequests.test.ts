// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { WatchedPullRequestReader, type WatchedPullRequestEvent } from '../../../src/main/agents/watchedPullRequests'
import { REFUSED_CHECKS_BEFORE_BACK_OFF, REMARKS_REREAD_MS } from '../../../src/main/agents/backgroundPullRequestReads'
import { GitHubRateLimit } from '../../../src/main/agents/github'
import { WatcherEvidenceStore, type PullRequestObservation } from '../../../src/main/agents/watcherEvidence'
import { scriptedGitHub, type ScriptedPull } from '../../fixtures/babysitGitHub'
import { readDetail } from '../../../src/main/agents/githubBabysitReads'
import { watcherPullRequestWords } from '../../../src/main/agents/watcherNews'
import { watcherPullRequestSummaries } from '../../../src/main/agents/watcherSlimReads'
import { centerTarget } from '../../fixtures/watcher'

/**
 * Watcher's own background reads (ADR-0144): with babysitting retired, the reader follows the pull requests of the
 * threads Watcher watches and tells Watcher what they say, at babysitting's cost. Every pass is run by hand over a
 * scripted gh and a scripted clock, so nothing waits on a timer and every question is counted.
 */
const START = Date.parse('2026-10-26T12:00:00Z')
const url = (number: number, name = 'r') => `https://github.com/o/${name}/pull/${number}`

function harness(pulls: ScriptedPull[], asked: string[]) {
  let now = START
  const clock = { now: () => now, advance: (minutes: number) => { now += minutes * 60_000 } }
  const github = scriptedGitHub(pulls, { now: clock.now })
  const observations: PullRequestObservation[] = []
  const events: WatchedPullRequestEvent[] = []
  const rateLimit = new GitHubRateLimit({ now: clock.now })
  const reader = new WatchedPullRequestReader({ pullRequests: () => asked, observed: read => observations.push(read), rateLimit, run: github.run, now: clock.now,
    log: event => events.push(event) })
  const pass = async () => { clock.advance(2); observations.length = 0; github.reset(); await reader.pass() }
  const seen = (number: number, name = 'r') => observations.filter(read => read.url === url(number, name)).at(-1)
  return { reader, github, observations, events, clock, rateLimit, pass, seen }
}

describe('Watcher\'s reads of watched pull requests', () => {
  it('shares fingerprints and caches checks and Bug Bot coverage without reading other remarks', async () => {
    const pulls: ScriptedPull[] = [{ number: 1, checks: [{ name: 'build', state: 'FAILURE' }] }, { number: 2 }, { number: 3, name: 'other' }]
    // Two watched threads link pull request 1; a duplicate and a link that is not GitHub's are read once and not at all.
    const f = harness(pulls, [url(1), url(2), url(1), url(3, 'other'), 'https://example.com/pull/4'])
    await f.pass()
    expect(f.github.count('fingerprint')).toBe(2)
    expect(f.github.count('words')).toBe(0)
    // Only the bounded Bug Bot classification reads bodies; ordinary remarks stay text-free.
    expect(f.github.questions.filter(question => question.kind === 'detail').every(question => question.variables['remarks'] === 'false')).toBe(true)
    expect(f.seen(1)).toMatchObject({ availability: 'available', state: 'open', checks: 'failed', conflicting: false })
    expect(f.seen(3, 'other')).toMatchObject({ availability: 'available', state: 'open' })
    expect(f.observations).toHaveLength(3)

    // Nothing moved: the fingerprints alone, and each pull request told again as it stands.
    await f.pass()
    expect([f.github.count('fingerprint'), f.github.count('detail')]).toEqual([2, 0])
    expect(f.seen(1)).toMatchObject({ checks: 'failed' })
  })

  it('tells Watcher of checks passing, the required checks passing, a conflict, remarks moving and a merge', async () => {
    const pull: ScriptedPull = { number: 1, checks: [{ name: 'build', state: 'IN_PROGRESS', required: true }], requiredChecks: ['build'] }
    const f = harness([pull], [url(1)])
    await f.pass()
    expect(f.seen(1)).toMatchObject({ checks: 'pending', requiredPassed: false })
    // A running check is read again every pass.
    await f.pass()
    expect(f.github.count('detail')).toBe(1)

    pull.checks = [{ name: 'build', state: 'SUCCESS', required: true }]
    await f.pass()
    expect(f.seen(1)).toMatchObject({ checks: 'passed', requiredPassed: true })

    const before = f.seen(1)!.remarks
    pull.comments = [{ id: 'c1', author: 'reviewer', at: '2026-10-26T12:05:00Z' }]
    await f.pass()
    expect(f.seen(1)!.remarks).not.toBe(before)
    // Remarks moving is told from the fingerprint alone, and the checks, unmoved, are not read again.
    expect(f.github.count('detail')).toBe(0)

    pull.mergeable = 'CONFLICTING'
    await f.pass()
    expect(f.seen(1)).toMatchObject({ conflicting: true, checks: 'passed' })

    pull.state = 'MERGED'
    await f.pass()
    expect(f.seen(1)).toMatchObject({ state: 'merged', availability: 'available' })
    // Merged is told once: while it is still asked for, it is not read again.
    await f.pass()
    expect(f.github.questions).toEqual([])
    expect(f.observations).toEqual([])
  })

  it('reads nothing while GitHub\'s rate limit pauses background reads, and says so once', async () => {
    const f = harness([{ number: 1 }], [url(1)])
    f.rateLimit.limited('github.com', 'API rate limit exceeded', { limit: 5000, remaining: 0, resetAt: new Date(START + 3_600_000).toISOString() })
    await f.pass()
    expect(f.github.questions).toEqual([])
    expect(f.events).toEqual(['watched-pull-request-rate-limited'])
  })

  it('tells Watcher a pull request it could not read is unavailable, keeping the head it last knew', async () => {
    const f = harness([{ number: 1, head: 'head-7' }], [url(1), url(99)])
    await f.pass()
    expect(f.seen(99)).toMatchObject({ availability: 'unavailable', reason: 'read-failed', head: null })
    expect(f.events).toContain('watched-pull-request-read-failed')
    f.github.fail(new Error('gh: Something went wrong'))
    await f.pass()
    expect(f.seen(1)).toMatchObject({ availability: 'unavailable', reason: 'read-failed', head: 'head-7' })
  })

  it('backs off refused checks as babysitting does, and asks again on the half hour', async () => {
    const f = harness([{ number: 1, checks: [{ name: 'build', state: 'SUCCESS' }], refuseChecks: 'list' }], [url(1)])
    for (let refused = 0; refused < REFUSED_CHECKS_BEFORE_BACK_OFF; refused++) { await f.pass(); expect(f.github.count('detail')).toBe(1) }
    await f.pass()
    expect(f.github.count('detail')).toBe(0)
    f.clock.advance(REMARKS_REREAD_MS / 60_000)
    await f.pass()
    expect(f.github.count('detail')).toBe(1)
  })

  it('forgets a pull request no longer asked for, so a watch that ends costs nothing more', async () => {
    const asked = [url(1)]
    const f = harness([{ number: 1, state: 'MERGED' }], asked)
    await f.pass()
    expect(f.seen(1)).toMatchObject({ state: 'merged' })
    asked.length = 0
    await f.pass()
    expect(f.github.questions).toEqual([])
    // Watched again later, it is read again once.
    asked.push(url(1))
    await f.pass()
    expect(f.github.count('fingerprint')).toBe(1)
  })
})

const HEAD = 'abcdef0123456789abcdef0123456789abcdef01'
const NEXT = 'def5678123456789abcdef0123456789abcdef01'
const MARKER = '<!-- sotto-bug-bot -->'
const reviewUrl = `${url(1)}#pullrequestreview-7`
const marked = (commit = HEAD) => ({ id: 'review-7', author: 'bot', bot: true, state: 'COMMENTED' as const,
  at: '2026-10-26T12:00:00Z', body: `${MARKER}\nprivate review words`, commit, url: reviewUrl })

describe('Bug Bot review coverage in Watcher evidence and news', () => {
  it.each([
    { name: 'marked review on the head', reviews: [marked()], coverage: 'current', commit: HEAD },
    { name: 'marked review on an earlier head', reviews: [marked(NEXT)], coverage: 'stale', commit: NEXT },
    { name: 'an unmarked review', reviews: [{ ...marked(), body: 'ordinary review' }], coverage: 'missing', commit: null },
    { name: 'no reviews', reviews: [], coverage: 'missing', commit: null },
    { name: 'a pending marked draft', reviews: [{ ...marked(), state: 'PENDING' as const }], coverage: 'missing', commit: null },
    { name: 'a marked review whose commit is unreadable', reviews: [{ ...marked(), commit: null }], coverage: 'unknown', commit: null },
  ])('classifies $name and discards review words', async ({ reviews, coverage, commit }) => {
    const f = harness([{ number: 1, head: HEAD, reviews }], [url(1)])
    await f.pass()
    expect(f.seen(1)?.bugBotReview).toMatchObject({ coverage, commit })
    expect(JSON.stringify(f.observations)).not.toContain('private review words')
    expect(f.seen(1)?.reviewApproved).toBeUndefined()
  })

  it('uses the latest submitted marked review, not an unmarked review or inline comments remapped to the head', async () => {
    const pull: ScriptedPull = { number: 1, head: NEXT, reviews: [marked(),
      { ...marked(NEXT), id: 'human', body: 'unmarked', at: '2026-10-26T12:02:00Z' }],
    threads: [{ path: 'a.ts', comments: [{ ...marked(NEXT), id: 'inline' }] }] }
    const f = harness([pull], [url(1)])
    await f.pass()
    expect(f.seen(1)?.bugBotReview).toEqual({ coverage: 'stale', commit: HEAD, url: reviewUrl })
    pull.reviews!.push({ ...marked(NEXT), id: 'new-review', at: '2026-10-26T12:04:00Z' })
    await f.pass()
    expect(f.seen(1)?.bugBotReview?.coverage).toBe('current')
  })

  it('does not use remapped inline commit_id and original_commit_id as the review commit', () => {
    const read = readDetail(JSON.stringify({ data: { rateLimit: null, repository: { pullRequest: {
      headRefOid: NEXT, bugBotReviews: { pageInfo: { hasPreviousPage: false }, nodes: [{ body: MARKER, state: 'COMMENTED',
        submittedAt: '2026-10-26T12:00:00Z', url: reviewUrl, commit: { oid: HEAD },
        comments: { nodes: [{ commit_id: NEXT, original_commit_id: HEAD }] } }] },
    } } } }), { checks: false, remarks: false, bugBotReviews: true })
    expect(read.bugBotReview).toEqual({ coverage: 'stale', commit: HEAD, url: reviewUrl })
    expect(JSON.stringify(read)).not.toContain(MARKER)
  })

  it('reports unreadable or incomplete review reads as unknown, backs off and recovers', async () => {
    const pull: ScriptedPull = { number: 1, head: HEAD, refuseReviews: true, checks: [{ name: 'build', state: 'SUCCESS', required: true }] }
    const f = harness([pull], [url(1)])
    await f.pass()
    expect(f.seen(1)).toMatchObject({ availability: 'available', checks: 'passed', requiredPassed: true, bugBotReview: { coverage: 'unknown' } })
    await f.pass()
    expect(f.github.count('detail')).toBe(0)
    pull.refuseReviews = false
    f.clock.advance(REMARKS_REREAD_MS / 60_000)
    await f.pass()
    expect(f.seen(1)?.bugBotReview?.coverage).toBe('missing')

    // The bounded last page cannot prove absence in older pages.
    pull.reviews = Array.from({ length: 101 }, (_, index) => ({ ...marked(), id: String(index), body: index === 0 ? MARKER : '' }))
    await f.pass()
    expect(f.seen(1)?.bugBotReview?.coverage).toBe('unknown')
  })

  it.each([undefined, null, { pageInfo: { hasPreviousPage: false }, nodes: null },
    { pageInfo: { hasPreviousPage: false }, nodes: [null] }])('treats an unreadable review connection as unknown without losing check results: %j', bugBotReviews => {
    const read = readDetail(JSON.stringify({ data: { rateLimit: null, repository: { pullRequest: { headRefOid: HEAD, bugBotReviews,
      commits: { nodes: [{ commit: { oid: HEAD, statusCheckRollup: null } }] } } } } }),
    { checks: true, remarks: false, bugBotReviews: true })
    expect(read.bugBotReview?.coverage).toBe('unknown')
    expect(read.checks).toEqual([])
  })

  it('keeps passing checks and merge news when a coverage-only request fails', async () => {
    const pull: ScriptedPull = { number: 1, head: HEAD, reviews: [marked()], checks: [{ name: 'build', state: 'SUCCESS', required: true }] }
    const f = harness([pull], [url(1)])
    await f.pass()
    const checksObservedAt = f.seen(1)!.checksObservedAt
    pull.reviews!.push({ ...marked(), id: 'new-review' })
    f.github.failReviews(new Error('gh: review read failed'))
    await f.pass()
    expect(f.seen(1)).toMatchObject({ availability: 'available', checks: 'passed', checksObservedAt, bugBotReview: { coverage: 'unknown' } })
    await f.pass()
    expect(f.github.count('detail')).toBe(0)
    pull.head = NEXT
    pull.state = 'MERGED'
    await f.pass()
    expect(f.seen(1)).toMatchObject({ availability: 'available', state: 'merged', head: NEXT, bugBotReview: { coverage: 'unknown' } })
    await f.pass()
    expect(f.github.questions).toEqual([])
  })

  it('retries a head that moved during the detail read on the next poll', async () => {
    const pull: ScriptedPull = { number: 1, head: HEAD, reviews: [marked()] }
    const github = scriptedGitHub([pull]), observations: PullRequestObservation[] = []
    let moveHead = true
    const reader = new WatchedPullRequestReader({ pullRequests: () => [url(1)], rateLimit: new GitHubRateLimit(),
      observed: read => observations.push(read), run: async (...args) => {
        // The fingerprint still names HEAD, but the following detail observes NEXT.
        const answer = await github.run(...args)
        if (moveHead) { pull.head = NEXT; moveHead = false }
        return answer
      } })
    await reader.pass()
    expect(observations.at(-1)).toMatchObject({ head: HEAD, bugBotReview: { coverage: 'unknown' } })
    github.reset()
    await reader.pass()
    expect(github.count('detail')).toBe(1)
    expect(observations.at(-1)).toMatchObject({ head: NEXT, bugBotReview: { coverage: 'stale', commit: HEAD } })
  })

  it('refreshes on head, new review and review edit changes, with one news line per meaningful change', async () => {
    const pull: ScriptedPull = { number: 1, head: HEAD, reviews: [marked()] }
    const f = harness([pull], [url(1)]), store = new WatcherEvidenceStore(f.clock.now)
    const told = new Set<string>()
    const news = async () => {
      await f.pass()
      store.pullRequest(centerTarget, f.seen(1)!)
      const attention = store.attentionFacts(centerTarget).filter(fact => !told.has(fact.key))
      attention.forEach(fact => told.add(fact.key))
      const facts = new Map([[`o/r#1`, new Set(attention.map(fact => fact.kind))]])
      return watcherPullRequestWords(facts, { pullRequests: [{ number: 1, url: url(1), title: '', state: 'open', draft: false, source: 'linked', linkedAt: new Date(START).toISOString() }] },
        store.read(centerTarget, true, f.clock.now()))
    }
    expect(await news()).toContain('Bug Bot reviewed current head abcdef0')
    expect(await news()).toBeUndefined()
    expect(f.github.count('detail')).toBe(0)
    pull.head = NEXT
    const stale = await news()
    expect(stale).toContain('Bug Bot reviewed abcdef0; head is def5678')
    expect(stale?.match(/Bug Bot/gu)).toHaveLength(1)
    expect(stale).toContain(reviewUrl)
    expect(watcherPullRequestSummaries(store.read(centerTarget))).toMatchObject([{ headId: NEXT, bugBotReview: { coverage: 'stale', commit: HEAD } }])
    expect(await news()).toBeUndefined()

    pull.reviews!.push({ ...marked(NEXT), at: '2026-10-26T12:10:00Z' })
    const current = await news()
    expect(current).toContain('Bug Bot reviewed current head def5678')
    expect(current?.match(/Pull request/gu)).toHaveLength(1)
    expect(current?.match(/Bug Bot/gu)).toHaveLength(1)
    expect(await news()).toBeUndefined()

    // An edit has ordinary remarks news with coverage beside it, but creates no new coverage fact.
    const beforeEdit = store.attentionFacts(centerTarget).find(fact => fact.kind === 'bug-bot-review')!.key
    pull.reviews![1]!.editedAt = '2026-10-26T12:12:00Z'
    const edited = await news()
    expect(edited).toContain('its comments or reviews changed')
    expect(edited?.match(/Bug Bot/gu)).toHaveLength(1)
    expect(store.attentionFacts(centerTarget).find(fact => fact.kind === 'bug-bot-review')!.key).toBe(beforeEdit)
    expect(f.github.count('detail')).toBe(1)
    expect(await news()).toBeUndefined()
    pull.checks = [{ name: 'build', state: 'SUCCESS', required: true }]
    expect(await news()).toContain('all checks passed on its newest commit; Bug Bot reviewed current head def5678')
    pull.state = 'MERGED'
    expect(await news()).toContain('merged; Bug Bot reviewed current head def5678')
    expect(JSON.stringify(store.read(centerTarget))).not.toContain('private review words')
  })

  it.each(['missing', 'unknown'] as const)('names %s coverage once without approval or merge instructions', async coverage => {
    const f = harness([{ number: 1, head: HEAD, refuseReviews: coverage === 'unknown' }], [url(1)]), store = new WatcherEvidenceStore(f.clock.now)
    await f.pass()
    store.pullRequest(centerTarget, f.seen(1)!)
    const words = watcherPullRequestWords(store.attentionByPullRequest(centerTarget), {}, store.read(centerTarget))
    expect(words).toContain(coverage === 'missing' ? 'Bug Bot has no marked review' : 'Bug Bot review coverage is unknown')
    expect(words?.match(/Bug Bot/gu)).toHaveLength(1)
    expect(words).not.toMatch(/approv|hold|wait|block/iu)
  })

  it('invalidates current coverage when another observation sees a new head, and carries paired facts', async () => {
    const f = harness([{ number: 1, head: HEAD, reviews: [marked()] }], [url(1)]), store = new WatcherEvidenceStore(f.clock.now)
    await f.pass()
    store.pullRequest(centerTarget, f.seen(1)!)
    const paired = new WatcherEvidenceStore(f.clock.now)
    store.read(centerTarget).forEach(fact => paired.paired(fact))
    expect(paired.read(centerTarget).find(fact => fact.bugBotReview)?.bugBotReview?.coverage).toBe('current')
    store.pullRequest(centerTarget, { url: url(1), head: NEXT, availability: 'available', observedAt: new Date(f.clock.now() + 1).toISOString() })
    expect(store.read(centerTarget).find(fact => fact.bugBotReview)).toMatchObject({ headId: NEXT, bugBotReview: { coverage: 'unknown' } })
    store.pullRequest(centerTarget, { ...f.seen(1)!, observedAt: new Date(START).toISOString() })
    expect(store.read(centerTarget).find(fact => fact.bugBotReview)?.bugBotReview?.coverage).toBe('unknown')
    store.pullRequest(centerTarget, { url: url(1), head: NEXT, availability: 'unavailable', reason: 'read-failed', observedAt: new Date(f.clock.now() + 2).toISOString() })
    expect(store.read(centerTarget).find(fact => fact.bugBotReview)).toMatchObject({ availability: 'unavailable', bugBotReview: { coverage: 'unknown' } })
  })
})
