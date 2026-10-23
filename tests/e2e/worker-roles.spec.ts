/**
 * Worker roles (#1041, ADR-0091) as the window shows them and as a start uses them, on the Owl track, with the real Claude
 * and Codex adapters over the fake CLIs in `tests/fixtures/` (`SOTTO_E2E_NATIVE_FIXTURE_ROOT` in `src/main/index.ts`),
 * which list Opus, Sonnet and Haiku, and GPT-6.1 Sol, GPT-6 Astra and GPT-6 Luna. Settings, under Watcher, has a card
 * per role on its default: Orchestrating, Building and UI on Opus, Code review on GPT-6.1 Sol because Muse is not set
 * up, Research on Haiku, Computer use on GPT-6 Astra with Full access held to the new-thread default. A choice made by
 * keyboard becomes the user's, survives Claude Code disconnecting with a note, and Reset puts the default back. A
 * delegation that names only its kind of work starts on that role, and its result says so. Stable shows none of it.
 *
 *   npm run build && npx playwright test tests/e2e/worker-roles.spec.ts
 */
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { evidenceDirectory } from '../fixtures/evidence'
import { fakeClaudePrompts } from '../fixtures/fakeClaudeRecords'
import { pageBoundProblems } from './support/designCapture'
import { onReleaseTrack } from './support/releaseTrack'
import { settingsLayoutProblems, settingsTextContrast } from './support/settingsChecks'
import { closeSotto, launchSotto, openPage, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'

const evidence = evidenceDirectory('artifacts/worker-roles')
const FIVE = ['low', 'medium', 'high', 'xhigh', 'max']

/** A fresh profile whose app finds the fake CLIs, each listing the models the roles' defaults name. */
async function rolesProfile() {
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-worker-roles-' })).directory
  const root = join(profile, 'native-fixture')
  for (const folder of ['claude', 'codex', 'project']) await mkdir(join(root, folder), { recursive: true })
  await writeFile(join(root, 'claude', 'script.json'), '{}')
  await writeFile(join(root, 'claude', 'models.json'), JSON.stringify([
    { value: 'opus', displayName: 'Opus 5.5', supportsEffort: true, supportedEffortLevels: FIVE },
    { value: 'sonnet', displayName: 'Sonnet 5.5', supportsEffort: true, supportedEffortLevels: FIVE },
    { value: 'haiku', displayName: 'Haiku 5.5', supportsEffort: false },
  ]))
  const codexModel = (model: string, displayName: string, efforts: readonly string[], isDefault = false) => ({ id: model, model, displayName, isDefault,
    defaultReasoningEffort: 'medium', supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort })) })
  await writeFile(join(root, 'codex', 'script.json'), JSON.stringify({ models: [codexModel('gpt-6.1-sol', 'GPT-6.1 Sol', FIVE, true),
    codexModel('gpt-6-astra', 'GPT-6 Astra', [...FIVE, 'ultra']), codexModel('gpt-6-luna', 'GPT-6 Luna', ['minimal', 'low', 'medium', 'high'])] }))
  const previous = { SOTTO_E2E_NATIVE_FIXTURE_ROOT: process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT, SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE: process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE }
  process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT = root
  process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE = process.execPath
  const restore = async (): Promise<void> => {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value
    await removeOwnedE2EProfile(profile)
  }
  return { profile, root, project: join(root, 'project'), restore }
}

/** Claude Code and Codex connected, a project, and a Claude Code thread whose turn on the user's message is still running. */
async function connected(page: Page, project: string): Promise<string> {
  return page.evaluate(async path => {
    await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
    const agents = window.sotto!.agents!
    const configured = await agents.command({ type: 'configure', patch: { provider: 'claude', enabled: true, enabledProviders: ['claude', 'codex'], checkClientUpdates: false } })
    if (configured.error) throw new Error(configured.error)
    for (const provider of ['claude', 'codex'] as const) {
      const result = await agents.command({ type: 'connect', provider })
      if (result.error) throw new Error(result.error)
    }
    const created = await agents.command({ type: 'create-project', provider: 'claude', title: 'Harbour', path, useExisting: true })
    if (created.error) throw new Error(created.error)
    const projectId = created.host.projects.find(item => item.title === 'Harbour')!.id
    const model = (await agents.get()).host.models.find(item => item.providerId === 'claude' && item.ready)
    if (!model) throw new Error('No ready Claude model.')
    const thread = await agents.command({ type: 'create-thread', projectId, title: 'Reconnect fix', titleSource: 'user', modelId: model.id, workingCopy: 'shared', runtimeMode: 'approval-required' })
    if (thread.error || !thread.activeThreadId) throw new Error(thread.error ?? 'No thread was created.')
    const sent = await agents.command({ type: 'manual-send', threadId: thread.activeThreadId, text: 'Fix the reconnect flake, and have it reviewed.' })
    if (sent.error) throw new Error(sent.error)
    return thread.activeThreadId
  }, project)
}

