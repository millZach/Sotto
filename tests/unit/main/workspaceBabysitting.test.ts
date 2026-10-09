// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { workspaceFixture } from '../../fixtures/workspaceFixture'
import { scriptedGitHub, type ScriptedPull } from '../../fixtures/babysitGitHub'
import { Babysitter, type BabysitEvent } from '../../../src/main/agents/babysitting'
import type { BabysitNews } from '../../../src/main/agents/babysitNews'
import { GitHubRateLimit } from '../../../src/main/agents/github'
import type { WorkspaceHost } from '../../../src/main/agents/workspace'
import { agentThreadSchema } from '../../../src/shared/agents'
import type { GitStatus } from '../../../src/shared/gitStatus'

/**
 * Babysitting on the thread's record (ADR-0061 decision 10): what a thread babysits and what it was last told live in
 * the host's `workspace.json`, survive a restart, and reach clients only as which pull request, who started it and since when.
 */
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

const START = Date.parse('2026-10-08T12:00:00Z')
const url = 'https://github.com/o/r/pull/1'
const at = (minutes: number): string => new Date(START + minutes * 60_000).toISOString().replace('.000Z', 'Z')

async function fixture(root?: string) {
  const f = await workspaceFixture(root)
  cleanup.push(async () => { await f.stop(); if (!root) await f.remove() })
  return f
}
async function linkedThread(f: Awaited<ReturnType<typeof fixture>>) {
  const snapshot = await f.host.connect()
  const project = snapshot.projects.find(item => item.providerId === 'codex')!
  const model = snapshot.models.find(item => item.providerId === 'codex')!
  await f.host.execute({ type: 'create-thread', commandId: 'create-local', threadId: 'local', projectId: project.id, title: 'New task', modelId: model.id })
  f.host.setGitPullRequests({ view: async () => ({ number: 1, url, title: 'Pull 1', body: '', state: 'open', draft: false }) } as never)
  await f.host.linkThreadPullRequest('local', url)
}
function babysitterOver(host: WorkspaceHost, pull: ScriptedPull, clock: { now: () => number }) {
  const github = scriptedGitHub([pull], { now: clock.now })
  const delivered: BabysitNews[] = []
  const events: BabysitEvent[] = []
  const babysitter = new Babysitter({ store: host, rateLimit: new GitHubRateLimit({ now: clock.now }), run: github.run, now: clock.now,
    log: event => events.push(event), deliver: async (_threadId, news) => { delivered.push(news) } })
  return { babysitter, github, delivered, events }
}

