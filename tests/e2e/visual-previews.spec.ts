import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

import { expect, test } from '@playwright/test'
import sharp from 'sharp'

const rendererRoot = resolve(process.cwd(), 'out/renderer')
const baselineRoot = resolve(process.cwd(), 'artifacts/design/baseline')
const actualRoot = resolve(process.cwd(), 'test-results/visual-previews/actual')
const buildRoot = resolve(process.cwd(), 'test-results/visual-previews/builds')
const previews = ['idle', 'listening', 'processing', 'pasted', 'copied', 'error'] as const
const themes = ['light', 'dark'] as const
const updateWidgetBaselines = process.env.SOTTO_UPDATE_WIDGET_BASELINES === '1'
const buildVariants = [
  ['unset', undefined],
  ['zero', '0'],
  ['other', 'true'],
  ['enabled', '1'],
] as const
type BuildVariant = (typeof buildVariants)[number][0]

const variantRoots: Readonly<Record<BuildVariant, string>> = {
  unset: resolve(buildRoot, 'unset'),
  zero: resolve(buildRoot, 'zero'),
  other: resolve(buildRoot, 'other'),
  enabled: resolve(buildRoot, 'enabled'),
}

interface PreviewPresentation {
  readonly background: string
  readonly animated: ReadonlyArray<readonly [string, string]>
  readonly descriptor: PropertyDescriptor | undefined
  readonly overflows: readonly string[]
  readonly detailFits: boolean
}

const contentTypes: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
}

let server: Server | undefined
let origin = ''

function buildRenderer(visualPreviewEnvironment: string | undefined): void {
  const environment = { ...process.env }
  if (visualPreviewEnvironment === undefined) delete environment.SOTTO_VISUAL_PREVIEW
  else environment.SOTTO_VISUAL_PREVIEW = visualPreviewEnvironment

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

async function assertProductionOutputRestored(): Promise<void> {
  const restoredHtml = await readFile(resolve(rendererRoot, 'widget.html'))
  const unsetHtml = await readFile(resolve(variantRoots.unset, 'widget.html'))
  if (digest(restoredHtml) !== digest(unsetHtml)) {
    throw new Error('Final renderer output does not match the unset production build')
  }
  const assetPaths = [...restoredHtml.toString('utf8').matchAll(/(?:src|href)="\.\/([^"]+)"/g)]
    .map((match) => match[1])
  for (const assetPath of assetPaths) {
    if (assetPath === undefined) continue
    const restored = await readFile(resolve(rendererRoot, assetPath))
    const unset = await readFile(resolve(variantRoots.unset, assetPath))
    if (digest(restored) !== digest(unset)) {
      throw new Error(`Final renderer asset does not match unset build: ${assetPath}`)
    }
  }
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(120_000)
  await rm(buildRoot, { force: true, recursive: true })
  await mkdir(buildRoot, { recursive: true })
  try {
    for (const [variant, environment] of buildVariants) {
      buildRenderer(environment)
      await rename(rendererRoot, variantRoots[variant])
    }
  } finally {
    // Leave the ordinary production output restored and fail-closed after test preparation.
    buildRenderer(undefined)
  }
  await assertProductionOutputRestored()

  const previewServer = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
      const segments = decodeURIComponent(requestUrl.pathname).split('/').filter(Boolean)
      const variant = segments.shift()
      if (variant === undefined || !Object.hasOwn(variantRoots, variant)) {
        response.writeHead(404).end('Not found')
        return
      }
      const root = variantRoots[variant as BuildVariant]
      const relativePath = segments.length === 0 ? 'widget.html' : segments.join('/')
      const candidate = resolve(root, relativePath)
      if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
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
  server = previewServer
  await new Promise<void>((resolveListening, reject) => {
    previewServer.once('error', reject)
    previewServer.listen(0, '127.0.0.1', resolveListening)
  })
  const address = previewServer.address()
  if (address === null || typeof address === 'string') throw new Error('Preview server has no TCP address')
  origin = `http://127.0.0.1:${address.port}`
})

