// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { heldOperation } from '../fixtures/deferred'
import { describeAdapterContract } from './adapterContract'
import { grokFixture, grokFixtureSkips } from '../fixtures/fakeGrokThreadFixture'
describeAdapterContract('Grok ACP', session => grokFixture(undefined, undefined, undefined, session), grokFixtureSkips)

// Grok lists its levels highest first, and its `_meta.reasoningEffort` is the level the session is on
// now rather than its default. Both reached the slider as reported before the adapter normalised them.
it("lists Grok's effort levels lowest first, points the default at Grok's own, and sends the chosen id verbatim", async () => {
  const f = await grokFixture()
  try {
    await f.script({ catalog: { currentModelId: 'fixture-model', availableModels: [{ modelId: 'fixture-model', name: 'Fixture Grok', _meta: { supportsReasoningEffort: true, reasoningEffort: 'medium',
      reasoningEfforts: [{ id: 'xhigh', value: 'xhigh' }, { id: 'high', value: 'high', default: true }, { id: 'medium', value: 'medium' }, { id: 'low', value: 'low' }, { id: 'high', value: 'high' }] } }] } })
    const snapshot = await f.host.connect()
    expect(snapshot.models[0]).toMatchObject({ reasoningEfforts: ['low', 'medium', 'high', 'xhigh'], defaultReasoningEffort: 'high' })
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    const id = randomUUID()
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Test', reasoningEffort: 'xhigh' })
    const setModel = (await f.driver.requests()).filter(request => request.method === 'session/set_model')
    expect(setModel.map(request => request.params)).toEqual([{ sessionId: await f.realId(id), modelId: 'fixture-model', _meta: { reasoningEffort: 'xhigh' } }])
    expect((await f.host.snapshot()).threads.find(thread => thread.id === id)).toMatchObject({ reasoningEffort: 'xhigh' })
  } finally { await f.cleanup() }
})

// Not every create names a level: the Agents view's new-thread form and a coordinator dispatch send none.
// Grok would then run at the level in the user's own Grok settings while the chip showed the default.
it("starts a Grok thread created without a level on the model's default, and tells Grok so", async () => {
  const f = await grokFixture()
  try {
    await f.script({ catalog: { currentModelId: 'fixture-model', availableModels: [{ modelId: 'fixture-model', name: 'Fixture Grok', _meta: { supportsReasoningEffort: true, reasoningEffort: 'medium',
      reasoningEfforts: [{ id: 'xhigh', value: 'xhigh' }, { id: 'high', value: 'high', default: true }, { id: 'medium', value: 'medium' }, { id: 'low', value: 'low' }] } }] } })
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    const id = randomUUID()
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Test' })
    const setModel = (await f.driver.requests()).filter(request => request.method === 'session/set_model')
    expect(setModel.map(request => request.params)).toEqual([{ sessionId: await f.realId(id), modelId: 'fixture-model', _meta: { reasoningEffort: 'high' } }])
    expect((await f.host.snapshot()).threads.find(thread => thread.id === id)).toMatchObject({ reasoningEffort: 'high' })
  } finally { await f.cleanup() }
})


it('a machine Stop losing its final fence preserves a user prompt still preparing on Grok', async () => {
  const f = await grokFixture(undefined, 10_000), gate = heldOperation()
  let spy: { mockRestore(): void } | undefined
  try {
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    const id = randomUUID()
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Test' })
    const native = f.adapter as unknown as { activePrompts: Set<string>; threadProcess(id: string): Promise<unknown> }
    const original = native.threadProcess.bind(native)
    spy = vi.spyOn(native, 'threadProcess').mockImplementation(async threadId => { const entry = await original(threadId); await gate.wait(); return entry })
    native.activePrompts.add(id)
    let stopAllowed = true
    const stopped = f.adapter.executeFromWatcher({ type: 'interrupt', commandId: randomUUID(), threadId: id }, () => { if (!stopAllowed) throw new Error('Synthetic final takeover fence') })
    await gate.entered
    stopAllowed = false; gate.release()
    await expect(stopped).rejects.toThrow('Synthetic final takeover fence')
    expect(native.activePrompts.has(id)).toBe(true)
    expect((await f.driver.requests()).some(item => item.method === 'session/cancel')).toBe(false)
  } finally { gate.release(); spy?.mockRestore(); await f.cleanup() }
})

