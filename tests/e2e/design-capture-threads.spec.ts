import { expect, test } from '@playwright/test'

import { hostEntityKey } from '../../src/shared/clientIdentity'
import { withSotto } from '../fixtures/designCaptureProfile'
import { capturePage } from './support/designCapture'
import { openThreads } from './support/sottoLaunch'

const captureEnabled = process.env.SOTTO_DESIGN_CAPTURE === '1'

test.describe('authoritative design-review captures', () => {
  test.skip(!captureEnabled, 'Run through npm run design:capture or npm run design:verify')
  test.describe.configure({ mode: 'serial', timeout: 10 * 60_000 })

  for (const appearance of ['dark', 'light'] as const) test(`threads page states in ${appearance}`, async () => {
    const suffix = appearance === 'light' ? '-light' : ''
    await withSotto({ onboardingComplete: true, appearance, scenario: 'design-threads', agents: 'design-threads' }, async ({ page }) => {
      await openThreads(page)
      // The page still names itself for assistive technology; the heading is no longer drawn.
      await expect(page.getByRole('heading', { name: 'Threads' })).toBeAttached()
      await expect(page.getByRole('complementary', { name: 'Thread sidebar' })).toBeVisible()
      const open = async (title: string): Promise<void> => {
        const toggle = page.getByRole('button', { name: title, exact: true })
        await toggle.click()
        await expect(toggle).toHaveAttribute('aria-current', 'page')
        await toggle.scrollIntoViewIfNeeded()
      }
      await open('Visual gate flake')
      // The coordinator queues the fixture's permission request once it has connected; the beta answers it in the
      // thread's own pane rather than in a queue of its own on the page.
      await expect(page.getByRole('button', { name: 'Allow' })).toBeVisible()
      // The fixture still hands these threads to the coordinator, but the beta hides every managing control, so the
      // captures must show a thread that reads the same whether or not Sotto is managing it.
      await expect(page.getByRole('button', { name: 'Pause managing' })).toHaveCount(0)
      await capturePage(page, `threads-populated${suffix}.png`, { theme: appearance, category: 'threads', state: 'populated' })

      await open('Footer links')
      await expect(page.getByLabel('Thread transcript')).toContainText('Fixing the footer links')
      await capturePage(page, `threads-open-running${suffix}.png`, { theme: appearance, category: 'threads', state: 'open-running' })

      await open('Streaming WAV stall')
      await expect(page.getByLabel('Thread transcript')).toContainText('The length marker fix still fails')
      await expect(page.getByRole('button', { name: 'Resume managing' })).toHaveCount(0)
      await capturePage(page, `threads-stopped${suffix}.png`, { theme: appearance, category: 'threads', state: 'stopped-open' })

      await page.getByRole('searchbox', { name: 'Search threads' }).fill('codex')
      await expect(page.getByRole('button', { name: /Settled/ })).toHaveAttribute('aria-expanded', 'true')
      // The attention queue stays listed whatever the query; a Codex-only result set follows it.
      await expect(page.getByRole('button', { name: 'Visual gate flake', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Release notes 1.4', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Weekly note', exact: true })).toHaveCount(0)
      await page.evaluate("document.querySelector('.thread-nav__scroll')?.scrollTo(0, 0)")
      await capturePage(page, `threads-search${suffix}.png`, { theme: appearance, category: 'threads', state: 'search' })
    })

    await withSotto({ onboardingComplete: true, appearance, scenario: 'design-threads-empty', agents: 'design-threads-empty' }, async ({ page }) => {
      await openThreads(page)
      await expect(page.getByRole('heading', { name: /No threads yet|Nothing here yet/i })).toBeVisible()
      await capturePage(page, `threads-empty${suffix}.png`, { theme: appearance, category: 'threads', state: 'empty' })
    })
  })

  for (const appearance of ['dark', 'light'] as const) test(`phase two workspace composition in ${appearance}`, async () => {
    await withSotto({ onboardingComplete: true, appearance, scenario: 'design-threads', agents: 'design-threads' }, async ({ page, app }) => {
      const resize = async (width: number): Promise<void> => {
        await app.evaluate(({ BrowserWindow }, next) => {
          const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().endsWith('/index.html'))!
          window.setContentSize(next, 800)
        }, width)
        await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width)
      }
      await openThreads(page)
      await page.getByRole('button', { name: 'Grok voice previews', exact: true }).click()
      await resize(1600)
      // A row's actions take their place only while the row is hovered or focused.
      await page.getByRole('button', { name: 'Footer links', exact: true }).hover()
      await page.getByRole('button', { name: 'Open Footer links beside', exact: true }).click()
      await expect(page.getByRole('separator', { name: 'Resize panes', exact: true })).toBeVisible()
      await capturePage(page, `threads-split-workspace-${appearance}.png`, { theme: appearance, category: 'threads', state: 'split-workspace' })
      await resize(820)
      await expect(page.getByRole('tablist', { name: 'Open panes' })).toBeVisible()
      const hostId = await page.evaluate(async () => (await window.sotto!.agents!.get()).hostId)
      await expect(page.locator(`[id="thread-pane-${hostEntityKey(hostId, 'grok-previews')}"]`)).toHaveAttribute('inert')
      await capturePage(page, `threads-split-focus-820-${appearance}.png`, { theme: appearance, category: 'threads', state: 'split-focus-820' })
      await page.getByRole('button', { name: 'Tools', exact: true }).click()
      const tools = page.getByRole('complementary', { name: 'Tools', exact: true })
      // Files answers at most four requests at once and says it is busy past that, with Retry. Late in a full capture
      // run on a loaded machine the earlier panes' reads can still be in flight, so a busy answer is retried once.
      const unavailable = tools.getByText('The working folder is not available.', { exact: true })
      const busy = tools.getByText('Files is busy.', { exact: true })
      await expect(unavailable.or(busy)).toBeVisible()
      if (await busy.isVisible()) await tools.getByRole('button', { name: 'Retry', exact: true }).click()
      await expect(unavailable).toBeVisible()
      await capturePage(page, `threads-files-unavailable-${appearance}.png`, { theme: appearance, category: 'threads', state: 'files-unavailable' })
      await tools.getByRole('button', { name: 'Close tools panel' }).click()
      await page.getByRole('button', { name: 'New thread', exact: true }).first().click()
      const dialog = page.getByRole('dialog', { name: 'New thread', exact: true })
      // The top New thread button asks only which project; choosing one opens the thread on the Settings defaults (#347).
      await expect(dialog.getByRole('button', { name: 'sotto-site C:/sotto-site', exact: true })).toBeVisible()
      await capturePage(page, `threads-new-thread-chooser-${appearance}.png`, { theme: appearance, category: 'threads', state: 'new-thread-chooser' })
    })
  })
})
