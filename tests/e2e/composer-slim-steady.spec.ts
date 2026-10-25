import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import { withSotto } from '../fixtures/designCaptureProfile'
import { evidenceDirectory } from '../fixtures/evidence'
import { longHistory } from './support/longHistory'
import { onReleaseTrack } from './support/releaseTrack'
import { bareEntityId, openThreads, type LaunchedSotto } from './support/sottoLaunch'
import { resizeContentWindow } from './support/sottoWindow'
import { seedWatcherRoom } from './support/watcherRoom'

/**
 * The slim composer (ADR-0125) slims and widens without moving anything else, on Watcher's pane and on a thread's, at
 * 150% display scaling, where the composer's height falls between whole pixels (the user's report on October 24, 2026,
 * on Owl 0.1.41-owl.20261024.1). Every frame of the move: the transcript keeps its size and the reader's place, the
 * pane never has anything to scroll, so it shows no second scroll bar, the card stays whole on screen between where it
 * stood and where it goes, and Watcher's night scene neither lays itself out again nor goes blank. At rest at the end,
 * whatever fraction of a pixel the composer's height carries, the pane has nothing to scroll. Run after
 * `npm run build`. Captures go to disposable run evidence; `SOTTO_E2E_EVIDENCE=publish` writes
 * artifacts/composer-slim-steady.
 */
const evidence = evidenceDirectory('artifacts/composer-slim-steady')
const recorded: Record<string, unknown> = {}
const WATCHER = '#watcher-pane'

function launchOptions(motion: 'normal' | 'reduced') {
  return { onboardingComplete: true, appearance: 'dark', motion, agents: 'design-threads', scenario: 'design-threads', darkTheme: 't3-code', scalePercent: 150 } as const
}

/** `release-notes` as a Watcher with a long conversation, watching five threads of the design fixture, its room open. */
async function seedRoom(page: Page): Promise<void> {
  await seedWatcherRoom(page, { watched: ['footer-links', 'visual-gate', 'weekly-note', 'grok-previews', 'release-checklist'], idPrefix: 'steady' })
  await page.getByRole('tablist', { name: 'Page' }).getByRole('tab', { name: 'Watcher', exact: true }).click()
  await expect(page.locator(`${WATCHER} [data-message-id="steady-23"]`)).toBeVisible()
}

/** `Grok voice previews` with a history long enough to read back through, its pane selected. */
async function openThread(page: Page): Promise<string> {
  const title = 'Grok voice previews'
  await page.getByRole('button', { name: title, exact: true }).click({ position: { x: 16, y: 12 } })
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
  const threadId = await page.locator('section.thread-pane[data-thread-id]').first().getAttribute('data-thread-id')
  expect(threadId, 'the pane names its thread').toBeTruthy()
  await longHistory(page, bareEntityId(threadId)!, 'steady-thread')
  await expect(page.locator('[data-message-id="steady-thread-15"]')).toBeVisible()
  return `section.thread-pane[data-thread-id="${threadId}"]`
}

/**
 * Gives the row under the composer a second line of words, as Watcher's compaction line or a thread's watched note
 * does, so the composer's height falls between whole pixels at 150% and the row steps away while the composer is slim.
 */
async function addMetaLine(page: Page, pane: string): Promise<void> {
  await page.evaluate(pane => {
    const meta = document.querySelector(`${pane} > .thread-workspace__compose > .thread-pane__meta`)!
    const line = document.createElement('div')
    line.className = 'thread-compaction'
    line.innerHTML = '<p role="status">Context compacted</p>'
    meta.append(line)
  }, pane)
}

async function settle(page: Page): Promise<void> {
  await page.mouse.move(0, 0)
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise(done => setTimeout(done, 300))
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
  })
}

/** Whether the pane has anything at all to scroll: what would show it a scroll bar beside the transcript's. */
async function paneScrolls(page: Page, pane: string): Promise<{ scrolls: boolean; overhang: number }> {
  return page.evaluate(pane => {
    const element = document.querySelector<HTMLElement>(pane)!
    const log = element.querySelector<HTMLElement>('.thread-workspace__transcript')!.parentElement!
    element.scrollTop = 40
    const scrolls = element.scrollTop > 0 || element.scrollHeight > element.clientHeight
    element.scrollTop = 0
    return { scrolls, overhang: log.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom }
  }, pane)
}

