import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

import { expect, test } from '@playwright/test'
import sharp from 'sharp'

const rendererRoot = resolve(process.cwd(), 'out/renderer')
const baselineRoot = resolve(process.cwd(), 'artifacts/design/baseline')
const actualRoot = resolve(process.cwd(), 'test-results/visual-previews/actual')
const previews = ['listening', 'processing', 'pasted', 'copied', 'error'] as const
const themes = ['light', 'dark'] as const

interface PreviewPresentation {
  readonly background: string
  readonly animated: ReadonlyArray<readonly [string, string]>
  readonly descriptor: PropertyDescriptor | undefined
  readonly overflows: readonly string[]
}

const contentTypes: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
}

let server: Server
let origin = ''

function buildRenderer(visualPreviewEnvironment: string | undefined): void {
  const environment = { ...process.env }
  if (visualPreviewEnvironment === undefined) delete environment.TALKTYPE_VISUAL_PREVIEW
  else environment.TALKTYPE_VISUAL_PREVIEW = visualPreviewEnvironment

  if (process.platform === 'win32') {
    execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm.cmd run build'], {
      cwd: process.cwd(),
      env: environment,
      stdio: 'pipe',
    })
    return
  }
  execFileSync('npm', ['run', 'build'], {
    cwd: process.cwd(),
    env: environment,
    stdio: 'pipe',
  })
}

function digest(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  buildRenderer(undefined)
  server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
      const pathname = requestUrl.pathname === '/' ? '/widget.html' : requestUrl.pathname
      const candidate = resolve(rendererRoot, `.${decodeURIComponent(pathname)}`)
      if (candidate !== rendererRoot && !candidate.startsWith(`${rendererRoot}${sep}`)) {
        response.writeHead(403).end('Forbidden')
        return
      }
      const body = await readFile(candidate)
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': contentTypes[extname(candidate)] ?? 'application/octet-stream',
      })
      response.end(body)
    } catch {
      response.writeHead(404).end('Not found')
    }
  })
  await new Promise<void>((resolveListening, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListening)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Preview server has no TCP address')
  origin = `http://127.0.0.1:${address.port}`
})

test.afterAll(async () => {
  await new Promise<void>((resolveClosed, reject) => {
    server.close((error) => error ? reject(error) : resolveClosed())
  })
})

test('an unset production environment gate stays inert despite the immutable descriptor', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.setViewportSize({ width: 420, height: 92 })
  await page.addInitScript(`Object.defineProperty(window, '__TALKTYPE_VISUAL_PREVIEW__', {
    value: true,
    writable: false,
    configurable: false,
    enumerable: false,
  })`)
  await page.goto(`${origin}/widget.html?preview=listening&theme=dark`)
  await expect(page.locator('.widget-shell')).toHaveCount(0)
  await expect(page.locator('[data-announcement-channel]')).toHaveCount(2)
  await expect(page.locator('[data-announcement-channel="polite"]')).toBeEmpty()
  await expect(page.locator('[data-announcement-channel="assertive"]')).toBeEmpty()
  expect(pageErrors).toEqual([])
})

test('compiled zero and other environment values remain inert', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 92 })
  await page.addInitScript(`Object.defineProperty(window, '__TALKTYPE_VISUAL_PREVIEW__', {
    value: true,
    writable: false,
    configurable: false,
    enumerable: false,
  })`)
  for (const value of ['0', 'true']) {
    buildRenderer(value)
    await page.goto(`${origin}/widget.html?preview=listening&theme=dark`)
    await expect(page.locator('.widget-shell')).toHaveCount(0)
    await expect(page.locator('[data-announcement-channel]')).toHaveCount(2)
    await expect(page.locator('[data-announcement-channel="polite"]')).toBeEmpty()
    await expect(page.locator('[data-announcement-channel="assertive"]')).toBeEmpty()
  }
})

test('the exact TALKTYPE_VISUAL_PREVIEW=1 build gate enables immutable test previews', async ({ page }) => {
  buildRenderer('1')
  await page.setViewportSize({ width: 420, height: 92 })
  await page.addInitScript(`Object.defineProperty(window, '__TALKTYPE_VISUAL_PREVIEW__', {
    value: true,
    writable: false,
    configurable: false,
    enumerable: false,
  })`)
  await page.goto(`${origin}/widget.html?preview=listening&theme=dark`)
  await expect(page.locator('.widget-shell')).toHaveCount(1)
})

test('preview query alone remains inert in a preview-enabled build', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 92 })
  await page.goto(`${origin}/widget.html?preview=listening&theme=dark`)
  await expect(page.locator('.widget-shell')).toHaveCount(0)
  await expect(page.locator('[data-announcement-channel]')).toHaveCount(2)
  await expect(page.locator('[data-announcement-channel="polite"]')).toBeEmpty()
  await expect(page.locator('[data-announcement-channel="assertive"]')).toBeEmpty()
})

