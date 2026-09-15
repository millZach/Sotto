// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { AgentRuntimeMode } from '../../src/shared/agents'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'
let f: Awaited<ReturnType<typeof grokFixture>> | undefined
afterEach(async () => { await f?.cleanup(); f = undefined })

const policy = { 'approval-required': { yoloMode: false, autoMode: false }, auto: { yoloMode: false, autoMode: true }, 'full-access': { yoloMode: true, autoMode: false } } as const
const nativeMode = { 'approval-required': 'default', auto: 'auto', 'full-access': 'bypassPermissions' } as const
async function setup(runtimeMode?: AgentRuntimeMode) {
  f = await grokFixture(); await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
  const id = randomUUID()
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Test', ...(runtimeMode ? { runtimeMode } : {}) })
  return id
}
const aliases = async () => JSON.parse(await readFile(join(f!.root, 'grok-threads.json'), 'utf8')) as Record<string, Record<string, unknown>>
const effective = async (id: string) => JSON.parse(await readFile(join(f!.root, 'native-sessions.json'), 'utf8'))[await f!.realId(id)].permissionMode as string
const sessionRequests = async (method: string, id: string) => (await f!.driver.requests()).filter(request => request.method === method && (request.params as { sessionId?: string } | undefined)?.sessionId === id)
const configure = (id: string, runtimeMode: AgentRuntimeMode) => f!.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, runtimeMode })

it('advertises only the Grok permission modes it can apply per session', async () => {
  f = await grokFixture(); const snapshot = await f.host.connect()
  expect(snapshot.models[0]!.runtimeModes).toEqual(['approval-required', 'auto', 'full-access'])
  expect(snapshot.capabilities).toMatchObject({ configureThread: true, configureThreadModel: false })
})

it.each([undefined, 'approval-required', 'auto', 'full-access'] as const)('creates and resumes a %s thread with the matching native session policy', async runtimeMode => {
  const id = await setup(runtimeMode); const mode = runtimeMode ?? 'approval-required'
  const created = (await f!.driver.requests()).find(request => request.method === 'session/new')!
  expect((created.params as { _meta: unknown })._meta).toEqual(policy[mode])
  expect(await effective(id)).toBe(nativeMode[mode])
  expect((await f!.host.snapshot()).threads[0]).toMatchObject({ runtimeMode: mode, status: 'idle' })
  if (runtimeMode) expect((await aliases())[id]).toMatchObject({ runtimeMode })
  else expect((await aliases())[id]).not.toHaveProperty('runtimeMode')
  const nativeId = await f!.realId(id)
  f = await f!.driver.restart(); const resumed = await f.host.connect()
  const loads = await sessionRequests('session/load', nativeId)
  expect(loads.length).toBeGreaterThan(0)
  for (const load of loads) expect((load.params as { _meta: unknown })._meta).toEqual(policy[mode])
  expect(await effective(id)).toBe(nativeMode[mode])
  expect(resumed.threads[0]).toMatchObject({ runtimeMode: mode, status: 'idle' })
})

it('rejects a permission mode Grok cannot apply before creating a native session', async () => {
  f = await grokFixture(); await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
  await expect(f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: randomUUID(), projectId: f.projectId, modelId: f.modelId, title: 'Edits', runtimeMode: 'auto-accept-edits' })).rejects.toThrow('permission mode')
  expect((await f.driver.requests()).some(request => request.method === 'session/new')).toBe(false)
})

