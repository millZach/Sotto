/**
 * Owlets (ADR-0210) through the built app, on the Owl track, with the real Claude Code and Codex adapters over their fake
 * CLIs: the room switch opens the Owlets page, New owlet makes one on this computer, its row shows its name, role and home
 * computer, its thread opens beside the sidebar, Edit owlet renames it, and the Threads page lists none of it.
 *
 *   npm run build && npx playwright test tests/e2e/owlets.spec.ts
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { evidenceDirectory } from '../fixtures/evidence'
import { fakeClaudeLaunches } from '../fixtures/fakeClaudeRecords'
import { writeProviderAction } from '../fixtures/providerRecords'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { onReleaseTrack } from './support/releaseTrack'
import { closeSotto, launchSotto, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'

async function fixture() {
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-owlets-' })).directory
  const root = join(profile, 'native-fixture')
  for (const folder of ['claude', 'codex', 'project']) await mkdir(join(root, folder), { recursive: true })
  await writeFile(join(root, 'codex', 'script.json'), JSON.stringify({ reply: 'Done.', models: [{ id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', isDefault: true, defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['low', 'medium', 'high'].map(reasoningEffort => ({ reasoningEffort })) }] }))
  await writeFile(join(root, 'claude', 'script.json'), JSON.stringify({ reply: 'Two new messages since yesterday. Nothing needs you.' }))
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

/** Claude Code and Codex connected, and one ordinary project and thread beside the owlets. */
const connect = (page: Page, project: string): Promise<void> => page.evaluate(async path => {
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
  if (thread.error) throw new Error(thread.error)
}, project)

test('makes an owlet on the Owlets page, opens its thread, renames it, and keeps it off the Threads page', async () => {
  test.setTimeout(180_000)
  const { profile, root, project, restore } = await fixture()
  const evidence = evidenceDirectory('artifacts/owlets')
  await mkdir(evidence, { recursive: true })
  let launched: LaunchedSotto | undefined
  try {
    await onReleaseTrack('owl', async () => {
      launched = await launchSotto('success', profile)
      const { page } = launched
      await connect(page, project)
      await page.reload()
      await resizeWindow(launched, 1280, 800)
      const shot = (name: string) => page.screenshot({ path: join(evidence, `${name}.png`), animations: 'disabled' })

      await page.getByRole('tab', { name: 'Owlets', exact: true }).first().click()
      await expect(page.getByText('No owlets yet. Make one with New owlet.')).toBeVisible()
      await shot('empty-dark-1280')

      await page.getByRole('button', { name: 'New owlet' }).first().click()
      const setup = page.getByRole('dialog', { name: 'New owlet' })
      await expect(setup).toBeVisible()
      await setup.getByLabel('Name').fill('Tawny')
      await setup.getByLabel('Role').fill('Keeps my inbox')
      await expect(setup.getByText('Its folder: Owlets/Tawny on this computer.', { exact: false })).toBeVisible()
      await shot('setup-dark-1280')
      await setup.getByRole('button', { name: 'Make owlet' }).click()
      await expect(setup).toBeHidden({ timeout: 30_000 })

      const list = page.getByRole('navigation', { name: 'Owlets' })
      const row = list.getByRole('button', { name: /Tawny/u })
      await expect(row).toBeVisible()
      await expect(row).toContainText('Keeps my inbox')
      await expect(row).toContainText('This computer')
      await expect(page.getByRole('region', { name: 'Tawny' }).getByRole('heading', { name: 'Tawny' })).toBeVisible()
      await expect(page.getByText('Owlets/Tawny').first()).toBeVisible()

      // A second owlet, on Codex, so the list has an order to show.
      await page.getByRole('button', { name: 'New owlet' }).first().click()
      await setup.getByLabel('Name').fill('Scops')
      await setup.getByLabel('Role').fill('Keeps the repos tidy')
      await setup.getByLabel('Model').selectOption({ label: 'Codex · GPT-6.1 Sol' })
      await setup.getByRole('button', { name: 'Make owlet' }).click()
      await expect(setup).toBeHidden({ timeout: 30_000 })
      await expect(list.getByRole('button', { name: /Scops/u })).toBeVisible()
      await shot('page-dark-1280')

      // Talking to it is sending to its thread.
      await page.locator('#owlet-prompt').click()
      await page.keyboard.type('What came in overnight?')
      await page.keyboard.press('Enter')
      await expect(page.getByText('Two new messages since yesterday. Nothing needs you.').or(page.getByText('Done.')).first()).toBeVisible({ timeout: 30_000 })
      await shot('talking-dark-1280')

      await page.getByRole('button', { name: 'Edit Scops' }).click()
      const edit = page.getByRole('dialog', { name: 'Edit Scops' })
      await edit.getByLabel('Name').fill('Scops Owl')
      await edit.getByRole('button', { name: 'Save' }).click()
      await expect(edit).toBeHidden()
      await expect(list.getByRole('button', { name: /Scops Owl/u })).toBeVisible()
      await expect(page.getByText('Owlets/Scops').first()).toBeVisible()

      // Tawny, on Claude Code, starts with its auto memory off, and waits on a card: it leads the list under Needs you.
      await writeFile(join(root, 'claude', 'script.json'), JSON.stringify({}))
      await list.getByRole('button', { name: /Tawny/u }).click()
      await page.locator('#owlet-prompt').click()
      await page.keyboard.type('Answer Pat about Saturday.')
      await page.keyboard.press('Enter')
      await expect.poll(async () => (await fakeClaudeLaunches(join(root, 'claude'))).length, { timeout: 30_000 }).toBeGreaterThan(0)
      const [launch] = await fakeClaudeLaunches(join(root, 'claude'))
      expect(JSON.parse(launch!.args[launch!.args.lastIndexOf('--settings') + 1]!)).toMatchObject({ autoMemoryEnabled: false })
      expect(launch!.args[launch!.args.indexOf('--append-system-prompt') + 1]).toContain('You are Tawny, an owlet')
      await writeProviderAction(join(root, 'claude', `control-${launch!.session}.json`), { type: 'permission', text: 'Send the reply to Pat' })
      await expect(list.getByRole('heading', { name: /Needs you/u })).toBeVisible({ timeout: 30_000 })
      await shot('needs-dark-1280')

      await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'light' }))
      await shot('page-light-1280')
      await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark' }))
      await resizeWindow(launched, 820, 560)
      await shot('page-dark-820')
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await resizeWindow(launched, 1600, 1000)
      await shot('page-dark-1600-reduced-motion')
      await page.emulateMedia({ reducedMotion: 'no-preference' })

      // The Threads page lists the ordinary thread and none of the owlets or their folders.
      await page.getByRole('tab', { name: 'Threads', exact: true }).first().click()
      await expect(page.getByText('Reconnect fix').first()).toBeVisible()
      await expect(page.locator('.thread-nav').getByText('Tawny')).toHaveCount(0)
      await expect(page.locator('.thread-nav').getByText('Scops Owl')).toHaveCount(0)
      await shot('threads-dark-1600')
    })
  } finally {
    if (launched) await closeSotto(launched)
    await restore()
  }
})
