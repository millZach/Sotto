import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { hostKeysPerTest } from './support/hostKeys'
import { longHistory } from './support/longHistory'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'
import { evidenceDirectory } from '../fixtures/evidence'

// The composer's two styles (ADR-0168): Zach's composer, the prompt above a footer of attach, permissions, the model and
// its effort and the disc, is the default; Drake's one pill is the other, chosen in Settings › Appearance. Both draw at a
// laptop's size and at the window's minimum, dark and light, at rest and while a turn runs, without an edge and without
// spilling. Captures go to disposable run evidence; `SOTTO_E2E_EVIDENCE=publish` writes artifacts/composer-style.

const evidence = evidenceDirectory('artifacts/composer-style')
const hostKeys = hostKeysPerTest()
const key = hostKeys.key
test.beforeEach(() => { hostKeys.reset() })

async function prepare(launched: LaunchedSotto): Promise<void> {
  const { page } = launched
  await page.evaluate(async () => {
    await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', accent: 'blue' })
    await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true } })
    await window.sotto!.agents!.command({ type: 'connect' })
  })
  await page.reload()
  await hostKeys.read(page)
  await openThreads(page)
}

async function resize(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, [width, height]) => {
    BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.setContentSize(width, height)
  }, [width, height] as const)
  await expect.poll(() => launched.page.evaluate(([width, height]) => window.innerWidth === width && Math.abs(window.innerHeight - height) <= 2, [width, height] as const)).toBe(true)
}

const paneOf = (page: Page, threadId: string): Locator => page.locator(`section.thread-pane[data-thread-id="${key(threadId)}"]`)

/** Opens the thread by its ID: the fixture's history retitles it from its first message. */
async function selectThread(page: Page, threadId: string): Promise<void> {
  await page.evaluate(async id => { await window.sotto!.agents!.command({ type: 'select-thread', threadId: id }) }, key(threadId))
  await expect(paneOf(page, threadId)).toBeVisible()
}

interface Layout { style: string | null; edge: string; editor: number; card: number; spills: boolean; footerInside: boolean; promptAboveFooter: boolean; actions: string[] }

async function layout(pane: Locator): Promise<Layout> {
  return pane.evaluate(element => {
    const card = element.querySelector<HTMLElement>('.thread-workspace__compose > .thread-prompt')!
    const editor = card.querySelector<HTMLElement>('.prompt-editor')!.getBoundingClientRect()
    const footer = card.querySelector<HTMLElement>('.thread-prompt__footer')!.getBoundingClientRect()
    const box = card.getBoundingClientRect()
    return {
      style: card.getAttribute('data-style'), edge: getComputedStyle(card).borderTopColor, editor: Math.round(editor.width), card: Math.round(box.width),
      spills: element.scrollWidth > element.clientWidth + 1,
      footerInside: footer.left >= box.left - 1 && footer.right <= box.right + 1 && footer.bottom <= box.bottom + 1,
      promptAboveFooter: editor.bottom <= footer.top + 1,
      actions: [...card.querySelectorAll('.thread-prompt__actions > button')].map(button => button.getAttribute('aria-label') ?? ''),
    }
  })
}

async function capture(launched: LaunchedSotto, name: string, pane: Locator): Promise<void> {
  for (const [width, height] of [[1280, 800], [820, 560]] as const) {
    await resize(launched, width, height)
    for (const appearance of ['dark', 'light'] as const) {
      await launched.page.evaluate(async mode => window.sotto!.updateSettings({ appearance: mode }), appearance)
      await expect(launched.page.locator('html')).toHaveAttribute('data-theme', appearance)
      const shown = await layout(pane)
      const context = `${name} ${width}x${height} ${appearance} ${JSON.stringify(shown)}`
      expect(shown.spills, context).toBe(false)
      expect(shown.footerInside, context).toBe(true)
      // No edge in any state (ADR-0110): the card's border stays transparent.
      expect(shown.edge, context).toMatch(/rgba\(0, 0, 0, 0\)|transparent/u)
      if (shown.style === 'rows') {
        expect(shown.promptAboveFooter, context).toBe(true)
        expect(shown.editor, context).toBeGreaterThan(shown.card * 0.85)
      }
      await launched.page.screenshot({ path: join(evidence, `${name}-${width}-${appearance}.png`), animations: 'disabled' })
    }
  }
  await launched.page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
}