it('changes an existing thread permission mode by closing and reloading its native session', async () => {
  const id = await setup(); const nativeId = await f!.realId(id)
  expect(await configure(id, 'full-access')).toEqual({ accepted: true })
  let methods: (string | undefined)[] = (await f!.driver.requests()).map(request => request.method).filter(method => method === '_x.ai/session/close' || method === 'session/load')
  expect(methods.slice(-2)).toEqual(['_x.ai/session/close', 'session/load'])
  expect(((await sessionRequests('session/load', nativeId)).at(-1)!.params as { _meta: unknown })._meta).toEqual(policy['full-access'])
  expect(await effective(id)).toBe('bypassPermissions')
  expect((await f!.host.snapshot()).threads[0]).toMatchObject({ runtimeMode: 'full-access', status: 'idle' })
  expect((await aliases())[id]).toMatchObject({ runtimeMode: 'full-access' })
  expect((await aliases())[id]).not.toHaveProperty('pendingRuntimeMode')
  // A resident Grok session cannot be downgraded by reloading alone; the close is load-bearing.
  expect(await configure(id, 'approval-required')).toEqual({ accepted: true })
  expect(await effective(id)).toBe('default')
  expect(await configure(id, 'auto')).toEqual({ accepted: true })
  expect(await effective(id)).toBe('auto')
  methods = (await f!.driver.requests()).map(request => request.method)
  expect(methods.filter(method => method === '_x.ai/session/close')).toHaveLength(3)
  f = await f!.driver.restart(); const resumed = await f.host.connect()
  expect(((await sessionRequests('session/load', nativeId)).at(-1)!.params as { _meta: unknown })._meta).toEqual(policy.auto)
  expect(resumed.threads[0]).toMatchObject({ runtimeMode: 'auto', status: 'idle' })
  expect(await f.host.execute({ type: 'send', commandId: 'after-mode', threadId: id, messageId: 'after-mode', text: 'Synthetic prompt' })).toEqual({ accepted: true })
})

it('keeps an unchanged permission mode without touching the native session', async () => {
  const id = await setup('auto')
  expect(await configure(id, 'auto')).toEqual({ accepted: true })
  expect((await f!.driver.requests()).some(request => request.method === '_x.ai/session/close')).toBe(false)
})

it('rejects unsupported thread setting changes without touching the native session', async () => {
  const id = await setup()
  await expect(f!.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, modelId: 'other-model' })).rejects.toThrow('Only the permission mode')
  await expect(f!.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, reasoningEffort: 'low' })).rejects.toThrow('Only the permission mode')
  await expect(configure(id, 'auto-accept-edits')).rejects.toThrow('permission mode')
  expect(await f!.host.execute({ type: 'send', commandId: 'busy', threadId: id, messageId: 'busy', text: 'Synthetic prompt' })).toEqual({ accepted: true })
  await expect(configure(id, 'full-access')).rejects.toThrow('Wait for')
  await f!.driver.completeTurn(id, 'Done')
  await expect.poll(async () => (await f!.host.snapshot()).threads[0]!.status).toBe('idle')
  await f!.driver.raisePermission(id, 'Run a tool?')
  await expect.poll(async () => (await f!.host.snapshot()).threads[0]!.requests.length).toBe(1)
  await expect(configure(id, 'full-access')).rejects.toThrow('Wait for')
  expect((await f!.driver.requests()).some(request => request.method === '_x.ai/session/close')).toBe(false)
  expect(await effective(id)).toBe('default')
})

it('blocks sends after an unconfirmed mode change and applies the pending mode on reconnect', async () => {
  const id = await setup('full-access'); const nativeId = await f!.realId(id)
  await f!.script({ rejectLoad: true })
  await expect(configure(id, 'approval-required')).rejects.toThrow()
  expect((await aliases())[id]).toMatchObject({ runtimeMode: 'full-access', pendingRuntimeMode: 'approval-required' })
  expect((await f!.host.snapshot()).threads[0]).toMatchObject({ status: 'error' })
  await expect(f!.host.execute({ type: 'send', commandId: 'blocked', threadId: id, messageId: 'blocked', text: 'Synthetic prompt' })).rejects.toThrow('permission mode')
  await f!.script({})
  f = await f!.driver.restart(); const resumed = await f.host.connect()
  expect(((await sessionRequests('session/load', nativeId)).at(-1)!.params as { _meta: unknown })._meta).toEqual(policy['approval-required'])
  expect(await effective(id)).toBe('default')
  expect(resumed.threads[0]).toMatchObject({ runtimeMode: 'approval-required', status: 'idle' })
  expect((await aliases())[id]).not.toHaveProperty('pendingRuntimeMode')
  expect(await f.host.execute({ type: 'send', commandId: 'allowed', threadId: id, messageId: 'allowed', text: 'Synthetic prompt' })).toEqual({ accepted: true })
})
