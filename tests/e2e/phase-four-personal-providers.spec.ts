import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeSotto, launchSotto } from './support/sottoLaunch'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'

test('Claude and Grok use their own saved-chat identity, native requests and keyboard composer in Electron', async () => {
  test.setTimeout(90_000)
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-phase4-personal-'))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, historyEnabled: true }))
  const launched = await launchSotto('success', profile)
  const { page, app } = launched
  await mkdir('artifacts/phase-four-native-chats', { recursive: true })
  try {
    await page.evaluate(async () => window.sotto!.updateSettings({ onboardingComplete: true, historyEnabled: true }))
    await page.getByRole('link', { name: 'Chats', exact: true }).click()
    for (const [provider, label] of [['claude', 'Claude'], ['grok', 'Grok']] as const) {
      await page.evaluate(async provider => window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false, reasoning: provider, reasoningModel: `${provider}:test`, reasoningEffort: 'low' } }), provider)
      await page.getByRole('navigation', { name: 'Chats', exact: true }).getByRole('button', { name: 'New chat', exact: true }).click()
      const composer = page.getByRole('textbox', { name: 'Message', exact: true })
      await expect(composer).toBeEnabled()
      await composer.fill(`${label} conversation`)
      await composer.press('Enter')
      await expect(page.getByText(`You said: ${label} conversation`)).toBeVisible()
      await expect(page.getByPlaceholder(`Reply to ${label}`)).toBeVisible()
      const id = await page.evaluate(async () => (await window.sotto!.personalChats!.get()).selectedChatId!)
      await page.evaluate(async id => window.sottoE2E!.agentEvent!({ scope: 'personal', type: 'permission', threadId: id, text: '', request: {
        id: 'permission-check', kind: 'permission', text: 'Read the suggested itinerary', options: [],
        permissionChoices: [{ id: 'native:once', label: 'Allow once', kind: 'allow-once' }, { id: 'native:deny', label: 'Skip', kind: 'deny' }],
      } }), id)
      await expect(page.getByRole('button', { name: 'Allow once', exact: true })).toBeVisible()
      for (const [width, height, theme] of [[1280, 900, 'dark'], [820, 560, 'light']] as const) {
        await app.evaluate(({ BrowserWindow }, { width, height }) => { const win = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!; win.setSize(width, height) }, { width, height })
        await page.evaluate(async theme => window.sotto!.updateSettings({ appearance: theme }), theme)
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
        await page.screenshot({ path: `artifacts/phase-four-native-chats/${provider}-${width}-${theme}.png` })
      }
      await page.getByRole('button', { name: 'Skip', exact: true }).click()
      await expect(page.locator('.agent-request')).toHaveCount(0)
      await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
      await expect(page.getByRole('button', { name: `Connect ${label}`, exact: true })).toBeVisible()
      await page.getByRole('button', { name: `Connect ${label}`, exact: true }).click()
      await expect(page.getByPlaceholder(`Reply to ${label}`)).toBeEnabled()
    }
    const state = await page.evaluate(async () => window.sotto!.personalChats!.get())
    expect(state.chats.map(chat => chat.providerId)).toEqual(['grok', 'claude'])
    expect(state.chats.every(chat => !('projectId' in chat) && chat.decisions?.[0]?.status === 'accepted')).toBe(true)
  } finally { await closeSotto(launched) }
})