test('Zach’s composer is the default and Drake’s pill is one Appearance choice away, at rest and while a turn runs', async () => {
  test.setTimeout(240_000)
  const launched = await launchSotto('composer-speed')
  const { page } = launched
  try {
    await page.evaluate(async () => {
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true } })
      await window.sotto!.agents!.command({ type: 'connect' })
      await window.sotto!.agents!.command({ type: 'configure-thread', threadId: 'workshop', reasoningEffort: 'high', runtimeMode: 'full-access' })
      await window.sotto!.agents!.command({ type: 'configure-thread', threadId: 'docs', reasoningEffort: 'medium', speed: 'fast' })
    })
    await prepare(launched)
    await resize(launched, 1280, 800)
    await longHistory(page, 'workshop', 'workshop-style')
    await longHistory(page, 'docs', 'docs-style')
    // A turn under way in Docs: its reply streaming in.
    await page.evaluate(async () => window.sottoE2E!.agentEvent!({ type: 'stream', threadId: 'docs', messageId: 'docs-live', text: 'Checking the footer links against the sitemap.', status: 'running' }))

    await selectThread(page, 'workshop')
    const idle = paneOf(page, 'workshop')
    await expect(idle.locator('.thread-prompt')).toHaveAttribute('data-style', 'rows')
    // Permissions, then the model and its effort with the speed's bolt, at the footer's end.
    await expect(idle.locator('.thread-prompt__shield').getByRole('combobox', { name: 'Thread permissions' })).toBeVisible()
    await expect(idle.locator('.split-chip-effort__bolts')).toBeVisible()
    await capture(launched, 'rows-idle', idle)

    await selectThread(page, 'docs')
    const running = paneOf(page, 'docs')
    await expect(running.locator('.thread-prompt')).toHaveAttribute('data-style', 'rows')
    // With nothing typed, the disc is Stop and Stop is drawn once.
    await expect.poll(async () => (await layout(running)).actions).toEqual(['Stop agent'])
    await capture(launched, 'rows-working', running)
    await running.locator('.prompt-editor').click()
    await page.keyboard.type('Check the footer at 820 wide before the release notes.')
    // Typed, the disc is Queue and a small Stop stands beside it.
    await expect.poll(async () => (await layout(running)).actions).toEqual(['Stop agent', 'Queue prompt'])
    await capture(launched, 'rows-working-typed', running)

    await page.evaluate(async () => window.sotto!.updateSettings({ composerStyle: 'pill' }))
    await expect(running.locator('.thread-prompt')).toHaveAttribute('data-style', 'pill')
    await capture(launched, 'pill-working-typed', running)
    await selectThread(page, 'workshop')
    await capture(launched, 'pill-idle', idle)
    // Settings › Appearance offers the two, Drake's in use now; pressing Zach's brings it back.
    await resize(launched, 1280, 800)
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Appearance', exact: true }).click()
    const choice = page.getByRole('radiogroup', { name: 'Composer' })
    await expect(choice.getByRole('radio', { name: 'Use Drake’s composer, in use' })).toBeChecked()
    await choice.scrollIntoViewIfNeeded()
    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(async mode => window.sotto!.updateSettings({ appearance: mode }), appearance)
      await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
      await choice.screenshot({ path: join(evidence, `appearance-choice-${appearance}.png`), animations: 'disabled' })
    }
    await choice.getByRole('radio', { name: 'Use Zach’s composer' }).click()
    await expect(choice.getByRole('radio', { name: 'Use Zach’s composer, in use' })).toBeChecked()
    await expect.poll(() => page.evaluate(async () => (await window.sotto!.getSettings()).composerStyle)).toBe('rows')
  } finally {
    await closeSotto(launched)
  }
})
