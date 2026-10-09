import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

import { expect, test, type Locator, type Page } from '@playwright/test'
import sharp from 'sharp'

import { DESIGN_CAPTURE_APP_THEMES, DESIGN_CAPTURE_SCALES, DESIGN_CAPTURE_WIDGET_THEMES } from '../../../scripts/design-capture-matrix.mjs'
import type { Appearance } from '../../../src/shared/settings'
import { baselineRoot, repositoryRoot, digest, requiredMetadata, recordCaptureEntry } from './designCaptureManifest.mjs'
import type { LaunchedSotto } from './sottoLaunch'

const updateBaselines = process.env.SOTTO_UPDATE_DESIGN_BASELINES === '1'
const actualRoot = resolve(repositoryRoot, 'test-results/design-capture/actual')
/** The main window has a dark and a light room; the untouched widget still follows the system scheme. */
export const appThemes = DESIGN_CAPTURE_APP_THEMES
export const widgetThemes = DESIGN_CAPTURE_WIDGET_THEMES
export const scales = DESIGN_CAPTURE_SCALES
type WidgetTheme = (typeof widgetThemes)[number]
type AppTheme = (typeof appThemes)[number]
type CaptureTheme = AppTheme | WidgetTheme
type CaptureScale = (typeof scales)[number]
type CaptureMotion = 'normal' | 'reduced'
type CaptureFocusTarget = 'none' | 'tab' | 'navigation' | 'input' | 'switch' | 'destructive'

interface CaptureMetadata {
  readonly category: 'onboarding' | 'dictate' | 'agents' | 'history' | 'settings' | 'help' | 'threads' | 'scale' | 'widget' | 'appearance' | 'width'
  readonly state: string
  readonly theme: CaptureTheme
  readonly scalePercent: CaptureScale
  readonly motion: CaptureMotion
  readonly focusTarget: CaptureFocusTarget
}

type CaptureHint = Partial<CaptureMetadata> & {
  readonly focus?: boolean
  readonly reducedMotion?: boolean
}

async function waitForStableFrame(page: Page): Promise<void> {
  // Clicks, scrolling, and scale changes can leave the pointer over a different
  // control by capture time (including Chromium's native checkbox hover paint).
  // Park it on the empty top-left window edge before settling animations. A
  // move alone preserves the keyboard focus and :focus-visible being reviewed.
  await page.mouse.move(0, 0)
  await page.evaluate(`(async () => {
    await document.fonts.ready
    // Infinite animations (the hero wave's keyframes) would be
    // captured at whatever phase the screenshot happens to land on, so pin
    // them all to the start of their cycle; finite ones are awaited below.
    for (const animation of document.getAnimations()) {
      const pinEndTime = animation.effect?.getComputedTiming().endTime
      const finite = typeof pinEndTime === 'number' && Number.isFinite(pinEndTime) && pinEndTime <= 1000
      if (finite) continue
      try {
        animation.currentTime = 0
        animation.pause()
      } catch {}
    }
    const finiteAnimations = document.getAnimations().filter((animation) => {
      const endTime = animation.effect?.getComputedTiming().endTime
      return typeof endTime === 'number' && Number.isFinite(endTime) && endTime <= 1000
    })
    await Promise.race([
      Promise.all(finiteAnimations.map((animation) => animation.finished.catch(() => undefined))),
      new Promise((resolveTimeout) => setTimeout(resolveTimeout, 1100)),
    ])
    await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)))
  })()`)
}

