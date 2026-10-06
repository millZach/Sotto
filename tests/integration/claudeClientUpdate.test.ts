// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { copyFile, link, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { claudeFixture } from '../fixtures/claudeFixture'

// Updating Claude Code replaces the client on disk while Sotto stays connected (ADR-0042). Each thread runs its own
// CLI, so each moves to the new client as it goes idle: an idle CLI stops at once and the next action starts the new
// client, and a busy one finishes on the old client first. Nothing is disconnected, cancelled or answered.
const fixtures: Awaited<ReturnType<typeof claudeFixture>>[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) await f.cleanup() })

async function fixture(threads: readonly string[]) {
  const f = await claudeFixture(undefined, 15_000)
  fixtures.push(f)
  await writeFile(join(f.root, 'version.txt'), '2.1.1')
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: 'project', projectId: f.projectId, title: 'Update', path: f.root })
  for (const id of threads) {
    await f.host.execute({ type: 'create-thread', commandId: `create-${id}`, threadId: id, projectId: f.projectId, title: id, modelId: f.modelId })
    await f.adapter.refreshThread(id)
  }
  return f
}
type Fixture = Awaited<ReturnType<typeof fixture>>
const thread = async (f: Fixture, id: string) => (await f.host.snapshot()).threads.find(value => value.id === id)!
const send = (f: Fixture, id: string, text: string) => f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: randomUUID(), text })
const live = (f: Fixture, id: string) => (f.adapter as unknown as { runtimes: Map<string, unknown> }).runtimes.has(id)
/** The executable each of this thread's CLIs was started from, in launch order. */
const launchedFrom = async (f: Fixture, id: string) => {
  const native = await f.realId(id)
  return (await f.driver.requests()).filter(record => ['launch', 'resume'].includes(record.method ?? ''))
    .map(record => record.params?.frame as { args?: string[]; executable?: string })
    .filter(frame => frame.args?.includes(native)).map(frame => frame.executable)
}
/** Install the "new" client: the same runtime at another path, which the adapter must find again. */
async function update(f: Fixture): Promise<string> {
  const next = join(f.root, `next-${basename(process.execPath)}`)
  await link(process.execPath, next).catch(() => copyFile(process.execPath, next))
  await writeFile(join(f.root, 'version.txt'), '2.1.2')
  vi.spyOn((f.adapter as unknown as { client: { findExecutable(): Promise<string | null> } }).client, 'findExecutable').mockResolvedValue(next)
  return next
}

it('lets a working thread finish on the old client and moves every thread to the new one as it goes idle', async () => {
  const f = await fixture(['working', 'idle'])
  expect((await f.host.snapshot()).version).toBe('2.1.1')
  expect(await send(f, 'working', 'Plan the trip')).toMatchObject({ accepted: true })
  await expect.poll(async () => (await thread(f, 'working')).status).toBe('running')
  const next = await update(f)

  await f.adapter.clientUpdated()
  const snapshot = await f.host.snapshot()
  expect(snapshot).toMatchObject({ connected: true, version: '2.1.2 (Claude Code)' })
  expect(snapshot.error).toBeUndefined()
  // The idle thread's CLI stopped without a word; the working one kept its CLI and its turn.
  expect(await f.sessions!.stopped('idle')).toBe(true)
  expect(await thread(f, 'idle')).toMatchObject({ status: 'idle' })
  expect(live(f, 'working')).toBe(true)
  expect(await f.sessions!.stopped('working')).toBe(false)
  expect((await thread(f, 'working')).status).toBe('running')

  // A turn the old client opens still names the old version; the provider keeps the one on disk.
  await f.action('working', { type: 'raw', frame: { type: 'system', subtype: 'init', session_id: await f.realId('working'), claude_code_version: '2.1.1' } })
  await f.driver.completeTurn('working', 'Here is the plan.')
  await expect.poll(async () => (await thread(f, 'working')).messages.at(-1)?.text).toBe('Here is the plan.')
  expect(await thread(f, 'working')).toMatchObject({ lastTurn: { status: 'completed' } })
  expect((await f.host.snapshot()).version).toBe('2.1.2 (Claude Code)')
  // Once idle, the working thread's old CLI stops too, and its reply was never cut short.
  await expect.poll(() => f.sessions!.stopped('working')).toBe(true)
  expect(await thread(f, 'working')).toMatchObject({ status: 'idle', lastTurn: { status: 'completed' } })
  expect((await f.host.snapshot()).connected).toBe(true)

  // Each thread's next action starts the new client.
  for (const id of ['idle', 'working']) {
    expect(await send(f, id, 'One more thing')).toMatchObject({ accepted: true })
    expect(await launchedFrom(f, id)).toEqual([process.execPath, next])
  }
})

it('leaves an unanswered request with the user and retires its CLI once it is answered', async () => {
  const f = await fixture(['asking'])
  await f.driver.raisePermission('asking', 'Build the project')
  await expect.poll(async () => (await thread(f, 'asking')).requests.length).toBe(1)
  const next = await update(f)

  await f.adapter.clientUpdated()
  expect(await f.sessions!.stopped('asking')).toBe(false)
  const request = (await thread(f, 'asking')).requests[0]!
  // Nothing answered it on the user's behalf.
  expect((await f.driver.requests()).filter(record => f.protocol!.permissionDecision(record) !== undefined)).toEqual([])

  expect(await f.host.execute({ type: 'answer', threadId: 'asking', commandId: randomUUID(), requestId: request.id, answer: '', approved: true })).toMatchObject({ accepted: true })
  await expect.poll(() => f.sessions!.stopped('asking')).toBe(true)
  expect((await f.driver.requests()).map(record => f.protocol!.permissionDecision(record)).filter(value => value !== undefined)).toEqual([true])
  expect(await send(f, 'asking', 'Carry on')).toMatchObject({ accepted: true })
  expect(await launchedFrom(f, 'asking')).toEqual([process.execPath, next])
})

it('starts a watched thread again on the new client straight away', async () => {
  const f = await fixture(['watched'])
  f.adapter.observeThreads(['watched'])
  const next = await update(f)

  await f.adapter.clientUpdated()
  await expect.poll(() => launchedFrom(f, 'watched')).toEqual([process.execPath, next])
  await expect.poll(() => f.sessions!.stopped('watched')).toBe(false)
  expect(await thread(f, 'watched')).toMatchObject({ status: 'idle' })
  expect((await f.host.snapshot()).error).toBeUndefined()
})

it('does nothing while Claude Code is not connected', async () => {
  const f = await claudeFixture(undefined, 15_000)
  fixtures.push(f)
  const find = vi.spyOn((f.adapter as unknown as { client: { findExecutable(): Promise<string | null> } }).client, 'findExecutable')
  await expect(f.adapter.clientUpdated()).resolves.toBeUndefined()
  expect(find).not.toHaveBeenCalled()
  expect((await f.host.snapshot()).connected).toBe(false)
})