interface Frame {
  readonly t: number
  readonly slim: boolean
  readonly logHeight: number
  readonly place: number | null
  readonly paneScroll: number
  readonly overhang: number
  readonly card: readonly [number, number]
  readonly paneBottom: number
  readonly sceneLayouts: number
  readonly sceneInk: number
  /** How far the transcript was asked to scroll, read on the frame before the move. */
  readonly asked: number
  /** Whether the card is what shows at its own middle, and how opaque it and the composer are. */
  readonly cardShown: boolean
  readonly cardOpacity: number
}

/**
 * Reads every frame for `ms` while `to` (pixels above the transcript's end) is scrolled to in the first one: the
 * transcript's size and scroll, where the message under the reader's eye stands, whether the pane has anything to
 * scroll, the card's top and bottom, and on Watcher how often the scene laid itself out and how much ink it shows.
 */
async function framesWhile(page: Page, pane: string, to: number, ms = 600): Promise<Frame[]> {
  return page.evaluate(async ({ pane, to, ms }) => {
    const element = document.querySelector<HTMLElement>(pane)!
    const log = element.querySelector<HTMLElement>('.thread-workspace__transcript')!
    const compose = element.querySelector<HTMLElement>(':scope > .thread-workspace__compose')!
    const card = compose.querySelector<HTMLElement>(':scope > .thread-prompt')!
    const land = element.querySelector<HTMLCanvasElement>(':scope > canvas.watcher-scene--land')
    const ink = land?.getContext('2d', { willReadFrequently: true }) ?? null
    const eye = log.getBoundingClientRect().top + 120
    let held: Element | null = null
    const place = (): number | null => {
      if (held === null) held = [...log.querySelectorAll('[data-message-id]')].find(row => { const box = row.getBoundingClientRect(); return box.top <= eye && box.bottom > eye }) ?? null
      return held === null ? null : held.getBoundingClientRect().top
    }
    // The scene's ink: one pixel in every 8 by 8 of the land canvas, enough to tell a drawn scene from a blank one.
    const sceneInk = (): number => {
      if (land === null || ink === null || land.width === 0) return -1
      const data = ink.getImageData(0, 0, land.width, land.height).data
      let sum = 0
      for (let y = 0; y < land.height; y += 8) for (let x = 0; x < land.width; x += 8) sum += data[(y * land.width + x) * 4 + 3]!
      return sum
    }
    const read = (t: number) => {
      const box = card.getBoundingClientRect(), base = element.getBoundingClientRect()
      const middle = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      return { t, slim: compose.hasAttribute('data-slim'), logHeight: log.clientHeight, place: place(), asked: 0,
        cardShown: middle !== null && card.contains(middle), cardOpacity: Number(getComputedStyle(card).opacity) * Number(getComputedStyle(compose).opacity),
        // What the pane could scroll, which shows it a scroll bar: overflow it clips is not scrolled to.
        paneScroll: (/auto|scroll/.test(getComputedStyle(element).overflowY) ? element.scrollHeight - element.clientHeight : 0) + element.scrollTop,
        overhang: log.parentElement!.getBoundingClientRect().bottom - base.bottom, card: [box.top, box.bottom] as const, paneBottom: base.bottom,
        sceneLayouts: Number(element.dataset.nightSceneLayouts ?? 0), sceneInk: sceneInk() }
    }
    const target = Math.max(0, log.scrollHeight - log.clientHeight - to)
    const frames = [{ ...read(-1), asked: target - log.scrollTop }]
    log.scrollTop = target
    log.dispatchEvent(new Event('scroll'))
    const start = performance.now()
    while (performance.now() - start < ms) {
      await new Promise(done => requestAnimationFrame(done))
      frames.push(read(Math.round(performance.now() - start)))
    }
    return frames
  }, { pane, to, ms })
}