test.afterAll(async () => {
  const previewServer = server
  if (previewServer === undefined || !previewServer.listening) return
  await new Promise<void>((resolveClosed, reject) => {
    previewServer.close((error) => error ? reject(error) : resolveClosed())
  })
})

function previewUrl(variant: BuildVariant, query: string): string {
  return `${origin}/${variant}/widget.html?${query}`
}

test('an unset production environment gate stays inert despite the immutable descriptor', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.setViewportSize({ width: 248, height: 88 })
  await page.addInitScript(`Object.defineProperty(window, '__SOTTO_VISUAL_PREVIEW__', {
    value: true,
    writable: false,
    configurable: false,
    enumerable: false,
  })`)
  await page.goto(previewUrl('unset', 'preview=listening&theme=dark'))
  await expect(page.locator('.widget-shell')).toHaveCount(0)
  await expect(page.locator('[data-announcement-channel]')).toHaveCount(2)
  await expect(page.locator('[data-announcement-channel="polite"]')).toBeEmpty()
  await expect(page.locator('[data-announcement-channel="assertive"]')).toBeEmpty()
  expect(pageErrors).toEqual([])
})

test('compiled zero and other environment values remain inert', async ({ page }) => {
  await page.setViewportSize({ width: 248, height: 88 })
  await page.addInitScript(`Object.defineProperty(window, '__SOTTO_VISUAL_PREVIEW__', {
    value: true,
    writable: false,
    configurable: false,
    enumerable: false,
  })`)
  for (const variant of ['zero', 'other'] as const) {
    await page.goto(previewUrl(variant, 'preview=listening&theme=dark'))
    await expect(page.locator('.widget-shell')).toHaveCount(0)
    await expect(page.locator('[data-announcement-channel]')).toHaveCount(2)
    await expect(page.locator('[data-announcement-channel="polite"]')).toBeEmpty()
    await expect(page.locator('[data-announcement-channel="assertive"]')).toBeEmpty()
  }
})

test('the exact SOTTO_VISUAL_PREVIEW=1 build gate enables immutable test previews', async ({ page }) => {
  await page.setViewportSize({ width: 248, height: 88 })
  await page.addInitScript(`Object.defineProperty(window, '__SOTTO_VISUAL_PREVIEW__', {
    value: true,
    writable: false,
    configurable: false,
    enumerable: false,
  })`)
  await page.goto(previewUrl('enabled', 'preview=listening&theme=dark'))
  await expect(page.locator('.widget-shell')).toHaveCount(1)
})

