import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { closeSotto, launchSotto, openThreads } from './support/sottoLaunch'

test('pasting screenshots previews, sends image-only input, and queues another screenshot', async () => {
  test.setTimeout(60_000)
  const launched = await launchSotto()
  const { page } = launched
  const image = (await readFile('build/icon.png')).toString('base64')
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload(); await openThreads(page)
    await page.getByRole('button', { name: 'Workshop', exact: true }).click()
    const prompt = page.getByRole('textbox', { name: 'Prompt', exact: true })
    const paste = async (name: string) => {
      await prompt.evaluate((element, data) => {
        const transfer = new DataTransfer()
        transfer.items.add(new File([Uint8Array.from(atob(data.image), char => char.charCodeAt(0))], data.name, { type: 'image/png' }))
        element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
      }, { image, name })
      await expect(page.getByLabel('Attached screenshots').getByAltText(name)).toBeVisible()
    }
    await expect(page.getByRole('button', { name: 'Attach screenshots', exact: true })).toBeEnabled()
    await paste('Screenshot.png')
    await expect(prompt).toHaveValue('')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]]) {
      await launched.app.evaluate(({ BrowserWindow }, size) => {
        BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.setContentSize(size.width!, size.height!)
      }, { width, height })
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), appearance)
        await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
        await expect(page.getByRole('button', { name: 'Send prompt', exact: true })).toBeInViewport()
        await expect(page.getByLabel('Attached screenshots').getByAltText('Screenshot.png')).toBeInViewport()
        await page.screenshot({ path: `artifacts/codex-images/pasted-${width}-${appearance}.png`, animations: 'disabled' })
      }
    }
    await page.getByRole('button', { name: 'Send prompt', exact: true }).click()
    const transcript = page.getByLabel('Thread transcript', { exact: true })
    await expect(transcript.getByAltText('Screenshot.png')).toBeVisible()
    await expect(page.getByLabel('Attached screenshots')).toHaveCount(0)
    await paste('Next screenshot.png')
    await prompt.fill('Check this next.')
    await prompt.press('Enter')
    const queue = page.getByRole('region', { name: 'Queued messages' })
    await expect(queue).toContainText('Check this next.')
    const state = await page.evaluate(async () => window.sotto!.agents!.get())
    expect(state.followups).toContainEqual(expect.objectContaining({ attachments: [expect.objectContaining({ name: 'Next screenshot.png' })] }))
    expect(state.assignments).toEqual([])
    await page.screenshot({ path: 'artifacts/codex-images/sent-and-queued.png', animations: 'disabled' })
  } finally { await closeSotto(launched) }
})
