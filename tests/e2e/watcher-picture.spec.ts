import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import { E2E_THREADS_NOW } from '../../src/shared/e2e'
import { contrastRatio, parseThemeRgb } from '../../src/shared/themes/color'
import { WATCHER_STAND_IN_KEY, type WatcherStandInSeed } from '../../src/renderer/src/e2e/watcherStandIn'
import type { WatcherEvidence, WatcherOperation, WatcherThreadTarget } from '../../src/shared/watcher'
import type { WatcherRoomState } from '../../src/shared/watcherRoom'
import { withSotto } from '../fixtures/designCaptureProfile'
import { evidenceDirectory } from '../fixtures/evidence'
import { pageBoundProblems } from './support/designCapture'
import { onReleaseTrack } from './support/releaseTrack'
import { openThreads, type LaunchedSotto } from './support/sottoLaunch'
import { resizeContentWindow } from './support/sottoWindow'

/**
 * Watcher's picture (#1339, Zach's pick on October 22, 2026: A, the constellation) in the built app, on the Sotto Owl
 * track: the Visualize tab, the threads Watcher watches drawn around it by project, the merge turns along the top, a
 * thread's card, messages moving as they happen and, with reduced motion, standing still beside the thread. Main's
 * Watcher side is stood in for by a seeded projection that then moves on a script (src/renderer/src/e2e/watcherStandIn.ts).
 * Run after `npm run build`. Captures go to disposable run evidence; `SOTTO_E2E_EVIDENCE=publish` writes
 * artifacts/watcher-picture.
 */
const evidence = evidenceDirectory('artifacts/watcher-picture')
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const
const CURRENT = 'release-notes'
const at = (minutes: number): string => new Date(E2E_THREADS_NOW - minutes * 60_000).toISOString()
const pr = (number: number, state: 'open' | 'merged' = 'open') => ({ number, url: `https://github.com/millZach/Sotto/pull/${number}`, title: `PR ${number}`, state, draft: false, source: 'linked' as const, linkedAt: at(60) })
/** The threads Watcher watches, and the pull requests the picture reads its merge turns from. */
const WATCHED: readonly { readonly id: string; readonly pullRequests?: ReturnType<typeof pr>[]; readonly settled?: boolean }[] = [
  { id: 'visual-gate', pullRequests: [pr(1291)] }, { id: 'footer-links', pullRequests: [pr(1295)] }, { id: 'weekly-note' },
  { id: 'wav-stall' }, { id: 'thread-routing', pullRequests: [pr(1288, 'merged')] }, { id: 'benchmark', pullRequests: [pr(1299)] },
  { id: 'grok-previews' }, { id: 'notes-cleanup', settled: true },
]

function launchOptions(appearance: 'dark' | 'light', theme = 't3-code', motion: 'normal' | 'reduced' = 'normal') {
  return { onboardingComplete: true, appearance, motion, scenario: 'design-threads', agents: 'design-threads',
    ...(appearance === 'dark' ? { darkTheme: theme } : { lightTheme: theme }) } as const
}

/**
 * Seeds Watcher's room: `release-notes` stands for Watcher, which watches eight threads across three projects, one of
 * them settled; #1288 merged, #1291 has its merge turn, #1295 waits in the queue, #1299's checks run. The script then
 * delivers a check-in to Footer links, has it answer, has Weekly note ask the user a question, and gives #1295 its turn.
 */