async function pageBoundProblems(page: Page): Promise<string[]> {
  return page.evaluate<string[]>(`(() => {
    const problems = []
    const tolerance = 1
    const documentRoot = document.documentElement
    if (documentRoot.scrollWidth > documentRoot.clientWidth + tolerance) problems.push('document-horizontal-overflow')
    if (document.body.scrollWidth > document.body.clientWidth + tolerance) problems.push('body-horizontal-overflow')

    for (const selector of ['.app-room', '.thread-workspace']) {
      const content = document.querySelector(selector)
      if (content !== null && content.scrollWidth > content.clientWidth + tolerance) problems.push('room-horizontal-overflow')
    }

    // The Threads page owns the whole window, so it has neither strip nor footer. Its own chrome takes their place and
    // has to be there: a missing sidebar or workspace would otherwise leave this check with nothing to measure.
    if (document.querySelector('.threads-view') !== null) {
      for (const selector of ['.thread-nav', '.thread-workspace']) {
        if (document.querySelector(selector) === null) problems.push(selector + '-missing')
      }
    }

    for (const selector of ['.app-shell', '.app-strip', '.app-room', '.app-footer', '.onboarding-shell', '.threads-view', '.thread-nav', '.thread-workspace', '.threads-view__winctl']) {
      const element = document.querySelector(selector)
      if (element === null) continue
      const bounds = element.getBoundingClientRect()
      if (bounds.left < -tolerance || bounds.right > innerWidth + tolerance) problems.push(selector + '-outside-horizontal-bounds')
      if (selector !== '.onboarding-shell' && (bounds.top < -tolerance || bounds.bottom > innerHeight + tolerance)) problems.push(selector + '-outside-vertical-bounds')
    }

    for (const element of document.querySelectorAll('button, input, select, textarea, a')) {
      const bounds = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      if (style.display === 'none' || style.visibility === 'hidden' || bounds.width === 0 || bounds.height === 0) continue
      if (bounds.left < -tolerance || bounds.right > innerWidth + tolerance) {
        const label = element.getAttribute('aria-label') || (element.textContent || '').trim().slice(0, 30) || 'control'
        problems.push(element.tagName.toLowerCase() + '-' + label + '-clipped')
      }
      if (element.scrollWidth > element.clientWidth + tolerance || element.scrollHeight > element.clientHeight + tolerance) {
        const label = element.getAttribute('aria-label') || (element.textContent || '').trim().slice(0, 30) || 'control'
        problems.push(element.tagName.toLowerCase() + '-' + label + '-content-clipped')
      }
    }

    for (const toggle of document.querySelectorAll('.tt-toggle')) {
      const track = toggle.querySelector('.tt-toggle__track')
      const copy = toggle.querySelector('.tt-toggle__copy')
      if (track === null || copy === null) {
        problems.push('toggle-missing-layout-region')
        continue
      }
      const trackBox = track.getBoundingClientRect()
      const copyBox = copy.getBoundingClientRect()
      const overlaps = trackBox.left < copyBox.right && trackBox.right > copyBox.left && trackBox.top < copyBox.bottom && trackBox.bottom > copyBox.top
      if (overlaps) problems.push('toggle-track-copy-overlap-' + (toggle.getAttribute('aria-label') || 'unnamed'))
      if (copy.scrollWidth > copy.clientWidth + tolerance || copy.scrollHeight > copy.clientHeight + tolerance) {
        problems.push('toggle-copy-clipped-' + (toggle.getAttribute('aria-label') || 'unnamed'))
      }
      for (const line of copy.querySelectorAll('strong, .tt-field__description')) {
        if (line.scrollWidth > line.clientWidth + tolerance || line.scrollHeight > line.clientHeight + tolerance) {
          problems.push('toggle-text-clipped-' + (toggle.getAttribute('aria-label') || 'unnamed'))
        }
      }
    }

    for (const shortcut of document.querySelectorAll('.tt-shortcut')) {
      if (shortcut.scrollWidth > shortcut.clientWidth + tolerance) problems.push('shortcut-horizontal-overflow')
    }

    // The Dictate room's last-transcript row must sit inside the room, not scroll away.
    const lastTranscript = document.querySelector('.dictate__last')
    const contentBounds = document.querySelector('.app-room')?.getBoundingClientRect()
    if (lastTranscript !== null && contentBounds !== undefined) {
      const rowBounds = lastTranscript.getBoundingClientRect()
      if (rowBounds.bottom > contentBounds.bottom + tolerance || rowBounds.top < contentBounds.top - tolerance) {
        problems.push('dictate-last-transcript-not-fully-visible')
      }
    }
    return [...new Set(problems)]
  })()`)
}

