import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { closeSotto, launchSotto, openPage, openThreads, type LaunchedSotto } from './support/sottoLaunch'

test('new threads inherit Agents despite a saved Grok override and wait if that agent disconnects', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-agent-default-'))
  const root = join(profile, 'fixture'), projectPath = join(root, 'project')
  await mkdir(projectPath, { recursive: true })
  const previousRoot = process.env.SOTTO_E2E_DEVIN_ROOT
  const previousExecutable = process.env.SOTTO_E2E_DEVIN_EXECUTABLE
  // This boundary wraps the other three providers in native ID adapters around local fixtures.
  process.env.SOTTO_E2E_DEVIN_ROOT = root
  process.env.SOTTO_E2E_DEVIN_EXECUTABLE = process.execPath
  let launched: LaunchedSotto | undefined
  try {
    launched = await launchSotto('success', profile)
    const { page } = launched
    const chosen = await page.evaluate(async path => {
      await window.sotto!.updateSettings({ onboardingComplete: true })
      const agents = window.sotto!.agents!
      await agents.command({ type: 'connect', provider: 'grok' })
      const state = await agents.command({ type: 'connect', provider: 'claude' })
      const claude = state.host.models.find(model => model.providerId === 'claude')!
      const grok = state.host.models.find(model => model.providerId === 'grok')!
      const configured = await agents.command({ type: 'configure', patch: { reasoning: 'claude', reasoningModel: decodeURIComponent(claude.id.slice('native:claude:model:'.length)), defaultModelId: grok.id } })
      if (configured.error) throw new Error(configured.error)
      const project = await agents.command({ type: 'create-project', provider: 'claude', title: 'Inheritance check', path, useExisting: true })
      if (project.error) throw new Error(project.error)
      return { modelId: claude.id, modelName: claude.name }
    }, projectPath)
    await page.reload()
    await openPage(page, 'Settings')
    await page.getByRole('tab', { name: 'Providers', exact: true }).click()
    await expect(page.getByText('New threads use the agent selected in Settings → Agents.')).toBeVisible()
    await expect(page.getByRole('combobox', { name: /default thread model/ })).toHaveCount(0)
    await mkdir('artifacts/new-thread-setup', { recursive: true })
    await page.screenshot({ path: 'artifacts/new-thread-setup/providers-inherit-agent.png', animations: 'disabled' })
    await openThreads(page)
    await page.getByRole('button', { name: 'New thread in Inheritance check', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'New thread', exact: true })
    await expect(dialog.locator('summary')).toContainText(chosen.modelName)
    await dialog.getByRole('button', { name: 'Create thread', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(() => page.evaluate(async () => {
      const state = await window.sotto!.agents!.get()
      const thread = state.host.threads.find(thread => thread.id === state.activeThreadId)
      return { modelId: thread?.modelId, providerId: thread?.providerId }
    })).toEqual({ modelId: chosen.modelId, providerId: 'claude' })
    await page.evaluate(async () => window.sotto!.agents!.command({ type: 'disconnect', provider: 'claude' }))
    await page.getByRole('button', { name: 'New thread in Inheritance check', exact: true }).click()
    await expect(dialog.getByRole('button', { name: 'Create thread', exact: true })).toBeDisabled()
    await expect(dialog.getByRole('status')).toContainText('Claude Code is not ready')
    await page.screenshot({ path: 'artifacts/new-thread-setup/inherited-agent-unavailable.png', animations: 'disabled' })
    await page.evaluate(async () => window.sotto!.agents!.command({ type: 'connect', provider: 'claude' }))
    await expect(dialog.getByRole('button', { name: 'Create thread', exact: true })).toBeEnabled()
    await expect(dialog.locator('summary')).toContainText(chosen.modelName)
    await page.keyboard.press('Escape')
  } finally {
    if (launched) await closeSotto(launched)
    if (previousRoot === undefined) delete process.env.SOTTO_E2E_DEVIN_ROOT; else process.env.SOTTO_E2E_DEVIN_ROOT = previousRoot
    if (previousExecutable === undefined) delete process.env.SOTTO_E2E_DEVIN_EXECUTABLE; else process.env.SOTTO_E2E_DEVIN_EXECUTABLE = previousExecutable
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true })
  }
})