async function seedPicture(page: Page): Promise<void> {
  const hostId = await page.evaluate(async () => (await window.sotto!.agents!.get()).hostId)
  expect(hostId, 'the window names its host').toBeTruthy()
  const target = (threadId: string): WatcherThreadTarget => ({ hostId: hostId!, threadId })
  const requestId = randomUUID()
  const identity = { target: target(CURRENT), projectId: 'workshop', provider: 'codex' as const, creationOperationId: randomUUID(), createdAt: at(240) }
  const participants = WATCHED.map(({ id }) => ({ requestId, startedBy: 'watcher' as const, generation: 0, state: 'participating' as const, target: target(id), promptCount: 1 }))
  const operation = (threadId: string, patch: Partial<WatcherOperation>): WatcherOperation => ({ id: randomUUID(), requestId, retryKey: randomUUID(), digest: 'a'.repeat(64),
    action: 'send', target: target(threadId), generation: 0, delivery: 'now', deliveryState: 'accepted', createdAt: at(30), updatedAt: at(30), receiptId: randomUUID(), cardId: randomUUID(), ...patch })
  const github = (threadId: string, number: number, patch: Partial<WatcherEvidence>): WatcherEvidence => ({ id: randomUUID(), source: 'github', observedAt: at(5), target: target(threadId),
    freshness: 'fresh', availability: 'available', fact: 'checks-passed', url: `https://github.com/millZach/Sotto/pull/${number}`, pullRequestState: 'open', ...patch })
  const go = operation('visual-gate', { createdAt: at(4), updatedAt: at(4) })
  const checkIn = operation('footer-links', { deliveryState: 'dispatching', createdAt: at(0), updatedAt: at(0) })
  const nextTurn = operation('footer-links', { createdAt: at(0), updatedAt: at(0) })
  const evidence: Record<string, WatcherEvidence[]> = {
    'visual-gate': [github('visual-gate', 1291, { checksState: 'passed' })], 'footer-links': [github('footer-links', 1295, { checksState: 'passed' })],
    'benchmark': [github('benchmark', 1299, { checksState: 'pending' })], 'thread-routing': [github('thread-routing', 1288, { fact: 'merge-observed', pullRequestState: 'merged', observedAt: at(9) })],
  }
  const rows: WatcherRoomState['watchedThreads'] = WATCHED.map(({ id, settled }, index) => ({ target: target(id), title: id, watched: true, paused: false, status: 'running', connected: true,
    settled: settled === true, backgroundWorkCount: 0, waitsOn: [], participation: [participants[index]!], evidence: evidence[id] ?? [] }))
  const receipts = [...WATCHED.map(({ id }) => operation(id, { action: 'start', outcome: 'working', createdAt: at(200), updatedAt: at(200) })), go, checkIn]
  const seed: WatcherStandInSeed = {
    state: { current: identity, currentOptions: { modelId: 'codex:gpt', reasoningEffort: null, runtimeMode: 'approval-required', status: 'running', connected: true },
      history: [], runtimeMode: 'approval-required', ownChanges: [],
      standingWatches: WATCHED.map(({ id }) => ({ id: randomUUID(), target: target(id), createdAt: at(240), generation: 0 })),
      requests: [{ id: requestId, watcher: identity.target, rootUserMessageId: 'watcher-ask', state: 'active', createdAt: at(240), closedAt: null, participants }],
      watchedThreads: rows, receipts, news: [], recoveryNotice: null, observedAt: at(0) },
    created: identity,
    // #1295's turn is known from the start, as main remembers it once the send is admitted; it shows once its receipt does.
    mergeTurns: { status: 'ok', turns: [{ operationId: go.id, target: target('visual-gate'), pullRequest: 1291, at: at(4) },
      { operationId: nextTurn.id, target: target('footer-links'), pullRequest: 1295, at: at(0) }],
      queue: [{ target: target('visual-gate'), title: 'Visual gate flake', pullRequest: { number: 1291, state: 'open', checks: 'passed' }, checksPassedAt: at(40) },
        { target: target('footer-links'), title: 'Footer links', pullRequest: { number: 1295, state: 'open', checks: 'passed' }, checksPassedAt: at(12) }] },
    script: [
      { afterMs: 2_500, state: { receipts: [...receipts.slice(0, -1), { ...checkIn, deliveryState: 'accepted', updatedAt: at(0) }] } },
      { afterMs: 4_500, state: { receipts: [...receipts.slice(0, -1), { ...checkIn, deliveryState: 'accepted', outcome: 'answered', updatedAt: at(0) }],
        news: [{ id: randomUUID(), kind: 'needs-user', requestId, target: target('weekly-note'), generation: 0, observedAt: at(0), requestCardKind: 'question' }] } },
      { afterMs: 7_000, state: { receipts: [...receipts.slice(0, -1), { ...checkIn, deliveryState: 'accepted', outcome: 'answered', updatedAt: at(0) }, nextTurn] } },
    ],
  }
  await page.evaluate(async ({ key, seed, master, linked }) => {
    localStorage.setItem(key, JSON.stringify(seed))
    await window.sottoE2E!.agentEvent!({ type: 'history', threadId: master, text: '', status: 'running', messages: [
      { id: 'watcher-ask', role: 'user', text: 'Keep the perf batch moving and merge in turn. Tell me when a thread needs me.', createdAt: new Date(Date.UTC(2026, 6, 12, 15, 0)).toISOString() },
    ] })
    for (const [threadId, pullRequests] of linked) await window.sottoE2E!.agentEvent!({ type: 'pull-requests', threadId, text: '', pullRequests })
  }, { key: WATCHER_STAND_IN_KEY, seed, master: CURRENT, linked: WATCHED.filter(item => item.pullRequests).map(item => [item.id, item.pullRequests!] as const) })
  await page.reload()
  await openThreads(page)
}

