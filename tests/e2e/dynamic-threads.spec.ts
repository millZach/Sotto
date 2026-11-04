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
import { evidenceDirectory } from '../fixtures/evidence'
import { fakeClaudeLaunches, fakeClaudeRecords } from '../fixtures/fakeClaudeRecords'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { onReleaseTrack } from './support/releaseTrack'
import { pageBoundProblems } from './support/designCapture'
import { settingsLayoutProblems, settingsTextContrast } from './support/settingsChecks'
import { closeSotto, launchSotto, openPage, openThreads, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'

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
const dialogGone = (page: Page) => page.getByRole('dialog', { name: 'Turn on Dynamic for this thread?' })
const openSettingsAt = async (page: Page): Promise<void> => {
  await openPage(page, 'Settings')
  await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Threads', exact: true }).click()
}
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
        return JSON.parse(text && 'text' in text ? text.text : '{}') as { status: string; code?: string; message?: string; delegation?: { thread?: string; effortHeld?: string } }
      }, { threadId: id, args })
      const worker = { work: 'code-review', brief: 'Review the reconnect fix.', wait_seconds: 0, provider: 'codex', model: 'native:codex:model:gpt-6.1-sol', effort: 'max', permission: 'approval-required', why: 'Another maker\'s read.' }
      // Codex is off the list, and only a press in Settings puts it on.
      const refused = await delegate(worker)
      expect(refused, JSON.stringify(refused)).toMatchObject({ status: 'refused', code: 'PROVIDER_NOT_ALLOWED' })
      await page.evaluate(() => window.sotto!.updateSettings({ dynamicThreads: { providers: ['claude', 'codex'], highestEffort: 'high', workersAtOnce: 4 } }))
      const started = await delegate(worker)
      expect(started, JSON.stringify(started)).toMatchObject({ status: 'ok' })
      expect(started.delegation?.effortHeld).toContain('held to high')
      await expect.poll(() => page.evaluate(async parent => {
        const thread = (await window.sotto!.agents!.get()).host.threads.find(item => item.delegatedBy === parent)
        return thread && { provider: thread.providerId, effort: thread.reasoningEffort }
      }, id), { timeout: 30_000 }).toEqual({ provider: 'codex', effort: 'high' })
      // Its row says which model the overseer chose, at what effort and why, and has a menu to open or stop it.
      await page.reload()
      await openThreads(page)
      await page.getByRole('button', { name: 'Reconnect fix', exact: true }).first().click({ position: { x: 16, y: 12 } })
      await expect(page.locator('.thread-workspace__head h2')).toHaveText('Reconnect fix')
      const row = page.locator('.delegated-work__row', { hasText: 'GPT-6.1 Sol' }).first()
      // A finished turn folds its work away under its Worked for line.
      const worked = page.getByRole('button', { name: /Worked for/u }).first()
      await expect(row.or(worked)).toBeVisible({ timeout: 15_000 })
      if (!await row.isVisible()) await worked.click()
      await expect(row).toBeVisible({ timeout: 15_000 })
      await expect(row.locator('.delegated-work__meta')).toContainText('GPT-6.1 Sol, High')
      await expect(row).toContainText('Why: Another maker\'s read.')
      await expect(row).toContainText('Its effort was held to the most you allow in Settings.')
      await row.getByRole('button', { name: /^Actions for / }).click()
      await expect(page.getByRole('menuitem', { name: 'Open this thread' })).toBeVisible()
      await expect(page.getByRole('menuitem', { name: 'Stop this worker' })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(row.getByRole('button', { name: /^Actions for / })).toBeFocused()
    })
  } finally {
    if (launched) await closeSotto(launched)
    await restore()
  }
})

