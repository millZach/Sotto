// @vitest-environment node
import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { claudeFixture, storedClaudeOrigins } from '../fixtures/claudeFixture'

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

it('keeps live watches through a settings change the session takes in place, and drops them when it is replaced', async () => {
  const f = await fixture()
  await raw(f, started)
  await expect.poll(async () => (await thread(f)).monitoring?.length).toBe(1)
  expect((await f.host.execute({ type: 'configure-thread', commandId: 'configure', threadId: 'thread', runtimeMode: 'auto-accept-edits' })).accepted).toBe(true)
  expect((await thread(f)).monitoring).toHaveLength(1)
  // A refused change starts the CLI again, and the watch ends with the session that ran it.
  await f.liveSettings.refuse()
  expect((await f.host.execute({ type: 'configure-thread', commandId: 'configure-again', threadId: 'thread', runtimeMode: 'auto' })).accepted).toBe(true)
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

// Claude Code 2.1.283 answers a finished task with a turn of its own and sends no prompt for it: the turn opens a query
// and makes a model request the thread did not ask for, and its result says where the prompt came from instead of which
// prompt it was. Every turn opens its query the same way, one Sotto sent included.
const query = { type: 'system', subtype: 'init' }
const reporting = { type: 'system', subtype: 'status', status: 'requesting', uuid: '4b7c1c1e-5f3a-4b8e-9d51-2f0c0f6f9a11' }
const reported = { type: 'result', subtype: 'success', is_error: false, result: 'The review found nothing.', origin: { kind: 'task-notification' } }
const promptTurn = async (f: Awaited<ReturnType<typeof fixture>>) => (await thread(f)).activities?.find(activity => activity.kind === 'turn' && activity.turnId === 'prompt')?.status
async function prompted(f: Awaited<ReturnType<typeof fixture>>) {
  expect(await f.host.execute({ type: 'send', commandId: 'send', messageId: 'prompt', threadId: 'thread', text: 'Review the diff in the background.' })).toEqual({ accepted: true })
  await f.driver.backgroundWork!.completeLeaving('thread', 'Left an agent running.', 'Review the diff')
  await expect.poll(async () => (await thread(f)).status).toBe('idle')
  expect((await thread(f)).backgroundWork).toHaveLength(1)
  await f.driver.backgroundWork!.end('thread')
  await expect.poll(async () => (await thread(f)).backgroundWork ?? []).toEqual([])
  await f.action('thread', { type: 'raw-burst', frames: [query, reporting] })
  await expect.poll(async () => (await thread(f)).status).toBe('running')
}

it('shows the turn Claude Code starts on its own to report finished work as running until its result', async () => {
  const f = await fixture()
  await prompted(f)
  expect((await thread(f)).lastTurn).toEqual({ id: reporting.uuid, status: 'running' })
  await f.action('thread', { type: 'raw-burst', frames: [
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'report', role: 'assistant' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'The review found nothing.' } } },
    reported] })
  await expect.poll(async () => (await thread(f)).status).toBe('idle')
  expect((await thread(f)).lastTurn).toEqual({ id: reporting.uuid, status: 'completed' })
  await expect.poll(async () => (await thread(f)).messages.at(-1)?.text).toBe('The review found nothing.')
})

it('reads a model request outside any query as no turn', async () => {
  const f = await fixture()
  await f.driver.completeTurn('thread', 'Nothing to report.')
  await expect.poll(async () => (await thread(f)).messages.at(-1)?.text).toBe('Nothing to report.')
  // The agent after the request shows only once the request has been read.
  await f.action('thread', { type: 'raw-burst', frames: [reporting, agent] })
  await expect.poll(async () => (await thread(f)).backgroundWork?.length).toBe(1)
  expect((await thread(f)).status).toBe('idle')
})

