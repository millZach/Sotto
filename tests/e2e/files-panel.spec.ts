import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { expect, test, type Page } from '@playwright/test'
import { closeSotto, launchSotto, type LaunchedSotto } from './support/sottoLaunch'

// Requires the shared tools slot to be mounted (ThreadsView `tools={props => <ToolsPanel {...props} />}` and one
// ToolsPanelToggle in the focused pane header). Real Files IPC reads real temporary folders; only providers are fixtures.
const SHOTS = 'artifacts/tools-ui'

function crc32(buffer: Buffer): number {
  let crc = ~0
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return ~crc >>> 0
}

function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2
  const rows = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * (width * 3 + 1) + 1 + x * 3
      const inside = Math.hypot(x - width / 2, y - height / 2) < width / 3
      rows[offset] = inside ? 70 : 24; rows[offset + 1] = inside ? 150 : 32; rows[offset + 2] = inside ? 240 : 40
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

async function project(root: string, name: string, files: Record<string, string | Buffer>): Promise<string> {
  const folder = join(root, name)
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(folder, path, '..'), { recursive: true })
    await writeFile(join(folder, path), content)
  }
  return folder
}

async function resize(launched: LaunchedSotto, width: number, height = 800): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!
    window.setContentSize(size.width, size.height)
  }, { width, height })
  await expect.poll(() => launched.page.evaluate(() => window.innerWidth)).toBe(width)
}

async function capture(page: Page, name: string): Promise<void> {
  for (const appearance of ['dark', 'light'] as const) {
    await page.evaluate(async mode => window.sotto!.updateSettings({ appearance: mode, accent: 'blue' }), appearance)
    await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
    await page.screenshot({ path: `${SHOTS}/${name}-${appearance}.png`, animations: 'disabled' })
  }
}

