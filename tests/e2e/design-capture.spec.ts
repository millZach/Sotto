import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import { _electron as electron, expect, test, type Locator, type Page } from '@playwright/test'
import sharp from 'sharp'

import {
  DESIGN_CAPTURE_REQUIREMENTS,
  DESIGN_CAPTURE_SCALES,
  DESIGN_CAPTURE_THEMES,
  designCaptureTupleKey,
} from '../../scripts/design-capture-matrix.mjs'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import type { E2EScenario } from '../../src/shared/e2e'
import type { HistoryEntry } from '../../src/shared/history'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import {
  closeSotto,
  launchSotto,
  type LaunchedSotto,
  type LaunchDependencies,
} from './support/sottoLaunch'

const captureEnabled = process.env.SOTTO_DESIGN_CAPTURE === '1'
const updateBaselines = process.env.SOTTO_UPDATE_DESIGN_BASELINES === '1'
const repositoryRoot = process.cwd()
const baselineRoot = resolve(repositoryRoot, 'artifacts/design/app-review/baseline')
const manifestPath = resolve(repositoryRoot, 'artifacts/design/app-review/manifest.json')
const actualRoot = resolve(repositoryRoot, 'test-results/design-capture/actual')
const themes = DESIGN_CAPTURE_THEMES
const scales = DESIGN_CAPTURE_SCALES
const externalWidgetStates = ['listening', 'processing', 'pasted', 'copied', 'error'] as const
type CaptureTheme = (typeof themes)[number]
type CaptureScale = (typeof scales)[number]
type CaptureMotion = 'normal' | 'reduced'
type CaptureFocusTarget = 'none' | 'navigation' | 'input' | 'switch' | 'destructive'

interface CaptureMetadata {
  readonly category: 'onboarding' | 'home' | 'history' | 'settings' | 'help' | 'scale' | 'widget'
  readonly state: string
  readonly theme: CaptureTheme
  readonly scalePercent: CaptureScale
  readonly motion: CaptureMotion
  readonly focusTarget: CaptureFocusTarget
}

interface CaptureEntry extends CaptureMetadata {
  readonly id: string
  readonly relativePath: string
  readonly width: number
  readonly height: number
  readonly sha256: string
  readonly source: 'app-review' | 'widget-baseline'
}

type CaptureHint = Partial<CaptureMetadata> & {
  readonly focus?: boolean
  readonly reducedMotion?: boolean
}

const capturedEntries: CaptureEntry[] = []
const requirementsById = new Map(DESIGN_CAPTURE_REQUIREMENTS.map((requirement) => [requirement.id, requirement]))

function requiredMetadata(fileName: string): CaptureMetadata & { readonly id: string; readonly source: 'app-review' | 'widget-baseline' } {
  const id = fileName.replace(/\.png$/u, '')
  const requirement = requirementsById.get(id)
  if (requirement === undefined) throw new Error(`Capture is not in the explicit design matrix: ${id}`)
  return requirement
}

const populatedHistory: readonly HistoryEntry[] = [
  {
    id: 'review-1',
    text: 'Draft the launch summary and send it to the product team before lunch.',
    createdAt: Date.UTC(2026, 6, 11, 16, 30),
    durationMs: 8_400,
    language: 'en',
    modelPreset: 'instant',
  },
  {
    id: 'review-2',
    text: 'Remember to confirm the accessibility review and installer smoke test.',
    createdAt: Date.UTC(2026, 6, 10, 22, 15),
    durationMs: 6_200,
    language: 'en',
    modelPreset: 'instant',
  },
  {
    id: 'review-3',
    text: 'The microphone notes stay local and the final transcript is copied automatically.',
    createdAt: Date.UTC(2026, 6, 9, 18, 5),
    durationMs: 10_700,
    language: 'en',
    modelPreset: 'instant',
  },
]

