// @vitest-environment node
// Claude thread settings over the control channel (#317): what the shared contract cannot say about a model
// and its effort travelling together, a change the CLI takes only in part, and the coordinator's saved intent.
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { AgentControl } from '../../src/main/agents/control'
import { AgentCredentials } from '../../src/main/agents/credentials'
import type { ClaudeSettingsEvent } from '../../src/main/agents/claude'
import { claudeFixture } from '../fixtures/claudeFixture'
import { immediatePublishScheduler } from '../fixtures/publishScheduler'

type Fixture = Awaited<ReturnType<typeof claudeFixture>>
const fixtures: Fixture[] = []
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup() })
const models = [
  { value: 'fixture-model', displayName: 'Fixture Claude', supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
  { value: 'fixture-large', displayName: 'Fixture Claude Large', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
]
const settingsRequests = new Set(['set_model', 'apply_flag_settings', 'set_permission_mode'])

/** A connected fixture with two models and one thread on `fixture-model` at low effort; `start` runs its CLI. */
async function fixture(start = true): Promise<{ f: Fixture; id: string; events: ClaudeSettingsEvent[] }> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-claude-'))
  await writeFile(join(root, 'models.json'), JSON.stringify(models))
  const events: ClaudeSettingsEvent[] = []
  const f = await claudeFixture(root, undefined, undefined, { logEvent: event => events.push(event) })
  fixtures.push(f)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Settings', path: f.root })
  const id = randomUUID()
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: 'Settings', modelId: 'fixture-model', reasoningEffort: 'low' })
  if (!start) {
    // The same saved thread under a fresh adapter that has not started its CLI, as after the reaper stopped it.
    const next = await f.driver.restart() as Fixture
    fixtures.splice(fixtures.indexOf(f), 1, next)
    await next.host.connect()
    return { f: next, id, events }
  }
  f.host.observeThreads?.([id])
  await f.adapter.refreshThread(id)
  return { f, id, events }
}
const thread = async (f: Fixture, id: string) => (await f.host.snapshot()).threads.find(value => value.id === id)!
const sent = async (f: Fixture) => (await f.driver.requests()).flatMap(record => settingsRequests.has(record.method ?? '') ? [record.method] : [])
const launches = async (f: Fixture) => (await f.driver.requests()).filter(record => record.method === 'launch' || record.method === 'resume').length

it('changes the model with the new model\'s own default effort in one operation on the running CLI, as Codex does', async () => {
  const { f, id, events } = await fixture()
  const started = await launches(f)
  // Claude Code reports no default level for a model, so a model change that names no level leaves none: the
  // CLI is told to clear the old model's level and runs the new model's own default, and a later start passes no --effort.
  const result = await f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, modelId: 'fixture-large' })
  expect(result.accepted).toBe(true)
  expect(result.snapshot?.threads.find(value => value.id === id)).toMatchObject({ modelId: 'fixture-large' })
  expect(result.snapshot?.threads.find(value => value.id === id)?.reasoningEffort).toBeUndefined()
  expect(await sent(f)).toEqual(['set_model', 'apply_flag_settings'])
  expect((await f.driver.requests()).findLast(record => record.method === 'apply_flag_settings')?.params?.frame).toMatchObject({ request: { settings: { effortLevel: null } } })
  const effective = await f.liveSettings.effective(id)
  expect(effective.modelId).toBe('fixture-large')
  expect(effective.reasoningEffort).toBeUndefined()
  expect(await launches(f)).toBe(started)
  // A named level is checked against the model the change leaves the thread on, not the one it has: `medium` is
  // offered by fixture-large alone, so it is refused with fixture-model and nothing is sent.
  await expect(f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, modelId: 'fixture-model', reasoningEffort: 'medium' }))
    .rejects.toThrow('That reasoning level is not supported by this model.')
  expect(await sent(f)).toEqual(['set_model', 'apply_flag_settings'])
  // A model and a new level chosen together are still one operation, and nothing restarts in between.
  expect((await f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, modelId: 'fixture-model', reasoningEffort: 'high' })).accepted).toBe(true)
  expect(await f.liveSettings.effective(id)).toMatchObject({ modelId: 'fixture-model', reasoningEffort: 'high' })
  expect(await launches(f)).toBe(started)
  expect(events).toEqual(['claude-settings-applied-live', 'claude-settings-applied-live'])
})

