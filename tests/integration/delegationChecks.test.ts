// @vitest-environment node
// #1312 over ADR-0081: This computer runs one check at a time. A later check waits its turn in the order asked, working,
// with its snapshot taken when it was asked for; Stop takes a waiting one out of the queue.
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { commitFile, git } from '../fixtures/branchRepositories'
import { delegationFixture, type DelegationRefused, type DelegationResult } from '../fixtures/delegationFixture'

type CheckResult = DelegationResult & { delegation: { check?: { ahead: number; note: string } }; startedFrom?: { note: string }; note?: string }
/** A checkout's text as committed: this computer's own `core.autocrlf` may give it CRLF on the way out. */
const lf = (text: string): string => text.replace(/\r\n/gu, '\n')
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

/** A delegating thread in its project's checkout, a repository on `feat/p`, with This computer's check queue. */
async function fixture() {
  const f = await delegationFixture(cleanups, { branchStarts: true, checks: true })
  const parent = await f.userThread('claude')
  const folder = f.control.shell().host.threads.find(thread => thread.id === parent)!.workingDirectory!
  git(folder, 'init', '-q'); await commitFile(folder, 'README.md', '# Project\n', 'Start the project')
  git(folder, 'switch', '-q', '-c', 'feat/p')
  await commitFile(folder, 'p.txt', 'p\n')
  const check = async (threadId: string, input: Record<string, unknown> = {}) =>
    f.ok(await f.delegate(threadId, { provider: 'codex', model: f.model('codex').id, wait_seconds: 0, test_run: true, ...input })) as CheckResult
  const made = (threadId: string) => f.control.shell().host.threads.some(thread => thread.id === threadId)
  return { ...f, parent, folder, check, made }
}

