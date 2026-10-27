// @vitest-environment node
// Fast mode on a Claude Code thread (ADR-0143): the user's choice per thread, applied with `--settings` at launch and
// `apply_flag_settings` on a running CLI, only on a model whose catalog entry offers it, and kept through a model change.
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import { createAgentControl } from '../fixtures/agentControlFixture'
import { claudeFixture } from '../fixtures/claudeFixture'
import { immediatePublishScheduler } from '../fixtures/publishScheduler'
import { testCredentials } from '../fixtures/testCredentials'

type Fixture = Awaited<ReturnType<typeof claudeFixture>>
const fixtures: Fixture[] = []
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup() })
const models = [
  { value: 'fixture-model', displayName: 'Fixture Opus', supportsEffort: true, supportedEffortLevels: ['low', 'high'], supportsFastMode: true },
  { value: 'fixture-plain', displayName: 'Fixture Sonnet', supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
]
const settingsRequests = new Set(['set_model', 'apply_flag_settings', 'set_permission_mode'])

async function fixture(): Promise<{ f: Fixture; id: string }> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-claude-fast-'))
  await writeFile(join(root, 'models.json'), JSON.stringify(models))
  const f = await claudeFixture(root)
  fixtures.push(f)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Fast', path: f.root })
  const id = randomUUID()
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: 'Fast', modelId: 'fixture-model', reasoningEffort: 'low' })
  f.host.observeThreads?.([id])
  await f.adapter.refreshThread(id)
  return { f, id }
}
/** The same saved threads under a fresh adapter, as after Sotto restarts. */
async function restarted(f: Fixture): Promise<Fixture> {
  const next = await f.driver.restart() as Fixture
  fixtures.splice(fixtures.indexOf(f), 1, next)
  await next.host.connect()
  return next
}
const thread = async (f: Fixture, id: string) => (await f.host.snapshot()).threads.find(value => value.id === id)!
const settingsFrames = async (f: Fixture) => (await f.driver.requests()).flatMap(record => settingsRequests.has(record.method ?? '')
  ? [(record.params?.frame as { request?: Record<string, unknown> } | undefined)?.request ?? {}] : [])
/** Each thread CLI's launch arguments, oldest first; the catalog read, which keeps no session, is not one. */
const launchArgs = async (f: Fixture) => (await f.driver.requests()).filter(record => record.method === 'launch' || record.method === 'resume')
  .map(record => (record.params?.frame as { args: string[] }).args).filter(args => !args.includes('--no-session-persistence'))
/** The `fastMode` a launch's `--settings` flag layer names; every launch names one, off as well as on. */
const fastFlag = (args: readonly string[]): unknown => JSON.parse(args[args.indexOf('--settings') + 1]!).fastMode
const configure = (f: Fixture, id: string, options: Record<string, unknown>) => f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, ...options })

it('starts a new thread with fast mode off, and its CLI launches with it off, outranking a fastMode the user saved with /fast', async () => {
  const { f, id } = await fixture()
  expect((await thread(f, id)).fastMode).toBeUndefined()
  expect(fastFlag((await launchArgs(f)).at(-1)!)).toBe(false)
  expect((await f.liveSettings.effective(id)).fastMode).toBe(false)
  // The catalog says which models offer it.
  const snapshot = await f.host.snapshot()
  expect(snapshot.models.find(model => model.id === 'fixture-model')?.fastMode).toEqual({})
  expect(snapshot.models.find(model => model.id === 'fixture-plain')?.fastMode).toBeUndefined()
})

it('turns fast mode on in place on the running CLI, and launches with it once Sotto starts again', async () => {
  const { f, id } = await fixture()
  const started = (await launchArgs(f)).length
  const result = await configure(f, id, { fastMode: true })
  expect(result.accepted).toBe(true)
  expect(result.snapshot?.threads.find(value => value.id === id)?.fastMode).toBe(true)
  expect(await settingsFrames(f)).toEqual([{ subtype: 'apply_flag_settings', settings: { fastMode: true } }])
  expect((await f.liveSettings.effective(id)).fastMode).toBe(true)
  expect((await launchArgs(f)).length).toBe(started)

  // Saved with the thread: a restart shows it and launches the CLI with the flag layer, not the user's own settings.
  const next = await restarted(f)
  expect((await thread(next, id)).fastMode).toBe(true)
  next.host.observeThreads?.([id])
  await next.adapter.refreshThread(id)
  const args = (await launchArgs(next)).at(-1)!
  expect(args[args.indexOf('--settings') + 1]).toBe('{"fastMode":true,"ultracode":false}')
  expect((await next.liveSettings.effective(id)).fastMode).toBe(true)

  // Off again is `false`, so the flag layer outranks a fastMode in the user's own settings.
  expect((await configure(next, id, { fastMode: false })).accepted).toBe(true)
  expect((await settingsFrames(next)).at(-1)).toEqual({ subtype: 'apply_flag_settings', settings: { fastMode: false } })
  expect((await thread(next, id)).fastMode).toBeUndefined()
  expect((await next.liveSettings.effective(id)).fastMode).toBe(false)
})

