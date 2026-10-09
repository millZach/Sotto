import { join } from 'node:path'
import { evidenceDirectory } from '../fixtures/evidence'
import { mkdir, writeFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { closeSotto, launchSotto, openThreads, resizeWindow } from './support/sottoLaunch'

const evidence = evidenceDirectory('artifacts/review-384')

test('Closed keeps a native terminal row and reopens it with fresh output', async () => {
  test.skip(process.platform !== 'win32', 'Native Windows ConPTY acceptance')
  test.setTimeout(120_000)
  const launched = await launchSotto()
  const { page } = launched
  try {
    await mkdir(evidence, { recursive: true })
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, reducedMotion: 'on' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload(); await openThreads(page)
    await page.getByRole('radio', { name: 'Terminal', exact: true }).click()
    const id = await page.evaluate(async () => {
      const state = await window.sotto!.agents!.get()
      const opened = await window.sotto!.terminals!.open({ projectId: state.host.projects[0]!.id, title: 'Closed shelf check', workingCopy: 'shared',
        launch: { provider: null, modelId: null, reasoning: null, permission: null } })
      if (!opened.ok) throw new Error(opened.error.message)
      return opened.value.terminal.id
    })
    const read = () => page.evaluate(async id => {
      const result = await window.sotto!.terminals!.read({ id })
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    }, id)
    await expect.poll(async () => (await read()).terminal.status).toBe('running')
    await page.getByRole('button', { name: 'Closed shelf check', exact: true }).click()
    const before = await read()
    expect(before.output).toContain('Opened by Sotto')
    await page.getByRole('button', { name: 'Close Closed shelf check', exact: true }).click()
    await expect.poll(async () => (await read()).output).toBe('')
    await page.getByRole('button', { name: 'Closed 1 terminal', exact: true }).click()
    const shelf = page.getByRole('region', { name: 'Closed', exact: true })
    await expect(shelf.getByRole('button', { name: 'Closed shelf check', exact: true })).toBeDisabled()
    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
      await resizeWindow(launched, width, height)
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), appearance)
        await expect(shelf.getByRole('button', { name: 'Reopen Closed shelf check', exact: true })).toBeInViewport()
        await page.screenshot({ path: join(evidence, `closed-${width}-${appearance}.png`), animations: 'disabled' })
      }
    }
    const reopen = shelf.getByRole('button', { name: 'Reopen Closed shelf check', exact: true })
    await shelf.locator('.thread-nav__row').hover()
    await expect(reopen).toBeVisible()
    const hit = await reopen.evaluate(element => {
      const bounds = element.getBoundingClientRect()
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
        receivesPointer: element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)),
        opacity: getComputedStyle(element.parentElement!).opacity }
    })
    await writeFile(join(evidence, 'reopen-hit.json'), JSON.stringify(hit, null, 2) + '\n')
    expect(hit.receivesPointer).toBe(true)
    expect(hit.opacity).toBe('1')
    await reopen.focus()
    await expect(reopen).toBeFocused()
    await reopen.click()
    await expect.poll(async () => (await read()).terminal.status).toBe('running')
    const reopened = await read()
    expect(reopened.terminal).toMatchObject({ id, title: before.terminal.title, workingDirectory: before.terminal.workingDirectory, command: before.terminal.command, closedAt: null })
    expect(reopened.output).toContain('Opened by Sotto')
    await expect(shelf.getByRole('button', { name: 'Closed shelf check', exact: true })).toHaveCount(0)
    const input = page.locator('.terminal-view .xterm-helper-textarea')
    await input.pressSequentially("Write-Output ('SOTTO_' + 'REOPEN_READY')")
    await input.press('Enter')
    await expect.poll(async () => (await read()).output).toContain('SOTTO_REOPEN_READY')
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await page.screenshot({ path: join(evidence, 'reopened.png'), animations: 'disabled' })
  } finally { await closeSotto(launched) }
})