export async function assertFocusPresentation(locator: Locator): Promise<void> {
  await locator.focus()
  if (!await locator.evaluate((element: unknown) => (element as { matches: (selector: string) => boolean }).matches(':focus-visible'))) {
    // A focus ring only shows once the last input was the keyboard. Shift says
    // that on its own: it moves focus nowhere and presses nothing, so the
    // control beside this one is not focused and then blurred. Tab was used
    // here before, and the blur it caused on the way back saved a setting the
    // capture never asked to change.
    await locator.page().keyboard.press('Shift')
    await locator.focus()
  }
  expect(await locator.evaluate((element: unknown) => (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement === element)).toBe(true)
  expect(await locator.evaluate((element: unknown) => (element as { matches: (selector: string) => boolean }).matches(':focus-visible'))).toBe(true)
  const outline = await locator.evaluate((element: unknown) => {
    const computed = (globalThis as unknown as { getComputedStyle: (target: unknown) => { outlineWidth: string; outlineStyle: string; outlineColor: string } }).getComputedStyle(element)
    return { width: computed.outlineWidth, style: computed.outlineStyle, color: computed.outlineColor }
  })
  expect(outline.width).toBe('3px')
  expect(outline.style).not.toBe('none')
  expect(outline.color).not.toBe('rgba(0, 0, 0, 0)')
}

/**
 * Settings starts every section visit at its heading, so that is what a section
 * is photographed showing. Playwright scrolls a control into view before it
 * presses it, and the saved-setting notice sits above the scrollport rather
 * than inside it, so a shot taken after a press would otherwise be framed by
 * whichever control was pressed and whether a notice was already up.
 */
export async function startSettingsAtHeading(page: Page): Promise<void> {
  await page.evaluate("document.querySelector('.settings-scroll')?.scrollTo(0, 0)")
  await expect.poll(() => page.evaluate("document.querySelector('.settings-scroll')?.scrollTop ?? -1")).toBe(0)
}

/** The Dictate room says its state in the one sentence and marks the section for styling. */
/** Save an appearance choice the way Settings does and wait for the root to repaint. */
export async function setAppearance(page: Page, patch: { readonly appearance?: Appearance; readonly lightTheme?: string; readonly darkTheme?: string }, resolved: AppTheme): Promise<void> {
  await page.evaluate(async (next) => { await window.sotto!.updateSettings(next) }, patch)
  await expect(page.locator('html')).toHaveAttribute('data-theme', resolved)
  const owner = resolved === 'light' ? patch.lightTheme : patch.darkTheme
  if (owner !== undefined) await expect(page.locator('html')).toHaveAttribute('data-theme-id', owner)
  await expect(page.locator('html')).not.toHaveAttribute('data-theme-switching')
}

/** Every token the room paints resolves through the root, so the rendered colours prove the mode and native controls follow. */
export async function assertRenderedRoom(page: Page, theme: AppTheme): Promise<void> {
  const painted = await page.evaluate(() => {
    const select = document.querySelector('select')
    // Paint the root's canvas token on a probe so the token and the body compare as the same computed colour,
    // whatever notation the palette wrote it in (the canvases are oklch colours), and rasterise it to judge
    // its lightness: every dark theme paints a dark canvas and every light theme a light one, not one literal.
    const probe = document.createElement('div')
    probe.style.backgroundColor = getComputedStyle(document.documentElement).getPropertyValue('--tt-canvas').trim()
    document.body.append(probe)
    const token = getComputedStyle(probe).backgroundColor
    probe.remove()
    const context = document.createElement('canvas').getContext('2d')!
    context.fillStyle = token
    context.fillRect(0, 0, 1, 1)
    const [red, green, blue] = context.getImageData(0, 0, 1, 1).data
    return {
      canvas: getComputedStyle(document.body).backgroundColor,
      token,
      luminance: (0.2126 * red! + 0.7152 * green! + 0.0722 * blue!) / 255,
      scheme: getComputedStyle(document.documentElement).colorScheme,
      selectScheme: select === null ? null : getComputedStyle(select).colorScheme,
    }
  })
  expect(painted.canvas).toBe(painted.token)
  expect(painted.luminance < 0.5).toBe(theme === 'dark')
  expect(painted.scheme).toBe(theme)
  if (painted.selectScheme !== null) expect(painted.selectScheme).toBe(theme)
}

/** Narrow the main window below its shipped minimum to the Phase 1 review width. */
export async function setMainWindowWidth(launched: LaunchedSotto, width: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, contentWidth) => {
    const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().endsWith('/index.html'))!
    window.setMinimumSize(contentWidth, 560)
    window.setContentSize(contentWidth, 720)
  }, width)
  await expect.poll(() => launched.page.evaluate<number>('innerWidth')).toBe(width)
}