it('keeps the choice through a model without fast mode, running it at normal speed, and takes it up again on the way back', async () => {
  const { f, id } = await fixture()
  expect((await configure(f, id, { fastMode: true })).accepted).toBe(true)
  const before = (await settingsFrames(f)).length

  // Off goes before the model change, so the CLI never holds fast mode on a model without it (the fake records a violation).
  expect((await configure(f, id, { modelId: 'fixture-plain' })).accepted).toBe(true)
  expect((await settingsFrames(f)).slice(before).map(frame => frame.subtype === 'apply_flag_settings' ? frame.settings : frame.subtype))
    .toEqual([{ fastMode: false }, 'set_model', { effortLevel: null }])
  expect(await thread(f, id)).toMatchObject({ modelId: 'fixture-plain', fastMode: true })
  expect((await f.liveSettings.effective(id)).fastMode).toBe(false)

  // A launch on that model names fast mode off, so the choice kept on the thread never runs there.
  const next = await restarted(f)
  next.host.observeThreads?.([id])
  await next.adapter.refreshThread(id)
  expect(fastFlag((await launchArgs(next)).at(-1)!)).toBe(false)

  // Back on a model that has it, fast mode comes on after the model change.
  const back = (await settingsFrames(next)).length
  expect((await configure(next, id, { modelId: 'fixture-model' })).accepted).toBe(true)
  expect((await settingsFrames(next)).slice(back).map(frame => frame.subtype === 'apply_flag_settings' ? frame.settings : frame.subtype))
    .toEqual(['set_model', { fastMode: true }])
  expect(await thread(next, id)).toMatchObject({ modelId: 'fixture-model', fastMode: true })
  expect((await next.liveSettings.effective(id)).fastMode).toBe(true)
})

it('refuses to turn fast mode on for a model without it, and sends nothing', async () => {
  const { f, id } = await fixture()
  expect((await configure(f, id, { modelId: 'fixture-plain' })).accepted).toBe(true)
  const before = (await settingsFrames(f)).length
  await expect(configure(f, id, { fastMode: true })).rejects.toThrow('This model does not offer fast mode.')
  expect((await settingsFrames(f)).length).toBe(before)
  expect((await thread(f, id)).fastMode).toBeUndefined()
})

it('creates a thread with fast mode on, as a first send from a draft that chose it does', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-claude-fast-'))
  await writeFile(join(root, 'models.json'), JSON.stringify(models))
  const f = await claudeFixture(root)
  fixtures.push(f)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Fast', path: f.root })
  const id = randomUUID()
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: 'Fast', modelId: 'fixture-model', fastMode: true })
  expect((await thread(f, id)).fastMode).toBe(true)
  const args = (await launchArgs(f)).at(-1)!
  expect(args[args.indexOf('--settings') + 1]).toBe('{"fastMode":true,"ultracode":false}')
})

