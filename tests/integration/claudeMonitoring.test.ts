// @vitest-environment node
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { claudeFixture } from '../fixtures/claudeFixture'

const fixtures: Awaited<ReturnType<typeof claudeFixture>>[] = []
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup() })
async function fixture(reaper = false) {
  const f = await claudeFixture(undefined, 15_000, undefined, reaper ? { reaperSweepMs: 20, sessionIdleMs: 150 } : {})
  fixtures.push(f)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: 'project', projectId: f.projectId, title: 'Monitoring', path: f.root })
  await f.host.execute({ type: 'create-thread', commandId: 'create', threadId: 'thread', projectId: f.projectId, title: 'Monitoring', modelId: f.modelId })
  await f.adapter.refreshThread('thread')
  return f
}
const started = { type: 'system', subtype: 'task_started', task_id: 'private-monitor-task', task_type: 'monitor', description: 'Watch the build' }
const thread = async (f: Awaited<ReturnType<typeof fixture>>) => (await f.host.snapshot()).threads.find(value => value.id === 'thread')!
async function raw(f: Awaited<ReturnType<typeof fixture>>, frame: Record<string, unknown>, persist = false) {
  await f.action('thread', { type: 'raw', frame, persist })
}

it('publishes a native live watch, keeps it through foreground completion, and clears on type-free end', async () => {
  const f = await fixture()
  await raw(f, started)
  await expect.poll(async () => (await thread(f)).monitoring?.length).toBe(1)
  const id = (await thread(f)).monitoring![0]!.id
  expect(id).not.toContain(started.task_id)
  expect((await thread(f)).activities?.some(row => row.kind === 'subagent')).toBeFalsy()
  await f.driver.completeTurn('thread', 'Watching the background build.')
  await expect.poll(async () => (await thread(f)).messages.at(-1)?.text).toBe('Watching the background build.')
  expect((await thread(f)).monitoring?.[0]?.id).toBe(id)
  await raw(f, { type: 'system', subtype: 'task_updated', task_id: started.task_id, patch: { status: 'paused' } })
  await expect.poll(async () => (await thread(f)).monitoring ?? []).toEqual([])
  await raw(f, { type: 'system', subtype: 'task_updated', task_id: started.task_id, patch: { status: 'running' } })
  await expect.poll(async () => (await thread(f)).monitoring?.length).toBe(1)
  await raw(f, { type: 'system', subtype: 'task_notification', task_id: started.task_id, status: 'completed' })
  await expect.poll(async () => (await thread(f)).monitoring ?? []).toEqual([])
})

