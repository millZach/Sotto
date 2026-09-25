import { expect, test } from '@playwright/test'
import { closeSotto, launchSotto, openThreads } from './support/sottoLaunch'

// Chromium's style work, not an elapsed-time budget: editing a controlled
// textarea must not restyle an unrelated subtree through broad :has() rules.
const UNRELATED_ELEMENTS = 1_000

test('typing does not invalidate the whole window while the theme editor is closed', async () => {
  const launched = await launchSotto('phase3-workspace')
  const { page } = launched
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload()
    await openThreads(page)
    await page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: 'Grok voice previews', exact: true }).click()
    const input = page.locator('#thread-workspace-prompt')
    await input.fill('Start')
    await page.evaluate(count => {
      const background = document.createElement('aside')
      background.style.cssText = 'position:fixed;left:-10000px;top:0;visibility:hidden'
      for (let index = 0; index < count; index++) background.append(document.createElement('span'))
      document.body.append(background)
    }, UNRELATED_ELEMENTS)
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const session = await page.context().newCDPSession(page)
    const completed = new Promise<string>((resolve, reject) => session.once('Tracing.tracingComplete', event => {
      if (event.stream) resolve(event.stream)
      else reject(new Error('Chromium did not return its style trace'))
    }))
    await session.send('Tracing.start', { categories: 'devtools.timeline', transferMode: 'ReturnAsStream' })
    await input.pressSequentially(' typing a few more letters', { delay: 20 })
    await expect(input).toHaveValue('Start typing a few more letters')
    await session.send('Tracing.end')
    const stream = await completed
    let json = ''
    for (;;) {
      const part = await session.send('IO.read', { handle: stream })
      json += part.data
      if (part.eof) break
    }
    await session.send('IO.close', { handle: stream })
    const trace = JSON.parse(json) as { traceEvents: { name: string; args?: { elementCount?: number } }[] }
    const counts = trace.traceEvents.filter(event => event.name === 'UpdateLayoutTree').map(event => event.args?.elementCount ?? 0)
    expect(counts.length).toBeGreaterThan(0)
    const largest = Math.max(...counts)
    expect(largest, 'A composer edit restyled the unrelated subtree').toBeLessThan(UNRELATED_ELEMENTS)
  } finally { await closeSotto(launched) }
})