it('refuses a second settings change while the first is still going out, and says that is what is in the way', async () => {
  const { f, id } = await fixture()
  const first = f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, reasoningEffort: 'high' })
  await expect(f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, runtimeMode: 'auto' }))
    .rejects.toThrow('Wait for this thread’s settings change to finish.')
  expect((await first).accepted).toBe(true)
  expect(await sent(f)).toEqual(['apply_flag_settings'])
})

it('puts back what the CLI took when it refuses the rest and background work rules out a restart', async () => {
  const { f, id, events } = await fixture()
  await f.action(id, { type: 'raw', frame: { type: 'system', subtype: 'task_started', task_id: 'agent-task', task_type: 'local_agent', description: 'Review the diff', is_backgrounded: true, spawn_depth: 1 } })
  await expect.poll(async () => (await thread(f, id)).backgroundWork?.length).toBe(1)
  const started = await launches(f)
  await writeFile(join(f.root, 'settings-script.json'), JSON.stringify({ refuse: ['apply_flag_settings'], once: true }))
  await expect(f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, modelId: 'fixture-large', reasoningEffort: 'medium' }))
    .rejects.toThrow('"Review the diff" is still running for this thread. Nothing was changed.')
  // The model it had already taken was set back, with the effort that goes with it, so "nothing was changed" is
  // true of the CLI as well as the thread.
  expect(await sent(f)).toEqual(['set_model', 'apply_flag_settings', 'set_model', 'apply_flag_settings'])
  expect(await f.liveSettings.effective(id)).toMatchObject({ modelId: 'fixture-model', reasoningEffort: 'low' })
  expect(await thread(f, id)).toMatchObject({ modelId: 'fixture-model', reasoningEffort: 'low', backgroundWork: [expect.objectContaining({ label: 'Review the diff' })] })
  expect(await launches(f)).toBe(started)
  expect(events).toEqual(['claude-settings-live-rejected'])
})

it('says the background work stopped when the CLI will not take back the part of a change it took', async () => {
  const { f, id, events } = await fixture()
  await f.action(id, { type: 'raw', frame: { type: 'system', subtype: 'task_started', task_id: 'agent-task', task_type: 'local_agent', description: 'Review the diff', is_backgrounded: true, spawn_depth: 1 } })
  await expect.poll(async () => (await thread(f, id)).backgroundWork?.length).toBe(1)
  // Every effort request is refused, so the model the CLI took cannot be set back with the level that goes with it.
  await writeFile(join(f.root, 'settings-script.json'), JSON.stringify({ refuse: ['apply_flag_settings'] }))
  const result = await f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, modelId: 'fixture-large', reasoningEffort: 'medium' })
  expect(result).toMatchObject({ accepted: false, uncertain: true })
  expect(result.error).toContain('Claude Code took only part of the settings change and would not undo it')
  expect(result.error).toContain('"Review the diff" stopped with it')
  expect(result.error).not.toContain('Nothing was changed')
  expect(await sent(f)).toEqual(['set_model', 'apply_flag_settings', 'set_model', 'apply_flag_settings'])
  // The thread shows the work ended the way it shows a CLI that exited under it.
  const shown = await thread(f, id)
  expect(shown.status).toBe('error')
  expect(shown.backgroundWork).toBeUndefined()
  expect(events).toEqual(['claude-settings-live-rejected', 'claude-settings-unconfirmed'])
})