const panel = (page: Page): Locator => page.locator('#settings-watcher')
const card = (page: Page, name: string): Locator => panel(page).getByRole('article', { name, exact: true })
async function openRoles(page: Page): Promise<void> {
  await openPage(page, 'Settings')
  await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Watcher', exact: true }).click()
  await expect(panel(page).getByRole('heading', { name: 'Worker roles' })).toBeVisible()
}
/** The model, effort and permission each card's fields show, in order. */
async function fields(page: Page, name: string): Promise<string[]> {
  return card(page, name).locator('.worker-role__fields').evaluate(element => [...element.querySelectorAll('.worker-role__field')]
    .map(field => (field.querySelector('button.thread-chip, .worker-role__none')?.textContent ?? '').trim()))
}
/** Nothing clipped or overflowing, and every word in the panel at 4.5:1 against what it sits on. */
async function checked(page: Page, where: string): Promise<void> {
  expect(await pageBoundProblems(page), where).toEqual([])
  expect(await settingsLayoutProblems(page, 'settings-watcher', '.worker-role, .worker-role button, .worker-role__note, .worker-roles__summary'), where)
    .toEqual({ pageOverflow: false, formOverflow: false, clipped: [] })
  const overflow = await panel(page).evaluate(element => [...element.querySelectorAll<HTMLElement>('.worker-role, .worker-role__field, .worker-role__defaults li')]
    .filter(item => item.scrollWidth > item.clientWidth + 1).map(item => item.className))
  expect(overflow, where).toEqual([])
  const selectors = '.worker-roles__lead, .worker-roles__head h3, .worker-role__head h4, .worker-role__tag, .worker-role__what, .worker-role__field > span:first-child, '
    + '.worker-role__field .thread-chip > span:not(.provider-mark), .worker-role__none, .worker-role__note, .worker-role__defaults-head span, .worker-role__defaults li > span:not(.provider-mark), '
    + '.worker-role__link, .worker-role__caption, .worker-role__composer > span:first-child, .worker-role__chip > span:not(.provider-mark), .worker-roles__summary, .worker-roles__reset-all:not(:disabled)'
  const low = (await settingsTextContrast(page, 'settings-watcher', selectors)).filter(item => item.text.trim() && item.ratio < 4.5)
  expect(low, where).toEqual([])
}
async function capture(launched: LaunchedSotto, name: string): Promise<void> {
  await mkdir(evidence, { recursive: true })
  await launched.page.mouse.move(0, 0)
  await launched.page.screenshot({ path: join(evidence, `${name}.png`), animations: 'disabled' })
}
type ToolResult = { status: string; code?: string; message?: string; delegation?: { id: string; thread?: string; outcome: string }; role?: { work: string; named: string[]; note: string } }
const delegate = (page: Page, threadId: string, args: Record<string, unknown>): Promise<ToolResult> => page.evaluate(async ({ threadId, args }) => {
  const result = await window.sottoE2E!.delegationTool!({ threadId, name: 'delegate', arguments: args })
  const text = result.content.find(item => item.type === 'text')
  return JSON.parse(text && 'text' in text ? text.text : '{}') as ToolResult
}, { threadId, args })

