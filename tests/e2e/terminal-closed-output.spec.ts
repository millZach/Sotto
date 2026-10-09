import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import { bareEntityId, closeSotto, launchSotto, openThreads, resizeWindow } from './support/sottoLaunch'
import { TERMINAL_CHANNEL, TERMINAL_LIMIT_MESSAGE, terminalSessionSchema } from '../../src/shared/terminal'

for (const place of ['tools', 'drawer'] as const) {
  test(`${place} startup names a checkout operation and keeps retry available`, async () => {
    const launched = await launchSotto()
    const { page } = launched
    try {
      await page.evaluate(async () => {
        await window.sotto!.updateSettings({ onboardingComplete: true, reducedMotion: 'on' })
        await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
        await window.sotto!.agents!.command({ type: 'connect' })
      })
      // Script the reservation response at IPC; service regressions exercise the actual checkout guard.
      await launched.app.evaluate(({ ipcMain }, channel) => {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, () => ({ ok: false, error: { code: 'busy', message: 'Sotto is removing this folder. The terminal did not start. Try again when it finishes.' } }))
      }, TERMINAL_CHANNEL + 'create')
      await page.reload(); await openThreads(page)
      await page.getByRole('button', { name: 'Workshop', exact: true }).first().click()
      if (place === 'tools') {
        await page.getByRole('button', { name: 'Tools', exact: true }).click()
        await page.getByRole('complementary', { name: 'Tools', exact: true }).getByRole('tab', { name: 'Terminal', exact: true }).click()
        await page.getByRole('button', { name: 'Start terminal', exact: true }).press('Enter')
      } else await page.getByRole('button', { name: 'Terminal drawer', exact: true }).click()
      const notice = page.getByRole('alert').filter({ hasText: 'Sotto is removing this folder.' })
      await expect(notice).toContainText('The terminal did not start. Try again when it finishes.')
      await expect(notice).not.toContainText('storage')
      const retry = page.getByRole('button', { name: 'Start terminal', exact: true })
      for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
        await resizeWindow(launched, width, height)
        for (const appearance of ['dark', 'light'] as const) {
          await page.evaluate(appearance => window.sotto!.updateSettings({ appearance }), appearance)
          await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
          await expect(notice).toBeInViewport()
          await retry.focus()
          await expect(retry).toBeFocused()
          await expect(retry).toBeInViewport()
          if (place === 'drawer') {
            await notice.scrollIntoViewIfNeeded()
            const contained = await notice.evaluate(element => {
              const drawer = element.closest('.pane-terminal')!.getBoundingClientRect()
              const bounds = element.getBoundingClientRect()
              return bounds.top >= drawer.top && bounds.bottom <= drawer.bottom
            })
            expect(contained).toBe(true)
          }
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
          await mkdir('artifacts/terminal-truths', { recursive: true })
          await page.screenshot({ path: `artifacts/terminal-truths/busy-${place}-${width}-${appearance}.png`, animations: 'disabled' })
        }
      }
      await launched.app.evaluate(({ ipcMain }, channel) => {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, () => ({ ok: false, error: { code: 'busy', message: 'A Git action is running in this folder. The terminal did not start. Try again when it finishes.' } }))
      }, TERMINAL_CHANNEL + 'create')
      await retry.press('Enter')
      await expect(page.getByRole('alert').filter({ hasText: 'A Git action is running in this folder.' })).toBeVisible()
      await expect(notice).toHaveCount(0)
      await expect(retry).toBeEnabled()
    } finally { await closeSotto(launched) }
  })
}