async function openPicture(page: Page): Promise<void> {
  await page.getByRole('tablist', { name: 'Page' }).getByRole('tab', { name: 'Watcher', exact: true }).click()
  await page.getByRole('tab', { name: 'Visualize', exact: true }).click()
  await expect(page.getByRole('tabpanel', { name: 'Visualize' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Visual gate flake: / })).toBeVisible()
}

async function settle(page: Page): Promise<void> {
  await page.mouse.move(0, 0)
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
  })
}

/** Every piece of the picture's words against the surface it sits on, which must read at 4.5:1. */
async function pictureContrast(page: Page): Promise<Array<{ name: string; ratio: number }>> {
  const pairs = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 1; canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    const hex = (value: string, under = '#000000'): string => {
      context.fillStyle = under; context.fillRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1)
      return `#${[...context.getImageData(0, 0, 1, 1).data.slice(0, 3)].map(channel => channel.toString(16).padStart(2, '0')).join('')}`
    }
    const surface = (element: Element): string => {
      const layers: string[] = []
      for (let node: Element | null = element; node !== null; node = node.parentElement) {
        const color = getComputedStyle(node).backgroundColor
        if (color === 'rgba(0, 0, 0, 0)' || color === 'transparent') continue
        layers.push(color)
        if (!color.startsWith('rgba') && !color.includes(' / ')) break
      }
      return layers.reverse().reduce((under, color) => hex(color, under), hex(getComputedStyle(document.body).backgroundColor))
    }
    const shown = [...document.querySelectorAll('.watcher-picture :is(.watcher-picture__title, .watcher-picture__cluster-name, .watcher-picture__cluster-name b, .watcher-picture__pr, .watcher-picture__turn, .watcher-picture__bar-label, .watcher-picture__owl-name, .watcher-picture__owl-name span, .watcher-picture__you, .watcher-picture__you b, .watcher-picture__you span, .watcher-picture__settled, .watcher-picture__card p, .watcher-picture__card h3, .watcher-picture__card li, .watcher-picture__card time)')]
      .filter(element => (element as HTMLElement).offsetParent !== null && element.textContent?.trim())
    return shown.map(element => ({ name: `${element.className || element.tagName}: ${element.textContent!.trim().slice(0, 30)}`, text: hex(getComputedStyle(element).color, surface(element)), under: surface(element) }))
  })
  return pairs.map(pair => ({ name: pair.name, ratio: contrastRatio(parseThemeRgb(pair.text, { r: 0, g: 0, b: 0 }), parseThemeRgb(pair.under, { r: 0, g: 0, b: 0 })) }))
}

async function capture(launched: LaunchedSotto, name: string): Promise<void> {
  const { page } = launched
  await settle(page)
  expect(await pageBoundProblems(page)).toEqual([])
  expect((await pictureContrast(page)).filter(item => item.ratio < 4.5)).toEqual([])
  await page.screenshot({ path: join(evidence, `${name}.png`), animations: 'disabled' })
}

