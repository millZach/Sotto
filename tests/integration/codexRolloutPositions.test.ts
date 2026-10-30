// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { open, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { CodexSessionLogWatcher } from '../../src/main/agents/codexSessionLog'
import { codexFixture } from '../fixtures/codexFixture'

// Every connect read every saved thread's rollout from its first byte, and every tick read every rollout again (#992).
// A thread's rollout is now read each second only while the thread is in use, and from where the last run left it.

let fixture: Awaited<ReturnType<typeof codexFixture>> | undefined
afterEach(async () => { vi.restoreAllMocks(); await fixture?.cleanup(); fixture = undefined })

/** The bytes main reads from files whose path contains `part`, counted as each read returns. */
async function bytesReadFrom(part: string): Promise<{ readonly bytes: () => number }> {
  const probe = await open(process.execPath, 'r')
  const handles = Object.getPrototypeOf(probe) as { read(...args: unknown[]): Promise<{ bytesRead: number }> }
  await probe.close()
  const opened = new WeakSet<object>()
  let total = 0
  const read = handles.read
  vi.spyOn(handles, 'read').mockImplementation(async function (this: object, ...args: unknown[]) {
    const result = await read.apply(this, args)
    if (opened.has(this)) total += result.bytesRead
    return result
  })
  // Which handles are the rollout's: those whose stat names its inode.
  const statOf = handles as unknown as { stat(): Promise<{ ino: number }> }
  const stats = statOf.stat
  const target = (await stat(part)).ino
  vi.spyOn(statOf, 'stat').mockImplementation(async function (this: object) {
    const result = await stats.apply(this)
    if (result.ino === target) opened.add(this)
    return result
  })
  return { bytes: () => total }
}

it('reads a thread\'s rollout after a restart only once the thread is in use, and from where the last run left it', async () => {
  let f = fixture = await codexFixture(undefined, false, 2000, { pollIntervalMs: 3_600_000 })
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Rollouts', path: f.root })
  const threadId = randomUUID()
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: f.projectId, title: 'Rollouts', modelId: f.modelId })
  for (const index of [1, 2, 3]) await f.typeUnseen(threadId, `Typed in Codex ${index}`)
  await f.adapter.pollSessionLogs()
  const codexThreadId = await f.realId(threadId)
  const path = join(f.root, 'home', 'sessions', '2026', '09', '10', `rollout-2026-09-10-${codexThreadId}.jsonl`)
  // Quitting saves where the rollout was read to: its end.
  f.adapter.disconnect(); await f.adapter.closed()
  const saved = JSON.parse(await readFile(join(f.root, 'codex-rollouts', `${codexThreadId}.json`), 'utf8')) as { offset: number; path: string }
  expect(saved).toMatchObject({ offset: (await stat(path)).size, path })

  // Restarted, with work typed in Codex outside Sotto meanwhile.
  await f.typeUnseen(threadId, 'Typed in Codex while Sotto was closed')
  const appended = (await stat(path)).size - saved.offset
  f = fixture = await codexFixture(f.root, false, 2000, { pollIntervalMs: 3_600_000 })
  const read = await bytesReadFrom(path)
  const reads = vi.spyOn(CodexSessionLogWatcher.prototype, 'pollThread')
  await f.host.connect()
  // Connecting reads nothing of a thread nobody looks at, and nor does a tick.
  await (f.adapter as unknown as { watcher: CodexSessionLogWatcher }).watcher.pollInUse()
  expect(reads.mock.calls.filter(([id]) => id === codexThreadId)).toEqual([])
  expect(read.bytes()).toBe(0)
  // Opened, it reads on from its saved position, and the work typed outside Sotto shows.
  f.host.observeThreads?.([threadId])
  await expect.poll(async () => (await f.adapter.refreshThread(threadId)).threads.find(thread => thread.id === threadId)?.messages.map(message => message.text))
    .toContain('Typed in Codex while Sotto was closed')
  expect(read.bytes()).toBe(appended)
})
