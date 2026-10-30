// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { open, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { CodexSessionLogWatcher } from '../../src/main/agents/codexSessionLog'
import { codexFixture } from '../fixtures/codexFixture'

// Every connect read every saved thread's rollout from its first byte, and every tick read every rollout again (#992).
// A thread's rollout is now read each second only while the thread is in use, and from where the last run left it.

let fixture: Awaited<ReturnType<typeof codexFixture>> | undefined
afterEach(async () => { vi.restoreAllMocks(); await fixture?.cleanup(); fixture = undefined })

/** The bytes main reads from each of `paths`, counted as each read returns, telling a file's handles by the inode they stat. */
async function bytesReadFrom(...paths: string[]): Promise<{ readonly bytes: (path?: string) => number }> {
  const probe = await open(process.execPath, 'r')
  const handles = Object.getPrototypeOf(probe) as { read(...args: unknown[]): Promise<{ bytesRead: number }>; stat(): Promise<{ ino: number }> }
  await probe.close()
  const inodes = new Map(await Promise.all(paths.map(async path => [(await stat(path)).ino, path] as const)))
  const owner = new WeakMap<object, string>()
  const totals = new Map(paths.map(path => [path, 0]))
  const read = handles.read, stats = handles.stat
  vi.spyOn(handles, 'read').mockImplementation(async function (this: object, ...args: unknown[]) {
    const result = await read.apply(this, args)
    const path = owner.get(this)
    if (path) totals.set(path, totals.get(path)! + result.bytesRead)
    return result
  })
  vi.spyOn(handles, 'stat').mockImplementation(async function (this: object) {
    const result = await stats.apply(this)
    const path = inodes.get(result.ino)
    if (path) owner.set(this, path)
    return result
  })
  return { bytes: (path = paths[0]!) => totals.get(path) ?? 0 }
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

it('waits on no rollout at the first connect without saved positions, and catches each up on the timer instead', async () => {
  let f = fixture = await codexFixture(undefined, false, 2000, { pollIntervalMs: 3_600_000 })
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Rollouts', path: f.root })
  const threadId = randomUUID()
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: f.projectId, title: 'Rollouts', modelId: f.modelId })
  for (const index of [1, 2]) await f.typeUnseen(threadId, `Typed in Codex ${index}`)
  const codexThreadId = await f.realId(threadId)
  const path = join(f.root, 'home', 'sessions', '2026', '09', '10', `rollout-2026-09-10-${codexThreadId}.jsonl`)
  f.adapter.disconnect(); await f.adapter.closed()
  // As the first run with saved positions finds it: none saved.
  await rm(join(f.root, 'codex-rollouts'), { recursive: true, force: true })
  f = fixture = await codexFixture(f.root, false, 2000, { pollIntervalMs: 3_600_000 })
  const read = await bytesReadFrom(path)
  await f.host.connect()
  expect(read.bytes()).toBe(0)
  await (f.adapter as unknown as { watcher: CodexSessionLogWatcher }).watcher.tick()
  expect(read.bytes()).toBe((await stat(path)).size)
})

it('reads a thread coming back into view to its rollout\'s end at once, while its session still runs', async () => {
  const f = fixture = await codexFixture(undefined, false, 2000, { pollIntervalMs: 3_600_000 })
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Rollouts', path: f.root })
  const threadId = randomUUID()
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: f.projectId, title: 'Rollouts', modelId: f.modelId })
  await f.typeUnseen(threadId, 'Typed in Codex first')
  f.host.observeThreads?.([threadId])
  await expect.poll(async () => (await f.adapter.refreshThread(threadId)).threads.find(thread => thread.id === threadId)?.messages.map(message => message.text)).toContain('Typed in Codex first')
  // The pane closes; the session keeps running until the reaper finds it idle.
  f.host.observeThreads?.([])
  await f.typeUnseen(threadId, 'Typed in Codex while the pane was closed')
  // Seen as the adapter says it: no tick and no read of the provider runs meanwhile.
  const said: string[] = []
  const off = f.adapter.subscribeEvents(({ threadId: id, event }) => { if (id === threadId && event.kind === 'message-added') said.push(event.message.text) })
  const ticks = vi.spyOn(CodexSessionLogWatcher.prototype, 'tick'), polls = vi.spyOn(CodexSessionLogWatcher.prototype, 'pollInUse')
  try {
    f.host.observeThreads?.([threadId])
    await expect.poll(() => said).toContain('Typed in Codex while the pane was closed')
  } finally { off() }
  expect(ticks).not.toHaveBeenCalled()
  expect(polls).not.toHaveBeenCalled()
})

it('catches up once only the unsettled threads after the update, and a settled one when it is opened', async () => {
  let f = fixture = await codexFixture(undefined, false, 2000, { pollIntervalMs: 3_600_000 })
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Rollouts', path: f.root })
  const [active, settled] = [randomUUID(), randomUUID()]
  for (const threadId of [active, settled]) {
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: f.projectId, title: 'Rollouts', modelId: f.modelId })
    await f.typeUnseen(threadId, `Typed in Codex on ${threadId}`)
  }
  const pathOf = async (threadId: string) => join(f.root, 'home', 'sessions', '2026', '09', '10', `rollout-2026-09-10-${await f.realId(threadId)}.jsonl`)
  const [activePath, settledPath] = [await pathOf(active), await pathOf(settled)]
  f.adapter.disconnect(); await f.adapter.closed()
  // As the first run after the update finds them: no position saved.
  await rm(join(f.root, 'codex-rollouts'), { recursive: true, force: true })
  f = fixture = await codexFixture(f.root, false, 2000, { pollIntervalMs: 3_600_000 })
  const read = await bytesReadFrom(activePath, settledPath)
  const activeRead = { bytes: () => read.bytes(activePath) }, settledRead = { bytes: () => read.bytes(settledPath) }
  // The run begins knowing which threads the user settled.
  f.adapter.useSettledThreads([settled])
  await f.host.connect()
  const watcher = (f.adapter as unknown as { watcher: CodexSessionLogWatcher }).watcher
  await watcher.tick(); await watcher.tick()
  expect(activeRead.bytes()).toBe((await stat(activePath)).size)
  expect(settledRead.bytes()).toBe(0)
  // Opened, the settled thread reads its whole rollout, once.
  f.host.observeThreads?.([settled])
  await expect.poll(async () => (await f.adapter.refreshThread(settled)).threads.find(thread => thread.id === settled)?.messages.map(message => message.text))
    .toContain(`Typed in Codex on ${settled}`)
  expect(settledRead.bytes()).toBe((await stat(settledPath)).size)
})
