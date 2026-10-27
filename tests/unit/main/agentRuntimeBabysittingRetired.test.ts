// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { BABYSITTING_RETIRED } from '../../../src/main/agents/babysitting'
import { toldAtStart, type BabysitNews } from '../../../src/main/agents/babysitNews'
import { FollowupStore } from '../../../src/main/agents/followups'
import type { AgentHostCommand } from '../../../src/main/agents/host'
import { createAgentRuntime } from '../../../src/main/agents/runtime'
import { WatcherService } from '../../../src/main/agents/watcher'
import { WatchedPullRequestReader } from '../../../src/main/agents/watchedPullRequests'
import type { PullRequestObservation } from '../../../src/main/agents/watcherEvidence'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import type { RunGitCommand } from '../../../src/main/agents/gitStatus'
import { scriptedGitHub, type ScriptedPull } from '../../fixtures/babysitGitHub'
import { testCredentials } from '../../fixtures/testCredentials'

/**
 * Restart stopped threads retires babysitting (ADR-0144): no thread is babysat, offered the pull request tools or sent a
 * babysitting wake-up, and the host lists no `pull-request-babysit`. Watcher keeps its pull request news: the same reader
 * follows the pull requests of the threads it watches, whether or not anyone ever babysat them.
 */
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    if (dirname(root) !== tmpdir() || !root.includes('sotto-runtime-babysitting-retired-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})

const url = 'https://github.com/o/r/pull/1'
const noGh: RunGitCommand = async () => { throw new Error('No gh in this test') }

async function runtime(options: { retired: boolean; root?: string; host?: E2EAgentHost; run?: RunGitCommand; watcher?: boolean }) {
  let root = options.root
  if (!root) { root = await mkdtemp(join(tmpdir(), 'sotto-runtime-babysitting-retired-')); roots.push(root) }
  const credentials = await testCredentials(root, { encryption: { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('No test key') }, decryptString: () => '' } })
  const run = options.run ?? noGh
  return createAgentRuntime({
    directory: root, credentials, settings: () => DEFAULT_SETTINGS, writingSettings: async () => DEFAULT_SETTINGS,
    historyEnabled: () => true, openExternal: async () => undefined, host: options.host ?? new E2EAgentHost(), reasoner: e2eAgentReasoner,
    ...(options.watcher ? { watcherEnabled: true } : {}),
    gitStatus: { fetchIntervalMs: () => 3_600_000, foreground: () => false },
    // The switch reads on, so a test fails if anything still reads it with babysitting retired.
    babysitting: options.retired ? { retired: true, run, agentTool: () => true } : { agentTool: () => true, run },
  })
}

const babysitNews = (startedAt: string): BabysitNews => ({ pullRequest: { url, number: 1, title: 'Pull 1' }, startedBy: 'agent', startedAt, head: 'head-1',
  changes: [{ kind: 'checks-failed', checks: [{ name: 'build', status: 'failure', url: null }] }], ended: null })

describe('babysitting retired by Restart stopped threads', () => {
  it('babysits nothing, lists no babysitting on the host, and refuses the user\'s Babysit and Stop babysitting', async () => {
    const host = await runtime({ retired: true })
    try {
      await host.agentControl.command({ type: 'connect' })
      expect(host.babysitter).toBeUndefined()
      expect(host.hostService.supportsBabysitting).toBe(false)
      for (const type of ['babysit-pull-request', 'stop-babysitting'] as const) {
        const state = await host.agentControl.command({ type, threadId: 'workshop', url })
        expect(state.error).toBe(BABYSITTING_RETIRED)
      }
      // No babysitting wake-up can be queued, whoever asks.
      await expect(host.agentControl.deliverWakeUp('workshop', babysitNews(new Date().toISOString()), { tool: false })).rejects.toThrow(BABYSITTING_RETIRED)
      expect(host.agentControl.get().followups ?? []).toEqual([])
    } finally { await host.close() }
  })

  it('drops a babysitting wake-up saved in the queue at start, sends nothing, and leaves the records on disk as they were', async () => {
    const first = await runtime({ retired: false })
    const root = roots.at(-1)!
    await first.agentControl.command({ type: 'connect' })
    const startedAt = new Date().toISOString()
    await first.agentHost.changeBabysitting('workshop', () => [{ url, number: 1, startedBy: 'user', startedAt, told: toldAtStart(startedAt) }])
    await first.close()
    const queue = new FollowupStore(root); await queue.load()
    await queue.queueWakeUp('workshop', babysitNews(startedAt), () => 'Sotto is babysitting a pull request for this thread, and it needs you.', 'unknown')
    const saved = async () => (JSON.parse(await readFile(join(root, 'workspace.json'), 'utf8')) as { snapshot: { threads: Array<{ id: string; babysitting?: unknown[] }> } })
      .snapshot.threads.find(thread => thread.id === 'workshop')?.babysitting
    const before = await saved()
    expect(before).toHaveLength(1)

    const host = new E2EAgentHost(); const sent: AgentHostCommand[] = []
    const execute = host.execute.bind(host)
    host.execute = async command => { sent.push(command); return execute(command) }
    const second = await runtime({ retired: true, root, host })
    try {
      // Gone as the queue loads, before the coordinator connects to anything that could send it.
      expect(second.agentControl.get().followups ?? []).toEqual([])
      await second.agentControl.command({ type: 'connect' })
      expect(second.agentControl.get().followups ?? []).toEqual([])
      expect(second.agentControl.get().host.connected).toBe(true)
      expect(sent.filter(command => command.type === 'send')).toEqual([])
    } finally { await second.close() }
    expect(await saved()).toEqual(before)
  })

  it('tells Watcher what a watched thread\'s pull request says, though nobody babysits it', async () => {
    const pull: ScriptedPull = { number: 1, checks: [{ name: 'build', state: 'FAILURE', required: true }], requiredChecks: ['build'] }
    const github = scriptedGitHub([pull])
    const readers: WatchedPullRequestReader[] = []
    // The passes are run by hand rather than on the two-minute timer.
    vi.spyOn(WatchedPullRequestReader.prototype, 'begin').mockImplementation(function (this: WatchedPullRequestReader) { readers.push(this) })
    vi.spyOn(WatcherService.prototype, 'watchedThreadIds').mockReturnValue(['workshop'])
    const heard: PullRequestObservation[] = []
    vi.spyOn(WatcherService.prototype, 'pullRequestObserved').mockImplementation(read => { heard.push(read) })
    const host = await runtime({ retired: true, run: github.run, watcher: true })
    try {
      await host.agentControl.command({ type: 'connect' })
      host.agentHost.setGitPullRequests({ view: async () => ({ number: 1, url, title: 'Pull 1', body: '', state: 'open', draft: false }) } as never)
      await host.agentHost.linkThreadPullRequest('workshop', url)
      expect(readers).toHaveLength(1)
      const reader = readers[0]!
      const latest = () => heard.at(-1)

      await reader.pass()
      expect(latest()).toMatchObject({ url, state: 'open', checks: 'failed', requiredPassed: false })
      pull.checks = [{ name: 'build', state: 'SUCCESS', required: true }]
      await reader.pass()
      expect(latest()).toMatchObject({ checks: 'passed', requiredPassed: true })
      const remarks = latest()!.remarks
      pull.reviews = [{ id: 'r1', author: 'reviewer', at: new Date().toISOString(), state: 'COMMENTED' }]
      await reader.pass()
      expect(latest()!.remarks).not.toBe(remarks)
      pull.mergeable = 'CONFLICTING'
      await reader.pass()
      expect(latest()).toMatchObject({ conflicting: true })
      pull.state = 'MERGED'
      await reader.pass()
      expect(latest()).toMatchObject({ state: 'merged' })
      // The thread's link follows what GitHub said, and nothing reached the thread as a wake-up.
      await vi.waitFor(() => expect(host.agentHost.workspaceSnapshot().threads.find(thread => thread.id === 'workshop')?.pullRequests?.[0]?.state).toBe('merged'))
      expect(host.agentControl.get().followups ?? []).toEqual([])
      expect(github.questions.filter(question => question.kind === 'detail').every(question => question.variables['remarks'] === 'false')).toBe(true)
    } finally { await host.close() }
  })

  it('leaves babysitting and its reader as they were with the feature off', async () => {
    const begin = vi.spyOn(WatchedPullRequestReader.prototype, 'begin')
    const host = await runtime({ retired: false, watcher: true })
    try {
      expect(host.babysitter).toBeDefined()
      expect(host.hostService.supportsBabysitting).toBe(true)
      expect(begin).not.toHaveBeenCalled()
    } finally { await host.close() }
  })
})