for (const theme of themes) {
  for (const preview of previews) {
    test(`${preview} ${theme} preview is deterministic, bounded, and transparent`, async ({ page }) => {
      const pageErrors: string[] = []
      page.on('pageerror', (error) => pageErrors.push(error.message))
      await page.setViewportSize({ width: 420, height: 92 })
      await page.addInitScript(`Object.defineProperty(window, '__TALKTYPE_VISUAL_PREVIEW__', {
        value: true,
        writable: false,
        configurable: false,
        enumerable: false,
      })`)
      await page.goto(`${origin}/widget.html?preview=${preview}&theme=${theme}`)

      const shell = page.locator('.widget-shell')
      const pill = page.locator('.widget-pill')
      await expect(shell).toHaveCount(1)
      expect(pageErrors).toEqual([])
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'on')
      await expect(shell).toHaveAttribute('data-status', preview === 'pasted' || preview === 'copied' ? 'success' : preview)

      expect(await shell.boundingBox()).toEqual({ x: 0, y: 0, width: 420, height: 92 })
      const pillBox = await pill.boundingBox()
      expect(pillBox).not.toBeNull()
      expect(pillBox!.x).toBeGreaterThanOrEqual(0)
      expect(pillBox!.y).toBeGreaterThanOrEqual(0)
      expect(pillBox!.x + pillBox!.width).toBeLessThanOrEqual(420)
      expect(pillBox!.y + pillBox!.height).toBeLessThanOrEqual(92)

      const presentation = await page.evaluate<PreviewPresentation>(`(() => {
        const bodyStyle = getComputedStyle(document.body)
        const animated = Array.from(document.querySelectorAll('*')).map((element) => {
          const style = getComputedStyle(element)
          return [style.animationDuration, style.transitionDuration]
        })
        const overflows = Array.from(document.querySelectorAll('.widget-pill *'))
          .filter((element) => {
            const bounds = element.getBoundingClientRect()
            return bounds.left < 0 || bounds.top < 0 || bounds.right > 420 || bounds.bottom > 92
          })
          .map((element) => element.className)
        return {
          background: bodyStyle.backgroundColor,
          animated,
          descriptor: Object.getOwnPropertyDescriptor(window, '__TALKTYPE_VISUAL_PREVIEW__'),
          overflows,
        }
      })()`)
      expect(presentation.background).toBe('rgba(0, 0, 0, 0)')
      expect(presentation.descriptor).toMatchObject({ value: true, writable: false, configurable: false })
      expect(presentation.overflows).toEqual([])
      for (const [animation, transition] of presentation.animated) {
        expect(parseFloat(animation) || 0).toBeLessThanOrEqual(0.001)
        expect(parseFloat(transition) || 0).toBeLessThanOrEqual(0.001)
      }

      const baselinePath = resolve(baselineRoot, `${preview}-${theme}.png`)
      const baselineBefore = await readFile(baselinePath)
      const baselineDigest = digest(baselineBefore)
      const screenshotPath = resolve(actualRoot, `${preview}-${theme}.png`)
      const image = await page.screenshot({
        path: screenshotPath,
        animations: 'disabled',
        omitBackground: true,
      })
      const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      expect(info.width).toBe(420)
      expect(info.height).toBe(92)
      expect(info.channels).toBe(4)

      const baseline = await sharp(baselineBefore).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      expect(baseline.info.width).toBe(info.width)
      expect(baseline.info.height).toBe(info.height)
      expect(baseline.info.channels).toBe(info.channels)
      let changedPixels = 0
      let maximumChannelDelta = 0
      for (let index = 0; index < data.length; index += 4) {
        let changed = false
        for (let channel = 0; channel < 4; channel += 1) {
          const delta = Math.abs((data[index + channel] ?? 0) - (baseline.data[index + channel] ?? 0))
          maximumChannelDelta = Math.max(maximumChannelDelta, delta)
          if (delta !== 0) changed = true
        }
        if (changed) changedPixels += 1
      }
      expect(changedPixels).toBe(0)
      expect(maximumChannelDelta).toBe(0)
      expect(digest(await readFile(baselinePath))).toBe(baselineDigest)

      const alphaAt = (x: number, y: number): number => data[(y * info.width + x) * 4 + 3] ?? 255
      // A very faint edge alpha is the pill's deliberate drop shadow, never a canvas fill.
      expect(alphaAt(0, 0)).toBeLessThanOrEqual(16)
      expect(alphaAt(419, 0)).toBeLessThanOrEqual(16)
      expect(alphaAt(0, 91)).toBeLessThanOrEqual(16)
      expect(alphaAt(419, 91)).toBeLessThanOrEqual(16)
      let transparentEdgePixels = 0
      let visiblePixels = 0
      for (let index = 3; index < data.length; index += 4) {
        if ((data[index] ?? 255) <= 16) transparentEdgePixels += 1
        if ((data[index] ?? 0) > 128) visiblePixels += 1
      }
      expect(transparentEdgePixels).toBeGreaterThan(500)
      expect(visiblePixels).toBeGreaterThan(10_000)
    })
  }
}