it('says the background work stopped when a lost answer stops the CLI, and keeps the change unconfirmed', async () => {
  const { f, id, events } = await fixture()
  await f.action(id, { type: 'raw', frame: { type: 'system', subtype: 'task_started', task_id: 'agent-task', task_type: 'local_agent', description: 'Review the diff', is_backgrounded: true, spawn_depth: 1 } })
  await expect.poll(async () => (await thread(f, id)).backgroundWork?.length).toBe(1)
  await f.liveSettings.silence()
  const result = await f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, reasoningEffort: 'high' })
  expect(result).toMatchObject({ accepted: false, uncertain: true })
  expect(result.error).toContain('Claude Code did not confirm the settings change, so Sotto stopped this thread\'s session, and "Review the diff" stopped with it.')
  expect(result.error).toContain('The session starts again with the new settings the next time you use the thread.')
  const shown = await thread(f, id)
  expect(shown.status).toBe('error')
  expect(shown.backgroundWork).toBeUndefined()
  expect(events).toEqual(['claude-settings-unconfirmed'])
})

it('starts the CLI again with the whole change when it takes only part of it and nothing is running', async () => {
  const { f, id, events } = await fixture()
  const started = await launches(f)
  await writeFile(join(f.root, 'settings-script.json'), JSON.stringify({ refuse: ['apply_flag_settings'] }))
  expect((await f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, modelId: 'fixture-large', reasoningEffort: 'medium' })).accepted).toBe(true)
  expect(await launches(f)).toBe(started + 1)
  expect(await f.liveSettings.effective(id)).toMatchObject({ modelId: 'fixture-large', reasoningEffort: 'medium' })
  expect(events).toEqual(['claude-settings-live-rejected', 'claude-settings-applied-restart'])
})

it('starts a CLI that is not running once, with the new settings, and sends no settings requests', async () => {
  const { f, id, events } = await fixture(false)
  const started = await launches(f)
  const result = await f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, reasoningEffort: 'high' })
  expect(result.accepted).toBe(true)
  expect(result.snapshot?.threads.find(value => value.id === id)?.reasoningEffort).toBe('high')
  expect(await launches(f)).toBe(started + 1)
  expect(await sent(f)).toEqual([])
  expect(await f.liveSettings.effective(id)).toMatchObject({ reasoningEffort: 'high' })
  expect(events).toEqual(['claude-settings-applied-restart'])
})

it('leaves the coordinator\'s saved intent in place when the CLI never answers, and reconciles it once the CLI that runs it starts', async () => {
  const { f, id, events } = await fixture()
  const credentials = new AgentCredentials(join(f.root, 'vault'), { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() })
  await credentials.load()
  const control = new AgentControl({ schedule: immediatePublishScheduler, directory: f.root, host: f.host, credentials,
    reasoner: { intent: async () => ({ type: 'clarify', text: 'Choose a thread' }), decide: async () => ({ decision: 'human', text: 'Review' }) },
    membership: { status: async () => ({ status: 'beta', label: 'Fixture', expiresAt: null }), action: async () => ({ status: 'beta', label: 'Fixture', expiresAt: null }) } })
  const outbox = async (): Promise<unknown[]> => (JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')) as { outbox: unknown[] }).outbox
  try {
    await control.start(); await control.command({ type: 'connect' })
    // Connecting ends the thread's CLI and the coordinator does not open a thread to change its settings (#318),
    // so the window opens it, and the change goes to the CLI that starts.
    await control.command({ type: 'observe-threads', threadIds: [id] })
    await f.liveSettings.silence()
    const unconfirmed = await control.command({ type: 'configure-thread', threadId: id, reasoningEffort: 'high' })
    expect(unconfirmed.error).toContain('did not confirm')
    expect(unconfirmed.host.threads.find(value => value.id === id)?.reasoningEffort).toBe('low')
    expect(events).toEqual(['claude-settings-unconfirmed'])
    // The coordinator's saved intent is still there, waiting for the thread to report the change.
    expect(await outbox()).toEqual([expect.objectContaining({ type: 'configure-thread', threadId: id, options: { reasoningEffort: 'high' } })])
    // Refreshing starts the thread's CLI with the change it was left carrying, and that reconciles the intent.
    await f.liveSettings.answer()
    await control.command({ type: 'refresh' })
    await expect.poll(() => control.get().host.threads.find(value => value.id === id)?.reasoningEffort).toBe('high')
    await expect.poll(outbox).toEqual([])
    expect(await f.liveSettings.effective(id)).toMatchObject({ reasoningEffort: 'high' })
    // Nothing was resent to get there.
    expect((await f.driver.requests()).filter(record => record.method === 'apply_flag_settings')).toHaveLength(1)
    expect((await control.command({ type: 'configure-thread', threadId: id, runtimeMode: 'auto' })).error).toBeNull()
  } finally { control.dispose() }
})

it('reaches a CLI the window started just before the press, once it is up, rather than the launch arguments it started with', async () => {
  const { f, id, events } = await fixture(false)
  const started = await launches(f)
  // The window opening the thread starts its CLI, and the press comes in while that start is still in flight.
  f.host.observeThreads?.([id])
  const result = await f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, reasoningEffort: 'high' })
  expect(result.accepted).toBe(true)
  expect(await launches(f)).toBe(started + 1)
  expect(await sent(f)).toEqual(['apply_flag_settings'])
  expect(await f.liveSettings.effective(id)).toMatchObject({ reasoningEffort: 'high' })
  expect(events).toEqual(['claude-settings-applied-live'])
})

