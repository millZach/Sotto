import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeSotto, launchSotto, openThreads } from './support/sottoLaunch'

const SHOTS = resolve('artifacts/terminal-display')

/** Pixel assertion on the rendered grid, independent of DOM/WebGL implementation details. */
async function orangeCoverage(page: Page, png: Buffer): Promise<number> {
  return page.evaluate(async base64 => {
    const image = new Image()
    image.src = `data:image/png;base64,${base64}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.width; canvas.height = image.height
    const context = canvas.getContext('2d')!
    context.drawImage(image, 0, 0)
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data
    let minX = canvas.width, minY = canvas.height, maxX = 0, maxY = 0, count = 0
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      const index = (y * canvas.width + x) * 4
      if (Math.abs(data[index]! - 215) < 5 && Math.abs(data[index + 1]! - 119) < 5 && Math.abs(data[index + 2]! - 87) < 5) {
        count++; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y)
      }
    }
    return count < 100 ? 0 : count / ((maxX - minX + 1) * (maxY - minY + 1))
  }, png.toString('base64'))
}

test('native terminal preserves truecolor, contiguous block glyphs and redraws across themes, resize and reopen', async () => {
  test.skip(process.platform !== 'win32', 'Native Windows ConPTY acceptance')
  test.setTimeout(120_000)
  const launched = await launchSotto()
  const { page } = launched
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    const folder = await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'on' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
      const state = await window.sotto!.agents!.command({ type: 'connect' })
      const thread = state.host.threads.find(item => item.id === 'workshop')!
      return state.host.projects.find(project => project.id === thread.projectId)!.path
    })
    expect(folder.startsWith(launched.userData)).toBe(true)
    await mkdir(SHOTS, { recursive: true })
    // Uses Node's real TTY capability detection, plus RGB, indexed and ANSI colors and box-drawing.
    // No provider, network request or paid model invocation is involved.
    await writeFile(join(folder, 'terminal-display.cjs'), `
const color = process.stdout.getColorDepth() >= 24;
const e = '\\x1b[';
const paint = () => process.stdout.write(e+'2J'+e+'H'+
  (color ? e+'38;2;215;119;87m' : '') + ('████████\\r\\n').repeat(3)+e+'0m'+
  e+'38;5;46m'+'Indexed green'+e+'0m\\r\\n'+
  e+'33m'+'ANSI yellow'+e+'0m\\r\\n'+
  '┌──────────────┐\\r\\n│ Terminal TUI │\\r\\n└──────────────┘\\r\\n'+
  'COLOR_DEPTH='+process.stdout.getColorDepth()+'\\r\\n');
paint(); process.stdout.on('resize', paint);
process.stdin.setRawMode(true);process.stdin.resume();
process.stdin.on('data', data => { if(data.includes(3)) process.exit(0); });
`)
    await page.reload()
    await openThreads(page)
    await page.getByRole('button', { name: 'Workshop', exact: true }).first().click()
    await page.getByRole('button', { name: 'Tools', exact: true }).click()
    const panel = page.getByRole('complementary', { name: 'Tools', exact: true })
    await panel.getByRole('tablist', { name: 'Tools', exact: true }).getByRole('tab', { name: 'Terminal', exact: true }).click()
    await panel.getByRole('button', { name: 'Start terminal', exact: true }).click()
    const input = panel.locator('.xterm-helper-textarea')
    await input.pressSequentially('node terminal-display.cjs')
    await input.press('Enter')
    const output = () => page.evaluate(async () => {
      const list = await window.sotto!.terminal!.list({ threadId: 'workshop' })
      if (!list.ok || !list.value.sessions[0]) return ''
      const read = await window.sotto!.terminal!.read({ threadId: 'workshop', workspaceId: list.value.workspace.workspaceId, sessionId: list.value.sessions[0].id })
      return read.ok ? read.value.output : ''
    })
    await expect.poll(output).toContain('COLOR_DEPTH=24')
    await expect(panel.locator('.xterm-screen canvas:not(.xterm-link-layer)')).toBeVisible()
    for (const [width, height] of [[1280, 800], [820, 560]]) {
      await launched.app.evaluate(({ BrowserWindow }, size) => {
        const host = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!
        host.setContentSize(size[0]!, size[1]!)
      }, [width!, height!])
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(appearance => window.sotto!.updateSettings({ appearance }), appearance)
        await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
        await expect.poll(async () => orangeCoverage(page, await panel.locator('.terminal-view').screenshot())).toBeGreaterThan(.98)
        await page.screenshot({ path: join(SHOTS, `grid-${width}-${appearance}.png`) })
      }
    }
    await panel.getByRole('button', { name: 'Close tools panel', exact: true }).click()
    await expect(page.locator('.terminal-view canvas')).toHaveCount(0)
    await page.getByRole('button', { name: 'Tools', exact: true }).click()
    await expect(panel.locator('.xterm-screen canvas:not(.xterm-link-layer)')).toBeVisible()
    await expect.poll(async () => orangeCoverage(page, await panel.locator('.terminal-view').screenshot())).toBeGreaterThan(.98)
    // Losing the GPU must retain the screen and keyboard in the DOM fallback.
    await panel.locator('.xterm-screen canvas:not(.xterm-link-layer)').evaluate(canvas => {
      const context = (canvas as HTMLCanvasElement).getContext('webgl2')!
      const extension = context.getExtension('WEBGL_lose_context')
      if (!extension) throw new Error('GPU context-loss probe unavailable')
      extension.loseContext()
    })
    await expect(panel.locator('.xterm-rows')).toContainText('COLOR_DEPTH=24', { timeout: 10_000 })
    await input.press('Control+c')
    await expect.poll(output).toMatch(/PS .*terminal-display\.cjs[\s\S]*COLOR_DEPTH=24[\s\S]*PS /u)
    expect(errors).toEqual([])
  } finally { await closeSotto(launched) }
})