export async function assertDictateState(page: Page, status: string, sentence: RegExp): Promise<void> {
  await expect(page.locator('.dictate')).toHaveAttribute('data-status', status)
  await expect(page.getByRole('heading', { level: 1, name: sentence })).toBeVisible()
}

interface PixelDifference {
  readonly changedPixels: number
  readonly totalChannelDelta: number
  readonly pixelCount: number
}

/**
 * Per-channel deltas at or below this are treated as identical. Chromium's
 * rasterization of the same frame drifts by a few units per channel across
 * runs and reboots (measured: 1 on the breath line between two same-day runs,
 * up to 5 on a button border across two days) with nothing visibly different.
 * Real changes clear this floor by an order of magnitude - a retimed text
 * label measured >100 - so the gate keeps its teeth while no longer failing
 * on pixels nobody can see.
 */
const CHANNEL_NOISE_FLOOR = 6

async function pixelDifference(actual: Buffer, baseline: Buffer): Promise<PixelDifference> {
  const actualImage = await sharp(actual).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const baselineImage = await sharp(baseline).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  if (
    actualImage.info.width !== baselineImage.info.width ||
    actualImage.info.height !== baselineImage.info.height ||
    actualImage.info.channels !== baselineImage.info.channels
  ) {
    return { changedPixels: Number.POSITIVE_INFINITY, totalChannelDelta: Number.POSITIVE_INFINITY, pixelCount: baselineImage.info.width * baselineImage.info.height }
  }
  let changedPixels = 0
  let totalChannelDelta = 0
  for (let index = 0; index < actualImage.data.length; index += 4) {
    let changed = false
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs((actualImage.data[index + channel] ?? 0) - (baselineImage.data[index + channel] ?? 0))
      if (delta <= CHANNEL_NOISE_FLOOR) continue
      totalChannelDelta += delta
      changed = true
    }
    if (changed) changedPixels += 1
  }
  return {
    changedPixels,
    totalChannelDelta,
    pixelCount: actualImage.info.width * actualImage.info.height,
  }
}

function pixelDifferenceLimits(pixelCount: number): { readonly changedPixels: number; readonly totalChannelDelta: number } {
  return {
    changedPixels: Math.max(100, Math.floor(pixelCount * 0.0005)),
    totalChannelDelta: Math.max(1_000, Math.floor(pixelCount * 0.005)),
  }
}

function isNegligibleDifference(difference: PixelDifference): boolean {
  const limits = pixelDifferenceLimits(difference.pixelCount)
  return difference.changedPixels <= limits.changedPixels &&
    difference.totalChannelDelta <= limits.totalChannelDelta
}

