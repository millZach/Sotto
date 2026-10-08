// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { workspaceFixture } from '../../fixtures/workspaceFixture'
import { scriptedGitHub, type ScriptedPull } from '../../fixtures/babysitGitHub'
import { Babysitter, type BabysitEvent } from '../../../src/main/agents/babysitting'
import type { BabysitNews } from '../../../src/main/agents/babysitNews'
import { GitHubRateLimit } from '../../../src/main/agents/github'
import type { WorkspaceHost } from '../../../src/main/agents/workspace'
import { agentThreadSchema } from '../../../src/shared/agents'

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
    // Settling the thread ends it quietly at the next pass.
    await f.host.setWorkspaceSettled('thread', 'local', true)
    await babysitter.pass()
    expect(f.host.workspaceSnapshot().threads.find(item => item.id === 'local')!.babysitting).toBeUndefined()
    expect(events).toEqual(['babysit-started', 'babysit-ended-settled'])
    unsubscribe()
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