test('the model menu turns Dynamic on, asking once which companies it may use, and Settings holds the list', async () => {
  test.setTimeout(180_000)
  const { profile, root, project, restore } = await fixture()
  let launched: LaunchedSotto | undefined
  try {
    await onReleaseTrack('owl', async () => {
      launched = await launchSotto('success', profile)
      const { page } = launched
      const id = await newThread(page, project)
      await page.reload()
      await openThreads(page)
      await page.getByRole('button', { name: 'Reconnect fix', exact: true }).first().click({ position: { x: 16, y: 12 } })
      await expect(page.locator('.thread-workspace__head h2')).toHaveText('Reconnect fix')
      // Off by default, and the chip says nothing of it.
      const chip = page.locator('.model-picker__trigger').first()
      await expect(chip).not.toContainText('oversees')
      await chip.click()
      const dynamic = page.getByRole('switch', { name: 'Dynamic' })
      await expect(dynamic).toHaveAttribute('aria-checked', 'false')
      await expect(page.locator('.model-picker__foot')).toContainText('oversees and chooses a model for each piece. It does no work itself.')
      await dynamic.click()
      // The first time, a question names the companies, once.
      const asked = page.getByRole('dialog', { name: 'Turn on Dynamic for this thread?' })
      await expect(asked).toBeVisible()
      await expect(asked).toContainText('Anthropic')
      await expect(asked).toContainText('OpenAI')
      // Escape leaves everything as it was.
      await page.keyboard.press('Escape')
      await expect(asked).toBeHidden()
      expect(await page.evaluate(async () => (await window.sotto!.getSettings()).dynamicThreads.providers)).toBeUndefined()
      await expect(chip).not.toContainText('oversees')
      await chip.click()
      await dynamic.click()
      await asked.getByRole('button', { name: 'Turn on' }).click()
      await expect(chip).toContainText('oversees')
      await expect.poll(() => page.evaluate(async () => (await window.sotto!.getSettings()).dynamicThreads.providers)).toEqual(expect.arrayContaining(['claude', 'codex']))
      await expect.poll(() => page.evaluate(async threadId => (await window.sotto!.agents!.get()).host.threads.find(item => item.id === threadId)?.dynamic, id)).toBe(true)
      // After that the switch just switches, and the keyboard reaches it.
      await chip.click()
      await dynamic.focus()
      await page.keyboard.press('Space')
      await expect(dialogGone(page)).toBeHidden()
      await expect(dynamic).toHaveAttribute('aria-checked', 'false')
      await page.keyboard.press('Space')
      await expect(dynamic).toHaveAttribute('aria-checked', 'true')
      await page.keyboard.press('Escape')
      await expect(chip).toContainText('oversees')
      // The first message goes on the overseer's instructions.
      expect(await send(page, id, 'Fix the reconnect flake.')).toBeNull()
      await expect.poll(async () => (await fakeClaudeLaunches(join(root, 'claude'))).some(launch => appended(launch.args).includes('You do no work yourself')), { timeout: 30_000 }).toBe(true)
      // Settings holds the list, with who each provider's work goes to.
      await openSettingsAt(page)
      const card = page.locator('[data-setting="dynamic-threads"]')
      await expect(card).toBeVisible()
      await expect(card).toContainText('OpenAI')
      const codex = card.getByRole('checkbox', { name: /Codex/u })
      await expect(codex).toBeChecked()
      await codex.uncheck()
      await expect.poll(() => page.evaluate(async () => (await window.sotto!.getSettings()).dynamicThreads.providers)).not.toContain('codex')
      await card.getByLabel('Highest effort').selectOption('high')
      await expect.poll(() => page.evaluate(async () => (await window.sotto!.getSettings()).dynamicThreads.highestEffort)).toBe('high')
      const workers = card.getByLabel('Workers at once')
      await workers.fill('')
      await workers.blur()
      await expect(workers).toHaveValue('4')
      await workers.fill('2')
      await workers.press('Enter')
      await expect.poll(() => page.evaluate(async () => (await window.sotto!.getSettings()).dynamicThreads.workersAtOnce)).toBe(2)
      await card.screenshot({ path: join(profile, 'card.png') }).catch(() => undefined)
    })
  } finally {
    if (launched) await closeSotto(launched)
    await restore()
  }
})

