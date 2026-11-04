/**
 * Dynamic threads (ADR-0191) through the built app, on the Owl track, with the real Claude Code adapter over the fake CLI:
 * the whole way from the command that marks a thread to what its client is started with and sent. The switch's own journey
 * comes with the switch.
 *
 *   npm run build && npx playwright test tests/e2e/dynamic-threads.spec.ts
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { overseerInstructions } from '../../src/shared/dynamicThreads'
import { fakeClaudeLaunches, fakeClaudeRecords } from '../fixtures/fakeClaudeRecords'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { onReleaseTrack } from './support/releaseTrack'
import { closeSotto, launchSotto, type LaunchedSotto } from './support/sottoLaunch'

async function fixture() {
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-dynamic-' })).directory
  const root = join(profile, 'native-fixture')
  for (const folder of ['claude', 'codex', 'project']) await mkdir(join(root, folder), { recursive: true })
  await writeFile(join(root, 'codex', 'script.json'), JSON.stringify({ reply: 'Reviewed.', models: [{ id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', isDefault: true, defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'].map(reasoningEffort => ({ reasoningEffort })) }] }))
  await writeFile(join(root, 'claude', 'script.json'), JSON.stringify({ reply: 'Done.' }))
  await writeFile(join(root, 'claude', 'models.json'), JSON.stringify([{ value: 'opus', displayName: 'Opus 5.5', supportsEffort: true, supportedEffortLevels: ['low', 'high'] }]))
  const previous = { SOTTO_E2E_NATIVE_FIXTURE_ROOT: process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT, SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE: process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE }
  process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT = root
  process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE = process.execPath
  const restore = async (): Promise<void> => {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value
    await removeOwnedE2EProfile(profile)
  }
  return { profile, root, project: join(root, 'project'), restore }
}

/** Claude Code connected, a project, and a thread nothing has been sent to. */
const newThread = (page: Page, project: string): Promise<string> => page.evaluate(async path => {
  await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
  const agents = window.sotto!.agents!
  const configured = await agents.command({ type: 'configure', patch: { provider: 'claude', enabled: true, enabledProviders: ['claude', 'codex'], checkClientUpdates: false } })
  if (configured.error) throw new Error(configured.error)
  for (const provider of ['claude', 'codex'] as const) {
    const connected = await agents.command({ type: 'connect', provider })
    if (connected.error) throw new Error(connected.error)
  }
  const created = await agents.command({ type: 'create-project', provider: 'claude', title: 'Harbour', path, useExisting: true })
  if (created.error) throw new Error(created.error)
  const projectId = created.host.projects.find(item => item.title === 'Harbour')!.id
  const model = (await agents.get()).host.models.find(item => item.providerId === 'claude' && item.ready)!
  const thread = await agents.command({ type: 'create-thread', projectId, title: 'Reconnect fix', titleSource: 'user', modelId: model.id, workingCopy: 'shared', runtimeMode: 'approval-required' })
  if (thread.error || !thread.activeThreadId) throw new Error(thread.error ?? 'No thread was created.')
  return thread.activeThreadId
}, project)
const command = (page: Page, input: Record<string, unknown>): Promise<string | null> => page.evaluate(async sent => (await window.sotto!.agents!.command(sent as never)).error, input)
const send = (page: Page, threadId: string, text: string): Promise<string | null> => command(page, { type: 'manual-send', threadId, text })
const appended = (args: readonly string[]): string => args[args.indexOf('--append-system-prompt') + 1] ?? ''

test('a thread made Dynamic before its first message starts on the overseer\'s instructions', async () => {
  test.setTimeout(120_000)
  const { profile, root, project, restore } = await fixture()
  let launched: LaunchedSotto | undefined
  try {
    await onReleaseTrack('owl', async () => {
      launched = await launchSotto('success', profile)
      const { page } = launched
      const id = await newThread(page, project)
      expect(await command(page, { type: 'set-thread-dynamic', threadId: id, dynamic: true })).toBeNull()
      expect(await send(page, id, 'Fix the reconnect flake.')).toBeNull()
      await expect.poll(async () => (await fakeClaudeLaunches(join(root, 'claude'))).filter(launch => appended(launch.args).includes('You do no work yourself')).length, { timeout: 30_000 }).toBe(1)
      const launch = (await fakeClaudeLaunches(join(root, 'claude'))).find(item => appended(item.args).includes('You do no work yourself'))!
      expect(appended(launch.args)).toContain(overseerInstructions())
      expect(appended(launch.args)).not.toContain('sotto_building')
    })
  } finally {
    if (launched) await closeSotto(launched)
    await restore()
  }
})

