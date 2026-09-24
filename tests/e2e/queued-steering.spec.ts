import { expect, test } from '@playwright/test'
import { hostKeys } from './support/hostKeys'
import { closeSotto, launchSottoWithVoice, openThreads, userMessageTexts } from './support/sottoLaunch'

test('steers a queued message from the keyboard without consuming the newer draft', async () => {
  const launched = await launchSottoWithVoice('queued-steering')
  const { page } = launched
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload()
    const docs = (await hostKeys(page))('docs')
    await openThreads(page)
    await page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: 'Docs', exact: true }).click()
    const pane = page.locator(`section.thread-pane[data-thread-id="${docs}"]`)
    const prompt = pane.locator('form.thread-prompt textarea')
    await prompt.fill('Start the work')
    await prompt.press('Enter')
    await expect(pane.getByLabel('Thread transcript')).toContainText('Start the work')
    await expect.poll(() => page.evaluate(async docs => (await window.sotto!.agents!.get()).host.threads.find(t => t.id === docs)?.lastTurn?.status, docs)).toBe('running')
    const turn = await page.evaluate(async docs => (await window.sotto!.agents!.get()).host.threads.find(t => t.id === docs)!.lastTurn!.id, docs)
    for (const text of ['Keep this queued', 'Use the simpler approach']) {
      await prompt.fill(text)
      await prompt.press('Enter')
    }
    const queue = pane.getByRole('region', { name: 'Queued messages' })
    await expect(queue.getByRole('button', { name: 'Steer now', exact: true })).toHaveCount(2)
    await prompt.fill('Keep this newer draft')
    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(appearance => window.sotto!.updateSettings({ appearance }), appearance)
      for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]]) {
        await launched.app.evaluate(({ BrowserWindow }, [width, height]) => {
          const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'))!
          window.setMinimumSize(700, 500); window.setContentSize(width!, height!)
        }, [width, height])
        await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
        const toggle = queue.getByRole('button', { name: /^Queued/ })
        if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click()
        await expect(queue.getByRole('button', { name: 'Steer now' }).last()).toBeVisible()
        expect(await queue.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
        await page.screenshot({ path: `artifacts/queued-steering/${appearance}-${width}.png`, animations: 'disabled' })
      }
    }
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const steer = queue.locator('li').filter({ hasText: 'Use the simpler approach' }).getByRole('button', { name: 'Steer now' })
    await expect(steer).toBeEnabled()
    await steer.focus()
    await page.keyboard.press('Enter')
    await expect(queue).not.toContainText('Use the simpler approach')
    await expect(queue).toContainText('Keep this queued')
    await expect(prompt).toHaveValue('Keep this newer draft')
    await expect(queue.getByRole('button', { name: /^Queued/ })).toBeFocused()
    const state = await page.evaluate(() => window.sotto!.agents!.get())
    const thread = state.host.threads.find(t => t.id === docs)!
    expect(thread.lastTurn?.id).toBe(turn)
    expect(await userMessageTexts(page, 'docs')).toEqual(['Start the work', 'Use the simpler approach'])
    await expect(queue.getByRole('button', { name: 'Steer now' })).toBeEnabled()
    await queue.getByRole('button', { name: 'Steer now' }).focus()
    await page.keyboard.press('Enter')
    await expect(queue).toHaveCount(0)
    await expect(prompt).toBeFocused()
    await expect(prompt).toHaveValue('Keep this newer draft')
    expect(await userMessageTexts(page, 'docs')).toEqual(['Start the work', 'Use the simpler approach', 'Keep this queued'])
  } finally { await closeSotto(launched) }
})