test.describe("Watcher's picture on the built app", () => {
  test.beforeAll(async () => { await mkdir(evidence, { recursive: true }) })

  for (const [appearance, theme] of [['dark', 't3-code'], ['light', 't3-code'], ['dark', 'tropic']] as const) {
    test(`draws the constellation at every window size, ${appearance} ${theme}`, async () => {
      await onReleaseTrack('owl', () => withSotto(launchOptions(appearance, theme, 'reduced'), async launched => {
        const { page } = launched
        await seedPicture(page)
        await openPicture(page)
        // The merge turns along the top: merged, the turn given, then the queue.
        await expect(page.getByRole('list', { name: 'Merge turns' }).getByRole('button')).toHaveText(['#1288 MERGED', '#1291 GO MERGE', '#1295 READY TO MERGE'])
        for (const [width, height] of SIZES) {
          await resizeContentWindow(launched, width, height, [800, 540])
          // Every watched thread that is not settled is on screen, each on its own line.
          for (const title of ['Visual gate flake', 'Footer links', 'Weekly note', 'Streaming WAV stall', 'Thread routing', 'Benchmark rerun', 'Grok voice previews']) {
            await expect(page.getByRole('button', { name: new RegExp(`^${title}: `) })).toBeInViewport()
          }
          await capture(launched, `${theme === 't3-code' ? 'sotto' : theme}-${appearance}-${width}x${height}`)
        }
        // A thread's card, at the smallest window.
        await page.getByRole('button', { name: /^Visual gate flake: / }).click()
        await expect(page.getByRole('dialog', { name: 'Visual gate flake, details' })).toBeVisible()
        await capture(launched, `${theme === 't3-code' ? 'sotto' : theme}-${appearance}-card-820x560`)
      }))
    })
  }

  test('moves messages as they happen, keeps one line of composer, and is worked from the keyboard', async () => {
    await onReleaseTrack('owl', () => withSotto(launchOptions('dark'), async launched => {
      const { page } = launched
      await seedPicture(page)
      await resizeContentWindow(launched, 1280, 800, [800, 540])
      await openPicture(page)
      // The check-in is delivered: a blob travels from Watcher to Footer links. Caught mid-flight.
      await expect(page.locator('.watcher-picture__blob .watcher-picture__shape[data-kind="steer"]')).toHaveCount(1, { timeout: 10_000 })
      await page.waitForTimeout(450)
      await page.screenshot({ path: join(evidence, 'sotto-dark-blob-1280x800.png') })
      // Then Weekly note asks the user: a question goes to You with its tag.
      await expect(page.locator('.watcher-picture__blob .watcher-picture__tag', { hasText: 'Question' })).toBeVisible({ timeout: 10_000 })
      await page.screenshot({ path: join(evidence, 'sotto-dark-question-1280x800.png') })
      // And #1295 gets its merge turn: GO MERGE travels to Footer links.
      await expect(page.locator('.watcher-picture__blob .watcher-picture__tag', { hasText: 'GO MERGE #1295' })).toBeVisible({ timeout: 10_000 })
      await page.waitForTimeout(300)
      await page.screenshot({ path: join(evidence, 'sotto-dark-go-merge-1280x800.png') })
      await expect(page.getByRole('list', { name: 'Merge turns' }).getByRole('button')).toHaveText(['#1288 MERGED', '#1291 GO MERGE', '#1295 GO MERGE'])

      // One line of composer while the picture shows, and all of it back with focus.
      const prompt = page.locator('.watcher-pane .thread-workspace__compose .thread-prompt')
      const short = (await prompt.boundingBox())!.height
      expect(short).toBeLessThan(56)
      await page.getByRole('textbox', { name: 'Watcher message', exact: true }).focus()
      await expect.poll(async () => (await prompt.boundingBox())!.height).toBeGreaterThan(short + 30)

      // From the keyboard: the tabs, then into the picture, a card, and Escape back to the thread.
      await page.getByRole('tab', { name: 'Visualize', exact: true }).focus()
      await page.keyboard.press('ArrowLeft')
      await expect(page.getByRole('tab', { name: /^Watched, / })).toHaveAttribute('aria-selected', 'true')
      await page.keyboard.press('ArrowRight')
      await expect(page.getByRole('tab', { name: 'Visualize', exact: true })).toHaveAttribute('aria-selected', 'true')
      const node = page.getByRole('button', { name: /^Streaming WAV stall: / })
      await node.focus()
      await page.keyboard.press('Enter')
      const card = page.getByRole('dialog', { name: 'Streaming WAV stall, details' })
      await expect(card).toBeVisible()
      await expect(card.getByRole('button', { name: 'Close details' })).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(card).toBeHidden()
      await expect(node).toBeFocused()
      // Settled threads come back on asking.
      await page.getByRole('button', { name: 'Show 1 settled' }).click()
      await expect(page.getByRole('button', { name: /^Notes cleanup: .*settled\. Show details$/ })).toBeVisible()
    }))
  })

  test('with reduced motion nothing travels: a still mark stands beside the thread, clear of its title', async () => {
    await onReleaseTrack('owl', () => withSotto(launchOptions('dark', 't3-code', 'reduced'), async launched => {
      const { page } = launched
      await page.evaluate(async () => window.sotto!.updateSettings({ reducedMotion: 'on' }))
      await seedPicture(page)
      await resizeContentWindow(launched, 1280, 800, [800, 540])
      await openPicture(page)
      const mark = page.locator('.watcher-picture__mark')
      await expect(mark.first()).toBeVisible({ timeout: 10_000 })
      await expect(page.locator('.watcher-picture__blob')).toHaveCount(0)
      const title = (await page.getByRole('button', { name: /^Footer links: / }).locator('.watcher-picture__title').boundingBox())!
      const still = (await mark.first().boundingBox())!
      const overlaps = still.x < title.x + title.width && title.x < still.x + still.width && still.y < title.y + title.height && title.y < still.y + still.height
      expect(overlaps, 'the mark sits beside the title, not over it').toBe(false)
      await page.screenshot({ path: join(evidence, 'sotto-dark-reduced-motion-1280x800.png'), animations: 'disabled' })
    }))
  })
})