test('the switch, a worker\'s row and the Settings card hold in both themes at every window size', async () => {
  test.setTimeout(240_000)
  const { profile, project, restore } = await fixture()
  const evidence = evidenceDirectory('artifacts/dynamic-threads')
  let launched: LaunchedSotto | undefined
  try {
    await onReleaseTrack('owl', async () => {
      launched = await launchSotto('success', profile)
      const { page } = launched
      const id = await newThread(page, project)
      await page.evaluate(() => window.sotto!.updateSettings({ dynamicThreads: { providers: ['claude', 'codex'], highestEffort: 'high', workersAtOnce: 4 } }))
      expect(await command(page, { type: 'set-thread-dynamic', threadId: id, dynamic: true })).toBeNull()
      expect(await send(page, id, 'Fix the reconnect flake.')).toBeNull()
      await expect.poll(() => page.evaluate(async threadId => (await window.sotto!.agents!.get()).host.threads.find(item => item.id === threadId)?.status !== 'running', id), { timeout: 30_000 }).toBe(true)
      await page.evaluate(async threadId => {
        const result = await window.sottoE2E!.delegationTool!({ threadId, name: 'delegate', arguments: { work: 'code-review', brief: 'Review the reconnect fix.', wait_seconds: 0, provider: 'codex', model: 'native:codex:model:gpt-6.1-sol', effort: 'max', permission: 'approval-required', why: 'Another maker\'s read, and Codex has room this week.' } })
        return result
      }, id)
      await page.reload()
      await openThreads(page)
      await page.getByRole('button', { name: 'Reconnect fix', exact: true }).first().click({ position: { x: 16, y: 12 } })
      await mkdir(evidence, { recursive: true })
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(theme => window.sotto!.updateSettings({ appearance: theme }), appearance)
        for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
          await resizeWindow(launched, width, height)
          const where = `${appearance} ${width}x${height}`
          await openThreads(page)
          const chip = page.locator('.thread-workspace .model-picker__trigger').first()
          await expect(chip, where).toContainText('oversees')
          const row = page.locator('.delegated-work__row', { hasText: 'GPT-6.1 Sol' }).first()
          const worked = page.getByRole('button', { name: /Worked for/u }).first()
          await expect(row.or(worked), where).toBeVisible({ timeout: 15_000 })
          if (!await row.isVisible()) await worked.click()
          await expect(row, where).toBeVisible()
          expect(await pageBoundProblems(page), where).toEqual([])
          await page.screenshot({ path: join(evidence, `row-${appearance}-${width}x${height}.png`), animations: 'disabled' })
          await chip.click()
          const foot = page.locator('.model-picker__foot')
          await expect(foot, where).toBeVisible()
          // Nothing in the menu is cut off at the smallest window: the foot sits wholly inside it.
          const box = await foot.boundingBox()
          expect(box!.y + box!.height, where).toBeLessThanOrEqual(height)
          await page.screenshot({ path: join(evidence, `menu-${appearance}-${width}x${height}.png`), animations: 'disabled' })
          await page.keyboard.press('Escape')
          await openPage(page, 'Settings')
          await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Threads', exact: true }).click()
          const card = page.locator('[data-setting="dynamic-threads"]')
          await card.scrollIntoViewIfNeeded()
          await expect(card, where).toBeVisible()
          expect(await settingsLayoutProblems(page, 'settings-agents', '.dynamic-threads, .dynamic-threads__provider'), where).toEqual({ pageOverflow: false, formOverflow: false, clipped: [] })
          const low = (await settingsTextContrast(page, 'settings-agents', '.dynamic-threads__lead, .dynamic-threads__note, .dynamic-threads__name, .dynamic-threads__name small, .dynamic-threads__limit')).filter(item => item.text.trim() && item.ratio < 4.5)
          expect(low, where).toEqual([])
          await page.screenshot({ path: join(evidence, `settings-${appearance}-${width}x${height}.png`), animations: 'disabled' })
        }
      }
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
