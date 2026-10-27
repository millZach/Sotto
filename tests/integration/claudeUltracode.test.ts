// @vitest-environment node
// Ultracode on a Claude Code thread (ADR-0148): the level past Max on a model with Extra high, kept per thread like any
// level, and run as Claude Code's `ultracode` session setting beside the effort this machine's setting names. The CLI
// launches with it, takes it in place, and is brought to the setting's level before every prompt that needs it.
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import type { UltracodeEffort } from '../../src/shared/ultracode'
import { claudeFixture } from '../fixtures/claudeFixture'

type Fixture = Awaited<ReturnType<typeof claudeFixture>>
const fixtures: Fixture[] = []
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup() })
const models = [
  { value: 'fixture-opus', displayName: 'Fixture Opus', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'fixture-sonnet', displayName: 'Fixture Sonnet', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max'] },
]

/** A connected fixture whose Ultracode effort setting reads `setting.value` at every launch and send, as main's does. */
async function fixture(setting: { value: UltracodeEffort }, catalog: readonly object[] = models): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-claude-ultracode-'))
  await writeFile(join(root, 'models.json'), JSON.stringify(catalog))
  // Every prompt is answered at once, so a thread is at rest again for the next send.
  await writeFile(join(root, 'script.json'), JSON.stringify({ reply: 'Done.' }))
  const f = await claudeFixture(root, 2000, undefined, { ultracodeEffort: () => setting.value })
  fixtures.push(f)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Ultracode', path: f.root })
  return f
}
async function thread(f: Fixture, modelId: string, reasoningEffort: string): Promise<string> {
  const id = randomUUID()
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: 'Ultracode', modelId, reasoningEffort })
  f.host.observeThreads?.([id])
  await f.adapter.refreshThread(id)
  return id
}
const shown = async (f: Fixture, id: string) => (await f.host.snapshot()).threads.find(value => value.id === id)!
/** Each thread CLI's launch arguments, oldest first; the catalog read, which keeps no session, is not one. */
const launchArgs = async (f: Fixture) => (await f.driver.requests()).filter(record => record.method === 'launch' || record.method === 'resume')
  .map(record => (record.params?.frame as { args: string[] }).args).filter(args => !args.includes('--no-session-persistence'))
const flag = (args: readonly string[], name: string): string | undefined => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
/** The settings requests and prompts the CLI received, in order, so a test can say which came first. */
const settingsAndPrompts = async (f: Fixture) => (await f.driver.requests()).flatMap((record): (string | Record<string, unknown>)[] => record.method === 'user' ? ['prompt']
  : record.method === 'apply_flag_settings' ? [(record.params?.frame as { request: { settings: Record<string, unknown> } }).request.settings] : [])
async function send(f: Fixture, id: string, text: string): Promise<void> {
  expect(await f.host.execute({ type: 'send', commandId: randomUUID(), messageId: randomUUID(), threadId: id, text })).toEqual({ accepted: true })
  await expect.poll(async () => (await shown(f, id)).status).toBe('idle')
}

