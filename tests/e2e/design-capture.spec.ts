import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import { _electron as electron, expect, test, type Locator, type Page } from '@playwright/test'
import sharp from 'sharp'

import {
  DESIGN_CAPTURE_ACCENTS,
  DESIGN_CAPTURE_APP_THEMES,
  DESIGN_CAPTURE_MINIMUM_WIDTH,
  DESIGN_CAPTURE_REQUIREMENTS,
  DESIGN_CAPTURE_SCALES,
  DESIGN_CAPTURE_WIDGET_THEMES,
  designCaptureTupleKey,
} from '../../scripts/design-capture-matrix.mjs'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { designThreadsFixture, type E2EScenario } from '../../src/shared/e2e'
import type { HistoryEntry } from '../../src/shared/history'
import { DEFAULT_SETTINGS, type Accent, type Appearance } from '../../src/shared/settings'
import {
  closeSotto,
  firstSottoWindow,
  launchSotto,
  type LaunchedSotto,
  type LaunchDependencies,
} from './support/sottoLaunch'

const captureEnabled = process.env.SOTTO_DESIGN_CAPTURE === '1'
/** Pinned for every launch in this suite; scripts/capture-design.mjs sets the same zone for the Node side. */
const CAPTURE_TIMEZONE = 'America/Los_Angeles'
const CAPTURE_LOCALE = 'en-US'
const updateBaselines = process.env.SOTTO_UPDATE_DESIGN_BASELINES === '1'
const repositoryRoot = process.cwd()
const baselineRoot = resolve(repositoryRoot, 'artifacts/design/app-review/baseline')
const manifestPath = resolve(repositoryRoot, 'artifacts/design/app-review/manifest.json')
const actualRoot = resolve(repositoryRoot, 'test-results/design-capture/actual')
/** The main window has a dark and a light room; the untouched widget still follows the system scheme. */
const appThemes = DESIGN_CAPTURE_APP_THEMES
const widgetThemes = DESIGN_CAPTURE_WIDGET_THEMES
const scales = DESIGN_CAPTURE_SCALES
const externalWidgetStates = ['listening', 'processing', 'pasted', 'copied', 'error'] as const
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

type DesignAgentsProfile = 'design-threads' | 'design-threads-empty'

/**
 * Saved coordinator state for the Threads page captures: agent control is
 * already on so Sotto connects to the fixture host at launch, and every
 * fixture thread but one is assigned. The coordinator's own seven-day
 * windows read the real clock, so context stamps are taken now; the page
 * itself reads the fixed E2E_THREADS_NOW.
 */
function designAgentsState(profile: DesignAgentsProfile): Record<string, unknown> {
  const fixture = designThreadsFixture()
  return {
    configuration: { provider: 'codex', enabled: true, projectsDirectory: '', defaultModelId: 'claude:sonnet',
      followupLimit: 5, speak: false, speechProvider: 'system', speechVoice: 'F1', grokSpeechVoice: 'ara', wakeModelDirectory: '', wakeRuntimeDirectory: '',
      reasoning: 'none', reasoningModel: '', reasoningEffort: '', membershipEndpoint: '' },
    assignments: profile === 'design-threads' ? fixture.assignments.map((assignment) => ({ ...assignment, contextUpdatedAt: Date.now() })) : [],
    queue: [], activeThreadId: null, activeProjectId: null, draft: '', draftThreadId: null, draftRequestId: null, composing: false,
    pendingRequest: '', contextSavedAt: Date.now(), outbox: [],
  }
}