test('Settings, under Watcher, gives each kind of work its model, and a delegation starts on its role', async () => {
  test.setTimeout(300_000)
  const { profile, root, project, restore } = await rolesProfile()
  let launched: LaunchedSotto | undefined
  try {
    await onReleaseTrack('owl', async () => {
      launched = await launchSotto('success', profile)
      const { page } = launched
      const parentId = await connected(page, project)
      await expect.poll(() => fakeClaudePrompts(join(root, 'claude')), { timeout: 30_000 }).toBe(1)
      await page.reload()
      await resizeWindow(launched, 1280, 800)
      await openRoles(page)

      // Each role on its default with Claude Code and Codex connected. Muse is not set up, so Code review is on its next.
      expect(await fields(page, 'Orchestrating')).toEqual(['Opus 5.5', 'High', 'Ask for approval'])
      expect(await fields(page, 'Building')).toEqual(['Opus 5.5', 'Extra high', 'Allow edits'])
      expect(await fields(page, 'UI')).toEqual(['Opus 5.5', 'Extra high', 'Allow edits'])
      expect(await fields(page, 'Code review')).toEqual(['GPT-6.1 Sol', 'Extra high', 'Ask for approval'])
      expect(await fields(page, 'Research')).toEqual(['Haiku 5.5', 'Haiku 5.5 has none', 'Ask for approval'])
      expect(await fields(page, 'Computer use')).toEqual(['GPT-6 Astra', 'Medium', 'Full access'])
      const computer = card(page, 'Computer use').locator('.worker-role__note')
      await expect(computer).toHaveText([/^Workers never start wider than your new-thread default, so these start on “Ask for approval”\. Change it in Agents$/u,
        'On Windows, Codex’s Computer Use can be stopped by its own sandbox below Full access. If it is, nothing is changed and the worker says so.'])
      const review = card(page, 'Code review').locator('.worker-role__defaults li')
      await expect(review.nth(0)).toContainText('Muse Wonder Full, Extra high')
      await expect(review.nth(0)).toContainText('Not set up')
      await expect(review.nth(1)).toContainText('In use')
      await expect(card(page, 'Building').locator('.worker-role__tag')).toHaveText('Default')
      await expect(panel(page).getByRole('button', { name: /^Reset all roles to their defaults/u })).toBeDisabled()
      // Orchestrating is drawn beside Watcher's composer chips: the same three.
      await expect(card(page, 'Orchestrating').locator('.worker-role__chip')).toHaveText(['Opus 5.5', 'High', 'Ask for approval'])

      for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
        await resizeWindow(launched, width, height)
        for (const appearance of ['dark', 'light'] as const) {
          await page.evaluate(appearance => window.sotto!.updateSettings({ appearance }), appearance)
          await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
          await panel(page).getByRole('heading', { name: 'Worker roles' }).scrollIntoViewIfNeeded()
          await checked(page, `defaults ${appearance} ${width}x${height}`)
          await capture(launched, `roles-${appearance}-${width}x${height}`)
          await card(page, 'Code review').scrollIntoViewIfNeeded()
          await capture(launched, `roles-lower-${appearance}-${width}x${height}`)
        }
      }
      await resizeWindow(launched, 1280, 800)
      await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark' }))

      // By keyboard: Building's model chip opens the model list with focus in its search; Sonnet is chosen and saved.
      const building = card(page, 'Building')
      const model = building.getByRole('combobox', { name: /^Choose Building’s model\. Now Opus 5\.5/u })
      await model.focus()
      await page.keyboard.press('Enter')
      const dialog = page.getByRole('dialog', { name: 'Choose model' })
      await expect(dialog.getByRole('textbox', { name: 'Search models' })).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await expect(model).toBeFocused()
      await page.keyboard.press('Enter')
      await page.keyboard.type('Sonnet')
      await page.keyboard.press('ArrowDown')
      await expect(dialog.getByRole('option', { name: 'Sonnet 5.5' })).toBeFocused()
      await page.keyboard.press('Enter')
      await expect.poll(() => fields(page, 'Building')).toEqual(['Sonnet 5.5', 'Extra high', 'Allow edits'])
      await expect(building.locator('.worker-role__tag')).toHaveText('Your choice')
      await expect.poll(() => page.evaluate(async () => (await window.sotto!.getSettings()).workerRoles.building?.modelId)).toBe('native:claude:model:sonnet')
      // The permission list opens on the row's mode, and Escape puts focus back on its chip.
      const permission = building.getByRole('combobox', { name: /^Choose what Building workers may do without asking/u })
      await permission.focus()
      await page.keyboard.press('Enter')
      await expect(building.getByRole('option', { name: /^Allow edits/u })).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(permission).toBeFocused()
      const resetAll = panel(page).getByRole('button', { name: 'Reset all roles to their defaults. 1 role is your choice' })
      await expect(resetAll).toBeEnabled()
      await capture(launched, 'roles-building-chosen-dark-1280x800')

      // Claude Code disconnects: the rows on its models move to their next default and say so; the choice stays.
      await page.evaluate(async () => { const result = await window.sotto!.agents!.command({ type: 'disconnect', provider: 'claude' }); if (result.error) throw new Error(result.error) })
      await expect(building.locator('.worker-role__tag')).toHaveText('Your choice, not available', { timeout: 30_000 })
      await expect(building.locator('.worker-role__note[data-kind="moved"]')).toHaveText('Your choice, Sonnet 5.5, stays. Claude Code is not connected, so until it is, workers start on GPT-6.1 Sol, the next default.')
      expect(await fields(page, 'UI')).toEqual(['GPT-6.1 Sol', 'Extra high', 'Allow edits'])
      await expect(card(page, 'UI').locator('.worker-role__tag')).toHaveText('Next default')
      await expect(panel(page).locator('.worker-roles__summary')).toContainText('Claude Code is not connected, so')
      await panel(page).getByRole('heading', { name: 'Worker roles' }).scrollIntoViewIfNeeded()
      for (const [width, height] of [[1280, 800], [820, 560]] as const) {
        await resizeWindow(launched, width, height)
        for (const appearance of ['dark', 'light'] as const) {
          await page.evaluate(appearance => window.sotto!.updateSettings({ appearance }), appearance)
          await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
          await checked(page, `claude off ${appearance} ${width}x${height}`)
          await capture(launched, `roles-claude-off-${appearance}-${width}x${height}`)
        }
      }
      await resizeWindow(launched, 1280, 800)
      await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark' }))
      await page.evaluate(async () => { const result = await window.sotto!.agents!.command({ type: 'connect', provider: 'claude' }); if (result.error) throw new Error(result.error) })
      await expect(building.locator('.worker-role__tag')).toHaveText('Your choice', { timeout: 30_000 })

      // Reset puts the default back and says so, with Undo.
      await building.getByRole('button', { name: 'Reset Building to its default, Opus 5.5 at Extra high with Allow edits' }).click()
      await expect.poll(() => fields(page, 'Building')).toEqual(['Opus 5.5', 'Extra high', 'Allow edits'])
      await expect(panel(page).locator('.worker-roles__said')).toContainText('Building is back on its default, Opus 5.5 at Extra high.')
      await panel(page).locator('.worker-roles__said').getByRole('button', { name: 'Undo' }).click()
      await expect.poll(() => fields(page, 'Building')).toEqual(['Sonnet 5.5', 'Extra high', 'Allow edits'])
      await resetAll.click()
      await expect.poll(() => page.evaluate(async () => (await window.sotto!.getSettings()).workerRoles)).toEqual({})

      // One start by role: a delegation that names only its kind of work starts on Code review's GPT-6.1 Sol at Extra high,
      // held to the delegating thread's Ask for approval, and its result says it came from the role.
      const started = await delegate(page, parentId, { work: 'code-review', title: 'Review the reconnect diff', brief: 'Review the diff on the reconnect fix.', wait_seconds: 0 })
      expect(started, JSON.stringify(started)).toMatchObject({ status: 'ok', role: { work: 'code-review', named: [] } })
      expect(started.role!.note).toContain('Started as Code review')
      const child = async () => page.evaluate(async parentId => {
        const thread = (await window.sotto!.agents!.get()).host.threads.find(item => item.delegatedBy === parentId && item.title === 'Review the reconnect diff')
        return thread && { providerId: thread.providerId, modelId: thread.modelId, reasoningEffort: thread.reasoningEffort, runtimeMode: thread.runtimeMode }
      }, parentId)
      await expect.poll(child, { timeout: 30_000 }).toEqual({ providerId: 'codex', modelId: 'native:codex:model:gpt-6.1-sol', reasoningEffort: 'xhigh', runtimeMode: 'approval-required' })
      // Words override a role for one request: a named model wins, and the result says so.
      const named = await delegate(page, parentId, { work: 'research', title: 'Find the flake', brief: 'Find where the reconnect flake comes from.', provider: 'codex', model: 'native:codex:model:gpt-6-luna', wait_seconds: 0 })
      expect(named, JSON.stringify(named)).toMatchObject({ status: 'ok', role: { work: 'research', named: ['model'] } })
      expect(named.role!.note).toContain('This request named its model')
    })
  } finally {
    if (launched) await closeSotto(launched)
    await restore()
  }
})

test('stable shows no worker roles and no Watcher page in Settings', async () => {
  test.setTimeout(120_000)
  const { profile, project, restore } = await rolesProfile()
  let launched: LaunchedSotto | undefined
  try {
    await onReleaseTrack('stable', async () => {
      launched = await launchSotto('success', profile)
      const { page } = launched
      await connected(page, project)
      await page.reload()
      await openPage(page, 'Settings')
      const tabs = page.getByRole('tablist', { name: 'Settings sections' })
      await expect(tabs.getByRole('tab', { name: 'Threads', exact: true })).toBeVisible()
      await expect(tabs.getByRole('tab', { name: 'Watcher', exact: true })).toHaveCount(0)
      await expect(page.locator('#settings-watcher')).toHaveCount(0)
      await expect(page.locator('.worker-role')).toHaveCount(0)
    })
  } finally {
    if (launched) await closeSotto(launched)
    await restore()
  }
})