test('each provider exits to an interactive shell and Close reclaims a native worktree', async () => {
  test.skip(process.platform !== 'win32', 'Native Windows ConPTY acceptance')
  test.setTimeout(180_000)
  const launched = await launchSotto()
  const { page } = launched
  try {
    const project = await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, reducedMotion: 'on' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
      const state = await window.sotto!.agents!.command({ type: 'connect' })
      return state.host.projects[0]!
    })
    expect(project.path.startsWith(launched.userData)).toBe(true)
    // The ordinary fixture folder has no Git repository; give this owned test folder a committed baseline.
    await writeFile(join(project.path, 'terminal-baseline.txt'), 'Terminal worktree fixture\n')
    for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Baseline']]) execFileSync('git', args, { cwd: project.path, stdio: 'pipe' })
    const commands = join(launched.userData, 'terminal-fixture-bin')
    await mkdir(commands)
    for (const provider of ['claude', 'codex', 'grok']) await writeFile(join(commands, `${provider}.cmd`), '@echo off\r\necho SOTTO_FIXTURE_PROVIDER\r\nexit /b 7\r\n')
    await launched.app.evaluate((_, commands) => { process.env.PATH = `${commands};${process.env.PATH ?? ''}` }, commands)
    await page.reload(); await openThreads(page)
    await page.getByRole('radio', { name: 'Terminal', exact: true }).click()
    // Drive the normal opening path before later launches vary the provider and folder through the bridge.
    await page.getByRole('button', { name: 'New terminal', exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: 'New terminal', exact: true })
    await dialog.getByRole('searchbox', { name: 'Search projects' }).press('ArrowDown')
    await page.keyboard.press('Enter')
    await dialog.getByRole('textbox', { name: 'Terminal name' }).fill('Shell entry check')
    await dialog.getByRole('combobox', { name: 'Terminal provider' }).selectOption('')
    await dialog.getByRole('button', { name: 'Open terminal', exact: true }).click()
    await expect(page.locator('.terminal-view .xterm-helper-textarea')).toBeVisible()
    await page.getByRole('button', { name: 'Close Shell entry check', exact: true }).click()
    for (const provider of ['claude', 'codex', 'grok'] as const) {
      const terminal = await page.evaluate(async ({ projectId, provider }) => {
        const result = await window.sotto!.terminals!.open({ projectId, title: `${provider} exit check`, workingCopy: 'independent', launch: { provider, modelId: null, reasoning: null, permission: 'ask' } })
        if (!result.ok) throw new Error(result.error.message)
        return result.value.terminal
      }, { projectId: project.id, provider })
      const read = () => page.evaluate(async id => {
        const result = await window.sotto!.terminals!.read({ id })
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      }, terminal.id)
      await expect.poll(async () => (await read()).output).toContain(`${provider} exited with code 7.`)
      expect((await read()).terminal.status).toBe('running')
      await page.getByRole('button', { name: `${provider} exit check`, exact: true }).click()
      const input = page.locator('.terminal-view .xterm-helper-textarea')
      await input.pressSequentially("Write-Output ('SOTTO_' + 'SHELL_READY'); (Get-Location).Path")
      await input.press('Enter')
      await expect.poll(async () => (await read()).output).toContain('SOTTO_SHELL_READY')
      const ready = await read()
      expect(ready.terminal.workingDirectory.startsWith(launched.userData)).toBe(true)
      expect(ready.output).toContain(ready.terminal.workingDirectory)
      await mkdir('artifacts/terminal-truths', { recursive: true })
      if (provider === 'codex') {
        await resizeWindow(launched, 820, 560)
        await page.screenshot({ path: 'artifacts/terminal-truths/provider-exit-820-dark.png', animations: 'disabled' })
      }
      await page.getByRole('button', { name: `Close ${provider} exit check`, exact: true }).click()
      await expect.poll(async () => (await read()).terminal.worktree?.reclaimedAt).toBeTruthy()
      await expect(stat(ready.terminal.workingDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  } finally { await closeSotto(launched) }
})

test('a running Tools shell restores truthfully and the global ended-shell limit can be recovered', async () => {
  test.skip(process.platform !== 'win32', 'Native Windows ConPTY acceptance')
  test.setTimeout(120_000)
  let launched = await launchSotto()
  try {
    await launched.page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'light', reducedMotion: 'on' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await launched.page.reload(); await openThreads(launched.page)
    await launched.page.getByRole('button', { name: 'Workshop', exact: true }).first().click()
    await launched.page.getByRole('button', { name: 'Tools', exact: true }).click()
    let panel = launched.page.getByRole('complementary', { name: 'Tools', exact: true })
    await panel.getByRole('tablist', { name: 'Tools', exact: true }).getByRole('tab', { name: 'Terminal', exact: true }).click()
    await panel.getByRole('button', { name: 'Start terminal', exact: true }).click()
    const input = panel.locator('.xterm-helper-textarea')
    await input.pressSequentially("Write-Output ('PRIVATE_' + 'OUTPUT')")
    await input.press('Enter')
    await expect(panel.locator('.xterm-screen')).toBeVisible()
    const profile = launched.userData
    await launched.app.close()
    // Keep the real running record; seed ended drawer hints to exercise a full global cap without 32 live PTYs.
    const saved = JSON.parse(await readFile(join(profile, 'terminal-sessions.json'), 'utf8')) as unknown[]
    const original = terminalSessionSchema.parse(saved[0])
    const ended = Array.from({ length: 31 }, () => ({ ...original, id: randomUUID(), place: 'drawer', status: 'exited', exitCode: 0 }))
    await writeFile(join(profile, 'terminal-sessions.json'), JSON.stringify([original, ...ended]))
    launched = { ...await launchSotto('success', profile), ownsUserData: true }
    await openThreads(launched.page)
    await launched.page.getByRole('button', { name: 'Workshop', exact: true }).first().click()
    if (!await launched.page.getByRole('complementary', { name: 'Tools', exact: true }).isVisible()) await launched.page.getByRole('button', { name: 'Tools', exact: true }).click()
    panel = launched.page.getByRole('complementary', { name: 'Tools', exact: true })
    await panel.getByRole('tablist', { name: 'Tools', exact: true }).getByRole('tab', { name: 'Terminal', exact: true }).click()
    await expect(panel.getByText('Nothing it showed was kept.')).toBeVisible()
    await expect(panel.getByText(TERMINAL_LIMIT_MESSAGE, { exact: true })).toBeVisible()
    await expect(panel.getByRole('button', { name: 'New terminal', exact: true })).toBeDisabled()
    const state = await launched.page.evaluate(() => window.sotto!.agents!.get())
    const threadId = state.host.threads.find(item => bareEntityId(item.id) === 'workshop')!.id
    const restored = await launched.page.evaluate(async threadId => {
      const listing = await window.sotto!.terminal!.list({ threadId })
      if (!listing.ok) throw new Error(listing.error.message)
      return window.sotto!.terminal!.read({ threadId, workspaceId: listing.value.workspace.workspaceId, sessionId: listing.value.sessions[0]!.id })
    }, threadId)
    expect(restored).toMatchObject({ ok: true, value: { output: '', session: { status: 'interrupted' } } })
    await resizeWindow(launched, 820, 560)
    await mkdir('artifacts/terminal-truths', { recursive: true })
    await launched.page.screenshot({ path: 'artifacts/terminal-truths/interrupted-820-light.png', animations: 'disabled' })
    await panel.getByRole('button', { name: 'Reopen', exact: true }).click()
    await expect(panel.getByText('Nothing it showed was kept.')).toHaveCount(0)
    await expect(panel.getByRole('button', { name: 'New terminal', exact: true })).toBeDisabled()
    await panel.locator('.terminal-tabs__close').click()
    await panel.getByRole('button', { name: 'End terminal', exact: true }).press('Enter')
    await expect(panel.getByRole('button', { name: 'Start terminal', exact: true })).toBeEnabled()
    await expect(panel.getByText(TERMINAL_LIMIT_MESSAGE)).toHaveCount(0)
  } finally { await closeSotto(launched) }
})

test('Closed keeps a native terminal row and reopens it with fresh output', async () => {
  test.skip(process.platform !== 'win32', 'Native Windows ConPTY acceptance')
  test.setTimeout(120_000)
  const launched = await launchSotto()
  const { page } = launched
  try {
    await mkdir('artifacts/review-384', { recursive: true })
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
        await page.screenshot({ path: `artifacts/review-384/closed-${width}-${appearance}.png`, animations: 'disabled' })
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
    await writeFile('artifacts/review-384/reopen-hit.json', JSON.stringify(hit, null, 2) + '\n')
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
    await page.screenshot({ path: 'artifacts/review-384/reopened.png', animations: 'disabled' })
  } finally { await closeSotto(launched) }
})