/** What went wrong in a move's frames, in words; empty when nothing did. */
function problems(frames: readonly Frame[], watcher: boolean): string[] {
  const found: string[] = []
  const [before, first, ...rest] = frames
  const last = frames.at(-1)!
  if (before === undefined || first === undefined) return ['no frames were read']
  if (before.slim === last.slim) found.push(`the composer did not ${before.slim ? 'widen' : 'slim'}`)
  const [fromTop, fromBottom] = before.card, [toTop] = last.card
  let previous = before
  for (const frame of [first, ...rest]) {
    const at = `at ${frame.t} ms`
    if (Math.abs(frame.logHeight - before.logHeight) > 0.5) found.push(`${at} the transcript changed height, ${before.logHeight} to ${frame.logHeight}`)
    // The message under the reader's eye moves by the scroll asked for, in the first frame, and never again.
    if (frame.place !== null && before.place !== null && Math.abs(frame.place - (before.place - before.asked)) > 1) found.push(`${at} the reader's place moved ${Math.round(frame.place - (before.place - before.asked))} px past the scroll asked for`)
    if (!frame.cardShown || frame.cardOpacity < 0.99) found.push(`${at} the card did not show (on top: ${frame.cardShown}, opacity ${frame.cardOpacity})`)
    if (frame.paneScroll > 0 || frame.overhang > 0.01) found.push(`${at} the pane had ${Math.max(frame.paneScroll, frame.overhang).toFixed(2)} px to scroll`)
    const [top, bottom] = frame.card
    if (bottom > frame.paneBottom + 0.5) found.push(`${at} the card ran ${Math.round(bottom - frame.paneBottom)} px off the pane`)
    if (top < Math.min(fromTop, toTop) - 1 || top > Math.max(fromTop, toTop) + 1) found.push(`${at} the card's top stood at ${Math.round(top)}, outside ${Math.round(fromTop)} to ${Math.round(toTop)}`)
    // Only the card's top moves: its foot stands where it stood, the row under it hidden in its place while slim.
    if (Math.abs(bottom - fromBottom) > 1) found.push(`${at} the card's foot moved ${Math.round(bottom - fromBottom)} px`)
    if (watcher && frame.sceneLayouts !== previous.sceneLayouts) found.push(`${at} the night scene laid itself out again`)
    if (watcher && frame.sceneInk < before.sceneInk * 0.5) found.push(`${at} the night scene went blank (${frame.sceneInk} of ${before.sceneInk})`)
    previous = frame
  }
  return found
}

/** Records the screen while `act` runs, as the frames the compositor drew, for the evidence. */
async function screencast(launched: LaunchedSotto, name: string, act: () => Promise<void>): Promise<void> {
  const session = await launched.page.context().newCDPSession(launched.page)
  const shots: Buffer[] = []
  session.on('Page.screencastFrame', frame => {
    shots.push(Buffer.from(frame.data, 'base64'))
    void session.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined)
  })
  await session.send('Page.startScreencast', { format: 'jpeg', quality: 70, everyNthFrame: 1 })
  try { await act() } finally {
    await session.send('Page.stopScreencast').catch(() => undefined)
    await session.detach().catch(() => undefined)
  }
  await mkdir(resolve(evidence, name), { recursive: true })
  await Promise.all(shots.map((shot, index) => writeFile(resolve(evidence, name, `${String(index).padStart(3, '0')}.jpg`), shot)))
}

/** Slims and widens the composer on `pane`, by a scroll and by the wheel, and checks every frame of each move. */
async function checkMoves(launched: LaunchedSotto, pane: string, label: string, watcher: boolean): Promise<void> {
  const { page } = launched
  const compose = page.locator(`${pane} > .thread-workspace__compose`)
  await framesWhile(page, pane, 0, 100)
  await settle(page)
  await screencast(launched, `${label}-frames`, async () => {
    const slimming = await framesWhile(page, pane, 420)
    await expect(compose).toHaveAttribute('data-slim', 'true')
    await settle(page)
    const widening = await framesWhile(page, pane, 0)
    await expect(compose).not.toHaveAttribute('data-slim')
    recorded[`${label}-slimming`] = slimming
    recorded[`${label}-widening`] = widening
    expect.soft(problems(slimming, watcher), `${label}: slimming`).toEqual([])
    expect.soft(problems(widening, watcher), `${label}: widening`).toEqual([])
  })
  await settle(page)
  // The reader's own wheel, a notch at a time, up past the line where the composer slims and back down to the end.
  const box = (await page.locator(`${pane} .thread-workspace__transcript`).boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3)
  const layouts = async (): Promise<number> => page.evaluate(pane => Number(document.querySelector<HTMLElement>(pane)!.dataset.nightSceneLayouts ?? 0), pane)
  const before = await layouts()
  await screencast(launched, `${label}-wheel-frames`, async () => {
    for (let notch = 0; notch < 4; notch++) { await page.mouse.wheel(0, -100); await page.waitForTimeout(40) }
    await expect(compose).toHaveAttribute('data-slim', 'true')
    await page.waitForTimeout(700)
    for (let notch = 0; notch < 8; notch++) { await page.mouse.wheel(0, 100); await page.waitForTimeout(40) }
    await expect(compose).not.toHaveAttribute('data-slim')
    await page.waitForTimeout(500)
  })
  await settle(page)
  if (watcher) expect.soft(await layouts(), `${label}: the night scene laid itself out again under the wheel`).toBe(before)
  const atEnd = await paneScrolls(page, pane)
  expect.soft(atEnd.scrolls, `${label}: the pane scrolls at the end after the wheel`).toBe(false)
  expect.soft(atEnd.overhang, `${label}: the transcript runs past the pane's foot after the wheel`).toBeLessThanOrEqual(0.01)
  await page.mouse.move(0, 0)
}