test('browses real working folders in the shared tools panel, following focus or pinned', async () => {
  test.setTimeout(120_000)
  const root = await mkdtemp(join(tmpdir(), 'sotto-e2e-files-'))
  const workshop = await project(root, 'workshop', {
    'README.md': '# Workshop\n\nA **small** fixture with a [safe link](https://example.com) and a remote image:\n\n![remote](https://example.com/tracker.png)\n\n- Browse folders\n- Preview files\n\n```ts\nexport const answer = 42\n```\n',
    'src/app.ts': "import { answer } from './answer'\n\nexport function main(): number {\n  return answer\n}\n",
    'src/answer.ts': 'export const answer = 42\n',
    'src/components/Button.tsx': 'export function Button() { return null }\n',
    'docs/guide.md': '## Guide\n\nSteps.\n',
    'assets/logo.png': png(96, 64),
    'data.bin': Buffer.from([0, 1, 2, 3, 0, 0, 255, 254, 0, 7]),
    'build.log': 'x'.repeat(600 * 1024),
    'notes.txt': 'Remove me during the test.\n',
  })
  const docs = await project(root, 'docs-site', { 'CHANGELOG.md': '# Changes\n\n1. First\n', 'package.json': '{ "name": "docs-site" }\n' })
  const launched = await launchSotto()
  const { app, page } = launched
  const clipboard = await app.evaluate(({ clipboard }) => clipboard.readText())
  try {
    const ids = await page.evaluate(async folders => {
      await window.sotto!.updateSettings({ onboardingComplete: true })
      const agents = window.sotto!.agents!
      await agents.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await agents.command({ type: 'connect' })
      const created: string[] = []
      for (const [title, path, thread] of [['workshop', folders[0], 'Workshop files'], ['docs-site', folders[1], 'Docs site']] as const) {
        await agents.command({ type: 'create-project', title, path, useExisting: true })
        const projectId = (await agents.get()).host.projects.find(item => item.title === title)!.id
        await agents.command({ type: 'create-thread', projectId, title: thread, modelId: 'claude:test', managed: false })
        created.push((await agents.get()).activeThreadId!)
      }
      return created
    }, [workshop, docs])
    expect(ids).toHaveLength(2)
    await page.reload()
    await page.getByRole('link', { name: 'Threads', exact: true }).click()
    await resize(launched, 1280)
    await page.getByRole('button', { name: 'Workshop files', exact: true }).first().click()
    await expect(page.getByRole('heading', { name: 'Workshop files', exact: true })).toBeVisible()

    const toggle = page.getByRole('button', { name: 'Tools', exact: true })
    await toggle.click()
    const panel = page.getByRole('complementary', { name: 'Tools' })
    await expect(panel).toHaveAttribute('data-mode', 'docked')
    await expect(page.getByRole('tab', { name: 'Files' })).toBeFocused()
    await expect(panel.getByRole('tab')).toHaveText(['Files', 'Changes', 'Terminal', 'Browser'])
    await expect(panel.locator('.tools-panel__path-text')).toHaveAttribute('title', workshop)
    const tree = panel.getByRole('tree')
    await expect(tree.getByRole('treeitem')).toHaveText(['assets', 'docs', 'src', 'build.log', 'data.bin', 'notes.txt', 'README.md'])

    // Keyboard: open src, move into it, open app.ts.
    await tree.getByRole('treeitem', { name: 'src' }).click()
    await expect(tree.getByRole('treeitem', { name: 'src' })).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await expect(tree.getByRole('treeitem', { name: 'app.ts' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(panel.locator('.files-preview__text')).toContainText('export function main(): number')
    await expect(tree.getByRole('treeitem', { name: 'app.ts' })).toHaveAttribute('aria-selected', 'true')
    await capture(page, 'focused-text-1280')

    await tree.getByRole('treeitem', { name: 'README.md' }).click()
    const markdown = panel.locator('.files-preview__markdown')
    await expect(markdown.getByRole('heading', { name: 'Workshop' })).toBeVisible()
    await expect(markdown.locator('img')).toHaveCount(0)
    await expect(panel.locator('img[src^="file:"], img[src^="http"]')).toHaveCount(0)
    await capture(page, 'focused-markdown-1280')
    await panel.getByRole('button', { name: 'Source' }).click()
    await expect(panel.locator('.files-preview__text')).toContainText('![remote](https://example.com/tracker.png)')
    await panel.getByRole('button', { name: 'Source' }).click()

    await panel.getByRole('button', { name: 'Copy path of README.md' }).click()
    await expect(panel.getByRole('status').filter({ hasText: 'Path copied' })).toBeVisible()
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(join(workshop, 'README.md'))

    await tree.getByRole('treeitem', { name: 'assets' }).click()
    await tree.getByRole('treeitem', { name: 'logo.png' }).click()
    const image = panel.locator('.files-preview__image img')
    await expect(image).toHaveAttribute('src', /^data:image\/png;base64,/)
    await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(96)
    await capture(page, 'focused-image-1280')

    await tree.getByRole('treeitem', { name: 'data.bin' }).click()
    await expect(panel.getByText('No preview for this file.')).toBeVisible()
    await tree.getByRole('treeitem', { name: 'build.log' }).click()
    await expect(panel.getByText('Too large to preview.')).toBeVisible()
    await capture(page, 'too-large-1280')

    // A file removed on disk is explained and recoverable.
    await tree.getByRole('treeitem', { name: 'notes.txt' }).click()
    await expect(panel.locator('.files-preview__text')).toContainText('Remove me')
    await unlink(join(workshop, 'notes.txt'))
    await panel.getByRole('button', { name: 'Refresh files' }).click()
    await expect(panel.getByText('This file is no longer here.')).toBeVisible()
    await capture(page, 'missing-file-1280')
    await panel.getByRole('button', { name: 'Refresh folder' }).click()
    await expect(tree.getByRole('treeitem', { name: 'notes.txt' })).toHaveCount(0)

    // Follow focus: the other thread shows its own folder; returning restores open folders and the selection.
    await tree.getByRole('treeitem', { name: 'app.ts' }).click()
    await page.getByRole('button', { name: 'Docs site', exact: true }).first().click()
    await expect(panel.locator('.tools-panel__path-text')).toHaveAttribute('title', docs)
    await expect(tree.getByRole('treeitem')).toHaveText(['CHANGELOG.md', 'package.json'])
    await page.getByRole('button', { name: 'Workshop files', exact: true }).first().click()
    await expect(panel.locator('.tools-panel__path-text')).toHaveAttribute('title', workshop)
    await expect(tree.getByRole('treeitem', { name: 'app.ts' })).toHaveAttribute('aria-selected', 'true')
    await expect(panel.locator('.files-preview__text')).toContainText('export function main')

    // Pin: focusing another thread leaves the panel on the pinned one, without changing the selection.
    await panel.getByRole('button', { name: 'Pin to Workshop files' }).click()
    await page.getByRole('button', { name: 'Docs site', exact: true }).first().click()
    await expect(page.getByRole('heading', { name: 'Docs site', exact: true })).toBeVisible()
    await expect(panel.getByText('Pinned', { exact: true })).toBeVisible()
    await expect(panel.locator('.tools-panel__path-text')).toHaveAttribute('title', workshop)
    expect(await page.evaluate(async () => (await window.sotto!.agents!.get()).activeThreadId)).toBe(ids[1])
    await capture(page, 'pinned-1280')
    await panel.getByRole('button', { name: 'Unpin from Workshop files' }).click()
    await expect(panel.locator('.tools-panel__path-text')).toHaveAttribute('title', docs)
    await tree.getByRole('treeitem', { name: 'CHANGELOG.md' }).click()
    await expect(panel.locator('.files-preview__markdown').getByRole('heading', { name: 'Changes' })).toBeVisible()
    await capture(page, 'focused-docs-1280')

    // The shipped minimum overlays the panel instead of squeezing the conversation.
    await resize(launched, 820)
    await expect(panel).toHaveAttribute('data-mode', 'overlay')
    const paneWidth = await page.locator('.thread-pane').first().evaluate(node => node.getBoundingClientRect().width)
    expect(paneWidth).toBeGreaterThanOrEqual(480)
    await capture(page, 'overlay-820')
    await panel.getByRole('button', { name: 'Pin to Docs site' }).click()
    await capture(page, 'overlay-pinned-820')
    await panel.getByRole('tab', { name: 'Files' }).focus()
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await expect(toggle).toBeFocused()

    // Reduced motion, docked, on this display's own scaling (recorded, not simulated).
    await resize(launched, 1280)
    await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark', accent: 'blue' }))
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await toggle.click()
    await expect(panel).toHaveAttribute('data-mode', 'docked')
    expect(await panel.locator('.tools-panel__sheet').evaluate(node => getComputedStyle(node).animationName)).toBe('none')
    const scale = await page.evaluate(() => window.devicePixelRatio)
    await page.screenshot({ path: `${SHOTS}/reduced-motion-1280-at-${Math.round(scale * 100)}-dark.png`, animations: 'disabled' })
  } finally {
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), clipboard).catch(() => undefined)
    await closeSotto(launched)
    await rm(root, { recursive: true, force: true })
  }
})
