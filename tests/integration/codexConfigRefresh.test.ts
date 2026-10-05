// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { codexFixture } from '../fixtures/codexFixture'

type Fixture = Awaited<ReturnType<typeof codexFixture>>
const fixtures: Fixture[] = []
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup() })
async function setup() {
  const f = await codexFixture(); fixtures.push(f)
  await mkdir(join(f.root, 'home'), { recursive: true })
  await writeFile(join(f.root, 'home', 'config.toml'), 'fixture = "before"')
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
  const id = randomUUID()
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Config refresh' })
  await f.host.refreshThread!(id)
  return { f, id }
}
const send = (f: Fixture, id: string, messageId = randomUUID()) => f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId, text: 'Check the desktop' })
const change = (f: Fixture) => writeFile(join(f.root, 'home', 'config.toml'), 'fixture = "desktop restarted with a different pipe"')
const steer = (f: Fixture, id: string, messageId = randomUUID()) => f.host.execute({ type: 'steer', threadId: id, commandId: randomUUID(), messageId, text: 'Check the desktop now' })

it('refreshes changed configuration before steering an active turn', async () => {
  const { f, id } = await setup()
  await send(f, id)
  const from = (await f.driver.requests()).length
  await change(f)
  await f.script({ requireFreshMcpConfig: true })
  await expect(steer(f, id)).resolves.toEqual({ accepted: true })
  const methods = (await f.driver.requests()).slice(from).map(r => r.method)
  expect(methods.indexOf('config/mcpServer/reload')).toBeGreaterThanOrEqual(0)
  expect(methods.indexOf('config/mcpServer/reload')).toBeLessThan(methods.indexOf('turn/steer'))
})

it('keeps a rejected steering refresh prompt unsent and retryable', async () => {
  const { f, id } = await setup()
  await send(f, id)
  await change(f)
  await f.script({ reject: 'config/mcpServer/reload' })
  const messageId = randomUUID()
  await expect(steer(f, id, messageId)).rejects.toThrow('Nothing was sent')
  expect((await f.driver.requests()).filter(r => r.method === 'turn/steer')).toHaveLength(0)
  await expect(steer(f, id, messageId)).resolves.toEqual({ accepted: true })
  expect((await f.driver.requests()).filter(r => r.method === 'config/mcpServer/reload')).toHaveLength(2)
})

it('refuses steering when the active turn ends while refresh waits', async () => {
  const { f, id } = await setup()
  await send(f, id)
  await change(f)
  await f.script({ holdReply: 'config/mcpServer/reload' })
  const steering = steer(f, id)
  const outcome = expect(steering).rejects.toThrow('active Codex turn changed')
  await expect.poll(async () => (await f.driver.requests()).some(r => r.method === 'config/mcpServer/reload')).toBe(true)
  await f.driver.completeTurn(id, 'Finished before steer')
  await expect.poll(async () => (await f.host.snapshot()).threads.find(t => t.id === id)?.status).toBe('idle')
  await f.action(id, { type: 'release-reply', method: 'config/mcpServer/reload' })
  await outcome
  expect((await f.driver.requests()).filter(r => r.method === 'turn/steer')).toHaveLength(0)
  await expect(send(f, id)).resolves.toEqual({ accepted: true })
})

it('refreshes a loaded thread before sending after global config changes', async () => {
  const { f, id } = await setup()
  const from = (await f.driver.requests()).length
  await f.script({ requireFreshMcpConfig: true })
  await change(f)
  await expect(send(f, id)).resolves.toEqual({ accepted: true })
  const methods = (await f.driver.requests()).slice(from).map(r => r.method)
  expect(methods).toContain('config/mcpServer/reload')
  expect(methods.indexOf('config/mcpServer/reload')).toBeLessThan(methods.indexOf('turn/start'))
  expect((await f.driver.requests()).find(r => r.method === 'config/mcpServer/reload')?.params).toBeUndefined()
})

it('keeps a rejected refresh prompt unsent and retryable', async () => {
  const { f, id } = await setup()
  await change(f)
  await f.script({ reject: 'config/mcpServer/reload' })
  const messageId = randomUUID()
  await expect(send(f, id, messageId)).rejects.toThrow()
  expect((await f.driver.requests()).filter(r => r.method === 'turn/start')).toHaveLength(0)
  await expect(send(f, id, messageId)).resolves.toEqual({ accepted: true })
  expect((await f.driver.requests()).filter(r => r.method === 'config/mcpServer/reload')).toHaveLength(2)
})

