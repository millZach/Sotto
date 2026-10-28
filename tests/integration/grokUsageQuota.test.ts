// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import type { RecordedRpc } from '../fixtures/adapterFixture'
import { grokFixture, LOST_REPLY_DEADLINE_MS } from '../fixtures/fakeGrokThreadFixture'
import { builtGitLauncherWorker } from '../fixtures/gitLauncherWorker'
import { mainThreadLaunches, resetMainThreadLaunches } from '../fixtures/mainThreadLaunches'
import { useGitLauncher } from '../../src/main/agents/gitLauncher'
import type { GrokAcpOptions } from '../../src/main/agents/grok'

vi.mock('node:child_process', async importOriginal => (await import('../fixtures/mainThreadLaunches')).timingLaunches(await importOriginal()))

// Usage reads Grok's limits through `_x.ai/billing` on a signed-in Grok process (ADR-0083). Starting a process held
// main for seconds on a busy Windows computer (#1456), so a refresh asks a thread's process that is already running and
// signed in. With none running, a refresh Usage makes on its own when it opens reuses a recent reading, and Read again
// still reads afresh. A process started for the question starts on the Git launcher's worker thread, as it does in
// the app, so every read here goes the way the app's does. No quota read creates, loads or prompts a session.
type Recorded = RecordedRpc & { process?: number }
let f: Awaited<ReturnType<typeof grokFixture>> | undefined
let worker: Awaited<ReturnType<typeof builtGitLauncherWorker>>
beforeAll(async () => { worker = await builtGitLauncherWorker(); await useGitLauncher(worker.path) }, 60_000)
afterEach(async () => { await f?.cleanup(); f = undefined })
afterAll(async () => { await useGitLauncher(null); await worker?.dispose() })

const records = async () => (await f!.driver.requests()) as Recorded[]
const started = async () => (await records()).filter(record => record.method === 'fixture/process').length
const sessionCalls = async () => (await records()).filter(record => ['session/new', 'session/load', 'session/prompt'].includes(record.method ?? '')).length
const billing = async () => (await records()).filter(record => record.method === '_x.ai/billing')
const thread = async (id: string) => (await f!.host.snapshot()).threads.find(item => item.id === id)!
const quota = (refresh: boolean, background?: boolean) => f!.host.readProviderQuota!('grok', refresh, background)

async function open(options: GrokAcpOptions = {}): Promise<void> {
  f = await grokFixture(undefined, undefined, undefined, {}, { usageEnabled: true, ...options }); await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
}
async function working(): Promise<{ id: string; process: number }> {
  const id = randomUUID()
  await f!.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f!.projectId, modelId: f!.modelId, title: 'Working' })
  await f!.host.execute({ type: 'send', commandId: 'working-prompt', threadId: id, messageId: 'working-prompt', text: 'Synthetic prompt' })
  await expect.poll(async () => (await thread(id)).status).toBe('running')
  const prompt = (await records()).find(record => record.method === 'session/prompt')!
  return { id, process: prompt.process! }
}

it('asks a running thread\'s signed-in process, starts none, and leaves its turn running', async () => {
  await open()
  const { id, process } = await working()
  const processes = await started(), calls = await sessionCalls()
  for (const background of [false, true]) {
    const read = await quota(true, background)
    expect(read).toMatchObject({ providerId: 'grok', status: 'available', refreshable: true })
    expect(read.windows).toEqual([expect.objectContaining({ id: 'grok-weekly', usedPercent: 42 })])
  }
  expect(await started()).toBe(processes)
  expect((await billing()).map(record => record.process)).toEqual([process, process])
  expect(await sessionCalls()).toBe(calls)
  // The read is the account's, not the session's: the turn it ran beside carries on and finishes.
  expect((await thread(id)).status).toBe('running')
  await f!.driver.completeTurn(id, 'Finished beside the billing read')
  await expect.poll(async () => (await thread(id)).status).toBe('idle')
  // A cached read asks nothing at all.
  expect(await quota(false)).toMatchObject({ status: 'available' })
  expect(await billing()).toHaveLength(2)
})

it('reuses a recent reading for a refresh Usage makes on its own, and reads afresh when the user asks', async () => {
  await open()
  const processes = await started()
  const first = await quota(true)
  expect(first.windows[0]).toMatchObject({ usedPercent: 42 })
  expect(await started()).toBe(processes + 1)
  await f!.script({ billingPercent: 64 })
  // Opening Usage again within the window shows the reading it already has, with its own time, and starts nothing.
  expect(await quota(true, true)).toEqual(first)
  expect(await started()).toBe(processes + 1)
  // Read again starts the one process it needs and shows the new figure.
  expect((await quota(true)).windows[0]).toMatchObject({ usedPercent: 64 })
  expect(await started()).toBe(processes + 2)
  expect(await sessionCalls()).toBe(0)
})

