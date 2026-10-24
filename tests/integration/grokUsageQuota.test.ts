// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import type { RecordedRpc } from '../fixtures/adapterFixture'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'

// Usage reads Grok's limits through `_x.ai/billing` on a signed-in Grok process (ADR-0083). Starting a process held
// main for seconds on a busy Windows computer (#1456), so a refresh asks a thread's process that is already running and
// signed in. With none running, a refresh Usage makes on its own when it opens reuses a recent reading, and Read again
// still reads afresh. No quota read creates, loads or prompts a session.
type Recorded = RecordedRpc & { process?: number }
let f: Awaited<ReturnType<typeof grokFixture>> | undefined
afterEach(async () => { await f?.cleanup(); f = undefined })

const records = async () => (await f!.driver.requests()) as Recorded[]
const started = async () => (await records()).filter(record => record.method === 'fixture/process').length
const sessionCalls = async () => (await records()).filter(record => ['session/new', 'session/load', 'session/prompt'].includes(record.method ?? '')).length
const billing = async () => (await records()).filter(record => record.method === '_x.ai/billing')
const thread = async (id: string) => (await f!.host.snapshot()).threads.find(item => item.id === id)!
const quota = (refresh: boolean, background?: boolean) => f!.host.readProviderQuota!('grok', refresh, background)

async function open(): Promise<void> {
  f = await grokFixture(undefined, undefined, undefined, {}, { usageEnabled: true }); await f.host.connect()
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

it('reports a refused read as read-failed without harming the live process it asked', async () => {
  await open()
  const { id } = await working()
  await f!.script({ rejectBilling: true })
  expect(await quota(true)).toMatchObject({ providerId: 'grok', status: 'error', reason: 'read-failed' })
  expect((await thread(id)).status).toBe('running')
  await f!.driver.completeTurn(id, 'Still finishing')
  await expect.poll(async () => (await thread(id)).status).toBe('idle')
})

it('says Grok is not connected before it connects', async () => {
  f = await grokFixture(undefined, undefined, undefined, {}, { usageEnabled: true })
  expect(await quota(true)).toMatchObject({ providerId: 'grok', status: 'unavailable', reason: 'not-connected' })
  expect(await started()).toBe(0)
})
