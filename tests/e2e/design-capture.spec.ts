import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import { _electron as electron, expect, test, type Locator, type Page } from '@playwright/test'
import sharp from 'sharp'

import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import type { E2EScenario } from '../../src/shared/e2e'
import type { HistoryEntry } from '../../src/shared/history'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import {
  closeTalkType,
  launchTalkType,
  type LaunchedTalkType,
  type LaunchDependencies,
} from './support/talktypeLaunch'

const captureEnabled = process.env.TALKTYPE_DESIGN_CAPTURE === '1'
const updateBaselines = process.env.TALKTYPE_UPDATE_DESIGN_BASELINES === '1'
const repositoryRoot = process.cwd()
const baselineRoot = resolve(repositoryRoot, 'artifacts/design/app-review/baseline')
const manifestPath = resolve(repositoryRoot, 'artifacts/design/app-review/manifest.json')
const actualRoot = resolve(repositoryRoot, 'test-results/design-capture/actual')
const themes = ['light', 'dark'] as const
const mainCapturesPerTheme = 25
const newWidgetCapturesPerTheme = 3
const externalWidgetStates = ['listening', 'processing', 'pasted', 'copied', 'error'] as const
type CaptureTheme = (typeof themes)[number]

interface CaptureMetadata {
  readonly category: 'onboarding' | 'home' | 'history' | 'settings' | 'help' | 'scale' | 'widget'
  readonly state: string
  readonly theme: CaptureTheme
  readonly focus?: boolean
  readonly reducedMotion?: boolean
  readonly scalePercent?: 100 | 125 | 150 | 200
  readonly source?: 'app-review' | 'widget-baseline'
}

interface CaptureEntry extends CaptureMetadata {
  readonly id: string
  readonly relativePath: string
  readonly width: number
  readonly height: number
  readonly sha256: string
  readonly source: 'app-review' | 'widget-baseline'
}

const capturedEntries: CaptureEntry[] = []

const populatedHistory: readonly HistoryEntry[] = [
  {
    id: 'review-1',
    text: 'Draft the launch summary and send it to the product team before lunch.',
    createdAt: Date.UTC(2026, 6, 11, 16, 30),
    durationMs: 8_400,
    language: 'en',
    modelPreset: 'balanced',
  },
  {
    id: 'review-2',
    text: 'Remember to confirm the accessibility review and installer smoke test.',
    createdAt: Date.UTC(2026, 6, 10, 22, 15),
    durationMs: 6_200,
    language: 'en',
    modelPreset: 'balanced',
  },
  {
    id: 'review-3',
    text: 'The microphone notes stay local and the final transcript is copied automatically.',
    createdAt: Date.UTC(2026, 6, 9, 18, 5),
    durationMs: 10_700,
    language: 'en',
    modelPreset: 'balanced',
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
    readonly reducedMotion?: 'system' | 'on'
  },
): Promise<string> {
  const profile = await mkdtemp(join(tmpdir(), 'talktype-e2e-design-'))
  const settings = {
    ...DEFAULT_SETTINGS,
    theme,
    reducedMotion: options.reducedMotion ?? 'system',
    onboardingComplete: options.onboardingComplete,
    successDisplayMs: 5_000,
  }
  await writeFile(join(profile, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  await writeFile(join(profile, 'history.json'), `${JSON.stringify(options.history ?? [], null, 2)}\n`, 'utf8')
  return profile
}

async function withTalkType(
  theme: CaptureTheme,
  options: {
    readonly onboardingComplete: boolean
    readonly history?: readonly HistoryEntry[]
    readonly reducedMotion?: 'system' | 'on'
    readonly scenario?: E2EScenario
    readonly scalePercent?: 100 | 125 | 150 | 200
  },
  run: (launched: LaunchedTalkType) => Promise<void>,
): Promise<void> {
  const profile = await createProfile(theme, options)
  let launched: LaunchedTalkType | undefined
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
    launched = await launchTalkType(options.scenario ?? 'success', profile, dependencies)
    await launched.page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    await expect(launched.page.locator('html')).toHaveAttribute('data-theme', theme)
    await expect.poll(() => launched!.page.evaluate<number>('devicePixelRatio')).toBeCloseTo(scaleFactor, 2)
    await run(launched)
  } finally {
    if (launched !== undefined) await closeTalkType(launched)
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true })
  }
}