// #2633: Grok Build runs a subagent in the background past its turn, on frames read from Grok 1.0.77 live.
describe('Grok background work', () => {
  const open = async () => {
    const f = await grokFixture()
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    const id = randomUUID()
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Grok thread' })
    f.host.observeThreads?.([id])
    expect(await f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm1', text: 'Draw the car in the background' })).toEqual({ accepted: true })
    const thread = async () => (await f.host.snapshot()).threads.find(item => item.id === id)!
    return { f, id, thread }
  }

  it('holds a finished subagent that wakes Grok until the turn Grok starts to report it has ended', async () => {
    const { f, id, thread } = await open()
    try {
      await f.action(id, { type: 'background-agent', text: 'Started it in the background.', description: 'GT3 RS drawing' })
      await expect.poll(async () => (await thread()).backgroundWork?.map(work => [work.label, work.type])).toEqual([['GT3 RS drawing', 'subagent']])
      expect((await thread()).status).toBe('idle')
      await f.action(id, { type: 'background-agent-end', wake: true })
      await expect.poll(async () => (await thread()).activities?.find(row => row.kind === 'subagent')?.status).toBe('completed')
      expect((await thread()).backgroundWork).toHaveLength(1)
      await f.action(id, { type: 'wake-turn', text: 'The drawing is done.' })
      await expect.poll(async () => (await thread()).backgroundWork).toBeUndefined()
    } finally { await f.cleanup() }
  })

  it('keeps a subagent that outlived its turn through a follow-up, and holds a woken one only for its own report', async () => {
    const { f, id, thread } = await open()
    try {
      await f.action(id, { type: 'background-agent', text: 'Started it in the background.', description: 'GT3 RS drawing' })
      await expect.poll(async () => (await thread()).backgroundWork?.length).toBe(1)
      // A follow-up turn starts and ends: the subagent that outlived the first turn stays background work through it.
      await f.action(id, { type: 'takeover', text: 'Also the side view.' })
      await expect.poll(async () => (await thread()).status).toBe('running')
      expect((await thread()).backgroundWork?.map(work => work.label)).toEqual(['GT3 RS drawing'])
      await f.action(id, { type: 'background-agent-end', wake: true })
      await expect.poll(async () => (await thread()).activities?.find(row => row.kind === 'subagent')?.status).toBe('completed')
      // Another turn's end is not the report Grok woke for.
      await f.action(id, { type: 'complete', text: 'Side view done.' })
      await expect.poll(async () => (await thread()).status).toBe('idle')
      expect((await thread()).backgroundWork?.map(work => work.label)).toEqual(['GT3 RS drawing'])
      await f.action(id, { type: 'wake-turn', text: 'The drawing is done.' })
      await expect.poll(async () => (await thread()).backgroundWork).toBeUndefined()
    } finally { await f.cleanup() }
  })

  it('refuses a permission change while background work runs, since the reload would end it', async () => {
    const { f, id, thread } = await open()
    try {
      await f.action(id, { type: 'background-agent', text: 'Started it in the background.', description: 'GT3 RS drawing' })
      await expect.poll(async () => (await thread()).backgroundWork?.length).toBe(1)
      await expect(f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, runtimeMode: 'full-access' })).rejects.toThrow('background work still running')
      expect((await thread()).backgroundWork).toHaveLength(1)
    } finally { await f.cleanup() }
  })

  it('counts the thread’s own running background shells as commands, and never a subagent’s own subagent', async () => {
    const { f, id, thread } = await open()
    try {
      await f.action(id, { type: 'background-agent', text: 'Started.', description: 'Outer', subagentId: 'outer' })
      await expect.poll(async () => (await thread()).backgroundWork?.length).toBe(1)
      await f.action(id, { type: 'background-agent', description: 'Inner', subagentId: 'inner', parent: 'outer' })
      await expect.poll(async () => (await thread()).activities?.filter(row => row.kind === 'subagent').length).toBe(2)
      await f.action(id, { type: 'shells', tasks: [{ task_id: 'call-1', command: 'npm run render', description: 'Render the turntable', kind: 'bash', status: 'running', started_at: '2026-11-16T02:25:20.147194701+00:00' },
        { task_id: 'call-0', command: 'ls', kind: 'bash', status: 'completed' }] })
      await expect.poll(async () => (await thread()).backgroundWork?.map(work => [work.label, work.type])).toEqual([['Outer', 'subagent'], ['Render the turntable', 'command']])
      await f.action(id, { type: 'shells', tasks: [{ task_id: 'call-1', command: 'npm run render', kind: 'bash', status: 'completed' }] })
      await expect.poll(async () => (await thread()).backgroundWork?.map(work => work.type)).toEqual(['subagent'])
    } finally { await f.cleanup() }
  })

  it('lets a background subagent go with a lost Grok process, so nothing counts it as working any more', async () => {
    const { f, id, thread } = await open()
    try {
      await f.action(id, { type: 'background-agent', text: 'Started it in the background.', description: 'GT3 RS drawing' })
      await expect.poll(async () => (await thread()).backgroundWork?.length).toBe(1)
      await f.action(id, { type: 'background-agent', description: 'Measure the wheelbase', subagentId: 'inner', parent: 'native-background-agent' })
      await expect.poll(async () => (await thread()).activities?.filter(row => row.kind === 'subagent').length).toBe(2)
      const started = (await f.driver.requests()).filter(record => record.method === 'fixture/process') as unknown as { params: { pid: number } }[]
      process.kill(started.at(-1)!.params.pid, 'SIGKILL')
      await expect.poll(async () => (await thread()).backgroundWork).toBeUndefined()
      // The subagent's own subagent ran in the same process and ended with it too.
      expect((await thread()).activities?.filter(row => row.kind === 'subagent').map(row => [row.status, row.agents?.[0]?.status])).toEqual([['unknown', 'interrupted'], ['unknown', 'interrupted']])
    } finally { await f.cleanup() }
  })
})