it('starts the process it asks on the launcher\'s worker thread, never on this one', async () => {
  // On Windows a process start runs on the thread that asks, and on Electron's main thread it holds the window: the
  // first start of Grok Build in a while held main for over a second (ADR-0083). This thread stands in for main here.
  await open()
  const processes = await started()
  resetMainThreadLaunches()
  expect(await quota(true)).toMatchObject({ providerId: 'grok', status: 'available' })
  expect(await quota(true)).toMatchObject({ providerId: 'grok', status: 'available' })
  // Two processes were started and asked, and neither was started from this thread.
  expect(await started()).toBe(processes + 2)
  expect(await billing()).toHaveLength(2)
  expect(mainThreadLaunches.count).toBe(0)
})

it('stops a process still asking when Grok disconnects, though it was started off this thread', async () => {
  await open()
  await f!.script({ holdBilling: true })
  const read = quota(true)
  await expect.poll(async () => (await records()).some(record => record.method === 'fixture/billing-held')).toBe(true)
  f!.host.disconnect()
  expect(await read).toMatchObject({ providerId: 'grok', status: 'unavailable', reason: 'not-connected' })
  // Every Grok process this connection started has exited, the asking one included.
  await f!.host.closed()
})

it('reports a refused read as read-failed without harming the live process it asked', async () => {
  await open()
  const { id } = await working()
  await f!.script({ rejectBilling: true })
  expect(await quota(true)).toMatchObject({ providerId: 'grok', status: 'error', reason: 'read-failed' })
  expect((await thread(id)).status).toBe('running')
  await f!.driver.completeTurn(id, 'Still finishing')
  await expect.poll(async () => (await thread(id)).status).toBe('idle')
})

it('says the read failed when the live process refuses, never handing back an earlier reading in its place', async () => {
  await open()
  // A good reading from moments ago, taken before any thread was running.
  expect(await quota(true)).toMatchObject({ status: 'available' })
  const { id } = await working()
  await f!.script({ rejectBilling: true })
  // Opening Usage again asks the running process, which refuses: that is a failed read, not the old reading.
  expect(await quota(true, true)).toMatchObject({ providerId: 'grok', status: 'error', reason: 'read-failed' })
  expect((await thread(id)).status).toBe('running')
})

it('keeps the newer reading when an older read finishes after it', async () => {
  await open()
  const { id } = await working()
  // Opening Usage asks first and its answer, 42%, is held back; Read again asks after it and is answered with 64% at once.
  await f!.script({ holdBilling: true })
  const opened = quota(true, true)
  // The fake records the request before it reads the script, so the hold itself is what is waited for.
  await expect.poll(async () => (await records()).some(record => record.method === 'fixture/billing-held')).toBe(true)
  await f!.script({ billingPercent: 64 })
  const asked = await quota(true)
  expect(asked.windows[0]).toMatchObject({ usedPercent: 64 })
  await f!.action(id, { type: 'release-billing' })
  // The older answer arrives last, and neither it nor what it hands back takes the newer reading's place.
  expect(await opened).toEqual(asked)
  expect(await quota(false)).toEqual(asked)
})

it('asks a process of its own when a running thread\'s process is slow to answer, and leaves that thread alone', async () => {
  // The held answer is lost for good, so the test waits out the live ask's deadline; the short one is safe here.
  await open({ liveBillingTimeoutMs: LOST_REPLY_DEADLINE_MS })
  const { id, process } = await working()
  await f!.script({ holdBillingResident: true })
  const processes = await started(), calls = await sessionCalls()
  const read = await quota(true)
  expect(read).toMatchObject({ providerId: 'grok', status: 'available' })
  expect(read.windows[0]).toMatchObject({ usedPercent: 42 })
  // The thread's process was asked first and held its answer; a process started for the question answered it.
  const asked = (await billing()).map(record => record.process)
  expect(asked[0]).toBe(process)
  expect(asked).toHaveLength(2)
  expect(asked[1]).not.toBe(process)
  expect(await started()).toBe(processes + 1)
  expect(await sessionCalls()).toBe(calls)
  // The late answer, once it comes, changes nothing, and the thread's turn carries on and finishes.
  await f!.action(id, { type: 'release-billing' })
  expect((await thread(id)).status).toBe('running')
  await f!.driver.completeTurn(id, 'Finished after the slow read')
  await expect.poll(async () => (await thread(id)).status).toBe('idle')
  expect(await quota(false)).toEqual(read)
})

it('says Grok is not connected before it connects', async () => {
  f = await grokFixture(undefined, undefined, undefined, {}, { usageEnabled: true })
  expect(await quota(true)).toMatchObject({ providerId: 'grok', status: 'unavailable', reason: 'not-connected' })
  expect(await started()).toBe(0)
})
