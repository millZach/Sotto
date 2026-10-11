import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import { E2E_THREADS_NOW } from '../../src/shared/e2e'
import { contrastRatio, parseThemeRgb } from '../../src/shared/themes/color'
import { WATCHER_STAND_IN_KEY, type WatcherStandInSeed } from '../../src/renderer/src/e2e/watcherStandIn'
import { withSotto } from '../fixtures/designCaptureProfile'
import { evidenceDirectory } from '../fixtures/evidence'
import { pageBoundProblems } from './support/designCapture'
import { onReleaseTrack } from './support/releaseTrack'
import { captureWindow } from './support/sottoCapture'
import { openPage, openThreads, type LaunchedSotto } from './support/sottoLaunch'
import { holdOwlSky } from './support/sottoOwl'
import { resizeContentWindow } from './support/sottoWindow'

/**
 * Watcher's room on the built app (ADR-0073, ticket 6): the owl in the room switch, the first entry, the Overview,
 * the badge on watched threads, Threads in flight, and the three-room keyboard path, on the Sotto Owl track, with
 * stable showing none of it. Main's Watcher side is stood in for by a seeded projection
 * (src/renderer/src/e2e/watcherStandIn.ts), so these runs check the room, not main. Run after `npm run build`.
 * Captures go to disposable run evidence; `SOTTO_E2E_EVIDENCE=publish` writes artifacts/watcher-room.
 */
const evidenceRoot = evidenceDirectory('artifacts/watcher-room')
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const
const THEMES = [['t3-code', 'sotto'], ['tropic', 'tropic']] as const
const BLACK = { r: 0, g: 0, b: 0 }
const MASTER = 'release-notes'
const WATCHED = ['visual-gate', 'footer-links'] as const
const recorded = new Map<string, unknown>()

const at = (minutes: number): string => new Date(E2E_THREADS_NOW - minutes * 60_000).toISOString()

function launchOptions(theme: string, appearance: 'dark' | 'light', motion: 'normal' | 'reduced' = 'normal') {
  return {
    onboardingComplete: true, appearance, motion, scenario: 'design-threads', agents: 'design-threads',
    ...(appearance === 'dark' ? { darkTheme: theme } : { lightTheme: theme }),
  } as const
}

/**
 * Seeds Watcher's projection and reloads: `release-notes` stands for the current Watcher (its history replaced by a
 * Watcher conversation), Watcher started and watches Visual gate flake and Footer links, and two threads are in flight.
 * With `current: false`, the room opens on its first entry and `open` names that same thread as the one created.
 */
async function seedRoom(page: Page, options: { readonly current: boolean }): Promise<void> {
  const hostId = await page.evaluate(async () => (await window.sotto!.agents!.get()).hostId)
  expect(hostId, 'the window names its host').toBeTruthy()
  const target = (threadId: string) => ({ hostId: hostId!, threadId })
  const requestId = randomUUID()
  const identity = { target: target(MASTER), projectId: 'workshop', provider: 'codex' as const, creationOperationId: randomUUID(), createdAt: at(12) }
  const participants = WATCHED.map(threadId => ({ requestId, startedBy: 'watcher' as const, generation: 0, state: 'participating' as const, target: target(threadId), promptCount: 1 }))
  const seed: WatcherStandInSeed = {
    state: {
      current: options.current ? identity : null,
      currentOptions: options.current ? { modelId: 'codex:gpt', reasoningEffort: null, status: 'idle', connected: true } : null,
      history: [],
      requests: options.current ? [{ id: requestId, watcher: identity.target, rootUserMessageId: 'watcher-ask', state: 'active', createdAt: at(12), closedAt: null, participants }] : [],
      watchedThreads: options.current ? participants.map(part => ({ target: part.target, title: part.target.threadId, status: 'running' as const, connected: true,
        settled: false, backgroundWorkCount: 0, waitsOn: [], participation: [part] })) : [],
      inFlight: options.current ? 2 : 0, inFlightLimit: 4, receipts: [], recoveryNotice: null, observedAt: at(0),
    },
    created: identity,
  }
  await page.evaluate(async ({ key, seed, master }) => {
    localStorage.setItem(key, JSON.stringify(seed))
    await window.sottoE2E!.agentEvent!({ type: 'history', threadId: master, text: '', messages: [
      { id: 'watcher-ask', role: 'user', text: 'Find why the visual gate flakes and fix the footer links. Keep an eye on both.', createdAt: new Date(Date.UTC(2026, 6, 12, 19, 29)).toISOString() },
      { id: 'watcher-reply', role: 'assistant', text: 'Started Visual gate flake on Claude Code and Footer links on Codex, and I am watching both. Visual gate flake is asking to run the unit suite. Only you can allow that, in its own pane.', createdAt: new Date(Date.UTC(2026, 6, 12, 19, 33)).toISOString() },
    ] })
  }, { key: WATCHER_STAND_IN_KEY, seed, master: MASTER })
  await page.reload()
  await openThreads(page)
}