async function stableScreenshot(
  fileName: string,
  capture: () => Promise<Buffer>,
  settle: () => Promise<void>,
): Promise<Buffer> {
  const destination = resolve(baselineRoot, fileName)
  if (!updateBaselines) {
    const baseline = await readFile(destination)
    let closest: { image: Buffer; difference: PixelDifference } | undefined
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const image = await capture()
      const difference = await pixelDifference(image, baseline)
      if (isNegligibleDifference(difference)) return image
      if (closest === undefined || difference.totalChannelDelta < closest.difference.totalChannelDelta) closest = { image, difference }
      await settle()
    }
    if (closest !== undefined) return closest.image
    throw new Error(`No screenshot was produced for ${fileName}`)
  }

  const first = await capture()
  await settle()
  const second = await capture()
  const firstSecond = await pixelDifference(first, second)
  if (isNegligibleDifference(firstSecond)) return second
  await settle()
  const third = await capture()
  const secondThird = await pixelDifference(second, third)
  const firstThird = await pixelDifference(first, third)
  const candidates = [
    { image: second, difference: firstSecond },
    { image: third, difference: secondThird },
    { image: third, difference: firstThird },
  ]
  candidates.sort((left, right) => left.difference.totalChannelDelta - right.difference.totalChannelDelta)
  return candidates[0]!.image
}

async function comparePixels(actual: Buffer, baseline: Buffer, name: string): Promise<void> {
  const difference = await pixelDifference(actual, baseline)
  const { changedPixels, totalChannelDelta, pixelCount } = difference
  const changedPixelLimit = Math.max(100, Math.floor(pixelCount * 0.0005))
  const totalDeltaLimit = Math.max(1_000, Math.floor(pixelCount * 0.005))
  const materiallyChanged = changedPixels > changedPixelLimit || totalChannelDelta > totalDeltaLimit
  if (materiallyChanged) {
    await mkdir(actualRoot, { recursive: true })
    await writeFile(resolve(actualRoot, name), actual)
  }
  const message = `${name} changed materially; actual image was saved under test-results/design-capture/actual`
  expect(changedPixels, message).toBeLessThanOrEqual(changedPixelLimit)
  expect(totalChannelDelta, message).toBeLessThanOrEqual(totalDeltaLimit)
}

async function recordCapture(image: Buffer, fileName: string, hint: CaptureHint = {}): Promise<void> {
  const destination = resolve(baselineRoot, fileName)
  let baseline: Buffer
  if (updateBaselines) {
    await mkdir(baselineRoot, { recursive: true })
    await writeFile(destination, image)
    baseline = image
  } else {
    baseline = await readFile(destination)
    await comparePixels(image, baseline, fileName)
  }
  const imageMetadata = await sharp(baseline).metadata()
  if (imageMetadata.width === undefined || imageMetadata.height === undefined) throw new Error(`Invalid capture: ${fileName}`)
  const metadata = requiredMetadata(fileName)
  if (metadata.source !== 'app-review') throw new Error(`Live capture cannot write external baseline entry: ${fileName}`)
  for (const key of ['category', 'state', 'theme', 'scalePercent', 'motion', 'focusTarget'] as const) {
    if (hint[key] !== undefined && hint[key] !== metadata[key]) throw new Error(`Capture hint does not match matrix for ${fileName}: ${key}`)
  }
  if (hint.reducedMotion === true && metadata.motion !== 'reduced') throw new Error(`Reduced-motion hint does not match matrix for ${fileName}`)
  if (hint.focus === true && metadata.focusTarget === 'none') throw new Error(`Focus hint does not match matrix for ${fileName}`)
  await recordCaptureEntry({
    ...metadata,
    id: fileName.replace(/\.png$/u, ''),
    relativePath: relative(repositoryRoot, destination).replaceAll('\\', '/'),
    width: imageMetadata.width,
    height: imageMetadata.height,
    sha256: digest(baseline),
  }, test.info().file, test.info().workerIndex)
}

export async function capturePage(page: Page, fileName: string, metadata: CaptureHint = {}, fullPage = false): Promise<void> {
  await waitForStableFrame(page)
  expect(await pageBoundProblems(page), `${fileName} has clipped or overflowing application chrome`).toEqual([])
  const image = await stableScreenshot(
    fileName,
    () => page.screenshot({ caret: 'hide', fullPage }),
    () => waitForStableFrame(page),
  )
  await recordCapture(image, fileName, metadata)
}