it('offers Ultracode after Max on a model with Extra high, and nowhere else', async () => {
  const f = await fixture({ value: 'xhigh' })
  const catalog = (await f.host.snapshot()).models
  expect(catalog.find(model => model.id === 'fixture-opus')?.reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
  expect(catalog.find(model => model.id === 'fixture-sonnet')?.reasoningEfforts).toEqual(['low', 'medium', 'high', 'max'])
  await expect(thread(f, 'fixture-sonnet', 'ultracode')).rejects.toThrow('That reasoning level is not supported by this model.')
})

it('launches a thread on Ultracode at the setting\'s effort with ultracode on, and every other thread with it off', async () => {
  const f = await fixture({ value: 'xhigh' })
  const id = await thread(f, 'fixture-opus', 'ultracode')
  expect((await shown(f, id)).reasoningEffort).toBe('ultracode')
  const args = (await launchArgs(f)).at(-1)!
  // Claude Code has no effort called ultracode: the level runs at Extra high with the session setting on.
  expect(flag(args, '--effort')).toBe('xhigh')
  expect(JSON.parse(flag(args, '--settings')!)).toEqual({ fastMode: false, ultracode: true })
  expect(await f.liveSettings.effective(id)).toMatchObject({ reasoningEffort: 'xhigh', ultracode: true })

  // A thread on any other level says ultracode off, so one saved in the user's own Claude Code settings never runs it.
  const plain = await thread(f, 'fixture-opus', 'max')
  const plainArgs = (await launchArgs(f)).at(-1)!
  expect(flag(plainArgs, '--effort')).toBe('max')
  expect(JSON.parse(flag(plainArgs, '--settings')!)).toEqual({ fastMode: false, ultracode: false })
  expect(await f.liveSettings.effective(plain)).toMatchObject({ reasoningEffort: 'max', ultracode: false })
})

it('brings the CLI to a changed setting before the next prompt, once, and leaves other threads alone', async () => {
  const setting: { value: UltracodeEffort } = { value: 'xhigh' }
  const f = await fixture(setting)
  const id = await thread(f, 'fixture-opus', 'ultracode')
  await send(f, id, 'First')
  // Nothing changed since launch, so the prompt goes as it is.
  expect(await settingsAndPrompts(f)).toEqual(['prompt'])

  setting.value = 'high'
  await send(f, id, 'Second')
  expect(await settingsAndPrompts(f)).toEqual(['prompt', { effortLevel: 'high', ultracode: true }, 'prompt'])
  expect(await f.liveSettings.effective(id)).toMatchObject({ reasoningEffort: 'high', ultracode: true })
  // The setting is still High, which the CLI now runs: the next prompt needs nothing first.
  await send(f, id, 'Third')
  expect(await settingsAndPrompts(f)).toEqual(['prompt', { effortLevel: 'high', ultracode: true }, 'prompt', 'prompt'])

  // A thread on another level ignores the setting.
  const plain = await thread(f, 'fixture-opus', 'medium')
  await send(f, plain, 'Plain')
  expect((await settingsAndPrompts(f)).slice(4)).toEqual(['prompt'])
  expect(await f.liveSettings.effective(plain)).toMatchObject({ reasoningEffort: 'medium', ultracode: false })
})

it('fits the setting to a model without its level, at the nearest level below', async () => {
  const f = await fixture({ value: 'max' }, [{ ...models[0], supportedEffortLevels: ['low', 'medium', 'high', 'xhigh'] }])
  const id = await thread(f, 'fixture-opus', 'ultracode')
  expect(flag((await launchArgs(f)).at(-1)!, '--effort')).toBe('xhigh')
  expect(await f.liveSettings.effective(id)).toMatchObject({ reasoningEffort: 'xhigh', ultracode: true })
})

it('turns Ultracode on and off in place with the effort, never as an effort of its own', async () => {
  const setting: { value: UltracodeEffort } = { value: 'high' }
  const f = await fixture(setting)
  const id = await thread(f, 'fixture-opus', 'medium')
  const launches = (await launchArgs(f)).length
  const configure = (reasoningEffort: string) => f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, reasoningEffort })

  expect((await configure('ultracode')).accepted).toBe(true)
  expect(await f.liveSettings.effective(id)).toMatchObject({ reasoningEffort: 'high', ultracode: true })
  expect((await shown(f, id)).reasoningEffort).toBe('ultracode')
  // The CLI was told the setting's level when it turned on, so the prompt needs nothing first.
  await send(f, id, 'On')

  expect((await configure('max')).accepted).toBe(true)
  expect(await f.liveSettings.effective(id)).toMatchObject({ reasoningEffort: 'max', ultracode: false })
  // Between two other levels the launch's flag layer already holds it off, so the request does not name it.
  expect((await configure('low')).accepted).toBe(true)
  expect(await settingsAndPrompts(f)).toEqual([{ effortLevel: 'high', ultracode: true }, 'prompt', { effortLevel: 'max', ultracode: false }, { effortLevel: 'low' }])
  expect((await launchArgs(f)).length).toBe(launches)
})
