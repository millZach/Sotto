// @vitest-environment node
/**
 * Opt-in live check of babysitting (ADR-0061, the October 13 amendment) against real GitHub through the signed-in gh,
 * read-only: it babysits one open pull request in memory, as if from a week before, and delivers nothing to any
 * provider. It prints what the thread would be told, by kind only, and checks three things: the gate holds while a
 * check the base branch's rules require is missing, no bot notice that it could not run is news, and a computer that
 * cannot reach GitHub counts no failed read.
 *
 *   PowerShell:  $env:SOTTO_GITHUB_LIVE = '1'; $env:SOTTO_GITHUB_LIVE_PR = 'https://github.com/millZach/Sotto/pull/816'; npx vitest run tests/integration/babysittingLive.test.ts --disable-console-intercept
 *   sh:          SOTTO_GITHUB_LIVE=1 SOTTO_GITHUB_LIVE_PR=https://github.com/millZach/Sotto/pull/816 npx vitest run tests/integration/babysittingLive.test.ts --disable-console-intercept
 */
import { describe, expect, it } from 'vitest'
import { Babysitter, type BabysitEvent, type BabysitStore, type BabysitThread } from '../../src/main/agents/babysitting'
import type { BabysitNews, BabysitRecord } from '../../src/main/agents/babysitNews'
import { GitHubRateLimit } from '../../src/main/agents/github'
import { DETAIL_QUERY, readDetail } from '../../src/main/agents/githubBabysitReads'
import { runGitStatusCommand, type RunGitCommand } from '../../src/main/agents/gitStatus'
import { pullRequestAddress, pullRequestKey } from '../../src/shared/gitPullRequests'

const LIVE = process.env.SOTTO_GITHUB_LIVE === '1'
const PULL = process.env.SOTTO_GITHUB_LIVE_PR ?? ''
const WEEK_AGO = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString()

function babysitter(run: RunGitCommand) {
  let records: BabysitRecord[] = []
  const thread = (): BabysitThread => ({ id: 'live', closed: null, knows: url => pullRequestKey(url) === pullRequestKey(PULL), records })
  const store: BabysitStore = {
    babysitThread: id => id === 'live' ? thread() : null,
    babysatThreads: () => records.length ? [thread()] : [],
    changeBabysitting: async (_id, change) => { records = [...change(records)] },
    onPullRequestUnlinked: () => () => undefined,
  }
  const delivered: BabysitNews[] = []
  const events: BabysitEvent[] = []
  const sitter = new Babysitter({ store, rateLimit: new GitHubRateLimit(), run, log: event => events.push(event), deliver: async (_threadId, news) => { delivered.push(news) } })
  /** Babysat since a week ago, so the remarks of that week are read as new. */
  const start = async () => {
    await sitter.start('live', PULL, 'user')
    records = records.map(record => ({ ...record, told: { ...record.told, remarksThrough: WEEK_AGO } }))
  }
  return { sitter, start, delivered, events, told: () => records[0]?.told }
}

describe.skipIf(!LIVE)('babysitting against GitHub (live) (requires SOTTO_GITHUB_LIVE=1 and SOTTO_GITHUB_LIVE_PR)', () => {
  it('holds the gate for a missing required check and tells no bot notice', async () => {
    const address = pullRequestAddress(PULL)
    expect(address, 'SOTTO_GITHUB_LIVE_PR must name a github.com pull request').toBeTruthy()
    // What GitHub says directly, to set the babysitter's answer beside.
    const detail = readDetail(await runGitStatusCommand(process.cwd(), 'gh', ['api', 'graphql', '-f', `query=${DETAIL_QUERY}`, '-f', `owner=${address!.owner}`, '-f', `name=${address!.name}`,
      '-F', `number=${address!.number}`, '-F', 'checks=true', '-F', 'remarks=true']), { checks: true, remarks: true })
    const missing = (detail.requiredChecks ?? []).filter(context => !detail.checks?.some(check => check.context === context))
    const h = babysitter(runGitStatusCommand)
    await h.start()
    await h.sitter.pass()
    const kinds = h.delivered.flatMap(news => news.changes.map(change => change.kind))
    console.log(`rules require ${detail.requiredChecks?.length ?? 'unknown'} checks, ${missing.length} missing; ${detail.remarks?.filter(remark => remark.bot).length ?? 0} bot remarks; told: ${kinds.join(', ') || 'nothing'}`)
    if (missing.length) expect(kinds).not.toContain('checks-passed')
    const toldBots = h.delivered.flatMap(news => news.changes.flatMap(change => change.kind === 'remarks' ? change.remarks : [])).filter(remark => detail.remarks?.some(read => read.bot && read.author === remark.author))
    console.log(`bot remarks told: ${toldBots.length}`)
    expect(h.events).not.toContain('babysit-read-failed')
    h.sitter.close()
  }, 120_000)

  it('counts no failed read while gh cannot reach GitHub', async () => {
    // A proxy nothing listens on stands in for a computer that is offline.
    const offline: RunGitCommand = (cwd, command, args, options) => runGitStatusCommand(cwd, command, args, { ...options, env: { ...options?.env, HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9' } })
    const h = babysitter(offline)
    await h.start()
    for (let index = 0; index < 10; index++) await h.sitter.pass()
    console.log(`offline: ${h.events.filter(event => event === 'babysit-unreachable').length} unreachable passes logged, failed reads ${h.told()?.failedReads}`)
    expect(h.told()?.failedReads).toBe(0)
    expect(h.sitter.list()).toHaveLength(1)
    expect(h.delivered).toEqual([])
    h.sitter.close()
  }, 300_000)
})
