// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { WatchedPullRequestReader, type WatchedPullRequestEvent } from '../../../src/main/agents/watchedPullRequests'
import { REFUSED_CHECKS_BEFORE_BACK_OFF, REMARKS_REREAD_MS } from '../../../src/main/agents/backgroundPullRequestReads'
import { GitHubRateLimit } from '../../../src/main/agents/github'
import type { PullRequestObservation } from '../../../src/main/agents/watcherEvidence'
import { scriptedGitHub, type ScriptedPull } from '../../fixtures/babysitGitHub'

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
  it('asks one fingerprint per repository whatever number of threads share a pull request, and the checks alone', async () => {
    const pulls: ScriptedPull[] = [{ number: 1, checks: [{ name: 'build', state: 'FAILURE' }] }, { number: 2 }, { number: 3, name: 'other' }]
    // Two watched threads link pull request 1; a duplicate and a link that is not GitHub's are read once and not at all.
    const f = harness(pulls, [url(1), url(2), url(1), url(3, 'other'), 'https://example.com/pull/4'])
    await f.pass()
    expect(f.github.count('fingerprint')).toBe(2)
    expect(f.github.count('words')).toBe(0)
    // Watcher hears that remarks moved from the fingerprint; it never asks for their text.
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
