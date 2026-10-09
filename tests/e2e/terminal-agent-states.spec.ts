import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { closeSotto, firstSottoWindow, launchSotto, openThreads, resizeWindow } from './support/sottoLaunch'

// Usage: npm run build && npx playwright test tests/e2e/terminal-agent-states.spec.ts
const SHOTS = resolve('artifacts/terminal-agent-states')
const fixture = resolve('tests/fixtures/fakeTerminalAgent.mjs')

async function state(page: Page, id: string): Promise<string | undefined> {
  return page.evaluate(async id => {
    const read = await window.sotto!.terminals!.read({ id })
    if (!read.ok) throw new Error(read.error.message)
    if (read.value.terminal.agentState === 'exited') throw new Error(`${read.value.terminal.title} exited: ${read.value.output}`)
    return read.value.terminal.agentState
  }, id)
}
async function command(page: Page, id: string, data: string): Promise<void> {
  await page.evaluate(async ({ id, data }) => {
    const result = await window.sotto!.terminals!.write({ id, data: data + '\r' })
    if (!result.ok) throw new Error(result.error.message)
  }, { id, data })
}

test('native fake agents report state and only unseen successful turns earn Just finished', async () => {
  test.skip(process.platform !== 'win32', 'Windows native PTY acceptance')
  test.setTimeout(180_000)
  const bin = await mkdtemp(join(tmpdir(), 'sotto-e2e-terminal-agent-bin-'))
  const quote = (value: string): string => "'" + value.replaceAll("'", "''") + "'"
  for (const provider of ['claude', 'codex', 'grok']) {
    await writeFile(join(bin, `${provider}.ps1`), `& ${quote(process.execPath)} ${quote(fixture)} ${quote(provider)} @args\nexit $LASTEXITCODE\n`)
  }
  const launched = await launchSotto('design-threads', undefined, {
    createProfile: () => mkdtemp(join(tmpdir(), 'sotto-e2e-')),
    launch: options => electron.launch({ ...options, env: { ...options?.env, PATH: bin + ';' + (options?.env?.PATH ?? process.env.PATH ?? '') } }),
    firstWindow: firstSottoWindow,
    removeProfile: path => rm(requireOwnedE2EProfile(path), { recursive: true, force: true }),
  })
  const { page } = launched
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await mkdir(SHOTS, { recursive: true })
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'on' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload(); await openThreads(page)
    await page.getByRole('radio', { name: 'Terminal', exact: true }).click()
    await resizeWindow(launched, 1600, 1000)
    const sidebar = page.getByRole('complementary', { name: 'Terminal sidebar', exact: true })
    // First use goes through the real New terminal dialog and keyboard, before later fixture setup through IPC.
    await sidebar.getByRole('button', { name: 'New terminal in workshop', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'New terminal', exact: true })
    await dialog.getByLabel('Terminal name', { exact: true }).fill('Claude approval')
    await dialog.getByLabel('Terminal provider', { exact: true }).selectOption('claude')
    await dialog.getByRole('button', { name: 'Open terminal', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    const initial = await page.evaluate(async () => {
      const listing = await window.sotto!.terminals!.list()
      if (!listing.ok) throw new Error(listing.error.message)
      return listing.value.terminals.find(item => item.title === 'Claude approval')!.id
    })
    await expect.poll(() => state(page, initial)).toBe('idle')
    const input = page.locator('.terminal-pane').filter({ has: page.getByRole('heading', { name: 'Claude approval', exact: true }) }).locator('.xterm-helper-textarea')
    await input.pressSequentially('w'); await input.press('Enter')
    await expect.poll(() => state(page, initial)).toBe('working')
    await input.pressSequentially('n'); await input.press('Enter')
    await expect.poll(() => state(page, initial)).toBe('needs-you')
    await expect(page.locator('.terminal-pane[data-needs-you]')).toHaveCount(1)
    // The edge belongs to the whole pane, under its layout controls too, and the pane's name says what it shows.
    await expect(page.getByRole('region', { name: 'Claude approval, needs you', exact: true })).toHaveCSS('box-shadow', /inset/)
    await expect(sidebar.locator('.terminal-nav__row[data-terminal-state="needs-you"]')).toHaveCount(1)
    // Cancellation cannot look like a successful completion.
    await input.pressSequentially('i'); await input.press('Enter')
    await expect.poll(() => state(page, initial)).toBe('idle')
    await input.pressSequentially('a'); await input.press('Enter')
    await expect.poll(() => state(page, initial)).toBe('needs-you')
    await input.pressSequentially('i'); await input.press('Enter')
    await expect.poll(() => state(page, initial)).toBe('idle')

    const others = await page.evaluate(async () => {
      const agents = await window.sotto!.agents!.get()
      const first = agents.host.projects.find(item => item.title === 'workshop')!
      const second = agents.host.projects.find(item => item.title === 'sotto-site')!
      const open = async (title: string, projectId: string, provider: 'claude' | 'codex' | 'grok' | null) => {
        const result = await window.sotto!.terminals!.open({ projectId, title, workingCopy: 'shared', launch: { provider, modelId: null, reasoning: null, permission: provider ? 'ask' : null } })
        if (!result.ok) throw new Error(result.error.message)
        return result.value.terminal.id
      }
      return { codex: await open('Codex working', second.id, 'codex'), finished: await open('Claude finished', first.id, 'claude'), grok: await open('Grok ready', second.id, 'grok'), shell: await open('Plain shell', second.id, null) }
    })
    for (const id of [others.codex, others.finished, others.grok]) await expect.poll(() => state(page, id)).toBe('idle')
    await command(page, others.grok, 'w'); await expect.poll(() => state(page, others.grok)).toBe('working')
    await command(page, others.grok, 'n'); await expect.poll(() => state(page, others.grok)).toBe('needs-you')
    await command(page, others.grok, 'i'); await expect.poll(() => state(page, others.grok)).toBe('idle')
    await command(page, others.grok, 'a'); await expect.poll(() => state(page, others.grok)).toBe('needs-you')
    await command(page, others.grok, 'i'); await expect.poll(() => state(page, others.grok)).toBe('idle')
    await command(page, others.grok, 'w'); await expect.poll(() => state(page, others.grok)).toBe('working')
    await command(page, others.grok, 'f'); await expect.poll(() => state(page, others.grok)).toBe('just-finished')
    await command(page, others.finished, 'w')
    await expect.poll(() => state(page, others.finished)).toBe('working')
    await command(page, others.finished, 'f')
    await expect.poll(() => state(page, others.finished)).toBe('just-finished')
    await command(page, others.codex, 'w')
    await expect.poll(() => state(page, others.codex)).toBe('working')
    await command(page, others.codex, 'a'); await expect.poll(() => state(page, others.codex)).toBe('needs-you')
    await command(page, others.codex, 'i'); await expect.poll(() => state(page, others.codex)).toBe('idle')
    await command(page, others.codex, 'w'); await expect.poll(() => state(page, others.codex)).toBe('working')
    await command(page, initial, 'w'); await expect.poll(() => state(page, initial)).toBe('working')
    await command(page, initial, 'n'); await expect.poll(() => state(page, initial)).toBe('needs-you')
    await sidebar.getByRole('button', { name: 'Codex working', exact: true }).click({ modifiers: ['Control'] })
    await expect(page.getByRole('group', { name: 'Terminal panes', exact: true })).toBeVisible()
    await expect(sidebar.locator('.terminal-nav__row[data-terminal-state="needs-you"] .terminal-nav__project')).toBeVisible()
    await expect(sidebar.locator('.terminal-nav__row[data-terminal-state="working"] .terminal-nav__project')).toBeVisible()
    const finishedRow = sidebar.locator('.terminal-nav__row[data-terminal-state="just-finished"]').filter({ has: page.getByRole('button', { name: 'Claude finished', exact: true }) })
    await expect(finishedRow).toContainText('Claude finished')
    await expect(finishedRow.locator('.thread-nav__ring[data-unseen]')).toHaveCount(1)
    const order = await sidebar.locator('.terminal-nav__row[data-terminal-state]').evaluateAll(rows => rows.map(row => row.getAttribute('data-terminal-state')))
    expect(order.indexOf('needs-you')).toBeLessThan(order.indexOf('working'))
    expect(order.indexOf('working')).toBeLessThan(order.indexOf('just-finished'))

    const workingMark = sidebar.locator('.terminal-nav__row[data-terminal-state="working"] .terminal-nav__mark').first()
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.evaluate(() => window.sotto!.updateSettings({ reducedMotion: 'system' }))
    await expect.poll(() => workingMark.evaluate(element => getComputedStyle(element).animationName)).toBe('thread-ring')
    await page.evaluate(() => window.sotto!.updateSettings({ reducedMotion: 'on' }))
    await expect.poll(() => workingMark.evaluate(element => getComputedStyle(element).animationName)).toBe('none')

    const geometry: unknown[] = []
    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
      await resizeWindow(launched, width, height)
      if (width === 820) await page.getByRole('tab', { name: 'Claude approval, needs you', exact: true }).click()
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(appearance => window.sotto!.updateSettings({ appearance }), appearance)
        await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
        await expect(sidebar.getByRole('button', { name: 'Claude approval', exact: true })).toBeInViewport()
        const bounds = await page.evaluate(() => {
          const elements = [...document.querySelectorAll<HTMLElement>('.terminal-pane:not([hidden]), .thread-nav__item')]
            .filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden')
          return { width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth,
            boxes: elements.map(element => { const rect = element.getBoundingClientRect(); return { name: element.getAttribute('aria-label') ?? element.className, x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom } }) }
        })
        expect(bounds.overflow).toBe(false)
        for (const box of bounds.boxes) { expect(box.x).toBeGreaterThanOrEqual(0); expect(box.y).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual(bounds.width + 1); expect(box.bottom).toBeLessThanOrEqual(bounds.height + 1) }
        const contrasts = await sidebar.evaluate(root => {
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
          const context = canvas.getContext('2d')!
          const rgba = (color: string): number[] => { context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data].map(value => value / 255) }
          const blend = (foreground: number[], background: number[]): number[] => foreground.slice(0, 3).map((value, index) => value * foreground[3]! + background[index]! * (1 - foreground[3]!)).concat(1)
          const luminance = (color: number[]): number => color.slice(0, 3).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index]!, 0)
          return [...root.querySelectorAll<HTMLElement>('.terminal-nav__group-label, .terminal-nav__project, .thread-nav__title, .thread-nav__needs')]
            .filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden')
            .map(element => {
              const ancestors: HTMLElement[] = []; let ancestor: HTMLElement | null = element
              while (ancestor) { ancestors.push(ancestor); ancestor = ancestor.parentElement }
              const background = ancestors.reverse().reduce((paint, node) => blend(rgba(getComputedStyle(node).backgroundColor), paint), [1, 1, 1, 1])
              const foreground = blend(rgba(getComputedStyle(element).color), background)
              const values = [luminance(foreground), luminance(background)].sort((a, b) => a - b)
              return { text: element.textContent?.trim(), ratio: (values[1]! + .05) / (values[0]! + .05) }
            })
        })
        for (const sample of contrasts) expect(sample.ratio, `${appearance}: ${sample.text}`).toBeGreaterThanOrEqual(4.5)
        const labels = await sidebar.locator('.terminal-nav__project, .thread-nav__needs').evaluateAll(elements => elements
          .filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden')
          .map(element => ({ text: element.textContent, clipped: element.scrollWidth > element.clientWidth + 1 })))
        for (const label of labels) expect(label.clipped, `${width}: ${label.text}`).toBe(false)
        geometry.push({ appearance, ...bounds, contrasts })
        await page.screenshot({ path: join(SHOTS, `states-${width}x${height}-${appearance}.png`), animations: 'disabled' })
      }
    }
    await writeFile(join(SHOTS, 'geometry.json'), JSON.stringify(geometry, null, 2) + '\n')
    await resizeWindow(launched, 1600, 1000)
    await expect(page.locator('.terminal-pane:visible')).toHaveCount(2)
    await page.getByRole('heading', { name: 'Codex working', exact: true }).click()
    await expect(sidebar.getByRole('button', { name: 'Codex working', exact: true })).toHaveAttribute('aria-current', 'page')
    // Both panes are visible, though only Codex is focused: completing Claude earns nothing.
    await command(page, initial, 'i'); await expect.poll(() => state(page, initial)).toBe('idle')
    await command(page, initial, 'w'); await expect.poll(() => state(page, initial)).toBe('working')
    await command(page, initial, 'f'); await expect.poll(() => state(page, initial)).toBe('idle')
    await command(page, others.codex, 'f'); await expect.poll(() => state(page, others.codex)).toBe('idle')
    await finishedRow.getByRole('button', { name: 'Claude finished', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => state(page, others.finished)).toBe('idle')
    await sidebar.getByRole('button', { name: 'Grok ready', exact: true }).click()
    await expect.poll(() => state(page, others.grok)).toBe('idle')
    await expect(sidebar.locator('.terminal-nav__row[data-terminal-state="just-finished"]')).toHaveCount(0)
    await page.screenshot({ path: join(SHOTS, 'viewed-idle.png'), animations: 'disabled' })
    // Minimise withdraws visibility; returning reads the completion rather than marking it retroactively.
    await sidebar.getByRole('button', { name: 'Claude finished', exact: true }).click()
    await command(page, others.finished, 'w'); await expect.poll(() => state(page, others.finished)).toBe('working')
    await launched.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!.minimize() })
    await command(page, others.finished, 'f'); await expect.poll(() => state(page, others.finished)).toBe('just-finished')
    await launched.app.evaluate(({ BrowserWindow }) => { const host = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!; host.restore(); host.show() })
    await expect.poll(() => state(page, others.finished)).toBe('idle')
    expect(errors).toEqual([])
  } finally { await closeSotto(launched); await rm(bin, { recursive: true, force: true }) }
})