const switchTab = (page: Page, name: 'Dictate' | 'Watcher' | 'Threads') => page.getByRole('tablist', { name: 'Page' }).getByRole('tab', { name, exact: true })

async function openRoom(page: Page): Promise<void> {
  await switchTab(page, 'Watcher').click()
  await expect(page.getByRole('complementary', { name: 'Overview' })).toBeVisible()
}

async function settle(page: Page): Promise<void> {
  await page.mouse.move(0, 0)
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
  })
}

/** Every piece of text the room draws in colour, measured against the surface it actually sits on. */
async function roomContrast(page: Page): Promise<Array<{ name: string; ratio: number }>> {
  const pairs = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 1; canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    const hex = (value: string): string => {
      context.clearRect(0, 0, 1, 1); context.fillStyle = 'rgba(0, 0, 0, 0)'; context.fillStyle = value; context.fillRect(0, 0, 1, 1)
      return `#${[...context.getImageData(0, 0, 1, 1).data.slice(0, 3)].map(channel => channel.toString(16).padStart(2, '0')).join('')}`
    }
    const token = (holder: Element, name: string): string => {
      const probe = document.createElement('i')
      probe.style.cssText = `position:absolute;width:1px;height:1px;background:var(${name})`
      holder.append(probe)
      const value = getComputedStyle(probe).backgroundColor
      probe.remove()
      return hex(value)
    }
    const surface = (element: Element): string => {
      for (let node: Element | null = element; node !== null; node = node.parentElement) {
        // An Owl sidebar paints its night band as a gradient: the band behind its first rows, the sidebar below.
        if (node.matches('.thread-nav[data-sky]')) return token(node, element.getBoundingClientRect().top - node.getBoundingClientRect().top < 84 ? '--tt-owl-night' : '--threads-sidebar')
        const color = getComputedStyle(node).backgroundColor
        if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') return hex(color)
      }
      return hex(getComputedStyle(document.body).backgroundColor)
    }
    const selectors = ['.watcher-overview__heading', '.watcher-overview__total', '.watcher-group__toggle', '.watcher-group__count', '.watcher-row__title',
      '.watcher-row__status', '.watcher-row__where', '.watcher-row__asks', '.thread-nav__time', '.watcher-head h2', '.watcher-meter', '.thread-options__pinned']
    return selectors.flatMap(selector => [...document.querySelectorAll(selector)].filter(element => element.getClientRects().length > 0).slice(0, 6)
      .map((element, index) => ({ name: `${selector} ${index}${element.getAttribute('data-tone') ? ` (${element.getAttribute('data-tone')})` : ''}`, ink: hex(getComputedStyle(element).color), on: surface(element) })))
  })
  return pairs.map(({ name, ink, on }) => ({ name, ratio: Number(contrastRatio(parseThemeRgb(ink, BLACK), parseThemeRgb(on, BLACK)).toFixed(2)) }))
}

async function capture(launched: LaunchedSotto, name: string): Promise<void> {
  await settle(launched.page)
  await holdOwlSky(launched.page)
  await captureWindow(launched.app, resolve(evidenceRoot, name))
}

