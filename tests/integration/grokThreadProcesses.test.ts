// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { RecordedRpc } from '../fixtures/adapterFixture'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'

// One ACP process per thread session, the way T3 Code runs Grok: each thread's work runs on its own
// process, one process ending fails only its own thread, and a client update moves each thread onto the
// new binary as it goes idle while a working one finishes on the process it started with.
type Recorded = RecordedRpc & { process?: number }
let f: Awaited<ReturnType<typeof grokFixture>> | undefined
afterEach(async () => { await f?.cleanup(); f = undefined })

const records = async () => (await f!.driver.requests()) as Recorded[]
/** The version each fake process started as, by process ID. */
const versions = async () => new Map((await records()).filter(record => record.method === 'fixture/process')
  .map(record => [record.params!.pid as number, record.params!.version as string]))
const received = async (method: string, id: string) => {
  const native = await f!.realId(id)
  return (await records()).filter(record => record.method === method && record.params?.sessionId === native)
}
const thread = async (id: string) => (await f!.host.snapshot()).threads.find(item => item.id === id)!
const send = (id: string, messageId: string, text = 'Synthetic prompt') => f!.host.execute({ type: 'send', commandId: messageId, threadId: id, messageId, text })
async function open(): Promise<void> {
  f = await grokFixture(); await f.host.connect()
  await f!.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f!.root })
}
async function create(title: string): Promise<string> {
  const id = randomUUID()
  expect(await f!.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f!.projectId, modelId: f!.modelId, title })).toEqual({ accepted: true })
  return id
}
const clientUpdated = () => f!.adapter.clientUpdated()

it('gives each thread session its own Grok process', async () => {
  await open()
  const first = await create('First'); const second = await create('Second')
  await send(first, 'first-prompt'); await send(second, 'second-prompt')
  const [firstPrompt] = await received('session/prompt', first)
  const [secondPrompt] = await received('session/prompt', second)
  expect(firstPrompt!.process).toBeDefined(); expect(secondPrompt!.process).toBeDefined()
  expect(firstPrompt!.process).not.toBe(secondPrompt!.process)
  // Each session was created on the process that then ran its prompt.
  expect((await records()).filter(record => record.method === 'session/new').map(record => record.process)).toEqual([firstPrompt!.process, secondPrompt!.process])
})

it('keeps the other thread working and Grok connected when one thread\'s process ends', async () => {
  await open()
  const lost = await create('Lost'); const working = await create('Working')
  await send(lost, 'lost-prompt'); await send(working, 'working-prompt')
  await expect.poll(async () => [(await thread(lost)).status, (await thread(working)).status]).toEqual(['running', 'running'])
  await f!.action(lost, { type: 'malformed' })
  await expect.poll(async () => (await thread(lost)).status).toBe('error')
  expect((await thread(lost)).lastTurn).toEqual({ id: 'lost-prompt', status: 'failed' })
  const snapshot = await f!.host.snapshot()
  expect(snapshot.connected).toBe(true)
  expect(snapshot.error).toBeUndefined()
  expect((await thread(working)).status).toBe('running')
  await f!.driver.completeTurn(working, 'Finished beside the lost one')
  await expect.poll(async () => (await thread(working)).status).toBe('idle')
  expect((await thread(working)).messages.some(message => message.text === 'Finished beside the lost one')).toBe(true)
  // The thread whose process ended starts a new one on its next send.
  expect(await send(lost, 'lost-again')).toEqual({ accepted: true })
  const prompts = await received('session/prompt', lost)
  expect(prompts).toHaveLength(2)
  expect(prompts[1]!.process).not.toBe(prompts[0]!.process)
})