async function waitForStableFrame(page: Page): Promise<void> {
  await page.evaluate(`(async () => {
    await document.fonts.ready
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

    for (const selector of ['.app-shell', '.app-titlebar', '.app-navigation', '.app-content', '.app-status-footer', '.onboarding-shell']) {
      const element = document.querySelector(selector)
      if (element === null) continue
      const bounds = element.getBoundingClientRect()
      if (bounds.left < -tolerance || bounds.right > innerWidth + tolerance) problems.push(selector + '-outside-horizontal-bounds')
      if (selector !== '.onboarding-shell' && (bounds.top < -tolerance || bounds.bottom > innerHeight + tolerance)) problems.push(selector + '-outside-vertical-bounds')
    }

    for (const element of document.querySelectorAll('button, input, select, a')) {
      const bounds = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      if (style.display === 'none' || style.visibility === 'hidden' || bounds.width === 0 || bounds.height === 0) continue
      if (bounds.left < -tolerance || bounds.right > innerWidth + tolerance) {
        const label = element.getAttribute('aria-label') || (element.textContent || '').trim().slice(0, 30) || 'control'
        problems.push(element.tagName.toLowerCase() + '-' + label + '-clipped')
      }
    }
    return [...new Set(problems)]
  })()`)
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
    changedPixels: Math.max(20, Math.floor(pixelCount * 0.0001)),
    totalChannelDelta: Math.max(200, Math.floor(pixelCount * 0.001)),
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
  const changedPixelLimit = Math.max(20, Math.floor(pixelCount * 0.0001))
  const totalDeltaLimit = Math.max(200, Math.floor(pixelCount * 0.001))
  const materiallyChanged = changedPixels > changedPixelLimit || totalChannelDelta > totalDeltaLimit
  if (materiallyChanged) {
    await mkdir(actualRoot, { recursive: true })
    await writeFile(resolve(actualRoot, name), actual)
  }
  const message = `${name} changed materially; actual image was saved under test-results/design-capture/actual`
  expect(changedPixels, message).toBeLessThanOrEqual(changedPixelLimit)
  expect(totalChannelDelta, message).toBeLessThanOrEqual(totalDeltaLimit)
}

async function recordCapture(image: Buffer, fileName: string, metadata: CaptureMetadata): Promise<void> {
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
  capturedEntries.push({
    ...metadata,
    id: fileName.replace(/\.png$/u, ''),
    relativePath: relative(repositoryRoot, destination).replaceAll('\\', '/'),
    width: imageMetadata.width,
    height: imageMetadata.height,
    sha256: digest(baseline),
    source: 'app-review',
  })
}

async function capturePage(page: Page, fileName: string, metadata: CaptureMetadata, fullPage = false): Promise<void> {
  await waitForStableFrame(page)
  expect(await pageBoundProblems(page), `${fileName} has clipped or overflowing application chrome`).toEqual([])
  const image = await stableScreenshot(
    fileName,
    () => page.screenshot({ caret: 'hide', fullPage }),
    () => waitForStableFrame(page),
  )
  await recordCapture(image, fileName, metadata)
}