test.describe("Watcher's room on the built app", () => {
  test.describe.configure({ mode: 'serial', timeout: 5 * 60_000 })
  test.beforeAll(async () => { await mkdir(evidenceRoot, { recursive: true }) })
  test.afterAll(async () => { await writeFile(resolve(evidenceRoot, 'readings.json'), `${JSON.stringify(Object.fromEntries(recorded), null, 2)}\n`, 'utf8') })

  test('first entry starts Watcher on a chosen model and opens its own pane', async () => {
    await onReleaseTrack('owl', () => withSotto(launchOptions('t3-code', 'dark'), async (launched) => {
      const { page } = launched
      await openThreads(page)
      await seedRoom(page, { current: false })
      await resizeContentWindow(launched, 1280, 800)
      await openRoom(page)
      await expect(page.getByRole('heading', { level: 2, name: 'Start Watcher' })).toBeVisible()
      const choice = page.getByRole('group', { name: 'Watcher’s model' })
      await expect(choice.getByRole('combobox', { name: 'Thread model' })).toHaveText(/Sonnet 4\.5/)
      // Devin is not offered for Watcher, and nothing in the room was selected on the Threads page.
      await choice.getByRole('combobox', { name: 'Thread model' }).click()
      await expect(page.getByRole('dialog', { name: 'Choose model' }).getByRole('option', { name: /Devin/ })).toHaveCount(0)
      await page.keyboard.press('Escape')
      expect(await pageBoundProblems(page)).toEqual([])
      await capture(launched, 'first-entry-sotto-dark-1280x800.png')
      await page.getByRole('button', { name: 'Start Watcher' }).click()
      const pane = page.getByRole('region', { name: 'Watcher', exact: true })
      await expect(pane).toBeVisible()
      await expect(pane.getByRole('heading', { level: 2, name: 'Watcher' })).toBeVisible()
      await expect(pane.getByRole('textbox', { name: 'Watcher message' })).toBeVisible()
      await expect(pane.getByText('Ask before changes')).toBeVisible()
      await expect(pane.getByRole('combobox', { name: 'Thread permissions' })).toHaveCount(0)
      expect(await page.evaluate(async () => (await window.sotto!.agents!.get()).activeThreadId)).toBeNull()
    }))
  })

  test('Overview, badges and Threads in flight, with Watcher kept out of Threads', async () => {
    await onReleaseTrack('owl', () => withSotto(launchOptions('t3-code', 'dark'), async (launched) => {
      const { page } = launched
      await openThreads(page)
      await seedRoom(page, { current: true })
      await resizeContentWindow(launched, 1600, 1000)
      // On Threads: the owl after a watched thread's provider logo, its pane says what a send does, and Watcher is not listed.
      const threads = page.getByRole('complementary', { name: 'Thread sidebar' })
      await threads.getByRole('button', { name: /^Settled/ }).click()
      await expect(threads.getByRole('button', { name: 'Benchmark rerun', exact: true })).toBeVisible()
      await expect(threads.getByRole('button', { name: 'Release notes 1.4', exact: true })).toHaveCount(0)
      await threads.getByRole('button', { name: /^Settled/ }).click()
      const footer = threads.getByRole('button', { name: 'Footer links', exact: true })
      await expect(footer.getByRole('img', { name: 'Watched by Watcher' })).toHaveAttribute('title', 'Watched by Watcher')
      await expect(threads.getByRole('button', { name: 'Weekly note', exact: true }).getByRole('img', { name: 'Watched by Watcher' })).toHaveCount(0)
      await footer.click()
      const workerPane = page.getByRole('region', { name: 'Footer links' })
      await expect(workerPane.getByRole('img', { name: 'Watched by Watcher' })).toBeVisible()
      await expect(workerPane.getByText('Watched by Watcher. If you send here, Watcher stops sending to it.')).toBeVisible()
      await capture(launched, 'threads-watched-sotto-dark-1600x1000.png')
      await resizeContentWindow(launched, 1280, 800)
      expect(await pageBoundProblems(page)).toEqual([])
      await capture(launched, 'threads-watched-sotto-dark-1280x800.png')
      await resizeContentWindow(launched, 1600, 1000)

      await openRoom(page)
      const overview = page.getByRole('complementary', { name: 'Overview' })
      await expect(overview.getByRole('heading', { level: 2, name: 'Overview' })).toBeVisible()
      await expect(overview.getByRole('button', { name: 'Needs you, 2 threads' })).toHaveAttribute('aria-expanded', 'true')
      expect(await overview.locator('.watcher-group__toggle').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))))
        .toEqual(['Needs you, 2 threads', 'Working, 2 threads', 'Idle, 4 threads'])
      await expect(overview.locator('.watcher-row').filter({ hasText: 'Release notes 1.4' })).toHaveCount(0)
      await expect(overview.locator('.watcher-row').filter({ hasText: 'Visual gate flake' }).getByRole('img', { name: 'Watched by Watcher' })).toBeVisible()
      const pane = page.getByRole('region', { name: 'Watcher', exact: true })
      await expect(pane.getByRole('meter', { name: 'Watched threads' })).toHaveAttribute('aria-valuetext', '2 of 4 watched')
      await expect(pane.getByText('Only you can allow that, in its own pane.')).toBeVisible()

      // Threads in flight saves the real setting.
      const more = pane.getByRole('button', { name: 'More Watcher actions' })
      await more.click()
      const limit = page.getByRole('dialog', { name: 'Watcher settings' }).getByRole('combobox', { name: 'Threads in flight' })
      await expect(limit).toBeFocused()
      await limit.selectOption('3')
      await expect(pane.getByRole('meter', { name: 'Watched threads' })).toHaveAttribute('aria-valuetext', '2 of 3 watched')
      await expect.poll(() => page.evaluate(async () => (await window.sotto!.getSettings()).watcherInFlightLimit)).toBe(3)
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog', { name: 'Watcher settings' })).toHaveCount(0)
      await expect(more).toBeFocused()
      recorded.set('limit', { saved: await page.evaluate(async () => (await window.sotto!.getSettings()).watcherInFlightLimit) })
    }))
  })

  test('the three rooms answer the keyboard from every page, and focus follows the switch', async () => {
    await onReleaseTrack('owl', () => withSotto(launchOptions('t3-code', 'dark'), async (launched) => {
      const { page } = launched
      await openThreads(page)
      await seedRoom(page, { current: true })
      await resizeContentWindow(launched, 1280, 800)
      const tabs = page.getByRole('tablist', { name: 'Page' }).getByRole('tab')
      await expect(tabs).toHaveCount(3)
      expect(await tabs.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label') ?? node.textContent))).toEqual(['Dictate', 'Watcher', 'Threads'])
      await expect(switchTab(page, 'Watcher')).toHaveAttribute('title', 'Watcher')
      const press = async (key: string, room: 'Dictate' | 'Watcher' | 'Threads'): Promise<void> => {
        await page.keyboard.press(key)
        await expect(switchTab(page, room)).toHaveAttribute('aria-selected', 'true')
        await expect(switchTab(page, room)).toBeFocused()
      }
      await switchTab(page, 'Threads').focus()
      await press('ArrowLeft', 'Watcher')
      await expect(page.getByRole('region', { name: 'Watcher', exact: true })).toBeVisible()
      await press('ArrowLeft', 'Dictate')
      await press('End', 'Threads')
      await press('Home', 'Dictate')
      await press('ArrowRight', 'Watcher')
      // Only the lit tab is in the Tab order. From it, Tab follows the eye: the foot, the room's header, its conversation, its composer.
      const order: string[] = []
      for (let step = 0; step < 40 && !order.includes('Watcher message'); step++) {
        await page.keyboard.press('Tab')
        order.push(await page.evaluate(() => {
          const element = document.activeElement as HTMLElement
          return element.getAttribute('aria-label') ?? element.getAttribute('title') ?? element.textContent?.trim().slice(0, 30) ?? element.tagName
        }))
      }
      expect(order.slice(0, 3)).toEqual(['History', 'Settings', 'Help'])
      expect(order.indexOf('More Watcher actions')).toBeGreaterThan(order.indexOf('Resize sidebar'))
      expect(order.indexOf('Watcher message')).toBeGreaterThan(order.indexOf('More Watcher actions'))
      recorded.set('tab-order', order)
      for (const name of ['Settings', 'Help', 'History'] as const) {
        await openPage(page, name)
        await expect(switchTab(page, 'Dictate')).toHaveAttribute('tabindex', '0')
        await switchTab(page, 'Dictate').focus()
        await press('ArrowRight', 'Watcher')
        await press('End', 'Threads')
      }
    }))
  })

  for (const [theme, label] of THEMES) for (const appearance of ['dark', 'light'] as const) {
    test(`the room at three sizes, ${label}, ${appearance}`, async () => {
      await onReleaseTrack('owl', () => withSotto(launchOptions(theme, appearance), async (launched) => {
        const { page } = launched
        await openThreads(page)
        await seedRoom(page, { current: true })
        await openRoom(page)
        const readings: Record<string, unknown> = {}
        for (const [width, height] of SIZES) {
          await resizeContentWindow(launched, width, height)
          await settle(page)
          expect(await pageBoundProblems(page)).toEqual([])
          // The composer and the header's controls stay inside the window at every size.
          for (const name of ['Watcher message', 'More Watcher actions']) {
            const box = await page.getByRole(name === 'Watcher message' ? 'textbox' : 'button', { name }).boundingBox()
            expect(box, name).not.toBeNull()
            expect(box!.y + box!.height, `${name} at ${width}x${height}`).toBeLessThanOrEqual(height)
            expect(box!.x + box!.width, `${name} at ${width}x${height}`).toBeLessThanOrEqual(width)
          }
          const contrast = await roomContrast(page)
          for (const { name, ratio } of contrast) expect(ratio, `${name} at ${width}x${height}`).toBeGreaterThanOrEqual(4.5)
          readings[`${width}x${height}`] = contrast
          await capture(launched, `room-${label}-${appearance}-${width}x${height}.png`)
        }
        recorded.set(`room-${label}-${appearance}`, readings)
      }))
    })
  }

  test('the room with reduced motion, from the system and from Sotto’s own setting', async () => {
    await onReleaseTrack('owl', async () => {
      for (const motion of ['normal', 'reduced'] as const) await withSotto(launchOptions('t3-code', 'dark', motion), async (launched) => {
        const { page } = launched
        if (motion === 'normal') await page.emulateMedia({ reducedMotion: 'reduce' })
        await openThreads(page)
        await seedRoom(page, { current: true })
        if (motion === 'normal') await page.emulateMedia({ reducedMotion: 'reduce' })
        await openRoom(page)
        await resizeContentWindow(launched, 1280, 800)
        await settle(page)
        const working = page.locator('.watcher-row__ring[data-tone="working"]').first()
        await expect(working).toBeVisible()
        expect(await working.evaluate(node => node.getAnimations().length)).toBe(0)
        await capture(launched, `room-sotto-dark-1280x800-reduced-motion-${motion === 'normal' ? 'system' : 'setting'}.png`)
      })
    })
  })

  test('stable shows nothing of Watcher, even with a projection seeded', async () => {
    await onReleaseTrack('stable', () => withSotto(launchOptions('t3-code', 'dark'), async (launched) => {
      const { page } = launched
      await openThreads(page)
      await seedRoom(page, { current: true })
      await expect(page.getByRole('tablist', { name: 'Page' }).getByRole('tab')).toHaveCount(2)
      await expect(switchTab(page, 'Watcher')).toHaveCount(0)
      await expect(page.getByRole('img', { name: 'Watched by Watcher' })).toHaveCount(0)
      await expect(page.getByText(/If you send here, Watcher stops sending to it/)).toHaveCount(0)
      // Stable lists the thread the projection names as Watcher, since stable has no Watcher to give it to.
      const threads = page.getByRole('complementary', { name: 'Thread sidebar' })
      await threads.getByRole('button', { name: /^Settled/ }).click()
      await expect(threads.getByRole('button', { name: 'Release notes 1.4', exact: true })).toHaveCount(1)
    }))
  })
})