describe('babysitting on the thread\'s record', () => {
  it('survives a restart, and the first pass after it tells once what changed while the host was not reading', async () => {
    let now = START
    const clock = { now: () => now }
    const pull: ScriptedPull = { number: 1, checks: [{ name: 'test', state: 'FAILURE' }] }
    const f = await fixture()
    await linkedThread(f)
    const first = babysitterOver(f.host, pull, clock)
    await expect(first.babysitter.start('local', url, 'user')).resolves.toMatchObject({ started: true })
    now += 2 * 60_000
    await first.babysitter.pass()
    expect(first.delivered.map(news => news.changes)).toEqual([[{ kind: 'checks-failed', checks: [expect.objectContaining({ name: 'test' })] }]])
    await first.babysitter.close()
    await f.stop()

    // What the thread was told is on its record in workspace.json, beside its links.
    const saved = JSON.parse(await readFile(join(f.root, 'workspace.json'), 'utf8')) as { snapshot: { threads: Array<{ id: string; pullRequests?: unknown[]; babysitting?: Array<Record<string, unknown>> }> } }
    const record = saved.snapshot.threads.find(thread => thread.id === 'local')!
    expect(record.pullRequests).toHaveLength(1)
    expect(record.babysitting).toEqual([{ url, number: 1, startedBy: 'user', startedAt: new Date(START).toISOString(),
      told: expect.objectContaining({ head: 'head-1', failedChecks: ['test'], failedReads: 0, commentOnly: 0 }) }])

    // While the host was not reading, someone reviewed and the branch began to conflict.
    pull.reviews = [{ id: 'r-1', author: 'reviewer', at: at(30), state: 'APPROVED' }]
    pull.mergeable = 'CONFLICTING'
    now += 60 * 60_000
    const reopened = await fixture(f.root)
    expect(reopened.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')!.babysitting).toEqual([{ url, number: 1, startedBy: 'user', startedAt: new Date(START).toISOString() }])
    const second = babysitterOver(reopened.host, pull, clock)
    expect(second.babysitter.list('local')).toEqual([{ threadId: 'local', url, number: 1, startedBy: 'user', startedAt: new Date(START).toISOString() }])
    await second.babysitter.pass()
    // The failure told before the restart is not told again; what happened meanwhile is told once.
    expect(second.delivered.map(news => news.changes)).toEqual([[
      { kind: 'remarks', remarks: [expect.objectContaining({ kind: 'review', author: 'reviewer', review: 'approved' })] },
      { kind: 'conflicting', base: 'main' },
    ]])
    now += 2 * 60_000
    await second.babysitter.pass()
    expect(second.delivered).toHaveLength(1)
    await second.babysitter.close()
  })

  it("keeps babysitting the branch's own pull request through a restart, while the host has not asked GitHub for it again", async () => {
    let now = START
    const clock = { now: () => now }
    const pull: ScriptedPull = { number: 1 }
    // A local read gives the branch's pull request from what the host last heard from GitHub, which a restart forgets.
    let pullRequest: GitStatus['pullRequest'] = { number: 1, title: 'Pull 1', url, state: 'open', draft: false }
    const status = (): GitStatus => ({ isRepository: true, branch: 'feat', upstream: 'origin/feat', hasRemote: true, defaultBranch: 'main', isDefaultBranch: false,
      dirty: false, changedFiles: 0, insertions: 0, deletions: 0, ahead: 0, behind: 0, aheadOfDefault: 1, pullRequest, fetchedAt: null, readAt: new Date(now).toISOString() })
    const git = () => ({ read: vi.fn(async () => status()), invalidate: vi.fn() })
    const f = await fixture()
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(item => item.providerId === 'codex')!
    const model = snapshot.models.find(item => item.providerId === 'codex')!
    f.host.setGitStatus(git(), { pollIntervalMs: () => 0 })
    await f.host.execute({ type: 'create-thread', commandId: 'create-local', threadId: 'local', projectId: project.id, title: 'New task', modelId: model.id })
    await f.host.execute({ type: 'send', commandId: 'send-local', threadId: 'local', messageId: 'message-local', text: 'Implement the task' })
    const thread = (host: WorkspaceHost) => host.workspaceSnapshot().threads.find(item => item.id === 'local')!
    await f.host.updateThreadWorktree('local', false)
    await vi.waitFor(() => expect(thread(f.host).worktree?.git?.pullRequest?.url).toBe(url))
    expect(thread(f.host).pullRequests).toBeUndefined()
    const first = babysitterOver(f.host, pull, clock)
    await expect(first.babysitter.start('local', url, 'agent')).resolves.toMatchObject({ started: true })
    now += 2 * 60_000
    await first.babysitter.pass()
    await first.babysitter.close()
    await f.stop()

    // After the restart the first local read finds no pull request, and no window is in front to ask GitHub.
    pullRequest = null
    pull.comments = [{ id: 'c-1', author: 'reviewer', at: at(10) }]
    now += 60 * 60_000
    const reopened = await fixture(f.root)
    reopened.host.setGitStatus(git(), { pollIntervalMs: () => 0 })
    await reopened.host.updateThreadWorktree('local', false)
    await vi.waitFor(() => expect(thread(reopened.host).worktree?.git?.readAt).toBe(new Date(now).toISOString()))
    expect(thread(reopened.host).worktree?.git?.pullRequest).toBeNull()
    const second = babysitterOver(reopened.host, pull, clock)
    await second.babysitter.pass()
    expect(second.events).not.toContain('babysit-ended-unlinked')
    expect(second.babysitter.list('local')).toHaveLength(1)
    expect(second.delivered.map(news => news.changes)).toEqual([[{ kind: 'remarks', remarks: [expect.objectContaining({ author: 'reviewer' })] }]])
    await second.babysitter.close()
  })

  it('ends babysitting quietly when the user unlinks the pull request', async () => {
    const f = await fixture()
    await linkedThread(f)
    const { babysitter, delivered, events } = babysitterOver(f.host, { number: 1 }, { now: () => START })
    await babysitter.start('local', url, 'user')
    await f.host.unlinkThreadPullRequest('local', url)
    expect(f.host.workspaceSnapshot().threads.find(item => item.id === 'local')!.babysitting).toBeUndefined()
    expect(babysitter.list()).toEqual([])
    expect(events).toEqual(['babysit-started', 'babysit-ended-unlinked'])
    expect(delivered).toEqual([])
    await babysitter.close()
  })

  it('publishes only which pull request, who started it and since when, and drops it when babysitting ends', async () => {
    const clock = { now: () => START }
    const f = await fixture()
    await linkedThread(f)
    const { babysitter, events } = babysitterOver(f.host, { number: 1 }, clock)
    let published = f.host.workspaceSnapshot()
    const unsubscribe = f.host.subscribe(snapshot => { published = snapshot })
    await babysitter.start('local', url, 'agent')
    const thread = () => published.threads.find(item => item.id === 'local')!
    expect(thread().babysitting).toEqual([{ url, number: 1, startedBy: 'agent', startedAt: new Date(START).toISOString() }])
    expect(JSON.stringify(f.host.workspaceSnapshot())).not.toContain('told')
    // A provider's update keeps it: babysitting is Sotto's record, not the provider's.
    f.adapters.codex.emit()
    expect(f.host.workspaceSnapshot().threads.find(item => item.id === 'local')!.babysitting).toHaveLength(1)
    // Settling the thread ends it quietly at once, without waiting for a pass.
    await f.host.setWorkspaceSettled('thread', 'local', true)
    await expect.poll(() => events).toEqual(['babysit-started', 'babysit-ended-settled'])
    expect(f.host.workspaceSnapshot().threads.find(item => item.id === 'local')!.babysitting).toBeUndefined()
    await babysitter.pass()
    expect(events).toEqual(['babysit-started', 'babysit-ended-settled'])
    unsubscribe()
    await babysitter.close()
  })

  it('ends babysitting quietly at once when the provider archives the thread', async () => {
    const f = await fixture()
    await linkedThread(f)
    const { babysitter, delivered, events } = babysitterOver(f.host, { number: 1 }, { now: () => START })
    await babysitter.start('local', url, 'agent')
    await f.host.execute({ type: 'send', commandId: 'first', threadId: 'local', messageId: 'first', text: 'Start.' })
    const session = f.adapters.codex.state.threads.find(thread => thread.id === f.registry.byThread('local')!.sessionId)!
    session.archivedAt = new Date(START).toISOString()
    f.adapters.codex.emit()
    await expect.poll(() => babysitter.list()).toEqual([])
    expect(events).toEqual(['babysit-started', 'babysit-ended-archived'])
    expect(delivered).toEqual([])
    await babysitter.close()
  })

  it('keeps why babysitting ended on its own through a restart, until the pull request is babysat again', async () => {
    const f = await fixture()
    await linkedThread(f)
    const thread = (host: WorkspaceHost) => host.workspaceSnapshot().threads.find(item => item.id === 'local')!
    await f.host.recordBabysitEnded('local', url, 'merged')
    expect(thread(f.host).babysitEnded).toEqual([{ url, number: 1, reason: 'merged', endedAt: expect.any(String) }])
    // A later ending of the same pull request replaces the earlier one.
    await f.host.recordBabysitEnded('local', url, 'unreadable')
    expect(thread(f.host).babysitEnded).toEqual([expect.objectContaining({ url, reason: 'unreadable' })])
    await f.stop()

    const reopened = await fixture(f.root)
    expect(thread(reopened.host).babysitEnded).toEqual([expect.objectContaining({ url, number: 1, reason: 'unreadable' })])
    const { babysitter } = babysitterOver(reopened.host, { number: 1 }, { now: () => START })
    await expect(babysitter.start('local', url, 'user')).resolves.toMatchObject({ started: true })
    expect(thread(reopened.host).babysitEnded).toBeUndefined()
    await babysitter.close()
  })

  it('reads a thread whose ending a later host words with a reason this build does not know, without the ending', () => {
    const thread = { id: 't', projectId: 'p', title: 'T', modelId: 'm', status: 'idle', messages: [], requests: [],
      babysitEnded: [{ url, number: 1, reason: 'a-later-reason', endedAt: new Date(START).toISOString() }] }
    const parsed = agentThreadSchema.safeParse(thread)
    expect(parsed.success).toBe(true)
    expect(parsed.data?.babysitEnded).toBeUndefined()
  })

  it('leaves the thread readable by a client that predates the field, and drops what a client was never meant to have', () => {
    const thread = { id: 't', projectId: 'p', title: 'T', modelId: 'm', status: 'idle', messages: [], requests: [],
      babysitting: [{ url, number: 1, startedBy: 'agent', startedAt: new Date(START).toISOString(), told: { head: 'x' } }] }
    const older = agentThreadSchema.omit({ babysitting: true })
    expect(older.safeParse(thread).success).toBe(true)
    expect(older.parse(thread)).not.toHaveProperty('babysitting')
    expect(agentThreadSchema.parse(thread).babysitting).toEqual([{ url, number: 1, startedBy: 'agent', startedAt: new Date(START).toISOString() }])
  })
})