export async function captureSection(page: Page, section: Locator, fileName: string, metadata: CaptureHint = {}): Promise<void> {
  await section.scrollIntoViewIfNeeded()
  await waitForStableFrame(page)
  expect(await pageBoundProblems(page), `${fileName} has clipped or overflowing controls`).toEqual([])
  const bounds = await section.boundingBox()
  expect(bounds, `${fileName} section must have visible bounds`).not.toBeNull()
  expect(bounds!.width).toBeGreaterThan(200)
  expect(bounds!.height).toBeGreaterThan(100)
  const image = await stableScreenshot(
    fileName,
    () => section.screenshot({ caret: 'hide' }),
    () => waitForStableFrame(page),
  )
  await recordCapture(image, fileName, metadata)
}

export async function captureFullSurface(
  page: Page,
  surface: Locator,
  fileName: string,
  requiredText: RegExp,
  metadata: CaptureHint = {},
): Promise<void> {
  await expect(surface).toHaveCount(1)
  await expect(surface.getByText(requiredText).first()).toBeVisible()
  await page.evaluate("document.querySelector('.app-room')?.scrollTo(0, 0)")
  await waitForStableFrame(page)
  expect(await pageBoundProblems(page), `${fileName} has overlap, wrapping, or clipping defects`).toEqual([])
  await page.evaluate(`(() => {
    const shell = document.querySelector('.app-shell')
    const room = document.querySelector('.app-room')
    if (!(shell instanceof HTMLElement) || !(room instanceof HTMLElement)) throw new Error('management scroll surface is unavailable')
    // The shell is three rows (strip | room | footer) pinned to the viewport;
    // let it and the room grow to the page so the whole surface is in frame.
    shell.style.setProperty('height', 'auto')
    shell.style.setProperty('min-height', '0')
    shell.style.setProperty('overflow', 'visible')
    shell.style.setProperty('grid-template-rows', 'auto auto auto')
    room.style.setProperty('overflow', 'visible')
    room.style.setProperty('height', 'auto')
  })()`)
  try {
    await waitForStableFrame(page)
    const bounds = await surface.boundingBox()
    const requiredBounds = await surface.getByText(requiredText).first().boundingBox()
    expect(bounds, `${fileName} full surface must have layout bounds`).not.toBeNull()
    expect(requiredBounds, `${fileName} required lower content must have bounds`).not.toBeNull()
    expect(bounds!.width).toBeGreaterThan(200)
    expect(bounds!.height).toBeGreaterThan(300)
    expect(requiredBounds!.y + requiredBounds!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height + 1)
    const image = await stableScreenshot(
      fileName,
      () => surface.screenshot({ caret: 'hide', animations: 'disabled' }),
      () => waitForStableFrame(page),
    )
    await recordCapture(image, fileName, metadata)
  } finally {
    await page.evaluate(`(() => {
      const shell = document.querySelector('.app-shell')
      const room = document.querySelector('.app-room')
      if (shell instanceof HTMLElement) for (const property of ['height', 'min-height', 'overflow', 'grid-template-rows']) shell.style.removeProperty(property)
      if (room instanceof HTMLElement) for (const property of ['overflow', 'height']) room.style.removeProperty(property)
    })()`)
  }
}