it('finishes a working thread\'s turn on its old process after a client update, and moves idle threads to the new client', async () => {
  await open()
  const working = await create('Working'); const idle = await create('Idle'); const watched = await create('Watched')
  f!.host.observeThreads?.([working, watched])
  await send(working, 'working-prompt')
  await expect.poll(async () => (await thread(working)).status).toBe('running')
  const [prompt] = await received('session/prompt', working)
  const oldProcess = prompt!.process!
  expect((await versions()).get(oldProcess)).toBe('1.0.5')

  // The installer replaced the client on disk.
  await f!.script({ cliVersion: '1.0.41' })
  await clientUpdated()
  const updated = await f!.host.snapshot()
  expect(updated).toMatchObject({ connected: true, version: '1.0.41 / ACP 1', verifiedVersion: '1.0.5' })
  expect(updated.error).toBeUndefined()

  // The idle thread stopped at once, the way the reaper stops one; the working one was not touched.
  await expect.poll(() => f!.sessions.stopped(idle)).toBe(true)
  expect(await f!.sessions.stopped(working)).toBe(false)
  expect((await thread(working)).status).toBe('running')
  expect((await records()).some(record => record.method === 'session/cancel')).toBe(false)
  // The watched thread started again straight away, on the new client.
  await expect.poll(async () => { const load = (await received('session/load', watched)).at(-1); return load && (await versions()).get(load.process!) }).toBe('1.0.41')

  // The working turn ends on the process it started on, and that process stops once it is idle.
  await f!.driver.completeTurn(working, 'Finished on the old client')
  await expect.poll(async () => (await thread(working)).status).toBe('idle')
  expect((await thread(working)).lastTurn).toEqual({ id: 'working-prompt', status: 'completed' })
  expect((await thread(working)).messages.some(message => message.text === 'Finished on the old client')).toBe(true)
  // Its old process closed the session once the turn was over, and, being watched, it loaded again on the new client.
  await expect.poll(async () => (await records()).some(record => record.method === 'fixture/session-resident' && record.process === oldProcess && record.params?.resident === false)).toBe(true)
  await expect.poll(async () => { const load = (await received('session/load', working)).at(-1); return load && (await versions()).get(load.process!) }).toBe('1.0.41')
  // The old process's own answer never moved the provider's version back.
  expect((await f!.host.snapshot()).version).toBe('1.0.41 / ACP 1')

  // Each thread's next action starts a process on the new client.
  for (const [id, messageId] of [[idle, 'idle-after'], [working, 'working-after']] as const) {
    expect(await send(id, messageId)).toEqual({ accepted: true })
    const next = (await received('session/prompt', id)).at(-1)!
    expect((await versions()).get(next.process!)).toBe('1.0.41')
  }
})

it('leaves every process and the version as they are and says why when the updated client is one Sotto will not drive', async () => {
  await open()
  const idle = await create('Idle')
  await f!.script({ cliVersion: '1.0.4' })
  await expect(clientUpdated()).rejects.toThrow('Grok Build was updated, but Sotto cannot run the new version. Grok CLI 1.0.5 or newer is required, and this client is 1.0.4. Threads that are working carry on and nothing was lost. Install a Grok Build version Sotto supports, then connect Grok Build again.')
  const snapshot = await f!.host.snapshot()
  expect(snapshot.connected).toBe(true)
  // The provider's version is what its threads run, and none of them runs the refused client.
  expect(snapshot.version).toBe('1.0.5 / ACP 1')
  expect(snapshot.error).toBeUndefined()
  expect(await f!.sessions.stopped(idle)).toBe(false)
})

it('finishes creating a thread whose process a client update made outdated halfway', async () => {
  await open()
  await f!.script({ holdCreate: true })
  const id = randomUUID()
  const creating = f!.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f!.projectId, modelId: f!.modelId, title: 'Created during the update' })
  await expect.poll(async () => (await records()).some(record => record.method === 'session/new')).toBe(true)
  await f!.script({ cliVersion: '1.0.41' })
  await clientUpdated()
  // The answer to `session/new` arrives after the update, and the create carries on to the model on the same process.
  await writeFile(join(f!.root, 'control.json'), JSON.stringify({ id: randomUUID(), type: 'release-create' }))
  expect(await creating).toEqual({ accepted: true })
  const setModel = (await records()).filter(record => record.method === 'session/set_model')
  expect(setModel).toHaveLength(1)
  expect((await records()).find(record => record.method === 'session/new')!.process).toBe(setModel[0]!.process)
  // Once made, the thread is idle on an outdated process, which stops; its next send starts on the new client.
  await send(id, 'after-update')
  const [prompt] = await received('session/prompt', id)
  expect((await versions()).get(prompt!.process!)).toBe('1.0.41')
})

it('does nothing on a client update while Grok is not connected', async () => {
  f = await grokFixture()
  await expect(clientUpdated()).resolves.toBeUndefined()
  expect(await f!.driver.requests()).toEqual([])
})