test('a thread made Dynamic after its first message is told by one note with its next one, and the message stays as typed', async () => {
  test.setTimeout(120_000)
  const { profile, root, project, restore } = await fixture()
  let launched: LaunchedSotto | undefined
  try {
    await onReleaseTrack('owl', async () => {
      launched = await launchSotto('success', profile)
      const { page } = launched
      const id = await newThread(page, project)
      expect(await send(page, id, 'Fix the reconnect flake.')).toBeNull()
      const records = () => fakeClaudeRecords(join(root, 'claude'))
      const atRest = () => page.evaluate(async threadId => (await window.sotto!.agents!.get()).host.threads.find(item => item.id === threadId)?.status !== 'running', id)
      await expect.poll(atRest, { timeout: 30_000 }).toBe(true)
      expect(await command(page, { type: 'set-thread-dynamic', threadId: id, dynamic: true })).toBeNull()
      expect(await send(page, id, 'Now have it reviewed.')).toBeNull()
      const notes = async () => (await records()).filter(record => record.method === 'hook-context').map(record => (record.params as { frame: { additionalContext: string | null; prompt: string } }).frame)
      await expect.poll(async () => (await notes()).filter(item => item.additionalContext !== null).length, { timeout: 30_000 }).toBe(1)
      const noted = (await notes()).find(item => item.additionalContext !== null)!
      expect(noted.additionalContext).toContain('From this message on, this thread is Dynamic.')
      expect(noted.prompt).toBe('Now have it reviewed.')
      // It went once: the message after it carries nothing.
      await expect.poll(atRest, { timeout: 30_000 }).toBe(true)
      expect(await send(page, id, 'And merge it.')).toBeNull()
      await expect.poll(async () => (await notes()).some(item => item.prompt === 'And merge it.'), { timeout: 30_000 }).toBe(true)
      expect((await notes()).filter(item => item.additionalContext !== null)).toHaveLength(1)
    })
  } finally {
    if (launched) await closeSotto(launched)
    await restore()
  }
})

test('an overseer starts the model it names inside the list, with its reason, and is refused one off it', async () => {
  test.setTimeout(120_000)
  const { profile, project, restore } = await fixture()
  let launched: LaunchedSotto | undefined
  try {
    await onReleaseTrack('owl', async () => {
      launched = await launchSotto('success', profile)
      const { page } = launched
      const id = await newThread(page, project)
      await page.evaluate(() => window.sotto!.updateSettings({ dynamicThreads: { providers: ['claude'], highestEffort: 'high', workersAtOnce: 4 } }))
      expect(await command(page, { type: 'set-thread-dynamic', threadId: id, dynamic: true })).toBeNull()
      expect(await send(page, id, 'Fix the reconnect flake.')).toBeNull()
      await expect.poll(() => page.evaluate(async threadId => (await window.sotto!.agents!.get()).host.threads.find(item => item.id === threadId)?.lastUserMessageId !== undefined, id), { timeout: 30_000 }).toBe(true)
      const delegate = (args: Record<string, unknown>) => page.evaluate(async ({ threadId, args }) => {
        const result = await window.sottoE2E!.delegationTool!({ threadId, name: 'delegate', arguments: args })
        const text = result.content.find(item => item.type === 'text')
        return JSON.parse(text && 'text' in text ? text.text : '{}') as { status: string; code?: string; message?: string; effortHeld?: string; delegation?: { thread?: string } }
      }, { threadId: id, args })
      const worker = { work: 'code-review', brief: 'Review the reconnect fix.', wait_seconds: 0, provider: 'codex', model: 'native:codex:model:gpt-6.1-sol', effort: 'max', permission: 'approval-required', why: 'Another maker\'s read.' }
      // Codex is off the list, and only a press in Settings puts it on.
      const refused = await delegate(worker)
      expect(refused, JSON.stringify(refused)).toMatchObject({ status: 'refused', code: 'PROVIDER_NOT_ALLOWED' })
      await page.evaluate(() => window.sotto!.updateSettings({ dynamicThreads: { providers: ['claude', 'codex'], highestEffort: 'high', workersAtOnce: 4 } }))
      const started = await delegate(worker)
      expect(started, JSON.stringify(started)).toMatchObject({ status: 'ok' })
      expect(started.effortHeld).toContain('held to high')
      await expect.poll(() => page.evaluate(async parent => {
        const thread = (await window.sotto!.agents!.get()).host.threads.find(item => item.delegatedBy === parent)
        return thread && { provider: thread.providerId, effort: thread.reasoningEffort }
      }, id), { timeout: 30_000 }).toEqual({ provider: 'codex', effort: 'high' })
    })
  } finally {
    if (launched) await closeSotto(launched)
    await restore()
  }
})

test('stable sets nothing', async () => {
  test.setTimeout(120_000)
  const { profile, project, restore } = await fixture()
  let launched: LaunchedSotto | undefined
  try {
    await onReleaseTrack('stable', async () => {
      launched = await launchSotto('success', profile)
      const id = await newThread(launched.page, project)
      expect(await command(launched.page, { type: 'set-thread-dynamic', threadId: id, dynamic: true })).toContain('available in Sotto Owl')
    })
  } finally {
    if (launched) await closeSotto(launched)
    await restore()
  }
})