/** At rest at the end, the composer's height a fraction of a pixel over each eighth: the pane has nothing to scroll. */
async function checkRest(page: Page, pane: string, label: string): Promise<void> {
  const readings: Record<string, unknown> = {}
  for (let eighth = 0; eighth < 8; eighth++) {
    await page.evaluate(([pane, eighth]) => {
      const compose = document.querySelector<HTMLElement>(`${pane} > .thread-workspace__compose`)!
      compose.style.paddingBottom = `${20 + eighth / 8}px`
    }, [pane, eighth] as const)
    await settle(page)
    const reading = await paneScrolls(page, pane)
    readings[`+${eighth}/8`] = reading
    expect.soft(reading.scrolls, `${label}: the pane scrolls with the composer ${eighth}/8 px taller`).toBe(false)
    expect.soft(reading.overhang, `${label}: the transcript runs past the pane's foot with the composer ${eighth}/8 px taller`).toBeLessThanOrEqual(0.01)
  }
  await page.evaluate(pane => document.querySelector<HTMLElement>(`${pane} > .thread-workspace__compose`)!.style.removeProperty('padding-bottom'), pane)
  recorded[`${label}-rest`] = readings
}

test.describe('The slim composer moves without moving anything else', () => {
  test.describe.configure({ timeout: 4 * 60_000 })
  test.beforeAll(async () => { await mkdir(evidence, { recursive: true }) })
  // Each case's frames, under its own name, for the verification note.
  test.afterEach(async () => {
    for (const [name, reading] of Object.entries(recorded)) await writeFile(resolve(evidence, `${name}.json`), `${JSON.stringify(reading, null, 1)}\n`, 'utf8')
    for (const name of Object.keys(recorded)) delete recorded[name]
  })

  test("Watcher's pane at 150%: one scroll bar, no jump, no blank frame", async () => {
    await onReleaseTrack('owl', () => withSotto(launchOptions('normal'), async (launched) => {
      const { page } = launched
      await openThreads(page)
      await seedRoom(page)
      await resizeContentWindow(launched, 1280, 800)
      await addMetaLine(page, WATCHER)
      await settle(page)
      await launched.page.screenshot({ path: resolve(evidence, 'watcher-end.png') })
      expect.soft(await paneScrolls(page, WATCHER), 'Watcher at the end with its compaction line').toMatchObject({ scrolls: false })
      await checkMoves(launched, WATCHER, 'watcher', true)
      await checkRest(page, WATCHER, 'watcher')
    }))
  })

  test("a thread's pane at 150%: one scroll bar, no jump, no blink", async () => {
    await onReleaseTrack('owl', () => withSotto(launchOptions('normal'), async (launched) => {
      const { page } = launched
      await openThreads(page)
      await resizeContentWindow(launched, 1280, 800)
      const pane = await openThread(page)
      await addMetaLine(page, pane)
      await settle(page)
      expect.soft(await paneScrolls(page, pane), 'the thread at the end with a second line under its composer').toMatchObject({ scrolls: false })
      await checkMoves(launched, pane, 'thread', false)
      await checkRest(page, pane, 'thread')
    }))
  })

  test('with motion reduced the composer changes at once, and still nothing else moves', async () => {
    await onReleaseTrack('owl', () => withSotto(launchOptions('reduced'), async (launched) => {
      const { page } = launched
      await openThreads(page)
      await seedRoom(page)
      await resizeContentWindow(launched, 1280, 800)
      await addMetaLine(page, WATCHER)
      await settle(page)
      const slimming = await framesWhile(page, WATCHER, 420, 300)
      expect(slimming[1]?.slim, 'slim in the first frame').toBe(true)
      await settle(page)
      const widening = await framesWhile(page, WATCHER, 0, 300)
      expect(widening[1]?.slim, 'full in the first frame').toBe(false)
      recorded['reduced-slimming'] = slimming
      recorded['reduced-widening'] = widening
      expect.soft(problems(slimming, true), 'reduced: slimming').toEqual([])
      expect.soft(problems(widening, true), 'reduced: widening').toEqual([])
      expect.soft(await page.evaluate(() => document.querySelector('#watcher-pane .thread-prompt')!.getAnimations().length), 'no motion on the card').toBe(0)
    }))
  })
})