it('runs one check at a time on This computer and starts the next, in the order asked, once the one ahead ends (#1312)', async () => {
  const f = await fixture()
  const other = await f.userThread('grok')
  const first = await f.check(f.parent)
  expect(first.delegation.outcome).toBe('working')
  expect(first.delegation.check).toBeUndefined()
  await vi.waitFor(() => expect(f.native(first.delegation.thread).status).toBe('running'))
  // A second thread's check waits behind the first, and a third behind both: one queue for the machine, whoever asks.
  const second = await f.check(other)
  const third = await f.check(f.parent, { work: 'research' })
  expect(second.delegation).toMatchObject({ outcome: 'working', check: { ahead: 1, note: expect.stringMatching(/^Waiting for This computer's check to finish\. 1 ahead\./u) } })
  expect(third.delegation).toMatchObject({ outcome: 'working', check: { ahead: 2, note: expect.stringMatching(/^Waiting for This computer's checks to finish\. 2 ahead\./u) } })
  // Nothing of a waiting check is started: no thread, so nothing counts as working for it.
  expect(f.made(second.delegation.thread)).toBe(false)
  expect(f.made(third.delegation.thread)).toBe(false)
  expect((f.ok(await f.read(other, second.delegation.id)) as CheckResult).delegation.check?.ahead).toBe(1)

  await f.endTurn(first.delegation.thread, 'Synthetic verdict: 3 passed, 1 failed')
  await vi.waitFor(() => expect(f.made(second.delegation.thread) && f.native(second.delegation.thread).status).toBe('running'))
  expect(f.native(second.delegation.thread).messages[0]).toMatchObject({ role: 'user', text: 'Synthetic brief' })
  expect(f.made(third.delegation.thread)).toBe(false)
  const read = f.ok(await f.read(f.parent, third.delegation.id)) as CheckResult
  expect(read.delegation).toMatchObject({ outcome: 'working', check: { ahead: 1 } })
  // The reply is the check's verdict in its own words; Sotto reads no pass or fail from it.
  expect(f.ok(await f.read(f.parent, first.delegation.id)).delegation).toMatchObject({ outcome: 'answered', reply: { from: 'delegated-thread', text: 'Synthetic verdict: 3 passed, 1 failed' } })

  await f.endTurn(second.delegation.thread, 'Synthetic verdict: passed')
  await vi.waitFor(() => expect(f.made(third.delegation.thread) && f.native(third.delegation.thread).status).toBe('running'))
  const running = f.ok(await f.read(f.parent, third.delegation.id)) as CheckResult
  expect(running.delegation.check).toBeUndefined()
})

it('takes a waiting check out of the queue when it is cancelled or its thread is stopped, starting nothing for it (#1312)', async () => {
  const f = await fixture()
  const first = await f.check(f.parent, { from_my_branch: true })
  await vi.waitFor(() => expect(f.native(first.delegation.thread).status).toBe('running'))
  const cancelled = await f.check(f.parent, { from_my_branch: true })
  const stopped = await f.check(f.parent, { work: 'research' })
  const last = await f.check(f.parent, { work: 'ui' })
  expect(last.delegation.check?.ahead).toBe(3)
  // Each start from the branch landed its own incoming ref; the waiting one lets go of its own when it leaves.
  const refs = () => git(f.folder, 'for-each-ref', '--format=%(refname)', 'refs/sotto').split('\n').filter(Boolean)
  expect(refs()).toHaveLength(2)
  const answer = await f.service.cancel(f.parent, { delegation: cancelled.delegation.id }) as CheckResult
  expect(answer.delegation.outcome).toBe('stopped')
  expect(answer.note).toBe('It was waiting for its turn among This computer\'s checks, and Sotto took it out of the queue. Nothing was started.')
  await vi.waitFor(() => expect(refs()).toHaveLength(1))
  expect((f.ok(await f.read(f.parent, last.delegation.id)) as CheckResult).delegation.check?.ahead).toBe(2)

  // Stop on the delegating thread stops its working check and takes its waiting ones out of the queue.
  await f.control.commandShell({ type: 'interrupt', threadId: f.parent })
  await vi.waitFor(async () => {
    expect((f.ok(await f.read(f.parent, stopped.delegation.id))).delegation.outcome).toBe('stopped')
    expect((f.ok(await f.read(f.parent, last.delegation.id))).delegation.outcome).toBe('stopped')
  })
  // The provider ends the stopped turn as interrupted, and the check leaves its place.
  await vi.waitFor(() => expect(f.adapterOf(first.delegation.thread).commands.some(command => command.type === 'interrupt')).toBe(true))
  await f.endTurn(first.delegation.thread, 'Synthetic stopped', 'interrupted')
  await vi.waitFor(async () => expect((f.ok(await f.read(f.parent, first.delegation.id))).delegation.outcome).toBe('stopped'))
  // The queue is empty after them, so the next check starts at once, and none of the stopped ones ever does.
  const next = await f.check(f.parent)
  expect(next.delegation.check).toBeUndefined()
  await vi.waitFor(() => expect(f.made(next.delegation.thread)).toBe(true))
  for (const gone of [cancelled, stopped, last]) expect(f.made(gone.delegation.thread)).toBe(false)
})

it('takes a waiting check’s snapshot when it is asked for, and says when, so later edits are not what it tests (#1312)', async () => {
  const f = await fixture()
  const first = await f.check(f.parent)
  await vi.waitFor(() => expect(f.native(first.delegation.thread).status).toBe('running'))
  await writeFile(join(f.folder, 'p.txt'), 'asked\n'); await writeFile(join(f.folder, 'scratch.txt'), 'scratch\n')
  const waiting = await f.check(f.parent, { from_my_branch: true })
  expect(waiting.delegation.check?.ahead).toBe(1)
  expect(waiting.startedFrom?.note).toMatch(/^Starts on This computer from feat\/p with your uncommitted changes as they were at \d\d:\d\d \(1 untracked file\)\.$/u)
  // Edits made while it waits stay out of it.
  await writeFile(join(f.folder, 'p.txt'), 'later\n')
  await f.endTurn(first.delegation.thread, 'Synthetic verdict: passed')
  await vi.waitFor(() => expect(f.made(waiting.delegation.thread)).toBe(true))
  await expect.poll(() => f.control.shell().host.threads.find(thread => thread.id === waiting.delegation.thread)?.worktree?.status, { timeout: 20_000 }).toBe('ready')
  const worktree = f.control.shell().host.threads.find(thread => thread.id === waiting.delegation.thread)!.worktree!
  expect(lf(await readFile(join(worktree.path!, 'p.txt'), 'utf8'))).toBe('asked\n')
  expect(lf(await readFile(join(f.folder, 'p.txt'), 'utf8'))).toBe('later\n')
})

it('refuses a check while Work across machines is off, so nothing queues (#1312)', async () => {
  const f = await delegationFixture(cleanups)
  const parent = await f.userThread('claude')
  const refused = await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, wait_seconds: 0, test_run: true }) as DelegationRefused
  expect(refused).toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
})