function digest(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

async function createProfile(
  theme: CaptureTheme,
  options: {
    readonly onboardingComplete: boolean
    readonly history?: readonly HistoryEntry[]
    readonly motion?: CaptureMotion
  },
): Promise<string> {
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-design-'))
  const settings = {
    ...DEFAULT_SETTINGS,
    theme,
    reducedMotion: options.motion === 'reduced' ? 'on' : 'system',
    onboardingComplete: options.onboardingComplete,
    successDisplayMs: 5_000,
  }
  await writeFile(join(profile, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  await writeFile(join(profile, 'history.json'), `${JSON.stringify(options.history ?? [], null, 2)}\n`, 'utf8')
  return profile
}

async function withSotto(
  theme: CaptureTheme,
  options: {
    readonly onboardingComplete: boolean
    readonly history?: readonly HistoryEntry[]
    readonly motion?: CaptureMotion
    readonly scenario?: E2EScenario
    readonly scalePercent?: CaptureScale
  },
  run: (launched: LaunchedSotto) => Promise<void>,
): Promise<void> {
  const profile = await createProfile(theme, options)
  let launched: LaunchedSotto | undefined
  try {
    const scaleFactor = (options.scalePercent ?? 100) / 100
    const dependencies: LaunchDependencies = {
      createProfile: async () => { throw new Error('Design capture supplies an owned profile') },
      launch: (launchOptions = {}) => electron.launch({
        ...launchOptions,
        args: ['--disable-gpu', `--force-device-scale-factor=${scaleFactor}`, ...(launchOptions.args ?? [])],
      }),
      firstWindow: (application) => application.firstWindow(),
      removeProfile: async () => undefined,
    }
    launched = await launchSotto(options.scenario ?? 'success', profile, dependencies)
    const motion = options.motion ?? 'normal'
    await launched.page.emulateMedia({ colorScheme: theme, reducedMotion: motion === 'reduced' ? 'reduce' : 'no-preference' })
    await expect(launched.page.locator('html')).toHaveAttribute('data-theme', theme)
    await expect.poll(() => launched!.page.evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches")).toBe(motion === 'reduced')
    if (motion === 'reduced') await expect(launched.page.locator('html')).toHaveAttribute('data-reduced-motion', 'on')
    else await expect(launched.page.locator('html')).not.toHaveAttribute('data-reduced-motion')
    await expect.poll(() => launched!.page.evaluate<number>('devicePixelRatio')).toBeCloseTo(scaleFactor, 2)
    await run(launched)
  } finally {
    if (launched !== undefined) await closeSotto(launched)
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true })
  }
}

async function waitForStableFrame(page: Page): Promise<void> {
  await page.evaluate(`(async () => {
    await document.fonts.ready
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

    const content = document.querySelector('.app-content')
    if (content !== null && content.scrollWidth > content.clientWidth + tolerance) problems.push('content-horizontal-overflow')

    for (const selector of ['.app-shell', '.app-titlebar', '.app-navigation', '.app-content', '.onboarding-shell']) {
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

    const activeDictationBar = document.querySelector('.home-dictation-bar[data-active="true"]')
    const homeRecent = document.querySelector('.home-recent')
    const contentBounds = content?.getBoundingClientRect()
    if (activeDictationBar !== null && homeRecent !== null && contentBounds !== undefined) {
      const recentBounds = homeRecent.getBoundingClientRect()
      const visibleHeight = Math.min(recentBounds.bottom, contentBounds.bottom) - Math.max(recentBounds.top, contentBounds.top)
      if (visibleHeight < Math.min(120, recentBounds.height) - tolerance) {
        problems.push('home-recent-not-materially-visible')
      }
    }
    return [...new Set(problems)]
  })()`)
}

async function assertFocusPresentation(locator: Locator): Promise<void> {
  await locator.focus()
  if (!await locator.evaluate((element: unknown) => (element as { matches: (selector: string) => boolean }).matches(':focus-visible'))) {
    await locator.page().keyboard.press('Tab')
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

async function assertDictationBarTone(page: Page, tone: 'success' | 'error'): Promise<void> {
  const bar = page.locator('.home-dictation-bar')
  await expect(bar).toHaveAttribute('data-tone', tone)
  const colors = await bar.evaluate((element: unknown, toneName: unknown) => {
    const target = element as {
      querySelector: (selector: string) => unknown
      appendChild: (node: unknown) => unknown
    }
    const globals = globalThis as unknown as {
      document: { createElement: (tag: string) => { style: { color: string }; remove: () => void } }
      getComputedStyle: (candidate: unknown) => { color: string }
    }
    const icon = target.querySelector('.home-dictation-bar__icon')
    const probe = globals.document.createElement('span')
    probe.style.color = `var(--tt-${toneName as string})`
    target.appendChild(probe)
    const expected = globals.getComputedStyle(probe).color
    probe.remove()
    return { expected, icon: icon === null ? '' : globals.getComputedStyle(icon).color }
  }, tone)
  expect(colors.icon, `dictation bar icon must render the ${tone} tone`).toBe(colors.expected)
}

interface PixelDifference {
  readonly changedPixels: number
  readonly totalChannelDelta: number
  readonly pixelCount: number
}

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
      totalChannelDelta += delta
      if (delta !== 0) changed = true
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
  capturedEntries.push({
    ...metadata,
    id: fileName.replace(/\.png$/u, ''),
    relativePath: relative(repositoryRoot, destination).replaceAll('\\', '/'),
    width: imageMetadata.width,
    height: imageMetadata.height,
    sha256: digest(baseline),
  })
}

async function capturePage(page: Page, fileName: string, metadata: CaptureHint = {}, fullPage = false): Promise<void> {
  await waitForStableFrame(page)
  expect(await pageBoundProblems(page), `${fileName} has clipped or overflowing application chrome`).toEqual([])
  const image = await stableScreenshot(
    fileName,
    () => page.screenshot({ caret: 'hide', fullPage }),
    () => waitForStableFrame(page),
  )
  await recordCapture(image, fileName, metadata)
}

async function captureSection(page: Page, section: Locator, fileName: string, metadata: CaptureHint = {}): Promise<void> {
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

async function captureFullSurface(
  page: Page,
  surface: Locator,
  fileName: string,
  requiredText: RegExp,
  metadata: CaptureHint = {},
): Promise<void> {
  await expect(surface).toHaveCount(1)
  await expect(surface.getByText(requiredText)).toBeVisible()
  await page.evaluate("document.querySelector('.app-content')?.scrollTo(0, 0)")
  await waitForStableFrame(page)
  expect(await pageBoundProblems(page), `${fileName} has overlap, wrapping, or clipping defects`).toEqual([])
  await page.evaluate(`(() => {
    const shell = document.querySelector('.app-shell')
    const content = document.querySelector('.app-content')
    if (!(shell instanceof HTMLElement) || !(content instanceof HTMLElement)) throw new Error('management scroll surface is unavailable')
    shell.style.setProperty('height', 'auto')
    shell.style.setProperty('min-height', '0')
    shell.style.setProperty('overflow', 'visible')
    shell.style.setProperty('grid-template-rows', '52px auto')
    content.style.setProperty('overflow', 'visible')
    content.style.setProperty('height', 'auto')
  })()`)
  try {
    await waitForStableFrame(page)
    const bounds = await surface.boundingBox()
    const requiredBounds = await surface.getByText(requiredText).boundingBox()
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
      const content = document.querySelector('.app-content')
      if (shell instanceof HTMLElement) for (const property of ['height', 'min-height', 'overflow', 'grid-template-rows']) shell.style.removeProperty(property)
      if (content instanceof HTMLElement) for (const property of ['overflow', 'height']) content.style.removeProperty(property)
    })()`)
  }
}

async function captureWidget(
  page: Page,
  fileName: string,
  metadata: CaptureHint = {},
  // The resting idle widget renders in its own smaller native footprint; all
  // other states use the active 248x88 window.
  footprint: { readonly width: number; readonly height: number } = { width: 248, height: 88 },
): Promise<void> {
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
    if (detail !== null && (detail.scrollWidth > detail.clientWidth || detail.scrollHeight > detail.clientHeight)) problems.push('widget-detail-clipped:' + detail.textContent + ':' + detail.scrollWidth + 'x' + detail.scrollHeight + '>' + detail.clientWidth + 'x' + detail.clientHeight)
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

async function widgetPage(launched: LaunchedSotto): Promise<Page> {
  await expect.poll(() => launched.app.windows().some((candidate) => candidate.url().endsWith('/widget.html'))).toBe(true)
  const widget = launched.app.windows().find((candidate) => candidate.url().endsWith('/widget.html'))
  if (widget === undefined) throw new Error('Widget renderer was not created')
  await widget.waitForLoadState('domcontentloaded')
  return widget
}

async function externalWidgetEntries(): Promise<CaptureEntry[]> {
  const entries: CaptureEntry[] = []
  for (const theme of themes) {
    for (const state of externalWidgetStates) {
      const path = resolve(repositoryRoot, `artifacts/design/baseline/${state}-${theme}.png`)
      const image = await readFile(path)
      const metadata = await sharp(image).metadata()
      if (metadata.width !== 248 || metadata.height !== 88) throw new Error(`Unexpected widget baseline geometry: ${path}`)
      const requirement = requiredMetadata(`widget-${state}-${theme}.png`)
      if (requirement.source !== 'widget-baseline') throw new Error(`External widget matrix source mismatch: ${state}-${theme}`)
      entries.push({
        ...requirement,
        relativePath: relative(repositoryRoot, path).replaceAll('\\', '/'),
        width: metadata.width,
        height: metadata.height,
        sha256: digest(image),
      })
    }
  }
  return entries
}

test.describe('authoritative design-review captures', () => {
  test.skip(!captureEnabled, 'Run through npm run design:capture or npm run design:verify')
  test.describe.configure({ mode: 'serial', timeout: 10 * 60_000 })

  for (const theme of themes) {
    test(`${theme} onboarding, management, focus, and feedback matrix`, async () => {
      await withSotto(theme, { onboardingComplete: false }, async ({ page }) => {
        const onboarding = page.locator('.onboarding-shell')
        const onboardingHeading = page.getByRole('heading', { name: /private dictation/i })
        await expect(onboardingHeading).toBeVisible()
        expect(await onboardingHeading.evaluate((heading: unknown) => (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement === heading)).toBe(true)
        expect(await onboardingHeading.evaluate((heading: unknown) => (globalThis as unknown as { getComputedStyle: (target: unknown) => { outlineStyle: string } }).getComputedStyle(heading).outlineStyle)).toBe('none')
        await captureSection(page, onboarding, `onboarding-step-1-welcome-${theme}.png`, { category: 'onboarding', state: 'welcome', theme })

        const continueButton = page.getByRole('button', { name: 'Continue' })
        await assertFocusPresentation(continueButton)
        await continueButton.click()
        await page.getByRole('button', { name: /test microphone/i }).click()
        await expect(page.getByText(/microphone ready/i)).toBeVisible()
        await captureSection(page, onboarding, `onboarding-step-2-microphone-ready-${theme}.png`, { category: 'onboarding', state: 'microphone-ready', theme })

        await page.getByRole('button', { name: 'Continue' }).click()
        await expect(page.getByText(/standard model is included and ready/i)).toBeVisible()
        await captureSection(page, onboarding, `onboarding-step-3-model-${theme}.png`, { category: 'onboarding', state: 'model-ready', theme })

        await page.getByRole('button', { name: 'Continue' }).click()
        await expect(page.getByRole('heading', { name: /one shortcut/i })).toBeVisible()
        await captureSection(page, onboarding, `onboarding-step-4-shortcut-${theme}.png`, { category: 'onboarding', state: 'shortcut-paste', theme })
      })

      await withSotto(theme, { onboardingComplete: true, history: populatedHistory }, async ({ page }) => {
        await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible()
        await capturePage(page, `home-ready-${theme}.png`, { category: 'home', state: 'ready', theme })

        const historyNavigation = page.getByRole('link', { name: 'History' })
        await assertFocusPresentation(historyNavigation)
        await capturePage(page, `focus-navigation-${theme}.png`)

        const start = page.getByRole('button', { name: 'Start dictation' })
        await start.click()
        await expect(page.getByRole('heading', { name: 'Listening' })).toBeVisible()
        await capturePage(page, `home-listening-${theme}.png`, { category: 'home', state: 'listening', theme })
        await page.getByRole('button', { name: 'Stop and transcribe' }).click()
        await expect(page.getByRole('heading', { name: 'Text pasted' })).toBeVisible()
        await assertDictationBarTone(page, 'success')
        await capturePage(page, `home-success-${theme}.png`, { category: 'home', state: 'success-pasted', theme })
      })

      await withSotto(theme, { onboardingComplete: true, scenario: 'design-processing' }, async ({ page }) => {
        await page.getByRole('button', { name: 'Start dictation' }).click()
        await page.getByRole('button', { name: 'Stop and transcribe' }).click()
        await expect(page.getByRole('heading', { name: 'Turning speech into text' })).toBeVisible()
        await capturePage(page, `home-processing-${theme}.png`, { category: 'home', state: 'processing', theme })
      })

      await withSotto(theme, { onboardingComplete: true, scenario: 'transcription-failure' }, async ({ page }) => {
        await page.getByRole('button', { name: 'Start dictation' }).click()
        await page.getByRole('button', { name: 'Stop and transcribe' }).click()
        await expect(page.getByRole('heading', { name: 'Dictation needs attention' })).toBeVisible()
        await assertDictationBarTone(page, 'error')
        await capturePage(page, `home-error-${theme}.png`, { category: 'home', state: 'error', theme })
      })

      await withSotto(theme, { onboardingComplete: true, motion: 'reduced' }, async ({ page }) => {
        await page.getByRole('button', { name: 'Start dictation' }).click()
        await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'on')
        await capturePage(page, `home-reduced-motion-${theme}.png`, { category: 'home', state: 'listening-reduced-motion', theme, reducedMotion: true })
      })

      await withSotto(theme, { onboardingComplete: true, history: populatedHistory }, async ({ page }) => {
        await page.getByRole('link', { name: 'History' }).click()
        await expect(page.getByText(populatedHistory[0]!.text)).toBeVisible()
        const historySearch = page.getByRole('searchbox', { name: 'Search transcripts' })
        await assertFocusPresentation(historySearch)
        await capturePage(page, `focus-input-${theme}.png`)
        const clearHistory = page.getByRole('button', { name: 'Clear history' })
        await assertFocusPresentation(clearHistory)
        await capturePage(page, `focus-destructive-${theme}.png`)
        await page.getByRole('button', { name: 'Copy transcript' }).first().click()
        await expect(page.getByRole('status')).toContainText('Transcript copied')
        await capturePage(page, `history-populated-${theme}.png`, { category: 'history', state: 'populated-feedback', theme })

        await page.getByRole('button', { name: 'Clear history' }).click()
        await page.getByRole('button', { name: 'Clear all transcripts' }).click()
        await expect(page.getByRole('heading', { name: 'No saved transcripts yet' })).toBeVisible()
        await capturePage(page, `history-empty-${theme}.png`, { category: 'history', state: 'empty-feedback', theme })

        await page.getByRole('link', { name: 'Settings' }).click()
        await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
        const pasteSwitch = page.getByRole('switch', { name: 'Automatic paste' })
        await pasteSwitch.scrollIntoViewIfNeeded()
        await assertFocusPresentation(pasteSwitch)
        await capturePage(page, `focus-switch-${theme}.png`)
        await page.getByRole('switch', { name: 'Sound cues' }).click()
        await expect(page.getByRole('status')).toHaveText('Setting saved.')
        await capturePage(page, `settings-feedback-${theme}.png`, { category: 'settings', state: 'saved-feedback', theme })

        const settingsSections = [
          ['Appearance', 'appearance'],
          ['Capture', 'capture'],
          ['Transcription', 'transcription'],
          ['Output', 'output'],
          ['Application and privacy', 'application-privacy'],
        ] as const
        for (const [heading, state] of settingsSections) {
          const section = page.locator('.settings-section').filter({ has: page.getByRole('heading', { name: heading, exact: true }) })
          await expect(section).toHaveCount(1)
          await captureSection(page, section, `settings-${state}-${theme}.png`, { category: 'settings', state, theme })
        }

        await page.getByLabel('Paste delay').fill('10')
        await page.getByRole('button', { name: 'Save paste delay' }).click()
        await expect(page.getByText('Enter a whole number between 50 and 1000.')).toBeVisible()
        await capturePage(page, `settings-validation-error-${theme}.png`, { category: 'settings', state: 'validation-error', theme })

        await page.getByRole('link', { name: 'Help' }).click()
        await expect(page.getByRole('heading', { name: 'Help' })).toBeVisible()
        await captureFullSurface(page, page.locator('.help-view'), `help-${theme}.png`, /Reset safely/i)
      })
    })

    test(`${theme} dense scaling matrix remains bounded`, async () => {
      for (const scalePercent of scales) {
        await withSotto(theme, { onboardingComplete: false, scalePercent }, async ({ page }) => {
          await page.getByRole('button', { name: 'Continue' }).click()
          await page.getByRole('button', { name: /test microphone/i }).click()
          await expect(page.getByText(/microphone ready/i)).toBeVisible()
          await page.getByRole('button', { name: 'Continue' }).click()
          await expect(page.getByText(/standard model is included and ready/i)).toBeVisible()
          await captureSection(page, page.locator('.onboarding-shell'), `scale-${scalePercent}-onboarding-${theme}.png`)
        })

        await withSotto(theme, { onboardingComplete: true, history: populatedHistory, scalePercent }, async (launched) => {
          const { page } = launched
          await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible()
          await capturePage(page, `scale-${scalePercent}-home-${theme}.png`)

          await page.getByRole('button', { name: 'Start dictation' }).click()
          const liveWidget = await widgetPage(launched)
          await liveWidget.emulateMedia({ colorScheme: theme, reducedMotion: 'no-preference' })
          await expect(liveWidget.locator('.widget-shell[data-status="listening"]')).toBeVisible()
          await captureWidget(liveWidget, `scale-${scalePercent}-widget-${theme}.png`)
          await liveWidget.getByRole('button', { name: 'Cancel dictation' }).click()

          await page.getByRole('link', { name: 'History' }).click()
          await captureFullSurface(page, page.locator('.history-view'), `scale-${scalePercent}-history-${theme}.png`, /Draft the launch summary/i)

          await page.getByRole('link', { name: 'Settings' }).click()
          await captureFullSurface(page, page.locator('.settings-view'), `scale-${scalePercent}-settings-${theme}.png`, /Application and privacy/i)

          await page.getByRole('link', { name: 'Help' }).click()
          await captureFullSurface(page, page.locator('.help-view'), `scale-${scalePercent}-help-${theme}.png`, /Reset safely/i)
        })
      }
    })

    test(`${theme} widget states missing from the established widget baseline are captured`, async () => {
      await withSotto(theme, { onboardingComplete: true, motion: 'reduced' }, async (launched) => {
        // The renderer publishes its first widget snapshot from a dictation
        // session, so cancel one and wait for the automatic reset back to the
        // resting idle sliver before capturing it.
        await launched.page.getByRole('button', { name: 'Start dictation' }).click()
        const widget = await widgetPage(launched)
        await expect(widget.locator('.widget-shell[data-status="listening"]')).toBeVisible()
        await widget.getByRole('button', { name: 'Cancel dictation' }).click()
        await expect(widget.locator('.widget-shell[data-status="idle"]')).toBeVisible({ timeout: 15_000 })
        await expect(widget.locator('.widget-sliver')).toBeVisible()
        await captureWidget(
          widget,
          `widget-idle-${theme}.png`,
          { category: 'widget', state: 'idle-sliver', theme, reducedMotion: true },
          { width: 124, height: 54 },
        )
      })

      await withSotto(theme, { onboardingComplete: true, motion: 'reduced', scenario: 'design-permission' }, async (launched) => {
        await launched.page.getByRole('button', { name: 'Start dictation' }).click()
        const widget = await widgetPage(launched)
        await expect(widget.getByText('Waiting for microphone', { exact: true })).toBeVisible()
        await captureWidget(widget, `widget-permission-${theme}.png`, { category: 'widget', state: 'requesting-permission', theme, reducedMotion: true })
      })

      await withSotto(theme, { onboardingComplete: true, motion: 'reduced' }, async (launched) => {
        await launched.page.getByRole('button', { name: 'Start dictation' }).click()
        const widget = await widgetPage(launched)
        await expect(widget.locator('.widget-shell[data-status="listening"]')).toBeVisible()
        await widget.getByRole('button', { name: 'Cancel dictation' }).click()
        await expect(widget.getByText('Cancelled', { exact: true })).toBeVisible()
        await captureWidget(widget, `widget-cancelled-${theme}.png`, { category: 'widget', state: 'cancelled', theme, reducedMotion: true })
      })
    })
  }

  test.afterAll(async () => {
    const expectedCaptured = DESIGN_CAPTURE_REQUIREMENTS.filter(({ source }) => source === 'app-review').length
    if (capturedEntries.length !== expectedCaptured) return
    const entries = [...capturedEntries, ...await externalWidgetEntries()]
      .sort((first, second) => first.id.localeCompare(second.id))
    const requiredIds = [...requirementsById.keys()].sort()
    expect(entries.map(({ id }) => id)).toEqual(requiredIds)
    expect(new Set(entries.map(designCaptureTupleKey)).size).toBe(entries.length)
    const manifest = {
      version: 2,
      captureBoundary: {
        mode: 'non-packaged-only',
        environmentGate: 'SOTTO_E2E=1',
        packagedRejectionProof: 'tests/unit/main/e2eBoundary.test.ts and scripts/verify-packaged-resources.mjs',
      },
      viewport: 'Sotto main BrowserWindow (1080x720 logical window); widget 248x88.',
      scalingMethod: 'Electron --force-device-scale-factor driven by Playwright at 100/125/150/200 percent; devicePixelRatio is asserted.',
      notes: [
        'The idle widget renders the resting click-to-dictate sliver; idle captures are recorded after a completed session returns to idle.',
        'Established Task 12 widget baselines are referenced in place; they are not duplicated.',
        'Every tuple records explicit normal or reduced motion; normal launches emulate no-preference and reduced launches are separately asserted.',
        'Full Settings and Help surfaces include content outside the management scrollport, including every Settings section and Reset safely help.',
        'Capture launches disable GPU compositing to avoid Electron tile tearing; application layout and CSS rendering remain authoritative.',
        'Verification permits only negligible Windows raster variance: at most max(100, 0.05%) pixels and max(1000, 0.5% pixel-count) total channel delta.',
      ],
      count: entries.length,
      entries,
    }
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`
    if (updateBaselines) {
      await mkdir(resolve(manifestPath, '..'), { recursive: true })
      await writeFile(manifestPath, serialized, 'utf8')
    } else {
      expect(await readFile(manifestPath, 'utf8')).toBe(serialized)
    }
  })
})