async function captureSection(page: Page, section: Locator, fileName: string, metadata: CaptureMetadata): Promise<void> {
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

async function captureWidget(page: Page, fileName: string, metadata: CaptureMetadata): Promise<void> {
  await waitForStableFrame(page)
  const image = await stableScreenshot(
    fileName,
    () => page.screenshot({ caret: 'hide', omitBackground: true }),
    () => waitForStableFrame(page),
  )
  const dimensions = await sharp(image).metadata()
  expect(dimensions).toMatchObject({ width: 420, height: 92 })
  await recordCapture(image, fileName, metadata)
}

async function widgetPage(launched: LaunchedTalkType): Promise<Page> {
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
      if (metadata.width !== 420 || metadata.height !== 92) throw new Error(`Unexpected widget baseline geometry: ${path}`)
      entries.push({
        id: `widget-${state}-${theme}`,
        category: 'widget',
        state,
        theme,
        reducedMotion: true,
        relativePath: relative(repositoryRoot, path).replaceAll('\\', '/'),
        width: metadata.width,
        height: metadata.height,
        sha256: digest(image),
        source: 'widget-baseline',
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
      await withTalkType(theme, { onboardingComplete: false }, async ({ page }) => {
        const onboarding = page.locator('.onboarding-shell')
        await expect(page.getByRole('heading', { name: /private dictation/i })).toBeVisible()
        await captureSection(page, onboarding, `onboarding-step-1-welcome-${theme}.png`, { category: 'onboarding', state: 'welcome', theme })

        await page.getByRole('button', { name: 'Continue' }).click()
        await page.getByRole('button', { name: /test microphone/i }).click()
        await expect(page.getByText(/microphone ready/i)).toBeVisible()
        await captureSection(page, onboarding, `onboarding-step-2-microphone-ready-${theme}.png`, { category: 'onboarding', state: 'microphone-ready', theme })

        await page.getByRole('button', { name: 'Continue' }).click()
        await expect(page.getByText(/balanced model is included and ready/i)).toBeVisible()
        await captureSection(page, onboarding, `onboarding-step-3-model-${theme}.png`, { category: 'onboarding', state: 'model-ready', theme })

        await page.getByRole('button', { name: 'Continue' }).click()
        await expect(page.getByRole('heading', { name: /one shortcut/i })).toBeVisible()
        await captureSection(page, onboarding, `onboarding-step-4-shortcut-${theme}.png`, { category: 'onboarding', state: 'shortcut-paste', theme })
      })

      await withTalkType(theme, { onboardingComplete: true, history: populatedHistory }, async ({ page }) => {
        await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible()
        await capturePage(page, `home-ready-${theme}.png`, { category: 'home', state: 'ready', theme })

        const start = page.getByRole('button', { name: 'Start dictation' })
        await start.focus()
        await capturePage(page, `home-focus-${theme}.png`, { category: 'home', state: 'ready-focus', theme, focus: true })
        await start.click()
        await expect(page.getByRole('heading', { name: 'Listening' })).toBeVisible()
        await capturePage(page, `home-listening-${theme}.png`, { category: 'home', state: 'listening', theme })
        await page.getByRole('button', { name: 'Stop and transcribe' }).click()
        await expect(page.getByRole('heading', { name: 'Text pasted' })).toBeVisible()
        await capturePage(page, `home-success-${theme}.png`, { category: 'home', state: 'success-pasted', theme })
      })

      await withTalkType(theme, { onboardingComplete: true, scenario: 'design-processing' }, async ({ page }) => {
        await page.getByRole('button', { name: 'Start dictation' }).click()
        await page.getByRole('button', { name: 'Stop and transcribe' }).click()
        await expect(page.getByRole('heading', { name: 'Turning speech into text' })).toBeVisible()
        await capturePage(page, `home-processing-${theme}.png`, { category: 'home', state: 'processing', theme })
      })

      await withTalkType(theme, { onboardingComplete: true, scenario: 'transcription-failure' }, async ({ page }) => {
        await page.getByRole('button', { name: 'Start dictation' }).click()
        await page.getByRole('button', { name: 'Stop and transcribe' }).click()
        await expect(page.getByRole('heading', { name: 'Dictation needs attention' })).toBeVisible()
        await capturePage(page, `home-error-${theme}.png`, { category: 'home', state: 'error', theme })
      })

      await withTalkType(theme, { onboardingComplete: true, reducedMotion: 'on' }, async ({ page }) => {
        await page.getByRole('button', { name: 'Start dictation' }).click()
        await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'on')
        await capturePage(page, `home-reduced-motion-${theme}.png`, { category: 'home', state: 'listening-reduced-motion', theme, reducedMotion: true })
      })

      await withTalkType(theme, { onboardingComplete: true, history: populatedHistory }, async ({ page }) => {
        await page.getByRole('link', { name: 'History' }).click()
        await expect(page.getByText(populatedHistory[0]!.text)).toBeVisible()
        await page.getByRole('button', { name: 'Copy transcript' }).first().click()
        await expect(page.getByRole('status')).toContainText('Transcript copied')
        await capturePage(page, `history-populated-${theme}.png`, { category: 'history', state: 'populated-feedback', theme })

        await page.getByRole('button', { name: 'Clear history' }).click()
        await page.getByRole('button', { name: 'Clear all transcripts' }).click()
        await expect(page.getByRole('heading', { name: 'No saved transcripts yet' })).toBeVisible()
        await capturePage(page, `history-empty-${theme}.png`, { category: 'history', state: 'empty-feedback', theme })

        await page.getByRole('link', { name: 'Settings' }).click()
        await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
        await page.getByLabel('Reduced motion').selectOption('on')
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
        await page.evaluate("document.querySelector('.app-content')?.scrollTo(0, 0)")
        await capturePage(page, `help-${theme}.png`, { category: 'help', state: 'overview', theme })
      })
    })

    test(`${theme} scaling equivalents remain bounded`, async () => {
      for (const scalePercent of [100, 125, 150, 200] as const) {
        await withTalkType(theme, { onboardingComplete: true, history: populatedHistory, scalePercent }, async ({ page }) => {
          await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible()
          await capturePage(page, `scale-${scalePercent}-home-${theme}.png`, {
            category: 'scale',
            state: 'home-ready',
            theme,
            scalePercent,
          })
        })
      }
    })

    test(`${theme} widget states missing from the established widget baseline are captured`, async () => {
      await withTalkType(theme, { onboardingComplete: true, reducedMotion: 'on' }, async (launched) => {
        const widget = await widgetPage(launched)
        await expect(widget.locator('.widget-shell')).toHaveCount(0)
        await captureWidget(widget, `widget-idle-${theme}.png`, { category: 'widget', state: 'idle-hidden', theme, reducedMotion: true })
      })

      await withTalkType(theme, { onboardingComplete: true, reducedMotion: 'on', scenario: 'design-permission' }, async (launched) => {
        await launched.page.getByRole('button', { name: 'Start dictation' }).click()
        const widget = await widgetPage(launched)
        await expect(widget.getByText('Waiting for microphone', { exact: true })).toBeVisible()
        await captureWidget(widget, `widget-permission-${theme}.png`, { category: 'widget', state: 'requesting-permission', theme, reducedMotion: true })
      })

      await withTalkType(theme, { onboardingComplete: true, reducedMotion: 'on' }, async (launched) => {
        await launched.page.getByRole('button', { name: 'Start dictation' }).click()
        const widget = await widgetPage(launched)
        await expect(widget.getByText('Listening', { exact: true })).toBeVisible()
        await widget.getByRole('button', { name: 'Cancel dictation' }).click()
        await expect(widget.getByText('Cancelled', { exact: true })).toBeVisible()
        await captureWidget(widget, `widget-cancelled-${theme}.png`, { category: 'widget', state: 'cancelled', theme, reducedMotion: true })
      })
    })
  }

  test.afterAll(async () => {
    const expectedCaptured = themes.length * (mainCapturesPerTheme + newWidgetCapturesPerTheme)
    if (capturedEntries.length !== expectedCaptured) return
    const entries = [...capturedEntries, ...await externalWidgetEntries()]
      .sort((first, second) => first.id.localeCompare(second.id))
    const manifest = {
      version: 1,
      captureBoundary: 'Non-packaged TALKTYPE_E2E=1 only; resolveE2EConfiguration rejects packaged builds.',
      viewport: 'TalkType main BrowserWindow (1080x720 logical window); widget 420x92.',
      scalingMethod: 'Electron --force-device-scale-factor driven by Playwright at 100/125/150/200 percent; devicePixelRatio is asserted.',
      notes: [
        'The idle widget is intentionally transparent because production renders no widget surface while idle.',
        'Established Task 12 widget baselines are referenced in place; they are not duplicated.',
        'Every page emulates reduced motion, widget captures also persist reduced-motion on, and Playwright hides carets for deterministic pixels.',
        'Capture launches disable GPU compositing to avoid Electron tile tearing; application layout and CSS rendering remain authoritative.',
        'Verification permits only negligible raster variance: at most max(20, 0.01%) pixels and max(200, 0.1% pixel-count) total channel delta.',
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
