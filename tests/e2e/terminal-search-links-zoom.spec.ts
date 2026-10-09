import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { closeSotto, launchSotto, openThreads, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'
import { forceDomTerminalRenderer, terminalOutput } from './support/terminal'

// Run after npm run build. These journeys use real ConPTYs; only external browser opening is stubbed.
const SHOTS = resolve('artifacts/terminal-search-links-zoom')
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVR4nGOQnFbxH4QZYAwASEIImVOee9IAAAAASUVORK5CYII='

/** Where the DOM renderer drew `text` in the first row containing `row`. */
async function renderedText(scope: Locator, row: string, text: string): Promise<{ x: number; y: number; width: number; height: number }> {
  return scope.locator('.xterm-rows > div').filter({ hasText: row }).first().evaluate((row, text) => {
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
    const start = row.textContent!.replace(/\u00a0/gu, ' ').indexOf(text), end = start + text.length
    const range = document.createRange()
    let offset = 0, started = false
    let node: Node | null
    while ((node = walker.nextNode())) {
      const length = node.textContent!.length
      if (!started && start >= offset && start < offset + length) { range.setStart(node, start - offset); started = true }
      if (started && end <= offset + length) {
        range.setEnd(node, end - offset)
        const { x, y, width, height } = range.getBoundingClientRect()
        return { x, y, width, height }
      }
      offset += length
    }
    throw new Error('Text was not rendered')
  }, text)
}

/** Each search highlight sits on its match's text, also after the text size changed. The addon redraws a repainted screen's highlights shortly after. */
async function expectHighlightOnText(scope: Locator): Promise<void> {
  await expect(async () => {
    const text = await renderedText(scope, 'beta needle two', 'needle')
    const highlights = await scope.locator('.xterm-decoration').evaluateAll(elements => elements.map(element => {
      const { x, y, width, height } = element.getBoundingClientRect()
      return { x, y, width, height }
    }))
    const highlight = highlights.find(box => Math.abs(box.y + box.height / 2 - (text.y + text.height / 2)) < box.height / 2)
    expect(highlight, 'a highlight on the "beta needle two" row').toBeDefined()
    expect(Math.abs(highlight!.x - text.x)).toBeLessThan(1.5)
    expect(Math.abs(highlight!.width - text.width)).toBeLessThan(1.5)
  }).toPass({ timeout: 15_000 })
}

async function clickTerminalLink(page: Page, scope: Locator, text: string, modifier = false): Promise<void> {
  const box = await renderedText(scope, text, text)
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await page.mouse.move(point.x, point.y)
  if (modifier) await page.keyboard.down('Control')
  try { await page.mouse.click(point.x, point.y) }
  finally { if (modifier) await page.keyboard.up('Control') }
}

for (const surface of ['tools', 'drawer', 'workspace'] as const) {
  test(`${surface} searches real output, follows safe links, saves font zoom and pastes images`, async () => {
    test.skip(process.platform !== 'win32', 'Native Windows ConPTY acceptance')
    test.setTimeout(180_000)
    const launched = await launchSotto()
    const { page, app } = launched
    let restarted: LaunchedSotto | undefined
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    try {
      const folder = await page.evaluate(async () => {
        await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'on' })
        await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
        const state = await window.sotto!.agents!.command({ type: 'connect' })
        return state.host.projects.find(project => project.id === state.host.threads.find(thread => thread.id === 'workshop' || thread.id.endsWith(':workshop'))!.projectId)!.path
      })
      expect(folder.startsWith(launched.userData)).toBe(true)
      await writeFile(join(folder, 'terminal-basics.cjs'), `
const e = '\\x1b';
const paint = () => process.stdout.write(e+'[3J'+e+'[2J'+e+'[H'+[
 'Search check ready', 'alpha needle one', 'beta needle two', 'gamma needle three',
 'URL https://example.com/terminal',
 'OSC '+e+']8;;https://example.com/docs'+e+'\\\\'+'project docs'+e+']8;;'+e+'\\\\',
 'Unsafe '+e+']8;;file:///tmp/blocked'+e+'\\\\'+'blocked file'+e+']8;;'+e+'\\\\',
 'CJK 界 emoji 😀', 'GRID='+process.stdout.columns+'x'+process.stdout.rows
].join('\\r\\n')+'\\r\\n');
paint();
process.stdin.setRawMode(true); process.stdin.resume(); let line='';
process.stdin.on('data', data => { for(const c of data.toString()) { if(c==='\\x03') process.exit(0); if(c==='\\x0c') {paint();continue;} if(c==='\\x02') {process.stdout.write('\\r\\n'+('many-match\\r\\n').repeat(1001));continue;} if(c==='\\r') {process.stdout.write('INPUT='+line+'\\r\\n');line='';} else line+=c; } });
`, 'utf8')
      await app.evaluate(({ shell }) => {
        const state = globalThis as typeof globalThis & { terminalOpenedLinks?: string[] }
        state.terminalOpenedLinks = []
        shell.openExternal = async url => { state.terminalOpenedLinks!.push(url) }
      })
      const links = () => app.evaluate(() => (globalThis as typeof globalThis & { terminalOpenedLinks: string[] }).terminalOpenedLinks)
      await page.reload()
      if (surface !== 'workspace') await forceDomTerminalRenderer(page)
      await resizeWindow(launched, 1600, 1000); await openThreads(page)
      await page.getByRole('button', { name: 'Workshop', exact: true }).first().click()
      const threadId = (await page.locator('.thread-pane').first().getAttribute('data-thread-id'))!
      let scope: Locator
      if (surface === 'tools') {
        await page.getByRole('button', { name: 'Tools', exact: true }).click()
        scope = page.getByRole('complementary', { name: 'Tools', exact: true })
        await scope.getByRole('tablist', { name: 'Tools', exact: true }).getByRole('tab', { name: 'Terminal', exact: true }).click()
        await scope.getByRole('button', { name: 'Start terminal', exact: true }).click()
      } else if (surface === 'drawer') {
        await page.locator('[data-pane-terminal-toggle]').first().click()
        scope = page.locator('.pane-terminal')
      } else {
        await page.getByRole('radio', { name: 'Terminal', exact: true }).click()
        await page.getByRole('button', { name: 'New terminal', exact: true }).first().click()
        const dialog = page.getByRole('dialog', { name: 'New terminal', exact: true })
        await expect(dialog).toBeVisible()
        if (await dialog.getByRole('textbox', { name: 'Terminal name', exact: true }).count() === 0) await dialog.locator('.new-thread-choice').filter({ hasText: folder }).click()
        await dialog.getByRole('textbox', { name: 'Terminal name', exact: true }).fill('Search check')
        await dialog.getByRole('combobox', { name: 'Terminal provider' }).selectOption('')
        await dialog.getByRole('button', { name: 'Open terminal', exact: true }).click()
        scope = page.locator('.terminal-pane')
      }
      const input = scope.locator('.xterm-helper-textarea')
      await expect(input).toBeAttached()
      await input.pressSequentially('node terminal-basics.cjs'); await input.press('Enter')
      const output = () => surface === 'workspace' ? page.evaluate(async () => {
        const list = await window.sotto!.terminals!.list()
        if (!list.ok || !list.value.terminals[0]) return ''
        const result = await window.sotto!.terminals!.read({ id: list.value.terminals[0].id })
        return result.ok ? result.value.output : ''
      }) : terminalOutput(page, threadId, surface)
      const grid = () => page.evaluate(async ({ surface, threadId }) => {
        if (surface === 'workspace') {
          const list = await window.sotto!.terminals!.list()
          return list.ok ? list.value.terminals[0]!.cols : 0
        }
        const list = await window.sotto!.terminal!.list({ threadId, place: surface })
        return list.ok ? list.value.sessions[0]!.cols : 0
      }, { surface, threadId })
      await expect.poll(output).toContain('Search check ready')
      if (surface === 'workspace') await expect(scope.locator('.xterm-screen canvas:not(.xterm-link-layer)')).toBeVisible()
      else await expect(scope.locator('.xterm-rows')).toContainText('CJK 界 emoji 😀')
      await input.press('Control+f')
      const search = scope.getByRole('search', { name: 'Search terminal output' })
      const find = search.getByRole('textbox', { name: 'Find in terminal' })
      await expect(find).toBeFocused()
      await find.fill('needle')
      await expect(search.locator('output')).toHaveText('1 of 3')
      if (surface === 'drawer') {
        await find.press('Control+j')
        await expect(scope).toBeHidden()
        await page.locator('[data-pane-terminal-toggle]').first().click()
        await expect(scope).toBeVisible()
        await input.press('Control+f')
        await expect(find).toHaveValue('needle')
        await expect(find).toBeFocused()
      }
      await find.press('Control+f')
      await expect(search.locator('output')).toHaveText('1 of 3')
      expect(await find.evaluate(input => [(input as HTMLInputElement).selectionStart, (input as HTMLInputElement).selectionEnd])).toEqual([0, 6])
      await find.press('Enter'); await expect(search.locator('output')).toHaveText('2 of 3')
      await find.press('Shift+Enter'); await expect(search.locator('output')).toHaveText('1 of 3')
      await search.getByRole('button', { name: 'Previous match' }).click()
      await expect(search.locator('output')).toHaveText('3 of 3')
      await search.getByRole('button', { name: 'Next match' }).click()
      await expect(search.locator('output')).toHaveText('1 of 3')
      await expect(scope.locator('.xterm-decoration')).not.toHaveCount(0)
      await find.fill('no-such-output'); await expect(search.locator('output')).toHaveText('No matches')
      await expect(search.getByRole('button', { name: 'Next match' })).toBeDisabled()
      await find.fill(''); await expect(search.locator('output')).toHaveText('')
      await expect(scope.locator('.xterm-decoration')).toHaveCount(0)
      await find.fill('needle')
      await search.getByRole('button', { name: 'Close search' }).press('Escape')
      await expect(search).toBeHidden(); await expect(input).toBeFocused()
      await expect(scope.locator('.xterm-decoration')).toHaveCount(0)
      if (surface === 'workspace') {
        await scope.locator('.xterm-screen canvas:not(.xterm-link-layer)').evaluate(canvas => {
          const extension = (canvas as HTMLCanvasElement).getContext('webgl2')!.getExtension('WEBGL_lose_context')
          if (!extension) throw new Error('GPU context-loss probe unavailable')
          extension.loseContext()
        })
        await forceDomTerminalRenderer(page)
        await expect(scope.locator('.xterm-rows')).toContainText('CJK 界 emoji 😀')
      }
      await input.press('Enter'); await expect.poll(output).toContain('INPUT=\r\n')
      await clickTerminalLink(page, scope, 'https://example.com/terminal')
      expect(await links()).toEqual([])
      await clickTerminalLink(page, scope, 'https://example.com/terminal', true)
      await expect.poll(links).toEqual(['https://example.com/terminal'])
      await clickTerminalLink(page, scope, 'project docs', true)
      await expect.poll(links).toEqual(['https://example.com/terminal', 'https://example.com/docs'])
      await clickTerminalLink(page, scope, 'blocked file', true)
      expect(await links()).toHaveLength(2)
      await input.press('Control+f')
      await find.press('Tab'); await page.keyboard.press('Tab'); await page.keyboard.press('Tab')
      const linkControl = search.getByRole('button', { name: 'Open terminal link', exact: true })
      await expect(linkControl).toBeFocused()
      await linkControl.press('Enter')
      const picker = scope.getByRole('dialog', { name: 'Open terminal link', exact: true })
      const namedLink = picker.getByRole('button', { name: 'Open project docs', exact: true })
      await expect(namedLink).toBeFocused()
      await expect(namedLink).toContainText('https://example.com/docs')
      await expect(picker.getByRole('button', { name: /blocked/u })).toHaveCount(0)
      await namedLink.press('Enter')
      await expect.poll(links).toEqual(['https://example.com/terminal', 'https://example.com/docs', 'https://example.com/docs'])
      await expect(linkControl).toBeFocused()
      await linkControl.press('Enter'); await page.keyboard.press('Tab')
      const plainLink = picker.getByRole('button', { name: 'Open https://example.com/terminal', exact: true })
      await expect(plainLink).toBeFocused(); await plainLink.press('Enter')
      await expect.poll(links).toHaveLength(4)
      await linkControl.press('Enter'); await namedLink.press('Escape')
      await expect(picker).toBeHidden(); await expect(linkControl).toBeFocused()
      await linkControl.press('Escape')
      await expect(search).toBeHidden(); await expect(input).toBeFocused()
      const before = await grid()
      await input.press('Control+=')
      await expect.poll(() => page.evaluate(async () => (await window.sotto!.getSettings()).terminalFontSize)).toBe(14)
      await expect.poll(grid).toBeLessThan(before)
      await expect(scope.locator('.xterm-rows')).toHaveCSS('font-size', '14px')
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.webContents.getZoomFactor())).toBe(1)
      await input.press('Control+-')
      await expect.poll(() => page.evaluate(async () => (await window.sotto!.getSettings()).terminalFontSize)).toBe(13)
      await input.press('Control+='); await input.press('Control+=')
      await expect.poll(() => page.evaluate(async () => (await window.sotto!.getSettings()).terminalFontSize)).toBe(15)
      await page.reload(); await openThreads(page)
      if (surface === 'workspace') {
        await page.getByRole('radio', { name: 'Terminal', exact: true }).click()
        await page.getByRole('button', { name: 'Search check', exact: true }).click()
      } else {
        await page.getByRole('button', { name: 'Workshop', exact: true }).first().click()
        if (surface === 'tools') {
          await page.getByRole('button', { name: 'Tools', exact: true }).click()
          await scope.getByRole('tablist', { name: 'Tools', exact: true }).getByRole('tab', { name: 'Terminal', exact: true }).click()
        }
      }
      await expect(scope.locator('.xterm-rows')).toHaveCSS('font-size', '15px')
      await input.press('Control+0')
      await expect.poll(() => page.evaluate(async () => (await window.sotto!.getSettings()).terminalFontSize)).toBe(13)
      await app.evaluate(({ clipboard, nativeImage }, png) => { const image = nativeImage.createFromBuffer(Buffer.from(png, 'base64')); if (image.isEmpty()) throw new Error('Clipboard fixture did not decode'); clipboard.writeImage(image) }, PNG)
      const clipboardFolder = join(folder, '.sotto', 'clipboard')
      await input.press('Control+f')
      await find.press('Control+v')
      expect(await readdir(clipboardFolder).catch(() => [])).toEqual([])
      await find.press('Escape')
      await input.press('Control+v')
      await input.press('Enter')
      await expect.poll(async () => readdir(clipboardFolder).catch(() => [])).toContain('.gitignore')
      await expect.poll(output).toMatch(/INPUT=.*\.sotto[\\/]clipboard[\\/].*\.png/u)
      const saved = (await readdir(clipboardFolder)).find(name => name.endsWith('.png'))!
      expect((await readFile(join(clipboardFolder, saved))).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
      await input.press('Control+f'); await find.fill('needle')
      await mkdir(SHOTS, { recursive: true })
      for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
        await resizeWindow(launched, width, height)
        await input.press('Control+l')
        await find.focus()
        for (const appearance of ['dark', 'light'] as const) {
          await page.evaluate(appearance => window.sotto!.updateSettings({ appearance }), appearance)
          await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
          await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'on')
          await expect(search.locator('output')).toHaveText(/of 3$/u)
          await expectHighlightOnText(scope)
          const box = await search.boundingBox(), bounds = await scope.locator('.terminal-view__screen').boundingBox()
          expect(box!.x).toBeGreaterThanOrEqual(bounds!.x)
          expect(box!.x + box!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width)
          expect(box!.y + box!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height)
          const screen = await scope.locator('.xterm-screen').boundingBox()
          expect(box!.y + box!.height, 'search stays above every output row and match').toBeLessThanOrEqual(screen!.y)
          for (const button of await search.getByRole('button').all()) await expect(button).toBeInViewport()
          await page.screenshot({ path: join(SHOTS, `${surface}-search-${width}x${height}-${appearance}.png`) })
          await linkControl.focus(); await linkControl.press('Enter')
          await expect(namedLink).toBeFocused()
          const linksBox = await picker.boundingBox()
          expect(linksBox!.x).toBeGreaterThanOrEqual(bounds!.x)
          expect(linksBox!.x + linksBox!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width)
          expect(linksBox!.y + linksBox!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height)
          await page.screenshot({ path: join(SHOTS, `${surface}-links-${width}x${height}-${appearance}.png`) })
          await namedLink.press('Escape'); await find.focus()
        }
      }
      expect(errors).toEqual([])
      if (surface === 'workspace') {
        await input.press('Control+b')
        await input.press('Control+f'); await find.fill('many-match')
        await expect(search.locator('output')).toHaveText('1 of 1000+')
        await find.press('Control+=')
        await expect.poll(() => page.evaluate(async () => (await window.sotto!.getSettings()).terminalFontSize)).toBe(14)
        await app.close()
        restarted = await launchSotto('success', launched.userData)
        expect(await restarted.page.evaluate(async () => (await window.sotto!.getSettings()).terminalFontSize)).toBe(14)
      }
    } finally { if (restarted) await closeSotto(restarted); await closeSotto(launched) }
  })
}