async function createProfile(
  options: {
    readonly onboardingComplete: boolean
    readonly history?: readonly HistoryEntry[]
    readonly motion?: CaptureMotion
    readonly agents?: DesignAgentsProfile
    readonly appearance?: Appearance
    readonly accent?: Accent
  },
): Promise<string> {
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-design-'))
  const settings = {
    ...DEFAULT_SETTINGS,
    reducedMotion: options.motion === 'reduced' ? 'on' : 'system',
    onboardingComplete: options.onboardingComplete,
    successDisplayMs: 5_000,
    appearance: options.appearance ?? DEFAULT_SETTINGS.appearance,
    accent: options.accent ?? DEFAULT_SETTINGS.accent,
  }
  await writeFile(join(profile, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  await writeFile(join(profile, 'history.json'), `${JSON.stringify(options.history ?? [], null, 2)}\n`, 'utf8')
  if (options.agents !== undefined) await writeFile(join(profile, 'agents.json'), `${JSON.stringify(designAgentsState(options.agents), null, 2)}\n`, 'utf8')
  return profile
}

async function withSotto(
  options: {
    readonly onboardingComplete: boolean
    readonly history?: readonly HistoryEntry[]
    readonly motion?: CaptureMotion
    readonly scenario?: E2EScenario
    readonly scalePercent?: CaptureScale
    readonly agents?: DesignAgentsProfile
    readonly appearance?: Appearance
    readonly accent?: Accent
  },
  run: (launched: LaunchedSotto) => Promise<void>,
): Promise<void> {
  const profile = await createProfile(options)
  let launched: LaunchedSotto | undefined
  try {
    const scaleFactor = (options.scalePercent ?? 100) / 100
    const dependencies: LaunchDependencies = {
      createProfile: async () => { throw new Error('Design capture supplies an owned profile') },
      // Every capture reads the same clock and language whatever machine runs it:
      // the zone and locale the committed baselines were captured with.
      launch: (launchOptions = {}) => electron.launch({
        ...launchOptions,
        args: ['--disable-gpu', `--force-device-scale-factor=${scaleFactor}`, ...(launchOptions.args ?? [])],
        timezoneId: CAPTURE_TIMEZONE,
        locale: CAPTURE_LOCALE,
      }),
      firstWindow: firstSottoWindow,
      removeProfile: async () => undefined,
    }
    launched = await launchSotto(options.scenario ?? 'success', profile, dependencies)
    const motion = options.motion ?? 'normal'
    await launched.page.emulateMedia({ reducedMotion: motion === 'reduced' ? 'reduce' : 'no-preference' })
    // The persisted mode and accent paint the root at launch. Only System reads
    // the scheme, and no fixed-mode capture depends on the machine's setting.
    const appearance = options.appearance ?? DEFAULT_SETTINGS.appearance
    if (appearance !== 'system') await expect(launched.page.locator('html')).toHaveAttribute('data-theme', appearance)
    await expect(launched.page.locator('html')).toHaveAttribute('data-accent', options.accent ?? DEFAULT_SETTINGS.accent)
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

    const content = document.querySelector('.app-room')
    if (content !== null && content.scrollWidth > content.clientWidth + tolerance) problems.push('room-horizontal-overflow')

    for (const selector of ['.app-shell', '.app-strip', '.app-room', '.app-footer', '.onboarding-shell']) {
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
    const contentBounds = content?.getBoundingClientRect()
    if (lastTranscript !== null && contentBounds !== undefined) {
      const rowBounds = lastTranscript.getBoundingClientRect()
      if (rowBounds.bottom > contentBounds.bottom + tolerance || rowBounds.top < contentBounds.top - tolerance) {
        problems.push('dictate-last-transcript-not-fully-visible')
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

/** The Dictate room says its state in the one sentence and marks the section for styling. */
/** Save an appearance choice the way Settings does and wait for the root to repaint. */
async function setAppearance(page: Page, patch: { readonly appearance?: Appearance; readonly accent?: Accent }, resolved: AppTheme): Promise<void> {
  await page.evaluate(async (next) => { await window.sotto!.updateSettings(next) }, patch)
  await expect(page.locator('html')).toHaveAttribute('data-theme', resolved)
  if (patch.accent !== undefined) await expect(page.locator('html')).toHaveAttribute('data-accent', patch.accent)
  await expect(page.locator('html')).not.toHaveAttribute('data-theme-switching')
}

/** Every token the room paints resolves through the root, so the rendered colours prove the mode and native controls follow. */
async function assertRenderedRoom(page: Page, theme: AppTheme): Promise<void> {
  const painted = await page.evaluate(() => {
    const select = document.querySelector('select')
    return {
      canvas: getComputedStyle(document.body).backgroundColor,
      scheme: getComputedStyle(document.documentElement).colorScheme,
      selectScheme: select === null ? null : getComputedStyle(select).colorScheme,
    }
  })
  expect(painted.canvas).toBe(theme === 'dark' ? 'rgb(0, 0, 0)' : 'rgb(245, 246, 243)')
  expect(painted.scheme).toBe(theme)
  if (painted.selectScheme !== null) expect(painted.selectScheme).toBe(theme)
}

/** Narrow the main window below its shipped minimum to the Phase 1 review width. */
async function setMainWindowWidth(launched: LaunchedSotto, width: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, contentWidth) => {
    const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().endsWith('/index.html'))!
    window.setMinimumSize(contentWidth, 560)
    window.setContentSize(contentWidth, 720)
  }, width)
  await expect.poll(() => launched.page.evaluate<number>('innerWidth')).toBe(width)
}

async function assertDictateState(page: Page, status: string, sentence: RegExp): Promise<void> {
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

async function captureWidget(
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
async function widgetPage(launched: LaunchedSotto, theme: WidgetTheme, motion: CaptureMotion = 'normal'): Promise<Page> {
  await expect.poll(() => launched.app.windows().some((candidate) => candidate.url().endsWith('/widget.html'))).toBe(true)
  const widget = launched.app.windows().find((candidate) => candidate.url().endsWith('/widget.html'))
  if (widget === undefined) throw new Error('Widget renderer was not created')
  await widget.waitForLoadState('domcontentloaded')
  await widget.emulateMedia({ colorScheme: theme, reducedMotion: motion === 'reduced' ? 'reduce' : 'no-preference' })
  await expect.poll(() => widget.evaluate("matchMedia('(prefers-color-scheme: dark)').matches")).toBe(theme === 'dark')
  return widget
}

async function externalWidgetEntries(): Promise<CaptureEntry[]> {
  const entries: CaptureEntry[] = []
  for (const theme of widgetThemes) {
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

  test('onboarding, dictate, focus, and feedback matrix', async () => {
    await withSotto({ onboardingComplete: false }, async ({ page }) => {
      const onboarding = page.locator('.onboarding-shell')
      const onboardingHeading = page.getByRole('heading', { name: /dictation, ready when you are/i })
      await expect(onboardingHeading).toBeVisible()
      expect(await onboardingHeading.evaluate((heading: unknown) => (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement === heading)).toBe(true)
      expect(await onboardingHeading.evaluate((heading: unknown) => (globalThis as unknown as { getComputedStyle: (target: unknown) => { outlineStyle: string } }).getComputedStyle(heading).outlineStyle)).toBe('none')
      await captureSection(page, onboarding, 'onboarding-step-1-welcome.png', { category: 'onboarding', state: 'welcome' })

      const continueButton = page.getByRole('button', { name: 'Continue' })
      await assertFocusPresentation(continueButton)
      await continueButton.click()
      await page.getByRole('button', { name: /test microphone/i }).click()
      await expect(page.getByText(/microphone ready/i)).toBeVisible()
      await captureSection(page, onboarding, 'onboarding-step-2-microphone-ready.png', { category: 'onboarding', state: 'microphone-ready' })

      await page.getByRole('button', { name: 'Continue' }).click()
      await expect(page.getByText(/connect your openrouter key/i)).toBeVisible()
      await captureSection(page, onboarding, 'onboarding-step-3-openrouter.png', { category: 'onboarding', state: 'openrouter-key' })

      await page.getByRole('button', { name: 'Continue' }).click()
      await expect(page.getByRole('heading', { name: /one shortcut/i })).toBeVisible()
      await captureSection(page, onboarding, 'onboarding-step-4-shortcut.png', { category: 'onboarding', state: 'shortcut-paste' })
    })

    await withSotto({ onboardingComplete: true, history: populatedHistory }, async ({ page }) => {
      await assertDictateState(page, 'idle', /ready when you are/i)
      await expect(page.locator('.app-strip')).toHaveCount(1)
      await expect(page.getByRole('tab', { name: 'Dictate' })).toHaveAttribute('aria-selected', 'true')
      await capturePage(page, 'dictate-ready.png', { category: 'dictate', state: 'ready' })

      const agentsTab = page.getByRole('tab', { name: 'Agents' })
      await assertFocusPresentation(agentsTab)
      await capturePage(page, 'focus-switch-tab.png', { focusTarget: 'tab', focus: true })

      const historyNavigation = page.getByRole('link', { name: 'History' })
      await assertFocusPresentation(historyNavigation)
      await capturePage(page, 'focus-navigation.png', { focusTarget: 'navigation', focus: true })

      await page.getByRole('button', { name: 'Start dictation' }).click()
      await assertDictateState(page, 'listening', /^listening\./i)
      await capturePage(page, 'dictate-listening.png', { category: 'dictate', state: 'listening' })
      await page.getByRole('button', { name: 'Stop', exact: true }).click()
      await assertDictateState(page, 'success', /^pasted\.$/i)
      await capturePage(page, 'dictate-pasted.png', { category: 'dictate', state: 'success-pasted' })
    })

    await withSotto({ onboardingComplete: true, scenario: 'design-processing' }, async ({ page }) => {
      await page.getByRole('button', { name: 'Start dictation' }).click()
      await page.getByRole('button', { name: 'Stop', exact: true }).click()
      await assertDictateState(page, 'processing', /turning speech into text/i)
      await capturePage(page, 'dictate-processing.png', { category: 'dictate', state: 'processing' })
    })

    await withSotto({ onboardingComplete: true, scenario: 'transcription-failure' }, async ({ page }) => {
      await page.getByRole('button', { name: 'Start dictation' }).click()
      await page.getByRole('button', { name: 'Stop', exact: true }).click()
      await assertDictateState(page, 'error', /dictation needs attention/i)
      await capturePage(page, 'dictate-error.png', { category: 'dictate', state: 'error' })
    })

    await withSotto({ onboardingComplete: true, motion: 'reduced' }, async ({ page }) => {
      await page.getByRole('button', { name: 'Start dictation' }).click()
      await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'on')
      await assertDictateState(page, 'listening', /^listening\./i)
      await capturePage(page, 'dictate-reduced-motion.png', { category: 'dictate', state: 'listening-reduced-motion', reducedMotion: true })
    })

    await withSotto({ onboardingComplete: true }, async ({ page }) => {
      await page.getByRole('tab', { name: 'Agents' }).click()
      await page.getByRole('button', { name: 'Not now', exact: true }).click()
      await expect(page.locator('.agent-orb')).toBeVisible()
      await expect(page.getByRole('tab', { name: 'Agents' })).toHaveAttribute('aria-selected', 'true')
      await capturePage(page, 'agents-room.png', { category: 'agents', state: 'overview' })
    })

    await withSotto({ onboardingComplete: true, history: populatedHistory }, async ({ page }) => {
      await page.getByRole('link', { name: 'History' }).click()
      await expect(page.getByText(populatedHistory[0]!.text).first()).toBeVisible()
      const historySearch = page.getByRole('searchbox', { name: 'Search transcripts' })
      await assertFocusPresentation(historySearch)
      await capturePage(page, 'focus-input.png', { focusTarget: 'input', focus: true })
      const clearHistory = page.getByRole('button', { name: 'Clear history' })
      await assertFocusPresentation(clearHistory)
      await capturePage(page, 'focus-destructive.png', { focusTarget: 'destructive', focus: true })
      await page.locator('.history-entry__toggle').first().click()
      await page.getByRole('button', { name: 'Copy transcript' }).first().click()
      await expect(page.getByRole('status')).toContainText('Transcript copied')
      await capturePage(page, 'history-populated.png', { category: 'history', state: 'populated-feedback' })

      await historySearch.fill('installer')
      await capturePage(page, 'history-search.png')
      await historySearch.fill('')
      await page.getByRole('button', { name: 'Clear history' }).click()
      await page.getByRole('button', { name: 'Clear all transcripts' }).click()
      await expect(page.getByRole('heading', { name: 'Nothing here yet.' })).toBeVisible()
      await capturePage(page, 'history-empty.png', { category: 'history', state: 'empty-feedback' })
      await page.evaluate(async () => { await window.sotto!.updateSettings({ historyEnabled: false }) })
      await capturePage(page, 'history-off.png')
      await page.evaluate(async () => { await window.sotto!.updateSettings({ historyEnabled: true }) })

      await page.getByRole('link', { name: 'Settings' }).click()
      await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
      const pasteSwitch = page.getByRole('switch', { name: 'Automatic paste' })
      await pasteSwitch.scrollIntoViewIfNeeded()
      await assertFocusPresentation(pasteSwitch)
      await capturePage(page, 'focus-switch.png', { focusTarget: 'switch', focus: true })
      await page.getByRole('switch', { name: 'Sound cues' }).click()
      await expect(page.getByRole('status')).toHaveText('Setting saved.')
      await capturePage(page, 'settings-feedback.png', { category: 'settings', state: 'saved-feedback' })

      const settingsSections = [
        ['Providers', 'providers'],
        ['Agents', 'agents'],
        ['Dictation', 'capture'],
        ['Transcription', 'transcription'],
        ['Cleanup', 'cleanup'],
        ['Output', 'output'],
        ['Appearance', 'appearance'],
        ['Application', 'application-privacy'],
      ] as const
      for (const [heading, state] of settingsSections) {
        const section = page.locator('.settings-section').filter({ has: page.getByRole('heading', { name: heading, exact: true }) })
        await expect(section).toHaveCount(1)
        if (state === 'agents') {
          await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Agents', exact: true }).click()
          await expect(section.getByLabel('Reasoning account', { exact: true })).toBeVisible()
          // The navigation sets aria-current before native smooth scrolling ends.
          await page.waitForTimeout(700)
          await expect(page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Agents', exact: true })).toHaveAttribute('aria-current', 'true')
          await capturePage(page, 'settings-agents.png', { category: 'settings', state })
          continue
        }
        await captureSection(page, section, `settings-${state}.png`, { category: 'settings', state })
      }

      await page.getByRole('button', { name: 'Verify key', exact: true }).click()
      await expect(page.getByText('Key verified.')).toBeVisible()
      await capturePage(page, 'settings-key-verified.png')
      await page.getByLabel('Paste delay').fill('10')
      await page.getByLabel('Paste delay').press('Tab')
      await expect(page.getByText('Enter a whole number between 50 and 1000.')).toBeVisible()
      await capturePage(page, 'settings-validation-error.png', { category: 'settings', state: 'validation-error' })

      await page.getByRole('link', { name: 'Help' }).click()
      await expect(page.getByRole('heading', { name: 'Help' })).toBeVisible()
      await captureFullSurface(page, page.locator('.help-view'), 'help.png', /Reset safely/i)
    })
  })

  for (const appearance of ['dark', 'light'] as const) test(`threads page states in ${appearance}`, async () => {
    const suffix = appearance === 'light' ? '-light' : ''
    await withSotto({ onboardingComplete: true, appearance, scenario: 'design-threads', agents: 'design-threads' }, async ({ page }) => {
      await page.getByRole('link', { name: 'Threads' }).click()
      await expect(page.getByRole('heading', { name: 'Threads' })).toBeVisible()
      await expect(page.getByRole('tab', { name: 'Agents' })).toHaveAttribute('aria-selected', 'true')
      await expect(page.getByRole('complementary', { name: 'Thread sidebar' })).toBeVisible()
      // The coordinator queues the fixture's permission request once it has connected.
      await expect(page.getByRole('button', { name: 'Allow' })).toBeVisible()
      await expect(page.getByText('Waiting on you')).toBeVisible()
      const open = async (title: string): Promise<void> => {
        const toggle = page.getByRole('button', { name: title, exact: true })
        await toggle.click()
        await expect(toggle).toHaveAttribute('aria-current', 'page')
        await toggle.scrollIntoViewIfNeeded()
      }
      await open('Visual gate flake')
      await expect(page.getByRole('button', { name: 'Pause managing' })).toBeVisible()
      await capturePage(page, `threads-populated${suffix}.png`, { theme: appearance, category: 'threads', state: 'populated' })

      await open('Footer links')
      await expect(page.getByLabel('Thread transcript')).toContainText('Fixing the footer links')
      await capturePage(page, `threads-open-running${suffix}.png`, { theme: appearance, category: 'threads', state: 'open-running' })

      await open('Streaming WAV stall')
      await expect(page.getByLabel('Thread transcript')).toContainText('The length marker fix still fails')
      await expect(page.getByRole('button', { name: 'Resume managing' })).toBeVisible()
      await capturePage(page, `threads-stopped${suffix}.png`, { theme: appearance, category: 'threads', state: 'stopped-open' })

      await page.getByRole('searchbox', { name: 'Search threads' }).fill('codex')
      await expect(page.getByRole('button', { name: /Settled/ })).toHaveAttribute('aria-expanded', 'true')
      // The attention queue stays listed whatever the query; a Codex-only result set follows it.
      await expect(page.getByRole('button', { name: 'Visual gate flake', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Release notes 1.4', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Weekly note', exact: true })).toHaveCount(0)
      await page.evaluate("document.querySelector('.app-room')?.scrollTo(0, 0)")
      await capturePage(page, `threads-search${suffix}.png`, { theme: appearance, category: 'threads', state: 'search' })
    })

    await withSotto({ onboardingComplete: true, appearance, scenario: 'design-threads-empty', agents: 'design-threads-empty' }, async ({ page }) => {
      await page.getByRole('link', { name: 'Threads' }).click()
      await expect(page.getByRole('heading', { name: /No threads yet|Nothing here yet/i })).toBeVisible()
      await capturePage(page, `threads-empty${suffix}.png`, { theme: appearance, category: 'threads', state: 'empty' })
    })
  })

  for (const appearance of ['dark', 'light'] as const) test(`phase two workspace composition in ${appearance}`, async () => {
    await withSotto({ onboardingComplete: true, appearance, scenario: 'design-threads', agents: 'design-threads' }, async ({ page, app }) => {
      const resize = async (width: number): Promise<void> => {
        await app.evaluate(({ BrowserWindow }, next) => {
          const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().endsWith('/index.html'))!
          window.setContentSize(next, 800)
        }, width)
        await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width)
      }
      await page.getByRole('link', { name: 'Threads', exact: true }).click()
      await page.getByRole('button', { name: 'Grok voice previews', exact: true }).click()
      await resize(1600)
      await page.getByRole('button', { name: 'Open Footer links beside', exact: true }).click()
      await expect(page.getByRole('separator', { name: 'Resize panes', exact: true })).toBeVisible()
      await capturePage(page, `threads-split-workspace-${appearance}.png`, { theme: appearance, category: 'threads', state: 'split-workspace' })
      await resize(820)
      await expect(page.getByRole('tablist', { name: 'Open panes' })).toBeVisible()
      await expect(page.locator('#thread-pane-grok-previews')).toHaveAttribute('inert')
      await capturePage(page, `threads-split-focus-820-${appearance}.png`, { theme: appearance, category: 'threads', state: 'split-focus-820' })
      await page.getByRole('button', { name: 'Files', exact: true }).click()
      const tools = page.getByRole('complementary', { name: 'Tools', exact: true })
      await expect(tools.getByText('The working folder is not available.', { exact: true })).toBeVisible()
      await capturePage(page, `threads-files-unavailable-${appearance}.png`, { theme: appearance, category: 'threads', state: 'files-unavailable' })
      await tools.getByRole('button', { name: 'Close tools panel' }).click()
      await page.getByRole('button', { name: 'New thread', exact: true }).first().click()
      const dialog = page.getByRole('dialog', { name: 'New thread', exact: true })
      await dialog.getByRole('button', { name: 'sotto-site C:/sotto-site', exact: true }).click()
      await expect(dialog.getByRole('radio', { name: 'New worktree', exact: true })).toBeChecked()
      await capturePage(page, `threads-working-copy-choice-${appearance}.png`, { theme: appearance, category: 'threads', state: 'working-copy-choice' })
    })
  })

  test('light room, accents, System and the minimum width', async () => {
    await withSotto({ onboardingComplete: false, appearance: 'light' }, async ({ page }) => {
      const onboarding = page.locator('.onboarding-shell')
      await assertRenderedRoom(page, 'light')
      await page.getByRole('button', { name: 'Continue' }).click()
      await page.getByRole('button', { name: /test microphone/i }).click()
      await expect(page.getByText(/microphone ready/i)).toBeVisible()
      await page.getByRole('button', { name: 'Continue' }).click()
      await expect(page.getByText(/connect your openrouter key/i)).toBeVisible()
      await captureSection(page, onboarding, 'onboarding-step-3-openrouter-light.png', { theme: 'light' })
    })

    await withSotto({ onboardingComplete: true, history: populatedHistory, appearance: 'light' }, async ({ page }) => {
      await assertDictateState(page, 'idle', /ready when you are/i)
      await assertRenderedRoom(page, 'light')
      await capturePage(page, 'dictate-ready-light.png', { theme: 'light' })
      await assertFocusPresentation(page.getByRole('tab', { name: 'Agents' }))
      await capturePage(page, 'focus-switch-tab-light.png', { focusTarget: 'tab', focus: true, theme: 'light' })
      await assertFocusPresentation(page.getByRole('link', { name: 'History' }))
      await capturePage(page, 'focus-navigation-light.png', { focusTarget: 'navigation', focus: true, theme: 'light' })
      await page.getByRole('button', { name: 'Start dictation' }).click()
      await assertDictateState(page, 'listening', /^listening\./i)
      await capturePage(page, 'dictate-listening-light.png', { theme: 'light' })
      await page.getByRole('button', { name: 'Stop', exact: true }).click()
      await assertDictateState(page, 'success', /^pasted\.$/i)
      await capturePage(page, 'dictate-pasted-light.png', { theme: 'light' })
    })

    await withSotto({ onboardingComplete: true, scenario: 'transcription-failure', appearance: 'light' }, async ({ page }) => {
      await page.getByRole('button', { name: 'Start dictation' }).click()
      await page.getByRole('button', { name: 'Stop', exact: true }).click()
      await assertDictateState(page, 'error', /dictation needs attention/i)
      await capturePage(page, 'dictate-error-light.png', { theme: 'light' })
    })

    await withSotto({ onboardingComplete: true, motion: 'reduced', appearance: 'light' }, async ({ page }) => {
      await page.getByRole('button', { name: 'Start dictation' }).click()
      await assertDictateState(page, 'listening', /^listening\./i)
      await capturePage(page, 'dictate-reduced-motion-light.png', { reducedMotion: true, theme: 'light' })
    })

    await withSotto({ onboardingComplete: true, appearance: 'light' }, async ({ page }) => {
      await page.getByRole('tab', { name: 'Agents' }).click()
      await page.getByRole('button', { name: 'Not now', exact: true }).click()
      await expect(page.locator('.agent-orb')).toBeVisible()
      await capturePage(page, 'agents-room-light.png', { theme: 'light' })
    })

    await withSotto({ onboardingComplete: true, history: populatedHistory, appearance: 'light' }, async ({ page }) => {
      await page.getByRole('link', { name: 'History' }).click()
      await expect(page.getByText(populatedHistory[0]!.text).first()).toBeVisible()
      await assertFocusPresentation(page.getByRole('searchbox', { name: 'Search transcripts' }))
      await capturePage(page, 'focus-input-light.png', { focusTarget: 'input', focus: true, theme: 'light' })
      await assertFocusPresentation(page.getByRole('button', { name: 'Clear history' }))
      await capturePage(page, 'focus-destructive-light.png', { focusTarget: 'destructive', focus: true, theme: 'light' })
      await page.locator('.history-entry__toggle').first().click()
      await page.getByRole('button', { name: 'Copy transcript' }).first().click()
      await expect(page.getByRole('status')).toContainText('Transcript copied')
      await capturePage(page, 'history-populated-light.png', { theme: 'light' })

      await page.getByRole('link', { name: 'Settings' }).click()
      await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
      await assertRenderedRoom(page, 'light')
      const pasteSwitch = page.getByRole('switch', { name: 'Automatic paste' })
      await pasteSwitch.scrollIntoViewIfNeeded()
      await assertFocusPresentation(pasteSwitch)
      await capturePage(page, 'focus-switch-light.png', { focusTarget: 'switch', focus: true, theme: 'light' })
      await page.getByRole('switch', { name: 'Sound cues' }).click()
      await expect(page.getByRole('status')).toHaveText('Setting saved.')
      await capturePage(page, 'settings-feedback-light.png', { theme: 'light' })
      for (const [heading, state] of [
        ['Providers', 'providers'],
        ['Dictation', 'capture'],
        ['Appearance', 'appearance'],
        ['Application', 'application-privacy'],
      ] as const) {
        const section = page.locator('.settings-section').filter({ has: page.getByRole('heading', { name: heading, exact: true }) })
        await captureSection(page, section, `settings-${state}-light.png`, { category: 'settings', state, theme: 'light' })
      }
      await page.getByLabel('Paste delay').fill('10')
      await page.getByLabel('Paste delay').press('Tab')
      await expect(page.getByText('Enter a whole number between 50 and 1000.')).toBeVisible()
      await capturePage(page, 'settings-validation-error-light.png', { theme: 'light' })
      await page.getByRole('link', { name: 'Help' }).click()
      await expect(page.getByRole('heading', { name: 'Help' })).toBeVisible()
      await captureFullSurface(page, page.locator('.help-view'), 'help-light.png', /Reset safely/i, { theme: 'light' })
    })

    await withSotto({ onboardingComplete: true, history: populatedHistory }, async ({ page }) => {
      await assertDictateState(page, 'idle', /ready when you are/i)
      for (const theme of appThemes) {
        for (const accent of DESIGN_CAPTURE_ACCENTS.filter(candidate => candidate !== 'teal')) {
          await setAppearance(page, { appearance: theme, accent }, theme)
          await assertRenderedRoom(page, theme)
          await capturePage(page, `accent-${accent}-${theme}.png`, { category: 'appearance', state: `accent-${accent}`, theme })
        }
      }

      // System follows the scheme Windows reports, live, without a relaunch.
      await page.getByRole('link', { name: 'Settings' }).click()
      await page.emulateMedia({ colorScheme: 'light' })
      await setAppearance(page, { appearance: 'system', accent: 'teal' }, 'light')
      const section = page.locator('#settings-appearance')
      for (const theme of ['dark', 'light'] as const) {
        await page.emulateMedia({ colorScheme: theme })
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
        await expect(section).toContainText(`Sotto follows Windows, ${theme} right now, with a teal accent.`)
        await assertRenderedRoom(page, theme)
        await captureSection(page, section, `appearance-system-${theme}.png`, { category: 'appearance', state: 'system-settings', theme })
      }
    })

    await withSotto({ onboardingComplete: true, history: populatedHistory }, async (launched) => {
      const { page } = launched
      await setMainWindowWidth(launched, DESIGN_CAPTURE_MINIMUM_WIDTH)
      for (const theme of appThemes) {
        if (theme === 'light') await setAppearance(page, { appearance: 'light' }, 'light')
        await page.getByRole('tab', { name: 'Dictate', exact: true }).click()
        await assertDictateState(page, 'idle', /ready when you are/i)
        await capturePage(page, `width-${DESIGN_CAPTURE_MINIMUM_WIDTH}-dictate-${theme}.png`, { theme })
        await page.getByRole('tab', { name: 'Agents', exact: true }).click()
        const notNow = page.getByRole('button', { name: 'Not now', exact: true })
        if (await notNow.isVisible()) await notNow.click()
        await expect(page.locator('.agent-orb')).toBeVisible()
        await capturePage(page, `width-${DESIGN_CAPTURE_MINIMUM_WIDTH}-agents-${theme}.png`, { theme })
        await page.getByRole('link', { name: 'Settings' }).click()
        await captureFullSurface(page, page.locator('.settings-view'), `width-${DESIGN_CAPTURE_MINIMUM_WIDTH}-settings-${theme}.png`, /^Application$/i, { theme })
      }
    })
  })

  test('orb and session states follow the voice and permission journeys', async () => {
    await withSotto({ onboardingComplete: true }, async ({ page }) => {
      await page.evaluate(async () => { await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } }); await window.sotto!.agents!.command({ type: 'connect' }) })
      await page.getByRole('tab', { name: 'Agents', exact: true }).click()
      await page.getByRole('button', { name: 'Not now', exact: true }).click()
      await expect(page.locator('.agent-orb')).toHaveAttribute('data-state', 'wake')
      await capturePage(page, 'agents-wake.png')
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('sotto:e2e:microphone', { detail: 'Hey Sotto' })))
      await expect(page.locator('.agent-orb')).toHaveAttribute('data-state', 'listening')
      await capturePage(page, 'agents-listening.png')
      const threadId = await page.evaluate(async () => {
        const state = await window.sotto!.agents!.get()
        const id = state.host.threads[0]!.id
        await window.sotto!.agents!.command({ type: 'assign', threadId: id })
        await window.sotto!.agents!.command({ type: 'select-thread', threadId: id })
        await window.sottoE2E!.agentEvent!({ type: 'permission', threadId: id, text: 'Allow the agent to update the project files?', requestId: 'crossing-permission' })
        return id
      })
      await expect(page.getByRole('button', { name: 'Allow', exact: true })).toBeVisible()
      await capturePage(page, 'agents-attention.png')
      await page.getByRole('button', { name: 'Open Workshop', exact: true }).click()
      await expect(page.getByRole('dialog', { name: 'Workshop' })).toBeVisible()
      await capturePage(page, 'agents-session.png')
      await page.keyboard.press('Escape')
      expect(await page.evaluate(async id => (await window.sotto!.agents!.get()).host.threads.find(thread => thread.id === id)?.requests.length, threadId)).toBe(1)
    })
  })

  test('dense scaling matrix remains bounded', async () => {
    for (const scalePercent of scales) {
      await withSotto({ onboardingComplete: false, scalePercent }, async ({ page }) => {
        await page.getByRole('button', { name: 'Continue' }).click()
        await page.getByRole('button', { name: /test microphone/i }).click()
        await expect(page.getByText(/microphone ready/i)).toBeVisible()
        await page.getByRole('button', { name: 'Continue' }).click()
        await expect(page.getByText(/connect your openrouter key/i)).toBeVisible()
        await captureSection(page, page.locator('.onboarding-shell'), `scale-${scalePercent}-onboarding.png`)
      })

      await withSotto({ onboardingComplete: true, history: populatedHistory, scalePercent }, async (launched) => {
        const { page } = launched
        await assertDictateState(page, 'idle', /ready when you are/i)
        await capturePage(page, `scale-${scalePercent}-dictate.png`)

        await page.getByRole('button', { name: 'Start dictation' }).click()
        for (const theme of widgetThemes) {
          const liveWidget = await widgetPage(launched, theme)
          await expect(liveWidget.locator('.widget-shell[data-status="listening"]')).toBeVisible()
          await captureWidget(liveWidget, `scale-${scalePercent}-widget-${theme}.png`, { theme })
        }
        const liveWidget = await widgetPage(launched, 'dark')
        await liveWidget.getByRole('button', { name: 'Cancel dictation' }).click()

        await page.getByRole('link', { name: 'History' }).click()
        await captureFullSurface(page, page.locator('.history-view'), `scale-${scalePercent}-history.png`, /Draft the launch summary/i)

        await page.getByRole('link', { name: 'Settings' }).click()
        await captureFullSurface(page, page.locator('.settings-view'), `scale-${scalePercent}-settings.png`, /^Application$/i)

        await page.getByRole('link', { name: 'Help' }).click()
        await captureFullSurface(page, page.locator('.help-view'), `scale-${scalePercent}-help.png`, /Reset safely/i)

        // The light room at the same scale, switched live.
        await setAppearance(page, { appearance: 'light' }, 'light')
        await page.getByRole('tab', { name: 'Dictate', exact: true }).click()
        await assertDictateState(page, 'idle', /ready when you are/i)
        await capturePage(page, `scale-${scalePercent}-dictate-light.png`, { theme: 'light' })
        await page.getByRole('link', { name: 'Settings' }).click()
        await captureFullSurface(page, page.locator('.settings-view'), `scale-${scalePercent}-settings-light.png`, /^Application$/i, { theme: 'light' })
      })
    }
  })

  for (const theme of widgetThemes) {
    test(`${theme} widget states missing from the established widget baseline are captured`, async () => {
      await withSotto({ onboardingComplete: true, motion: 'reduced' }, async (launched) => {
        // Bootstrap seeds the idle snapshot after showing both windows. Wait
        // for that seed so it cannot overwrite the first recording snapshot.
        const widget = await widgetPage(launched, theme, 'reduced')
        await expect(widget.locator('.widget-shell[data-status="idle"]')).toBeVisible()
        await launched.page.getByRole('button', { name: 'Start dictation' }).click()
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

      await withSotto({ onboardingComplete: true, motion: 'reduced', scenario: 'design-permission' }, async (launched) => {
        const widget = await widgetPage(launched, theme, 'reduced')
        await expect(widget.locator('.widget-shell[data-status="idle"]')).toBeVisible()
        await launched.page.getByRole('button', { name: 'Start dictation' }).click()
        await expect(widget.getByText('Waiting for microphone', { exact: true })).toBeVisible()
        await captureWidget(widget, `widget-permission-${theme}.png`, { category: 'widget', state: 'requesting-permission', theme, reducedMotion: true })
      })

      await withSotto({ onboardingComplete: true, motion: 'reduced' }, async (launched) => {
        const widget = await widgetPage(launched, theme, 'reduced')
        await expect(widget.locator('.widget-shell[data-status="idle"]')).toBeVisible()
        await launched.page.getByRole('button', { name: 'Start dictation' }).click()
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
        "Application tuples carry the main window's resolved mode, dark (the Crossing default existing installs keep) or light; accent and System tuples name the choice in their state. The untouched widget follows the system scheme, emulated on its own window, so widget tuples keep light and dark.",
        'Width tuples narrow the main window to 760 logical pixels, below the shipped 820 minimum, to review the Phase 1 minimum width.',
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