test('preview query alone remains inert in a preview-enabled build', async ({ page }) => {
  await page.setViewportSize({ width: 248, height: 88 })
  await page.goto(previewUrl('enabled', 'preview=listening&theme=dark'))
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
      await page.setViewportSize({ width: 248, height: 88 })
      await page.addInitScript(`Object.defineProperty(window, '__SOTTO_VISUAL_PREVIEW__', {
        value: true,
        writable: false,
        configurable: false,
        enumerable: false,
      })`)
      await page.goto(previewUrl('enabled', `preview=${preview}&theme=${theme}`))

      const shell = page.locator('.widget-shell')
      const pill = page.locator(preview === 'idle' ? '.widget-sliver' : '.widget-capsule')
      await expect(shell).toHaveCount(1)
      expect(pageErrors).toEqual([])
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'on')
      await expect(shell).toHaveAttribute('data-status', preview === 'pasted' || preview === 'copied' ? 'success' : preview)

      expect(await shell.boundingBox()).toEqual({ x: 0, y: 0, width: 248, height: 88 })
      const pillBox = await pill.boundingBox()
      expect(pillBox).not.toBeNull()
      expect(pillBox!.x).toBeGreaterThanOrEqual(0)
      expect(pillBox!.y).toBeGreaterThanOrEqual(0)
      expect(pillBox!.x + pillBox!.width).toBeLessThanOrEqual(248)
      expect(pillBox!.y + pillBox!.height).toBeLessThanOrEqual(88)

      const presentation = await page.evaluate<PreviewPresentation>(`(() => {
        const bodyStyle = getComputedStyle(document.body)
        const animated = Array.from(document.querySelectorAll('*')).map((element) => {
          const style = getComputedStyle(element)
          return [style.animationDuration, style.transitionDuration]
        })
        const overflows = Array.from(document.querySelectorAll('.widget-capsule *'))
          .filter((element) => {
            const bounds = element.getBoundingClientRect()
            return bounds.left < 0 || bounds.top < 0 || bounds.right > 248 || bounds.bottom > 88
          })
          .map((element) => element.className)
        return {
          background: bodyStyle.backgroundColor,
          animated,
          descriptor: Object.getOwnPropertyDescriptor(window, '__SOTTO_VISUAL_PREVIEW__'),
          overflows,
          detailFits: (() => {
            const detail = document.querySelector('.widget-copy')
            return detail === null || detail.scrollWidth <= detail.clientWidth
          })(),
        }
      })()`)
      expect(presentation.background).toBe('rgba(0, 0, 0, 0)')
      expect(presentation.descriptor).toMatchObject({ value: true, writable: false, configurable: false })
      expect(presentation.overflows).toEqual([])
      expect(presentation.detailFits).toBe(true)
      for (const [animation, transition] of presentation.animated) {
        expect(parseFloat(animation) || 0).toBeLessThanOrEqual(0.001)
        expect(parseFloat(transition) || 0).toBeLessThanOrEqual(0.001)
      }

      const baselinePath = resolve(baselineRoot, `${preview}-${theme}.png`)
      let baselineBefore: Buffer | null = await readFile(baselinePath).catch(() => null)
      if (baselineBefore === null && !updateWidgetBaselines) {
        throw new Error(`Missing widget baseline: ${baselinePath}`)
      }
      const baselineDigest = baselineBefore === null ? null : digest(baselineBefore)
      const screenshotPath = resolve(actualRoot, `${preview}-${theme}.png`)
      const image = await page.screenshot({
        path: screenshotPath,
        animations: 'disabled',
        omitBackground: true,
      })
      const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      expect(info.width).toBe(248)
      expect(info.height).toBe(88)
      expect(info.channels).toBe(4)

      if (updateWidgetBaselines) {
        await writeFile(baselinePath, image)
        baselineBefore = image
      }
      const baseline = await sharp(baselineBefore!).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
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
      if (!updateWidgetBaselines) expect(digest(await readFile(baselinePath))).toBe(baselineDigest!)

      const alphaAt = (x: number, y: number): number => data[(y * info.width + x) * 4 + 3] ?? 255
      for (let x = 0; x < info.width; x += 1) {
        expect(alphaAt(x, 0), `top edge pixel ${x}`).toBe(0)
        expect(alphaAt(x, info.height - 1), `bottom edge pixel ${x}`).toBe(0)
      }
      for (let y = 0; y < info.height; y += 1) {
        expect(alphaAt(0, y), `left edge pixel ${y}`).toBe(0)
        expect(alphaAt(info.width - 1, y), `right edge pixel ${y}`).toBe(0)
      }
      let transparentEdgePixels = 0
      let visiblePixels = 0
      for (let index = 3; index < data.length; index += 4) {
        if ((data[index] ?? 255) <= 16) transparentEdgePixels += 1
        if ((data[index] ?? 0) > 128) visiblePixels += 1
      }
      expect(transparentEdgePixels).toBeGreaterThan(500)
      expect(visiblePixels).toBeGreaterThan(preview === 'idle' ? 250 : 3_000)
    })
  }
}
