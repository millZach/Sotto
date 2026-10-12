// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
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
