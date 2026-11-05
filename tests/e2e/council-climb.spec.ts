import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeSotto, launchSotto, openThreads } from './support/sottoLaunch'
import { resizeContentWindow } from './support/sottoWindow'
import { evidenceDirectory } from '../fixtures/evidence'

const evidence = evidenceDirectory('artifacts/council-climb')

test('Climb keeps its setup in the Council drawer, previews a non-Git folder and requires approval', async () => {
  test.setTimeout(120_000)
  const previous = process.env.SOTTO_OWL_FEATURES
  process.env.SOTTO_OWL_FEATURES = 'council=1'
  const launched = await launchSotto('composer-speed').finally(() => {
    if (previous === undefined) delete process.env.SOTTO_OWL_FEATURES; else process.env.SOTTO_OWL_FEATURES = previous
  })
  const { page } = launched
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await mkdir(evidence, { recursive: true })
  try {
    const selected = await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'on' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true } })
      const state = await window.sotto!.agents!.command({ type: 'connect' })
      const origin = state.host.threads.find(thread => /(?:^|:)workshop$/u.test(thread.id))!
      return { id: origin.id, folder: state.host.projects.find(project => project.id === origin.projectId)!.path }
    })
    await writeFile(join(selected.folder, 'explanation.txt'), 'An explanation to improve.\n')
    await page.reload()
    await openThreads(page)
    await page.getByRole('button', { name: 'Workshop', exact: true }).first().click()
    await page.getByRole('button', { name: 'Council', exact: true }).click()
    await page.getByRole('button', { name: 'Climb', exact: true }).click()
    const panel = page.locator('.climb-panel')
    await panel.getByRole('textbox', { name: 'Goal', exact: true }).fill('Make the explanation clear and complete.')
    await panel.getByLabel('Folder path', { exact: true }).fill(selected.folder)
    await panel.getByRole('button', { name: 'Preview capture', exact: true }).click()
    await expect(panel.getByText(/1 files ·/u)).toBeVisible()
    await panel.getByRole('button', { name: 'About the goal', exact: true }).focus()
    await expect(panel.getByRole('tooltip')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(panel.getByRole('tooltip')).toHaveCount(0)
    await panel.getByRole('slider', { name: 'Attempts', exact: true }).press('End')
    await panel.getByRole('slider', { name: 'Model turns', exact: true }).press('End')
    await expect(panel.getByRole('slider', { name: 'Attempts', exact: true })).toHaveAttribute('aria-valuetext', 'No limit')
    await expect(panel.getByRole('slider', { name: 'Model turns', exact: true })).toHaveAttribute('aria-valuetext', 'No limit')
    // Hiding the drawer retains the form without creating a terminal.
    await page.getByRole('button', { name: 'Council', exact: true }).click()
    await page.getByRole('button', { name: 'Council', exact: true }).click()
    await expect(panel.getByRole('textbox', { name: 'Goal', exact: true })).toHaveValue('Make the explanation clear and complete.')
    const geometry: unknown[] = []
    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]]) {
      await resizeContentWindow(launched, width!, height!, [820, 560])
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), appearance)
        await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
        await page.locator('.council-scroll, .council-view').evaluateAll(elements => elements.forEach(element => { element.scrollTop = 0 }))
        const bounds = await panel.evaluate(element => {
          const scroll = element.closest('.council-scroll')!, frame = scroll.getBoundingClientRect()
          return { pageOverflow: document.documentElement.scrollWidth > innerWidth, formOverflow: scroll.scrollWidth > scroll.clientWidth + 1,
            clippedControls: [...element.querySelectorAll<HTMLElement>('input,select,button,textarea')].filter(control => {
              if (!control.getClientRects().length) return false
              const box = control.getBoundingClientRect()
              return box.left < frame.left - 1 || box.right > frame.right + 1
            }).map(control => control.getAttribute('aria-label') ?? control.tagName) }
        })
        geometry.push({ width, height, appearance, ...bounds })
        expect(bounds).toEqual({ pageOverflow: false, formOverflow: false, clippedControls: [] })
        await page.screenshot({ path: join(evidence, `setup-${width}-${appearance}.png`), animations: 'disabled', caret: 'hide' })
        await panel.getByRole('button', { name: 'Ask chair for proposal', exact: true }).scrollIntoViewIfNeeded()
        await page.screenshot({ path: join(evidence, `limits-${width}-${appearance}.png`), animations: 'disabled', caret: 'hide' })
      }
    }
    await panel.getByRole('button', { name: 'Ask chair for proposal', exact: true }).click()
    await expect(panel.getByRole('heading', { name: 'Preparing proposal', exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(async () => {
      const result = await window.sotto!.council!.climb!({ type: 'read' })
      return result.climbs?.[0]?.turns[0]?.delivery
    })).toBe('accepted')
    // Script only the provider's reply; setup approval and capture stay in real main-process code.
    await page.evaluate(async () => {
      const result = await window.sotto!.council!.climb!({ type: 'read' }), record = result.climbs![0]!
      await window.sottoE2E!.agentEvent!({ type: 'ready', threadId: record.turns[0]!.thread.replace(/^host:[0-9a-f-]+:/iu, ''), text: `<climb-result>${JSON.stringify({ constraints: 'Keep the meaning.', criteria: record.spec!.criteria })}</climb-result>` })
    })
    await expect(panel.getByRole('heading', { name: 'Chair’s proposal', exact: true })).toBeVisible()
    const approve = panel.getByRole('button', { name: 'Approve & start round 0', exact: true })
    await expect(approve).toBeDisabled()
    await panel.getByRole('checkbox', { name: 'Allow fix briefs to this builder within these limits.', exact: true }).check()
    await expect(approve).toBeEnabled()
    await page.screenshot({ path: join(evidence, 'proposal-820-light.png'), animations: 'disabled', caret: 'hide' })
    await approve.click()
    await expect(panel.getByRole('heading', { name: 'Judging', exact: true })).toBeVisible()
    await panel.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect(panel.getByRole('heading', { name: 'Stopped', exact: true })).toBeVisible()
    const shells = await page.evaluate(async threadId => window.sotto!.terminal!.list({ threadId, place: 'drawer' }), selected.id)
    expect(shells.ok && shells.value.sessions).toEqual([])
    await writeFile(join(evidence, 'geometry.json'), JSON.stringify(geometry, null, 2))
    expect(errors).toEqual([])
  } finally { await closeSotto(launched) }
})
