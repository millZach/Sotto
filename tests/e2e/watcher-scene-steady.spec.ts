import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { expect, test, type Page } from '@playwright/test'
import sharp from 'sharp'

import { E2E_THREADS_NOW } from '../../src/shared/e2e'
import { WATCHER_STAND_IN_KEY, type WatcherStandInSeed } from '../../src/renderer/src/e2e/watcherStandIn'
import { withSotto } from '../fixtures/designCaptureProfile'
import { evidenceDirectory } from '../fixtures/evidence'
import { onReleaseTrack } from './support/releaseTrack'
import { type LaunchedSotto, openThreads } from './support/sottoLaunch'
import { resizeContentWindow } from './support/sottoWindow'
import { seedWatcherRoom } from './support/watcherRoom'

/**
 * Watcher's night scene never blinks (the user's rule, October 24, 2026). The screen is recorded, frame by frame as the
 * compositor draws it, while the room goes through what changes it: a reply arrives, the room's projection changes (an
 * owl wakes, a newcomer comes out of the moon, a question waits and the needs-you line appears), a fold opens and
 * closes, the composer slims and widens, the Watched tab opens and closes, a draft is typed, the window is resized and
 * the scene is set in each of its places in turn (ADR-0148). In every frame the scene's left margin keeps its glyphs: a
 * frame that loses most of the ones its place shows is a blink, and while one place gives way to the next, most of the
 * fainter one's. Run after
 * `npm run build`. Captures go to disposable run evidence; `SOTTO_E2E_EVIDENCE=publish` writes
 * artifacts/composer-slim-steady.
 */
const evidence = evidenceDirectory('artifacts/composer-slim-steady')
const WATCHER = '#watcher-pane'
/** The places the scene is set in after the room's other changes, ending where it started. */
const PLACES = ['harbour', 'snowfield', 'desert', 'night-wood'] as const
/** How long the last place takes to fade over the new one (`PLACE_FADE_MS` in WatcherNightScene.tsx). */
const PLACE_FADE_MS = 600

/** The room's projection, read from the stand-in's seed so a later step can change a part of it. */
async function seed(page: Page): Promise<WatcherStandInSeed> {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)!) as WatcherStandInSeed, WATCHER_STAND_IN_KEY)
}

/** Records every frame the compositor draws while `act` runs, as JPEG buffers with when each came, by this clock. */
async function record(launched: LaunchedSotto, act: () => Promise<void>): Promise<Array<{ shot: Buffer; at: number }>> {
  const session = await launched.page.context().newCDPSession(launched.page)
  const shots: Array<{ shot: Buffer; at: number }> = []
  session.on('Page.screencastFrame', frame => {
    shots.push({ shot: Buffer.from(frame.data, 'base64'), at: Date.now() })
    void session.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined)
  })
  await session.send('Page.startScreencast', { format: 'jpeg', quality: 80, everyNthFrame: 1 })
  try { await act() } finally {
    await session.send('Page.stopScreencast').catch(() => undefined)
    await session.detach().catch(() => undefined)
  }
  return shots
}

/**
 * The scene's glyphs in a frame: of the pixels in the left margin, below the header and above the composer, how many
 * stand clearly off the room's colour. The room is that region's median.
 */
async function sceneInk(shot: Buffer, region: { left: number; top: number; width: number; height: number; scale: number }): Promise<number> {
  const image = sharp(shot)
  const { width = 0 } = await image.metadata()
  const scale = width / region.scale
  const { data, info } = await image.extract({ left: Math.round(region.left * scale), top: Math.round(region.top * scale), width: Math.round(region.width * scale), height: Math.round(region.height * scale) })
    .removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true })
  const values = [...data]
  const room = [...values].sort((a, b) => a - b)[values.length >> 1]!
  return values.filter(value => Math.abs(value - room) > 18).length / (info.width * info.height)
}