it('clears an interrupted watch and ignores saved monitor starts after reconnect', async () => {
  const f = await fixture()
  await raw(f, started, true)
  await expect.poll(async () => (await thread(f)).monitoring?.length).toBe(1)
  expect(await f.host.execute({ type: 'interrupt', commandId: 'stop', threadId: 'thread' })).toEqual({ accepted: true })
  expect((await thread(f)).monitoring ?? []).toEqual([])
  await raw(f, { ...started, task_id: 'second' }, true)
  await expect.poll(async () => (await thread(f)).monitoring?.length).toBe(1)
  // A delivered fixture action must be consumed, or a resumed CLI would replay it as live.
  await expect(access(join(f.root, 'control-' + await f.realId('thread') + '.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  f.host.disconnect()
  expect((await thread(f)).monitoring ?? []).toEqual([])
  await f.adapter.closed()
  await f.host.connect()
  await f.adapter.refreshThread('thread')
  expect((await thread(f)).monitoring ?? []).toEqual([])
})

it('holds an unwatched monitoring session open while an ordinary idle session is reaped', async () => {
  const f = await fixture(true)
  await raw(f, started)
  await expect.poll(async () => (await thread(f)).monitoring?.length).toBe(1)
  await f.host.execute({ type: 'create-thread', commandId: 'idle-create', threadId: 'idle', projectId: f.projectId, title: 'Idle', modelId: f.modelId })
  await f.adapter.refreshThread('idle')
  await expect.poll(() => f.sessions!.stopped('idle')).toBe(true)
  expect(await f.sessions!.stopped('thread')).toBe(false)
  expect((await thread(f)).monitoring).toHaveLength(1)
  await raw(f, { type: 'system', subtype: 'task_notification', task_id: started.task_id, status: 'completed' })
  await expect.poll(() => f.sessions!.stopped('thread')).toBe(true)
})

it('hides monitoring on native process exit', async () => {
  const f = await fixture()
  await raw(f, started)
  await expect.poll(async () => (await thread(f)).monitoring?.length).toBe(1)
  await f.action('thread', { type: 'exit' })
  await expect.poll(async () => (await thread(f)).status).toBe('error')
  expect((await thread(f)).monitoring ?? []).toEqual([])
})

it('drops live watches when changing settings replaces the native session', async () => {
  const f = await fixture()
  await raw(f, started)
  await expect.poll(async () => (await thread(f)).monitoring?.length).toBe(1)
  expect(await f.host.execute({ type: 'configure-thread', commandId: 'configure', threadId: 'thread', runtimeMode: 'auto-accept-edits' })).toEqual({ accepted: true })
  expect((await thread(f)).monitoring ?? []).toEqual([])
})

const agent = { type: 'system', subtype: 'task_started', task_id: 'private-agent-task', task_type: 'local_agent', description: 'Review the diff', is_backgrounded: true, spawn_depth: 1 }

it('keeps background work through the turn result and clears it on interrupt, an error result and disconnect', async () => {
  const f = await fixture()
  await raw(f, agent)
  await expect.poll(async () => (await thread(f)).backgroundWork?.length).toBe(1)
  expect((await thread(f)).backgroundWork![0]!.id).not.toContain(agent.task_id)
  await f.driver.completeTurn('thread', 'Left an agent running.')
  await expect.poll(async () => (await thread(f)).messages.at(-1)?.text).toBe('Left an agent running.')
  expect((await thread(f)).backgroundWork).toHaveLength(1)
  expect(await f.host.execute({ type: 'interrupt', commandId: 'stop', threadId: 'thread' })).toEqual({ accepted: true })
  expect((await thread(f)).backgroundWork ?? []).toEqual([])

  await raw(f, { ...agent, task_id: 'second' })
  await expect.poll(async () => (await thread(f)).backgroundWork?.length).toBe(1)
  await raw(f, { type: 'result', subtype: 'error_during_execution', is_error: true, result: '' })
  await expect.poll(async () => (await thread(f)).backgroundWork ?? []).toEqual([])

  await raw(f, { ...agent, task_id: 'third' }, true)
  await expect.poll(async () => (await thread(f)).backgroundWork?.length).toBe(1)
  f.host.disconnect()
  expect((await thread(f)).backgroundWork ?? []).toEqual([])
  await f.adapter.closed()
  await f.host.connect()
  await f.adapter.refreshThread('thread')
  expect((await thread(f)).backgroundWork ?? []).toEqual([])
})

it('holds a session with background work open while an ordinary idle session is reaped', async () => {
  const f = await fixture(true)
  await raw(f, agent)
  await expect.poll(async () => (await thread(f)).backgroundWork?.length).toBe(1)
  await f.host.execute({ type: 'create-thread', commandId: 'idle-create', threadId: 'idle', projectId: f.projectId, title: 'Idle', modelId: f.modelId })
  await f.adapter.refreshThread('idle')
  await expect.poll(() => f.sessions!.stopped('idle')).toBe(true)
  expect(await f.sessions!.stopped('thread')).toBe(false)
  await raw(f, { type: 'system', subtype: 'task_notification', task_id: agent.task_id, status: 'completed' })
  await expect.poll(async () => (await thread(f)).backgroundWork ?? []).toEqual([])
  await expect.poll(() => f.sessions!.stopped('thread')).toBe(true)
})
