// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RecordedRpc } from '../fixtures/adapterFixture'
import { devinFixture } from '../fixtures/devinFixture'

/** The thinking levels Sotto set on a Devin session, in order. */
const levelsSet = (records: RecordedRpc[]): unknown[] => records
  .filter(record => record.method === 'session/set_config_option' && record.params?.configId === 'thought_level').map(record => record.params?.value)
/** How many Devin ACP processes have started. */
const acpStarts = (records: RecordedRpc[]): number => records.filter(record => record.method === 'fixture/spawn' && record.params?.kind === 'acp').length

describe('Devin effort levels', () => {
  let f: Awaited<ReturnType<typeof devinFixture>>
  const model = async (id: string) => (await f.host.snapshot()).models.find(entry => entry.id === id)
  const thread = async (id: string) => (await f.host.snapshot()).threads.find(entry => entry.id === id)!
  const create = async (reasoningEffort?: string): Promise<string> => {
    const id = randomUUID()
    expect(await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId,
      title: 'Synthetic thread', ...(reasoningEffort ? { reasoningEffort } : {}) })).toEqual({ accepted: true })
    return id
  }
  const send = (id: string) => f.host.execute({ type: 'send', commandId: randomUUID(), messageId: randomUUID(), threadId: id, text: 'Synthetic prompt' })
  const configure = (id: string, change: Record<string, string>) => f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, ...change })
  const project = () => f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
  beforeEach(async () => { f = await devinFixture() })
  afterEach(async () => { await f?.cleanup() })

  it('offers the levels Devin reports for its default model at connect, with no reading after', async () => {
    const snapshot = await f.host.connect()
    expect(snapshot.models.find(entry => entry.id === 'fixture-model')).toMatchObject({ reasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium' })
    expect(snapshot.capabilities).toMatchObject({ configureThreadModel: false, configureThreadEffort: true })
    expect(acpStarts(await f.driver.requests())).toBe(1)
  })

  it('reads the other models\' levels after connecting, keeps them for the Devin version, and reads again after an update', async () => {
    await f.script({ plainModel: true })
    await f.host.connect()
    await expect.poll(() => model('fixture-plain')).toMatchObject({ reasoningEfforts: [], noReasoningEfforts: true })
    await expect.poll(async () => JSON.parse(await readFile(join(f.root, 'devin', 'thinking-levels.json'), 'utf8').catch(() => '{}')).models?.['fixture-plain'])
      .toEqual({ levels: [] })
    // Connecting again on the same version reads nothing: the saved levels are there at once.
    f = await f.driver.restart()
    const starts = acpStarts(await f.driver.requests())
    expect((await f.host.connect()).models.find(entry => entry.id === 'fixture-plain')).toMatchObject({ noReasoningEfforts: true })
    expect(acpStarts(await f.driver.requests())).toBe(starts + 1)
    // A new Devin version has its levels read again.
    await f.script({ plainModel: true, cliVersion: '3000.14.40000' })
    f = await f.driver.restart()
    const connected = await f.host.connect()
    expect(connected.models.find(entry => entry.id === 'fixture-plain')?.noReasoningEfforts).toBeUndefined()
    await expect.poll(() => model('fixture-plain')).toMatchObject({ noReasoningEfforts: true })
  })

  it('starts a thread on the chosen level before its first prompt, and says so', async () => {
    await f.host.connect(); await project()
    const id = await create('high')
    expect(await thread(id)).toMatchObject({ reasoningEffort: 'high' })
    expect(await send(id)).toEqual({ accepted: true })
    const records = await f.driver.requests()
    expect(levelsSet(records)).toEqual(['high'])
    const set = records.findIndex(record => record.params?.configId === 'thought_level')
    expect(set).toBeLessThan(records.findIndex(record => record.method === 'session/prompt'))
    // A thread with no level chosen runs at Devin's default and sets none.
    await create()
    expect(levelsSet(await f.driver.requests())).toEqual(['high'])
    await expect(create('max')).rejects.toThrow('That reasoning level is not supported by this model.')
  })

  it('changes a started thread\'s level in place while its model stays, and sets it again when the session reopens', async () => {
    await f.host.connect(); await project()
    const id = await create('high'); f.host.observeThreads([id])
    await send(id)
    await f.driver.completeTurn(id, 'Reply')
    await expect.poll(async () => (await thread(id)).status).toBe('idle')
    const changed = await configure(id, { reasoningEffort: 'low' })
    expect(changed.accepted).toBe(true)
    expect(changed.snapshot?.threads.find(entry => entry.id === id)).toMatchObject({ reasoningEffort: 'low' })
    expect(levelsSet(await f.driver.requests())).toEqual(['high', 'low'])
    await expect(configure(id, { reasoningEffort: 'max' })).rejects.toThrow('That reasoning level is not supported by this model.')
    await expect(configure(id, { modelId: 'fixture-plain' })).rejects.toThrow('Start a new thread to choose a model.')
    // Changed while its session is closed, the level is recorded and set on the session when it next opens.
    f = await f.driver.restart(); await f.host.connect()
    expect(await thread(id)).toMatchObject({ reasoningEffort: 'low' })
    expect((await configure(id, { reasoningEffort: 'medium' })).accepted).toBe(true)
    expect(await send(id)).toEqual({ accepted: true })
    const records = await f.driver.requests()
    expect(levelsSet(records).at(-1)).toBe('medium')
    expect(records.findLastIndex(record => record.params?.configId === 'thought_level')).toBeLessThan(records.findLastIndex(record => record.method === 'session/prompt'))
  })

  it('leaves the level as it was when Devin will not confirm it', async () => {
    await f.host.connect(); await project()
    const id = await create('high'); f.host.observeThreads([id])
    await send(id)
    await f.driver.completeTurn(id, 'Reply')
    await expect.poll(async () => (await thread(id)).status).toBe('idle')
    await f.script({ refuseThinking: true })
    await expect(configure(id, { reasoningEffort: 'low' })).rejects.toThrow()
    expect(await thread(id)).toMatchObject({ reasoningEffort: 'high' })
    expect(JSON.parse(await readFile(join(f.root, 'devin-threads.json'), 'utf8'))[id].reasoningEffort).toBe('high')
  })
})