it('saves the toggle through the coordinator, which reconciles off against a thread that shows none, and keeps an unanswered one', async () => {
  const { f, id } = await fixture()
  const credentials = await testCredentials(join(f.root, 'vault'), { mode: 'plain' })
  const control = createAgentControl({ schedule: immediatePublishScheduler, directory: f.root, host: f.host, credentials, reasoner: {} })
  const outbox = async (): Promise<unknown[]> => (JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')) as { outbox: unknown[] }).outbox
  try {
    await control.start(); await control.command({ type: 'connect' })
    await control.command({ type: 'observe-threads', threadIds: [id] })
    const on = await control.command({ type: 'configure-thread', threadId: id, fastMode: true })
    expect(on.error).toBeNull()
    expect(on.host.threads.find(value => value.id === id)?.fastMode).toBe(true)
    // Off is a thread that shows no fastMode at all, which settles the saved intent rather than waiting on it: an intent the
    // thread did not settle would answer that the provider has not confirmed the change.
    const off = await control.command({ type: 'configure-thread', threadId: id, fastMode: false })
    expect(off.error).toBeNull()
    expect(off.host.threads.find(value => value.id === id)?.fastMode).toBeUndefined()
    expect(off.unconfirmedSettings ?? []).toEqual([])

    // An unanswered press is kept for the thread's next start, as an effort's is, and the window marks the toggle by it.
    await f.liveSettings.silence()
    const unanswered = await control.command({ type: 'configure-thread', threadId: id, fastMode: true })
    expect(unanswered.error).toContain('did not confirm')
    expect(unanswered.unconfirmedSettings).toEqual([{ threadId: id, fastMode: true }])
    await f.liveSettings.answer()
    await control.command({ type: 'refresh' })
    await expect.poll(() => control.get().host.threads.find(value => value.id === id)?.fastMode).toBe(true)
    await expect.poll(outbox).toEqual([])
    expect((await f.liveSettings.effective(id)).fastMode).toBe(true)
  } finally { control.dispose() }
})

it('lets a model change go through when Claude Code refuses only the fast mode it carried, and lets a refused toggle stand', async () => {
  const { f, id } = await fixture()
  // The thread chose fast mode and moved to a model without it, so moving back turns it on after the model.
  expect((await configure(f, id, { fastMode: true })).accepted).toBe(true)
  expect((await configure(f, id, { modelId: 'fixture-plain' })).accepted).toBe(true)
  await writeFile(join(f.root, 'settings-script.json'), JSON.stringify({ refuseFastMode: true }))
  const launched = (await launchArgs(f)).length
  const { process } = await f.liveSettings.effective(id)
  const before = (await settingsFrames(f)).length
  const moved = await configure(f, id, { modelId: 'fixture-model' })
  expect(moved.accepted).toBe(true)
  expect(moved.snapshot?.threads.find(value => value.id === id)).toMatchObject({ modelId: 'fixture-model' })
  // The model stays; fast mode is not running and the thread's choice is off, as after a refused toggle.
  expect((await settingsFrames(f)).slice(before).map(frame => frame.subtype === 'apply_flag_settings' ? frame.settings : `${String(frame.subtype)} ${String(frame.model)}`))
    .toEqual(['set_model fixture-model', { fastMode: true }])
  expect((await launchArgs(f)).length).toBe(launched)
  expect(await f.liveSettings.effective(id)).toMatchObject({ process, modelId: 'fixture-model', fastMode: false })
  expect((await thread(f, id)).modelId).toBe('fixture-model')
  expect((await thread(f, id)).fastMode).toBeUndefined()
  // Saved so: a restart shows the choice off and launches without the flag.
  const next = await restarted(f)
  expect((await thread(next, id)).fastMode).toBeUndefined()

  // Pressed on its own, the refusal stands: nothing else changes and nothing starts again.
  const { f: g, id: other } = await fixture()
  await writeFile(join(g.root, 'settings-script.json'), JSON.stringify({ refuseFastMode: true }))
  const gLaunched = (await launchArgs(g)).length
  const gProcess = (await g.liveSettings.effective(other)).process
  expect(await configure(g, other, { fastMode: true })).toEqual({ accepted: false })
  expect((await thread(g, other)).fastMode).toBeUndefined()
  expect(await g.liveSettings.effective(other)).toMatchObject({ process: gProcess, modelId: 'fixture-model', fastMode: false })
  expect((await launchArgs(g)).length).toBe(gLaunched)
})

it('does not adopt a spare started without fast mode for a first send that turned it on, and adopts one that matches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-claude-fast-'))
  await writeFile(join(root, 'models.json'), JSON.stringify(models))
  const f = await claudeFixture(root)
  fixtures.push(f)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Fast', path: f.root })
  const session = (args: readonly string[]): string => args[args.indexOf('--session-id') + 1]!

  // Typing began while fast mode was off, and the toggle was pressed before the first send.
  const plain = randomUUID()
  await f.adapter.startThreadSession(plain, { modelId: 'fixture-model', workingDirectory: f.root })
  expect(await launchArgs(f)).toHaveLength(1)
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: plain, projectId: f.projectId, title: 'Fast', modelId: 'fixture-model', fastMode: true })
  const [spare, own] = await launchArgs(f)
  expect(fastFlag(spare!)).toBe(false)
  expect(own![own!.indexOf('--settings') + 1]).toBe('{"fastMode":true,"ultracode":false}')
  expect(session(own!)).not.toBe(session(spare!))

  // A spare started with the choice the first send carries is the thread's CLI.
  const fast = randomUUID()
  await f.adapter.startThreadSession(fast, { modelId: 'fixture-model', workingDirectory: f.root, fastMode: true })
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: fast, projectId: f.projectId, title: 'Fast', modelId: 'fixture-model', fastMode: true })
  const all = await launchArgs(f)
  expect(all).toHaveLength(3)
  expect(all[2]![all[2]!.indexOf('--settings') + 1]).toBe('{"fastMode":true,"ultracode":false}')
})
