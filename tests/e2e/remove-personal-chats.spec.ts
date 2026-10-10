import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeSotto, launchSotto, openPage, type LaunchedSotto } from './support/sottoLaunch'
import { evidenceDirectory } from '../fixtures/evidence'

const shots = evidenceDirectory('artifacts/remove-personal-chats')

async function resize(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!
    window.setContentSize(size.width, size.height)
  }, { width, height })
  await expect.poll(() => launched.page.evaluate(() => innerWidth)).toBe(width)
}

test('removes standalone Chats while keeping desktop navigation, thread requests and old chat files', async () => {
  test.setTimeout(120_000)
  const launched = await launchSotto()
  const { page } = launched
  const legacyDirectory = join(launched.userData, 'personal-chat')
  const legacyFile = join(legacyDirectory, 'chats.json')
  const legacy = '{"version":1,"chats":[],"retained":"Existing chat data"}\n'
  try {
    await page.evaluate(async () => { await window.sotto!.updateSettings({ onboardingComplete: true, historyEnabled: true }) })
    await mkdir(legacyDirectory, { recursive: true })
    await writeFile(legacyFile, legacy, 'utf8')
    await page.evaluate(async () => {
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload()
    await expect(page.getByRole('complementary', { name: 'Thread sidebar', exact: true })).toBeVisible()
    expect(await page.evaluate(() => ['personalChats', 'chatPrompts'].filter(key => key in window.sotto!))).toEqual([])
    expect(await launched.app.evaluate(({ ipcMain }) => [...(ipcMain as unknown as { _invokeHandlers: Map<string, unknown> })._invokeHandlers.keys()]
      .filter(channel => channel.startsWith('personal-chat:') || channel.startsWith('chat-prompt:')))).toEqual([])

    await mkdir(shots, { recursive: true })
    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
      await resize(launched, width, height)
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(async appearance => { await window.sotto!.updateSettings({ appearance }) }, appearance)
        await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
        await expect(page.getByRole('link', { name: 'Chats', exact: true })).toHaveCount(0)
        await expect(page.getByRole('navigation', { name: 'Pages', exact: true }).getByRole('link')).toHaveText(['History', 'Settings', 'Help'])
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true)
        await page.screenshot({ path: `${shots}/threads-${width}x${height}-${appearance}.png` })
      }
    }

    await page.evaluate(async () => { await window.sotto!.updateSettings({ reducedMotion: 'on' }) })
    await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'on')
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Expand sidebar', exact: true })).toBeFocused()
    const history = page.getByRole('link', { name: 'History', exact: true })
    await history.focus()
    await page.keyboard.press('Tab')
    await expect(page.getByRole('link', { name: 'Settings', exact: true })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('tablist', { name: 'Settings sections' })).toBeVisible()
    await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Agents', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'New threads', exact: true })).toBeVisible()
    await expect(page.getByRole('group', { name: 'New threads start with', exact: true })).toBeVisible()
    await expect(page.getByText('Reasoning', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Personal chats and reasoning', { exact: true })).toHaveCount(0)
    await page.screenshot({ path: `${shots}/settings-820x560-light-reduced-motion.png` })

    for (const name of ['Help', 'History'] as const) {
      await openPage(page, name)
      await expect(page.getByRole('link', { name: 'Chats', exact: true })).toHaveCount(0)
    }
    await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
    await openPage(page, 'Dictate')
    await expect(page.getByRole('heading', { name: /ready when you are/i })).toBeVisible()
    await page.getByRole('tab', { name: 'Threads', exact: true }).click()
    await page.getByRole('button', { name: 'Workshop', exact: true }).click()
    await page.evaluate(async () => { await window.sottoE2E!.agentEvent!({ type: 'question', threadId: 'workshop', text: 'Keep the thread question?', request: {
      id: 'retained-thread-question', kind: 'question', text: 'Keep the thread question?', options: [{ id: 'keep', label: 'Keep it' }],
    } }) })
    await expect(page.locator('.thread-questions')).toContainText('Keep the thread question?')
    await page.screenshot({ path: `${shots}/question-820x560-light-reduced-motion.png` })
    expect(await readFile(legacyFile, 'utf8')).toBe(legacy)
  } finally { await closeSotto(launched) }
})
