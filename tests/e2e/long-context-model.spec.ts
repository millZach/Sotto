import { promptField } from './support/prompt'
import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { closeSotto, launchSotto, openThreads } from './support/sottoLaunch'

// Claude Code 2.1.283 lists `opus` and no `opus[1m]`, which threads still carry (#344). The fixture's catalog has
// `claude:test` alone, and this thread is on its long-context variant.
test('a thread on a long-context model its catalog lists only by the base takes a screenshot and names the base model', async () => {
  test.setTimeout(60_000)
  const launched = await launchSotto()
  const { page } = launched
  const image = (await readFile('build/icon.png')).toString('base64')
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await window.sotto!.agents!.command({ type: 'connect' })
      const created = await window.sotto!.agents!.command({ type: 'create-thread', projectId: 'project', title: 'Long context', modelId: 'claude:test[1m]', managed: false })
      if (created.error) throw new Error(created.error)
    })
    await page.reload(); await openThreads(page)
    await page.getByRole('button', { name: 'Long context', exact: true }).click()
    // The chip carries the provider's mark beside the name, so its title is the name alone.
    await expect(page.getByRole('combobox', { name: 'Thread model' })).toHaveAttribute('title', 'Claude Test')
    await expect(page.getByRole('button', { name: 'Attach screenshots', exact: true })).toBeEnabled()
    const prompt = promptField(page)
    await prompt.evaluate((element, data) => {
      const transfer = new DataTransfer()
      transfer.items.add(new File([Uint8Array.from(atob(data), char => char.charCodeAt(0))], 'Screenshot.png', { type: 'image/png' }))
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
    }, image)
    await expect(page.getByLabel('Attached screenshots').getByAltText('Screenshot.png')).toBeVisible()
    await expect(page.getByText('This model does not support screenshots.', { exact: false })).toHaveCount(0)
    await page.getByRole('button', { name: 'Send prompt', exact: true }).click()
    await expect(page.getByLabel('Thread transcript', { exact: true }).getByAltText('Screenshot.png')).toBeVisible()
    const state = await page.evaluate(async () => window.sotto!.agents!.get())
    expect(state.host.threads.find(thread => thread.title === 'Long context')?.modelId).toBe('claude:test[1m]')
  } finally { await closeSotto(launched) }
})