it('goes straight on to a prompt that waited behind a turn Claude Code gave itself', async () => {
  const f = await fixture()
  // Claude Code holds a prompt that arrives as its own turn begins and hands it back once that turn's result is out.
  await writeFile(join(f.root, 'script.json'), JSON.stringify({ delay: 1000 }))
  const sent = f.host.execute({ type: 'send', commandId: 'send', messageId: 'prompt', threadId: 'thread', text: 'Anything new?' })
  await expect.poll(async () => (await thread(f)).status).toBe('running')
  const origin = (await storedClaudeOrigins(f.root, 'thread')).at(-1)!.uuid
  // The held prompt's own turn opens a query and makes a request before the prompt comes back; the agent marks them read.
  await f.action('thread', { type: 'raw-burst', frames: [reported, query, { ...reporting, uuid: '9d2e6a40-3c1b-4f7e-8a55-6b0e1f2d3c4a' }, agent] })
  await expect.poll(async () => (await thread(f)).backgroundWork?.length).toBe(1)
  expect((await thread(f)).status).toBe('running')
  expect(await sent).toEqual({ accepted: true })
  expect((await thread(f)).lastTurn).toEqual({ id: origin, status: 'running' })
  expect(await promptTurn(f)).toBe('running')
  await f.driver.completeTurn('thread', 'Nothing new.')
  await expect.poll(async () => promptTurn(f)).toBe('completed')
  expect((await thread(f)).lastTurn).toEqual({ id: origin, status: 'completed' })
})

it('stops a turn Claude Code started on its own without calling it a failure', async () => {
  const f = await fixture()
  await prompted(f)
  await writeFile(join(f.root, 'interrupt-script.json'), JSON.stringify({ error: true }))
  expect(await f.host.execute({ type: 'interrupt', commandId: 'stop', threadId: 'thread' })).toEqual({ accepted: true })
  // The agent after the interrupt's error result shows only once that result has been read.
  await raw(f, agent)
  await expect.poll(async () => (await thread(f)).backgroundWork?.length).toBe(1)
  expect((await thread(f)).status).toBe('idle')
  expect((await thread(f)).lastTurn).toEqual({ id: reporting.uuid, status: 'interrupted' })
  expect((await f.host.snapshot()).error).toBeUndefined()
  expect(await promptTurn(f)).toBe('completed')
})

// A shell left running in the background: stopping the CLI under it would stop the command too.
const command = { type: 'system', subtype: 'task_started', task_id: 'private-shell-task', task_type: 'local_bash', description: 'Run all CI gates', is_backgrounded: true }

it.each([['an agent', agent], ['a background command', command]])('holds a session with %s open while an ordinary idle session is reaped', async (_, work) => {
  const f = await fixture(true)
  await raw(f, work)
  await expect.poll(async () => (await thread(f)).backgroundWork?.length).toBe(1)
  await f.host.execute({ type: 'create-thread', commandId: 'idle-create', threadId: 'idle', projectId: f.projectId, title: 'Idle', modelId: f.modelId })
  await f.adapter.refreshThread('idle')
  await expect.poll(() => f.sessions!.stopped('idle')).toBe(true)
  expect(await f.sessions!.stopped('thread')).toBe(false)
  await raw(f, { type: 'system', subtype: 'task_notification', task_id: work.task_id, status: 'completed' })
  await expect.poll(async () => (await thread(f)).backgroundWork ?? []).toEqual([])
  await expect.poll(() => f.sessions!.stopped('thread')).toBe(true)
})

it('refuses to rewind, or to restart for a settings change, while background work runs, because either would end it', async () => {
  const f = await fixture()
  await raw(f, agent)
  await expect.poll(async () => (await thread(f)).backgroundWork?.length).toBe(1)
  // Only a change the running CLI refuses needs the restart that would end the work.
  await f.liveSettings.refuse()
  await expect(f.host.execute({ type: 'configure-thread', commandId: 'configure', threadId: 'thread', runtimeMode: 'auto-accept-edits' })).rejects.toThrow('"Review the diff" is still running for this thread. Nothing was changed. Wait for it to finish, or ask Claude to stop it, before')
  await expect(f.adapter.rollbackThread('thread', 1, ['first'])).rejects.toThrow('"Review the diff" is still running for this thread. Nothing was changed. Wait for it to finish, or ask Claude to stop it, before')
  expect((await thread(f)).backgroundWork).toHaveLength(1)
  expect((await thread(f)).runtimeMode).not.toBe('auto-accept-edits')
  await raw(f, { type: 'system', subtype: 'task_notification', task_id: agent.task_id, status: 'completed' })
  await expect.poll(async () => (await thread(f)).backgroundWork ?? []).toEqual([])
  expect((await f.host.execute({ type: 'configure-thread', commandId: 'configure-after', threadId: 'thread', runtimeMode: 'auto-accept-edits' })).accepted).toBe(true)
})