it('does not reload unchanged config on a later turn', async () => {
  const { f, id } = await setup()
  await change(f)
  await send(f, id)
  await f.driver.completeTurn(id, 'Done')
  await expect.poll(async () => (await f.host.snapshot()).threads.find(t => t.id === id)?.status).toBe('idle')
  await send(f, id)
  expect((await f.driver.requests()).filter(r => r.method === 'config/mcpServer/reload')).toHaveLength(1)
})

it('does not reload when config has not changed', async () => {
  const { f, id } = await setup()
  await send(f, id)
  expect((await f.driver.requests()).filter(r => r.method === 'config/mcpServer/reload')).toHaveLength(0)
})

it('does not queue a second prompt while its runtime refresh is pending', async () => {
  const { f, id } = await setup()
  await change(f)
  await f.script({ holdReply: 'config/mcpServer/reload' })
  const sending = send(f, id)
  await expect.poll(async () => (await f.driver.requests()).some(r => r.method === 'config/mcpServer/reload')).toBe(true)
  await expect(send(f, id)).rejects.toThrow('already running a turn')
  await f.action(id, { type: 'release-reply', method: 'config/mcpServer/reload' })
  await expect(sending).resolves.toEqual({ accepted: true })
  expect((await f.driver.requests()).filter(r => r.method === 'config/mcpServer/reload')).toHaveLength(1)
  expect((await f.driver.requests()).filter(r => r.method === 'turn/start')).toHaveLength(1)
})

it.each([
  { code: -32601, message: 'Method not found' },
  { code: -32600, message: 'Invalid request: unknown variant `config/mcpServer/reload`, expected `initialize`' },
])('keeps ordinary sends available when an older runtime does not support reload ($code)', async rejection => {
  const { f, id } = await setup()
  await change(f)
  await f.script({ reject: 'config/mcpServer/reload', rejection })
  await expect(send(f, id)).resolves.toEqual({ accepted: true })
  await f.driver.completeTurn(id, 'Done')
  await expect.poll(async () => (await f.host.snapshot()).threads.find(t => t.id === id)?.status).toBe('idle')
  await send(f, id)
  expect((await f.driver.requests()).filter(r => r.method === 'config/mcpServer/reload')).toHaveLength(1)
})

it('leaves a prompt retryable when the connection closes during reload', async () => {
  const { f, id } = await setup()
  await change(f)
  await f.script({ holdReply: 'config/mcpServer/reload' })
  const sending = send(f, id)
  const outcome = expect(sending).rejects.toThrow('Nothing was sent')
  await expect.poll(async () => (await f.driver.requests()).some(r => r.method === 'config/mcpServer/reload')).toBe(true)
  f.host.disconnect()
  await outcome
  expect((await f.driver.requests()).filter(r => r.method === 'turn/start')).toHaveLength(0)
  await f.host.connect()
  await expect(send(f, id)).resolves.toEqual({ accepted: true })
})

it('refreshes each runtime independently while another thread can answer and stop', async () => {
  const { f, id } = await setup()
  const other = randomUUID()
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: other, projectId: f.projectId, modelId: f.modelId, title: 'Working thread' })
  await send(f, other)
  await f.driver.raisePermission(other, 'Run a command')
  await expect.poll(async () => (await f.host.snapshot()).threads.find(t => t.id === other)?.requests.length).toBe(1)
  await change(f)
  await f.script({ holdReply: 'config/mcpServer/reload' })
  const sending = send(f, id)
  await expect.poll(async () => (await f.driver.requests()).some(r => r.method === 'config/mcpServer/reload')).toBe(true)
  const request = (await f.host.snapshot()).threads.find(t => t.id === other)!.requests[0]!
  await expect(f.host.execute({ type: 'answer', commandId: randomUUID(), threadId: other, requestId: request.id, answer: 'Allow', approved: true })).resolves.toEqual({ accepted: true })
  await expect(f.host.execute({ type: 'interrupt', commandId: randomUUID(), threadId: other })).resolves.toEqual({ accepted: true })
  const released = await f.action(id, { type: 'release-reply', method: 'config/mcpServer/reload' })
  await expect.poll(() => f.acted(released)).toBe(true)
  await expect(sending).resolves.toEqual({ accepted: true })
  await send(f, other)
  expect((await f.driver.requests()).filter(r => r.method === 'config/mcpServer/reload')).toHaveLength(2)
})