export async function captureWidget(
  page: Page,
  fileName: string,
  metadata: CaptureHint = {},
  // The resting idle widget renders in its own smaller native footprint; all
  // other states use the active 248x88 window.
  footprint: { readonly width: number; readonly height: number } = { width: 248, height: 88 },
): Promise<void> {
  // The live pill counts wall-clock seconds even when its animations are
  // paused. Freeze only this test renderer's Date so repeated captures do not
  // compare 00:00 with 00:01; timers and real recording effects keep running.
  const elapsed = page.locator('.widget-time')
  if (await elapsed.count()) {
    await page.clock.setFixedTime(0)
    await expect(elapsed).toHaveText('00:00')
  }
  await waitForStableFrame(page)
  const logicalViewport = await page.evaluate<readonly [number, number]>('[innerWidth, innerHeight]')
  expect(logicalViewport[0]).toBeGreaterThanOrEqual(footprint.width)
  expect(logicalViewport[0]).toBeLessThanOrEqual(footprint.width + 4)
  expect(logicalViewport[1]).toBeGreaterThanOrEqual(footprint.height)
  expect(logicalViewport[1]).toBeLessThanOrEqual(footprint.height + 4)
  const widgetProblems = await page.evaluate<string[]>(`(() => {
    const problems = []
    for (const element of document.querySelectorAll('.widget-capsule, .widget-capsule *, .widget-sliver')) {
      const bounds = element.getBoundingClientRect()
      if (bounds.left < 0 || bounds.top < 0 || bounds.right > ${footprint.width} || bounds.bottom > ${footprint.height}) problems.push(element.className || element.tagName)
    }
    const detail = document.querySelector('.widget-copy')
    if (detail !== null) {
      // Horizontal overrun is fine when the element declares ellipsis — that
      // truncation is the widget's designed behaviour for long status lines
      // ("Waiting for microphone" ellipsizes by intent). Vertical overrun or
      // a plain hidden-overflow cut is still a real clip.
      const style = getComputedStyle(detail)
      const designedTruncation = style.textOverflow === 'ellipsis' && style.whiteSpace === 'nowrap'
      const clippedX = detail.scrollWidth > detail.clientWidth && !designedTruncation
      const clippedY = detail.scrollHeight > detail.clientHeight
      if (clippedX || clippedY) problems.push('widget-detail-clipped:' + detail.textContent + ':' + detail.scrollWidth + 'x' + detail.scrollHeight + '>' + detail.clientWidth + 'x' + detail.clientHeight)
    }
    return problems
  })()`)
  expect(widgetProblems, `${fileName} has clipped widget content`).toEqual([])
  const image = await stableScreenshot(
    fileName,
    () => page.screenshot({ caret: 'hide', omitBackground: true }),
    () => waitForStableFrame(page),
  )
  const dimensions = await sharp(image).metadata()
  expect(dimensions.width).toBeGreaterThanOrEqual(footprint.width)
  expect(dimensions.height).toBeGreaterThanOrEqual(footprint.height)
  const rgba = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const alphaAt = (x: number, y: number): number => rgba.data[(y * rgba.info.width + x) * 4 + 3] ?? 255
  for (let x = 0; x < rgba.info.width; x += 1) {
    expect(alphaAt(x, 0), `${fileName} top edge ${x}`).toBe(0)
    expect(alphaAt(x, rgba.info.height - 1), `${fileName} bottom edge ${x}`).toBe(0)
  }
  for (let y = 0; y < rgba.info.height; y += 1) {
    expect(alphaAt(0, y), `${fileName} left edge ${y}`).toBe(0)
    expect(alphaAt(rgba.info.width - 1, y), `${fileName} right edge ${y}`).toBe(0)
  }
  await recordCapture(image, fileName, metadata)
}

/** The widget still themes itself from the system scheme, so the scheme is emulated on its window alone. */
export async function widgetPage(launched: LaunchedSotto, theme: WidgetTheme, motion: CaptureMotion = 'normal'): Promise<Page> {
  await expect.poll(() => launched.app.windows().some((candidate) => candidate.url().endsWith('/widget.html'))).toBe(true)
  const widget = launched.app.windows().find((candidate) => candidate.url().endsWith('/widget.html'))
  if (widget === undefined) throw new Error('Widget renderer was not created')
  await widget.waitForLoadState('domcontentloaded')
  await widget.emulateMedia({ colorScheme: theme, reducedMotion: motion === 'reduced' ? 'reduce' : 'no-preference' })
  await expect.poll(() => widget.evaluate("matchMedia('(prefers-color-scheme: dark)').matches")).toBe(theme === 'dark')
  return widget
}