it('launches the CLI the window asks for while a restart closes the old one with the new settings, and only that one', async () => {
  const { f, id, events } = await fixture()
  // The old CLI takes a while to exit, as one finishing its writes may. The fake records a violation if a second
  // CLI starts on the session before it has, which reading the requests below reports.
  await writeFile(join(f.root, 'exit-delay.json'), JSON.stringify({ ms: 300 }))
  const started = await launches(f)
  // Entering full access starts the CLI again. The window opening the thread asks for its CLI while the old one
  // is still closing, before the new settings would otherwise be recorded.
  const pending = f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, runtimeMode: 'full-access' })
  f.host.observeThreads?.([id])
  const result = await pending
  expect(result.accepted).toBe(true)
  expect(result.snapshot?.threads.find(value => value.id === id)?.runtimeMode).toBe('full-access')
  expect(await launches(f)).toBe(started + 1)
  expect(await f.liveSettings.effective(id)).toMatchObject({ runtimeMode: 'full-access' })
  expect(events).toEqual(['claude-settings-applied-restart'])
})

it('launches the CLI the window asks for after an unconfirmed change with the change it was left carrying', async () => {
  const { f, id, events } = await fixture()
  // The window asks for the thread's CLI while the one that never answered is being stopped: the adapter logs
  // the change as unconfirmed and then lets that CLI go.
  const log = events.push.bind(events)
  events.push = (...logged) => {
    if (logged.includes('claude-settings-unconfirmed')) setImmediate(() => f.host.observeThreads?.([id]))
    return log(...logged)
  }
  await f.liveSettings.silence()
  // The CLI that never answered takes a while to exit; the new one waits for it (see the restart case above).
  await writeFile(join(f.root, 'exit-delay.json'), JSON.stringify({ ms: 300 }))
  const started = await launches(f)
  expect(await f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, reasoningEffort: 'high' })).toEqual({ accepted: false, uncertain: true })
  await expect.poll(async () => (await thread(f, id)).reasoningEffort).toBe('high')
  expect(await launches(f)).toBe(started + 1)
  expect(await f.liveSettings.effective(id)).toMatchObject({ reasoningEffort: 'high' })
})

it('starts a thread\'s CLI only once the one the reaper stopped has exited', async () => {
  const { f, id } = await fixture()
  await writeFile(join(f.root, 'exit-delay.json'), JSON.stringify({ ms: 300 }))
  const started = await launches(f)
  const internals = f.adapter as unknown as { stopSession(id: string): Promise<void> }
  // The reaper lets the CLI go, and the window asks for the thread again before it has exited.
  const stopping = internals.stopSession(id)
  const reopened = f.adapter.refreshThread(id)
  await Promise.all([stopping, reopened])
  expect(await launches(f)).toBe(started + 1)
  const records = await f.driver.requests()
  const exit = records.findLastIndex(record => record.method === 'exit')
  expect(exit).toBeGreaterThanOrEqual(0)
  expect(records.findLastIndex(record => record.method === 'launch' || record.method === 'resume')).toBeGreaterThan(exit)
})