test("Watcher's night scene never blinks while the room changes", async () => {
  test.setTimeout(4 * 60_000)
  await mkdir(evidence, { recursive: true })
  await onReleaseTrack('owl', () => withSotto({ onboardingComplete: true, appearance: 'dark', motion: 'normal', agents: 'design-threads', scenario: 'design-threads', darkTheme: 't3-code' }, async (launched) => {
    const { page } = launched
    await openThreads(page)
    await seedWatcherRoom(page, { watched: ['footer-links', 'visual-gate', 'weekly-note'], idPrefix: 'blink' })
    // Later projections the stand-in publishes on its own while the run goes on: an owl wakes, a newcomer joins, and a
    // question waits on the user, which brings the needs-you line into the header.
    const base = await seed(page)
    const rows = base.state.watchedThreads
    const running = rows.map((row, index) => index === 0 ? { ...row, status: 'running' as const } : row)
    const newcomer = { ...rows[0]!, target: { ...rows[0]!.target, threadId: 'grok-previews' }, title: 'grok-previews' }
    const waits = [...running, newcomer].map((row, index) => index === 1 ? { ...row, waitsOn: [{ id: 'blink-ask', kind: 'question' as const, openTarget: row.target }] } : row)
    await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: WATCHER_STAND_IN_KEY, value: { ...base, script: [
      { afterMs: 9_000, state: { watchedThreads: running } },
      { afterMs: 12_000, state: { watchedThreads: [...running, newcomer] } },
      { afterMs: 15_000, state: { watchedThreads: waits } },
    ] } satisfies WatcherStandInSeed })
    await page.reload()
    await openThreads(page)
    await page.getByRole('tablist', { name: 'Page' }).getByRole('tab', { name: 'Watcher', exact: true }).click()
    await expect(page.locator(`${WATCHER} [data-message-id="blink-23"]`)).toBeVisible()
    await resizeContentWindow(launched, 1280, 800)
    await expect.poll(() => page.evaluate(pane => Number(document.querySelector<HTMLElement>(pane)!.dataset.nightSceneFrames ?? 0), WATCHER)).toBeGreaterThan(2)
    await page.mouse.move(0, 0)
    await page.waitForTimeout(600)

    // The left margin below the header, clear of the composer's column, in CSS pixels.
    const region = await page.evaluate(pane => {
      const element = document.querySelector<HTMLElement>(pane)!, base = element.getBoundingClientRect()
      const card = element.querySelector(':scope > .thread-workspace__compose > .thread-prompt')!.getBoundingClientRect()
      const header = Math.max(...[...element.querySelectorAll(':scope > :is(.watcher-head, .watcher-glance)')].map(node => node.getBoundingClientRect().bottom))
      return { left: base.left + 4, top: header + 70, width: Math.max(40, card.left - base.left - 40), height: Math.max(40, card.top - header - 90), scale: innerWidth }
    }, WATCHER)
    const log = page.locator(`${WATCHER} .thread-workspace__transcript`)
    const toEnd = (fromEnd: number) => log.evaluate((node, fromEnd) => { node.scrollTop = node.scrollHeight - node.clientHeight - fromEnd; node.dispatchEvent(new Event('scroll')) }, fromEnd)
    const steps: Array<{ at: number; name: string }> = []
    let started = 0
    const step = (name: string): void => { steps.push({ at: Date.now() - started, name }) }

    const shots = await record(launched, async () => {
      started = Date.now()
      step('a reply arrives')
      await page.evaluate(async now => {
        const said = Array.from({ length: 24 }, (_, index) => ({ id: `blink-${index}`, role: index % 2 ? 'assistant' as const : 'user' as const,
          text: index % 2 ? `Watching it. Package (Windows) is still running for the release thread (${(index + 1) / 2}).` : `Is the release thread green yet? (${index / 2 + 1})`,
          createdAt: new Date(now - (26 - index) * 60_000).toISOString() }))
        const at = new Date(now - 90_000).toISOString(), done = new Date(now - 30_000).toISOString()
        await window.sottoE2E!.agentEvent!({ type: 'history', threadId: 'release-notes', text: '', messages: [...said,
          { id: 'blink-24', role: 'user', text: 'Check the footer links thread.', createdAt: at },
          { id: 'blink-25', role: 'assistant', text: 'The footer links thread waits on review; nothing else changed.', createdAt: done }],
        activities: [
          { id: 'blink-turn', turnId: 'blink-turn', sequence: 0, afterMessageId: 'blink-24', kind: 'turn', status: 'completed', title: 'Turn', startedAt: at, completedAt: done },
          { id: 'blink-read', turnId: 'blink-turn', sequence: 1, afterMessageId: 'blink-24', kind: 'command', status: 'completed', title: 'Read the thread', command: 'read_thread footer-links', startedAt: at, completedAt: done },
        ] })
      }, E2E_THREADS_NOW)
      await expect(page.locator(`${WATCHER} [data-message-id="blink-25"]`)).toBeVisible()
      await page.waitForTimeout(700)
      const fold = page.locator(WATCHER).getByRole('button', { name: /^Worked for/ })
      if (await fold.count() > 0) {
        step('a fold opens'); await fold.first().click(); await page.waitForTimeout(700)
        step('the fold closes'); await fold.first().click(); await page.waitForTimeout(700)
      } else step('no fold to open')
      await page.mouse.move(0, 0)
      step('the composer slims'); await toEnd(420); await page.waitForTimeout(700)
      step('the composer widens'); await toEnd(0); await page.waitForTimeout(700)
      step('Watched opens'); await page.getByRole('tab', { name: /^Watched, / }).click(); await page.waitForTimeout(700)
      step('Conversation again'); await page.getByRole('tab', { name: 'Conversation' }).click(); await page.waitForTimeout(700)
      step('a draft is typed'); await page.getByRole('textbox', { name: 'Watcher message' }).click(); await page.keyboard.type('Is visual gate green?'); await page.waitForTimeout(500)
      await page.keyboard.press('Control+A'); await page.keyboard.press('Delete'); await page.mouse.move(0, 0)
      // The room's own changes come on the stand-in's clock: an owl wakes, a newcomer joins, a question waits.
      step('the room changes'); await expect(page.locator(`${WATCHER} .watcher-glance`)).toContainText(/need/i, { timeout: 20_000 }); await page.waitForTimeout(1_500)
      step('the window resizes'); await resizeContentWindow(launched, 1240, 780); await page.waitForTimeout(700)
      await resizeContentWindow(launched, 1280, 800); await page.waitForTimeout(700)
      // The place changes: the new one is drawn in the frame it is picked, under the last one fading away.
      for (const place of PLACES) {
        step(`place: ${place}`)
        await page.evaluate(async scene => { await window.sotto!.updateSettings({ watcherScene: scene }) }, place)
        await expect(page.locator(WATCHER)).toHaveAttribute('data-night-scene-place', place)
        await page.waitForTimeout(1_600)
      }
    })

    const inks: number[] = []
    for (const { shot } of shots) inks.push(await sceneInk(shot, region))
    const median = (values: readonly number[]): number => [...values].sort((a, b) => a - b)[values.length >> 1] ?? 0
    // Each frame that lost most of the scene's glyphs, with the step the room was in when it was drawn.
    const during = (at: number): string => steps.filter(item => item.at <= at - started).at(-1)?.name ?? 'before the first step'
    // The place each frame shows, the one before it, and how long since it was picked. Each place's glyphs are counted
    // apart, from its frames after the fade, since a desert's margin holds fewer than a wood's.
    const placeAt = (at: number): { place: string; before: string; since: number } => {
      const picks = steps.filter(item => item.name.startsWith('place: ') && item.at <= at - started)
      const last = picks.at(-1)
      return { place: last?.name.slice(7) ?? 'night-wood', before: picks.at(-2)?.name.slice(7) ?? 'night-wood', since: last === undefined ? Number.POSITIVE_INFINITY : at - started - last.at }
    }
    const frames = shots.map(({ at }, index) => ({ index, ink: inks[index]!, ...placeAt(at) }))
    const typicalOf = new Map<string, number>()
    for (const place of ['night-wood', ...PLACES]) typicalOf.set(place, median(frames.filter(frame => frame.place === place && frame.since > PLACE_FADE_MS + 200).map(frame => frame.ink)))
    const floor = (frame: typeof frames[number]): number => (frame.since <= PLACE_FADE_MS + 200 ? Math.min(typicalOf.get(frame.place)!, typicalOf.get(frame.before)!) : typicalOf.get(frame.place)!) * 0.5
    const blinks = frames.filter(frame => frame.ink < floor(frame)).map(frame => ({ index: frame.index, ink: Math.round(frame.ink * 1e4) / 1e4, place: frame.place, during: during(shots[frame.index]!.at) }))
    await mkdir(resolve(evidence, 'scene-frames'), { recursive: true })
    await Promise.all(shots.map(({ shot }, index) => writeFile(resolve(evidence, 'scene-frames', `${String(index).padStart(3, '0')}.jpg`), shot)))
    await writeFile(resolve(evidence, 'scene-ink.json'), `${JSON.stringify({ region, typical: Object.fromEntries(typicalOf), steps, frames: inks.map((ink, index) => ({ ink: Math.round(ink * 1e4) / 1e4, during: during(shots[index]!.at) })), blinks }, null, 1)}\n`, 'utf8')
    for (const [place, ink] of typicalOf) expect(ink, `the scene shows glyphs in its margin at all in ${place}`).toBeGreaterThan(0.005)
    expect(shots.length, 'the compositor drew frames to read').toBeGreaterThan(20)
    expect(blinks, `frames where the scene lost most of its glyphs, of ${shots.length}`).toEqual([])
  }))
})
