import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeSotto, launchSotto, openThreads, resizeWindow } from './support/sottoLaunch'
import { evidenceDirectory } from '../fixtures/evidence'

/**
 * The terminal drawer in a thread pane: its own shells in the thread's working copy, apart from the Tools
 * panel's terminal, kept running while hidden, and Ctrl+J from inside the shell and back. With
 * SOTTO_PANE_TERMINAL_EVIDENCE=1 it also saves the drawer at the three verified window sizes, in dark and light,
 * to artifacts/pane-terminal.
 */
const evidence = process.env.SOTTO_PANE_TERMINAL_EVIDENCE === '1'
const SHOTS = evidenceDirectory('artifacts/pane-terminal')

async function drawerSessions(page: Page, threadId: string, place: 'drawer' | 'tools'): Promise<Array<{ id: string; status: string }>> {
  return page.evaluate(async ({ thread, where }) => {
    const list = await window.sotto!.terminal!.list({ threadId: thread, place: where })
    return list.ok ? list.value.sessions.map(session => ({ id: session.id, status: session.status })) : []
  }, { thread: threadId, where: place })
}

async function drawerOutput(page: Page, threadId: string): Promise<string> {
  return page.evaluate(async thread => {
    const list = await window.sotto!.terminal!.list({ threadId: thread, place: 'drawer' })
    const session = list.ok ? list.value.sessions[0] : undefined
    if (!list.ok || !session) return ''
    const read = await window.sotto!.terminal!.read({ threadId: thread, workspaceId: list.value.workspace.workspaceId, sessionId: session.id })
    return read.ok ? read.value.output : ''
  }, threadId)
}

test('a pane opens its own terminal below the composer, keeps it running while hidden, and Ctrl+J moves in and out of it', async () => {
  test.skip(process.platform !== 'win32', 'Native Windows ConPTY acceptance')
  test.setTimeout(180_000)
  const launched = await launchSotto()
  const { page } = launched
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'on' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload()
    await resizeWindow(launched, 1280, 800)
    await openThreads(page)
    await page.getByRole('button', { name: 'Workshop', exact: true }).first().click()

    const pane = page.locator('.thread-pane').first()
    const threadId = (await pane.getAttribute('data-thread-id'))!
    const toggle = pane.locator('[data-pane-terminal-toggle]')
    await expect(toggle).toHaveAccessibleName('Terminal drawer')
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    const drawer = page.locator('.pane-terminal')
    // Opening starts a shell by itself: no empty "Start terminal" step.
    await expect(drawer.getByRole('tab', { selected: true })).toBeVisible()
    await expect(drawer.getByRole('separator', { name: 'Resize terminal' })).toBeVisible()

    const input = drawer.locator('.xterm-helper-textarea')
    await input.click()
    await input.pressSequentially('Write-Output ("drawer-" + 6*7)')
    await input.press('Enter')
    await expect.poll(() => drawerOutput(page, threadId)).toContain('drawer-42')
    // The drawer's shells are its own: the Tools panel's terminal has none.
    expect(await drawerSessions(page, threadId, 'tools')).toEqual([])

    // Ctrl+J from inside the shell hides the drawer, hands focus back to the composer and leaves the shell running.
    // A half-typed line waits at the prompt: had the shell received Ctrl+J, a line feed, it would have run it.
    await input.pressSequentially('Write-Output ("unsent" + "-line")')
    await page.keyboard.press('Control+KeyJ')
    await expect(drawer).toHaveCount(0)
    await expect(pane.locator('.thread-workspace__compose textarea')).toBeFocused()
    expect((await drawerSessions(page, threadId, 'drawer')).map(session => session.status)).toEqual(['running'])

    // And again from the composer: the drawer comes back with the same shell and takes focus.
    await page.keyboard.press('Control+KeyJ')
    await expect(drawer.locator('.xterm-helper-textarea')).toBeFocused()
    expect(await drawerSessions(page, threadId, 'drawer')).toHaveLength(1)
    expect(await drawerOutput(page, threadId)).not.toContain('unsent-line')
    // Escape belongs to the shell: PowerShell clears the waiting line, and the drawer stays open.
    await input.press('Escape')
    await expect(drawer).toHaveCount(1)

    if (evidence) {
      await mkdir(SHOTS, { recursive: true })
      // A short prompt keeps the folder path, and with it the user name, out of the images.
      await input.pressSequentially("function prompt { 'PS project> ' }; Clear-Host; git --version")
      await input.press('Enter')
      await expect.poll(() => drawerOutput(page, threadId)).toContain('git version')
      for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
        await resizeWindow(launched, width, height)
        await page.mouse.move(0, 0)
        await page.waitForTimeout(400)
        await page.screenshot({ path: resolve(SHOTS, `drawer-dark-${width}x${height}.png`) })
      }
      await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'light' }))
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
      await resizeWindow(launched, 1280, 800)
      await page.waitForTimeout(400)
      await page.screenshot({ path: resolve(SHOTS, 'drawer-light-1280x800.png') })
    }

    // Closing its last shell hides the drawer.
    await drawer.getByRole('button', { name: /^Close / }).click()
    await drawer.getByRole('button', { name: 'End terminal' }).click()
    await expect(drawer).toHaveCount(0)
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(() => drawerSessions(page, threadId, 'drawer')).toEqual([])
  } finally {
    await closeSotto(launched)
  }
})
