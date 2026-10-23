import { expectPromptText, fillPrompt, promptField } from './support/prompt'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeSotto, launchSotto, openThreads } from './support/sottoLaunch'
import { waitForShellPrompt } from './support/terminal'
import { evidenceDirectory } from '../fixtures/evidence'

const SHOTS = evidenceDirectory('artifacts/terminal-loading')

test('the Tools terminal recovers a failed view without restarting its shell or losing a draft', async () => {
  test.skip(process.platform !== 'win32', 'Native Windows ConPTY acceptance')
  test.setTimeout(120_000)
  const launched = await launchSotto()
  const { page, app } = launched
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'on' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload()
    await openThreads(page)
    await page.getByRole('button', { name: 'Workshop', exact: true }).first().click()
    // Block the real built chunk. No production test switch or mocked terminal renderer is involved.
    await app.evaluate(({ session }) => {
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        callback({ cancel: /terminalView-[^/]+\.js/u.test(details.url) })
      })
    })
    const id = await page.evaluate(async () => {
      const list = await window.sotto!.terminal!.list({ threadId: 'workshop' })
      if (!list.ok) throw new Error(list.error.message)
      const created = await window.sotto!.terminal!.create({ threadId: 'workshop', workspaceId: list.value.workspace.workspaceId })
      if (!created.ok) throw new Error(created.error.message)
      return created.value.session.id
    })
    const read = () => page.evaluate(async id => {
      const list = await window.sotto!.terminal!.list({ threadId: 'workshop' })
      if (!list.ok) throw new Error(list.error.message)
      const result = await window.sotto!.terminal!.read({ threadId: 'workshop', workspaceId: list.value.workspace.workspaceId, sessionId: id })
      if (!result.ok) throw new Error(result.error.message)
      return { output: result.value.output, status: result.value.session.status }
    }, id)
    await expect.poll(async () => (await read()).status).toBe('running')
    await waitForShellPrompt(read)
    await page.evaluate(async id => {
      const data = "$sottoRecovery = 'same shell'; Write-Output 'BEFORE_RELOAD'\r"
      const list = await window.sotto!.terminal!.list({ threadId: 'workshop' })
      if (!list.ok) throw new Error(list.error.message)
      await window.sotto!.terminal!.write({ threadId: 'workshop', workspaceId: list.value.workspace.workspaceId, sessionId: id, data })
    }, id)
    await expect.poll(async () => (await read()).output).toContain('BEFORE_RELOAD')
    const show = async (): Promise<void> => {
      await page.getByRole('button', { name: 'Tools', exact: true }).click()
      await page.getByRole('complementary', { name: 'Tools', exact: true }).getByRole('tab', { name: 'Terminal', exact: true }).click()
    }
    await show()
    await expect(page.getByText('The terminal view could not load. Your terminal and its output are still here.')).toBeVisible()
    await expect(page.locator('.terminal-view')).not.toHaveAttribute('aria-busy', 'true')
    await mkdir(SHOTS, { recursive: true })
    const contrasts: { width: number; appearance: string; ratio: number }[] = []
    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]]) {
      await app.evaluate(({ BrowserWindow }, size) => {
        const host = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!
        host.setContentSize(size[0]!, size[1]!)
      }, [width!, height!])
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(appearance => window.sotto!.updateSettings({ appearance }), appearance)
        await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
        const recovery = page.getByRole('button', { name: 'Reload window', exact: true })
        await recovery.focus()
        await expect(recovery).toBeFocused()
        await expect(page.locator('.files-problem').filter({ has: recovery })).toBeVisible()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        const ratio = await page.locator('.files-problem strong').evaluate(element => {
          const canvas = document.createElement('canvas')
          canvas.width = canvas.height = 1
          const context = canvas.getContext('2d')!
          const ancestors: Element[] = []
          for (let current: Element | null = element; current; current = current.parentElement) ancestors.unshift(current)
          for (const current of ancestors) { context.fillStyle = getComputedStyle(current).backgroundColor; context.fillRect(0, 0, 1, 1) }
          const luminance = (): number => {
            const rgb = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => {
              const channel = value / 255
              return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4
            })
            return .2126 * rgb[0]! + .7152 * rgb[1]! + .0722 * rgb[2]!
          }
          const background = luminance()
          context.fillStyle = getComputedStyle(element).color; context.fillRect(0, 0, 1, 1)
          const foreground = luminance()
          return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05)
        })
        expect(ratio).toBeGreaterThanOrEqual(4.5)
        contrasts.push({ width: width!, appearance, ratio })
        await page.screenshot({ path: join(SHOTS, `tools-${width}-${appearance}.png`) })
      }
    }
    await writeFile(join(SHOTS, 'tools-contrast.json'), JSON.stringify(contrasts, null, 2))
    await app.evaluate(({ session }) => session.defaultSession.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: false })))
    // The current document still caches the failed import; the recovery button reloads it.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.setContentSize(1600, 1000))
    await fillPrompt(promptField(page), 'Keep this draft through terminal recovery.')
    await page.getByRole('button', { name: 'Reload window', exact: true }).press('Enter', { noWaitAfter: true })
    await page.waitForLoadState('domcontentloaded')
    await openThreads(page)
    await page.getByRole('button', { name: 'Workshop', exact: true }).first().click()
    await expectPromptText(promptField(page), 'Keep this draft through terminal recovery.')
    await show()
    await expect(page.locator('.xterm-helper-textarea')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Reload window', exact: true })).toHaveCount(0)
    expect((await read()).status).toBe('running')
    expect((await read()).output).toContain('BEFORE_RELOAD')
    await page.locator('.xterm-helper-textarea').pressSequentially('Write-Output $sottoRecovery')
    await page.locator('.xterm-helper-textarea').press('Enter')
    await expect.poll(async () => (await read()).output).toMatch(/same shell\r?\n/u)
    await page.screenshot({ path: join(SHOTS, 'tools-restored.png') })
  } finally { await closeSotto(launched) }
})
