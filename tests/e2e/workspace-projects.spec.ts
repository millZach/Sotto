import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { defaultAgentConfiguration } from '../../src/shared/agents'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { closeSotto, firstSottoWindow, launchSotto, openThreads, type LaunchedSotto, userMessageTexts } from './support/sottoLaunch'

const ARTIFACTS = 'artifacts/phase1-workspace'
// A 1x1 PNG: enough for the real attachment validation path.
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

async function ownedProfile(prefix: string): Promise<string> {
  const profile = await mkdtemp(join(tmpdir(), prefix))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true }))
  return profile
}

async function connectAndOpenThreads(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.sotto!.updateSettings({ onboardingComplete: true })
    await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
    await window.sotto!.agents!.command({ type: 'connect' })
  })
  await page.reload()
  await openThreads(page)
}

async function resize(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!
    window.setMinimumSize(760, 600); window.setSize(size.width, size.height)
  }, { width, height })
  // Fractional display scaling rounds the CSS viewport by a pixel or two.
  await expect.poll(async () => Math.abs(await launched.page.evaluate(() => innerWidth) - width)).toBeLessThanOrEqual(2)
}

/** Nothing on the Threads page scrolls sideways or clips its status line at this width. */
async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.threads-view, .thread-nav, .thread-workspace, .thread-prompt')]
    .filter(element => element.scrollWidth > element.clientWidth + 1).map(element => element.className))
  expect(overflow).toEqual([])
}

const percentile = (values: readonly number[], fraction: number): number => {
  const sorted = [...values].sort((first, second) => first - second)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!
}

test('Enter shows the local pending message within 100 ms, measured apart from provider latency', async () => {
  const launched = await launchSotto()
  const { page } = launched
  try {
    await connectAndOpenThreads(page)
    await page.getByRole('button', { name: 'Workshop', exact: true }).click()
    const prompt = page.getByRole('textbox', { name: 'Prompt', exact: true })
    await page.evaluate(() => {
      const samples: { typing: number[]; send: { dom: number; frame: number }[] } = { typing: [], send: [] }
      ;(window as unknown as { __workspaceTiming: typeof samples }).__workspaceTiming = samples
      // Capture phase on the document runs before React's root listener sees the key.
      document.addEventListener('keydown', event => {
        const target = event.target as HTMLElement
        if (target.id !== 'thread-workspace-prompt') return
        const started = performance.now()
        if (event.key !== 'Enter' || event.shiftKey) {
          const before = (target as HTMLTextAreaElement).value
          requestAnimationFrame(() => { if ((target as HTMLTextAreaElement).value !== before) samples.typing.push(performance.now() - started) })
          return
        }
        const existing = document.querySelectorAll('[aria-label="Pending message"]').length
        const observer = new MutationObserver(() => {
          if (document.querySelectorAll('[aria-label="Pending message"]').length <= existing) return
          observer.disconnect()
          const dom = performance.now() - started
          requestAnimationFrame(() => samples.send.push({ dom, frame: performance.now() - started }))
        })
        observer.observe(document.body, { childList: true, subtree: true })
        setTimeout(() => observer.disconnect(), 2_000)
      }, true)
    })
    const rounds = 10
    for (let round = 0; round < rounds; round += 1) {
      await prompt.click()
      await page.keyboard.type(`Round ${round} check`, { delay: 15 })
      await page.keyboard.press('Enter')
      await expect(page.getByLabel('Thread transcript')).toContainText(`Round ${round} check`)
      await expect(prompt).toHaveValue('')
      // The press is the feedback; the provider holds the prompt a moment later, and a reply before that would answer nothing.
      await expect.poll(() => userMessageTexts(page, 'workshop')).toContain(`Round ${round} check`)
      await page.evaluate(async index => window.sottoE2E!.agentEvent!({ type: 'ready', threadId: 'workshop', text: `Done with round ${index}.` }), round)
      await expect(page.getByLabel('Thread transcript')).toContainText(`Done with round ${round}.`)
    }
    const timing = await page.evaluate(() => (window as unknown as { __workspaceTiming: { typing: number[]; send: { dom: number; frame: number }[] } }).__workspaceTiming)
    const deliveries = (await page.evaluate(async () => (await window.sotto!.agents!.get()).deliveries ?? []))
      .filter(delivery => delivery.threadId === 'workshop')
    const report = {
      scenario: 'success (deterministic E2E provider host, Windows Electron)',
      rounds,
      localAcknowledgement: {
        definition: 'Enter keydown (document capture phase) to the pending message in the DOM, and to the next animation frame after it',
        domMs: { p50: percentile(timing.send.map(sample => sample.dom), 0.5), max: Math.max(...timing.send.map(sample => sample.dom)) },
        nextFrameMs: { p50: percentile(timing.send.map(sample => sample.frame), 0.5), p95: percentile(timing.send.map(sample => sample.frame), 0.95), max: Math.max(...timing.send.map(sample => sample.frame)) },
        samples: timing.send,
      },
      typingNextFrameMs: { count: timing.typing.length, p50: percentile(timing.typing, 0.5), p95: percentile(timing.typing, 0.95), max: Math.max(...timing.typing) },
      controller: {
        definition: 'deliveries[].localFeedbackMs (main-process receipt to queued publish) and providerLatencyMs (provider dispatch), reported by the backend',
        localFeedbackMs: deliveries.map(delivery => delivery.localFeedbackMs ?? null),
        providerLatencyMs: deliveries.map(delivery => delivery.providerLatencyMs ?? null),
        statuses: deliveries.map(delivery => delivery.status),
      },
    }
    await mkdir(ARTIFACTS, { recursive: true })
    await writeFile(join(ARTIFACTS, 'local-acknowledgement.json'), `${JSON.stringify(report, null, 2)}\n`)
    console.log(JSON.stringify({ nextFrameMs: report.localAcknowledgement.nextFrameMs, domMs: report.localAcknowledgement.domMs, typingNextFrameMs: report.typingNextFrameMs }))
    expect(timing.send).toHaveLength(rounds)
    expect(report.localAcknowledgement.nextFrameMs.max).toBeLessThan(100)
    expect(report.typingNextFrameMs.p95).toBeLessThan(100)
  } finally { await closeSotto(launched) }
})

test('project folders hold several threads, settle and restore threads and projects, and drafts survive a restart', async () => {
  const profile = await ownedProfile('sotto-e2e-workspace-projects-')
  const folder = await mkdtemp(join(tmpdir(), 'sotto-workspace-folder-'))
  const title = basename(folder)
  let launched = await launchSotto('success', profile)
  try {
    let { page } = launched
    await connectAndOpenThreads(page)
    const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
    await expect(sidebar.getByRole('region', { name: 'Projects' }).getByRole('button', { name: /^Sotto test/ })).toBeVisible()

    // Open a folder as a project (the native folder picker is outside the test), then start threads in it.
    const created = await page.evaluate(async path => window.sotto!.agents!.command({ type: 'create-project', title: path.split(/[\\/]/).at(-1)!, path, useExisting: true }), folder)
    expect(created.error).toBeNull()
    const projectFolder = sidebar.getByRole('region', { name: 'Projects' }).getByRole('button', { name: new RegExp(`^${title}`) })
    await expect(projectFolder).toBeVisible()
    for (const name of ['Plan the release', 'Fix the footer']) {
      await sidebar.getByRole('button', { name: `New thread in ${title}` }).click()
      const dialog = page.getByRole('dialog', { name: 'New thread' })
      await dialog.getByLabel('Thread name').fill(name)
      await dialog.getByRole('button', { name: /Create thread/ }).click()
      await expect(dialog).toHaveCount(0)
      await expect(sidebar.getByRole('button', { name, exact: true })).toBeVisible()
    }
    await expect(projectFolder).toHaveAccessibleName(new RegExp(`^${title}.*2 threads`))
    await sidebar.getByRole('button', { name: 'Plan the release', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Plan the release', exact: true })).toBeVisible()
    const unstarted = await page.evaluate(async () => (await window.sotto!.agents!.get()).host.threads.find(thread => thread.title === 'Plan the release')!)
    expect(unstarted.nativeSessionStarted).toBe(false)
    // An unstarted thread can still change its model from the composer's model chip.
    await expect(page.getByRole('combobox', { name: 'Thread model' })).toBeEnabled()
    await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Outline the release steps.')
    await page.keyboard.press('Enter')
    await expect(page.getByLabel('Thread transcript')).toContainText('Outline the release steps.')
    await expect.poll(async () => (await page.evaluate(async () => (await window.sotto!.agents!.get()).host.threads.find(thread => thread.title === 'Plan the release')!)).nativeSessionStarted).toBe(true)
    expect(await page.evaluate(async () => (await window.sotto!.agents!.get()).assignments)).toHaveLength(0)
    await mkdir(ARTIFACTS, { recursive: true })
    await page.screenshot({ animations: 'disabled', path: join(ARTIFACTS, 'projects-desktop.png') })

    // Settle one thread: it moves to Settled under its own project, then comes back.
    const footerRow = sidebar.getByRole('region', { name: 'Projects' }).locator('.thread-nav__row', { has: page.getByRole('button', { name: 'Fix the footer', exact: true }) })
    await footerRow.hover()
    await footerRow.getByRole('button', { name: 'Settle Fix the footer' }).click()
    await expect(sidebar.getByRole('region', { name: 'Projects' }).getByRole('button', { name: 'Fix the footer', exact: true })).toHaveCount(0)
    await sidebar.getByRole('button', { name: /^Settled/ }).click()
    const settled = sidebar.getByRole('region', { name: 'Settled' })
    await expect(settled.getByRole('button', { name: new RegExp(`^${title}`) })).toBeVisible()
    await page.screenshot({ animations: 'disabled', path: join(ARTIFACTS, 'settled-thread.png') })

    // Settle the whole project: every thread follows; restoring the project keeps the thread's own settlement.
    await sidebar.getByRole('button', { name: `Settle project ${title}` }).click()
    await expect(sidebar.getByRole('region', { name: 'Projects' }).getByRole('button', { name: new RegExp(`^${title}`) })).toHaveCount(0)
    await expect(settled.getByRole('button', { name: 'Plan the release', exact: true })).toBeVisible()
    await settled.getByRole('button', { name: `Restore project ${title}` }).click()
    await expect(sidebar.getByRole('region', { name: 'Projects' }).getByRole('button', { name: 'Plan the release', exact: true })).toBeVisible()
    await expect(settled.getByRole('button', { name: 'Fix the footer', exact: true })).toBeVisible()
    const restoreRow = settled.locator('.thread-nav__row', { has: page.getByRole('button', { name: 'Fix the footer', exact: true }) })
    await restoreRow.hover()
    await restoreRow.getByRole('button', { name: 'Restore Fix the footer' }).click()
    await expect(sidebar.getByRole('region', { name: 'Projects' }).getByRole('button', { name: 'Fix the footer', exact: true })).toBeVisible()

    // Text and screenshot drafts belong to their threads and survive navigation and a restart.
    await sidebar.getByRole('button', { name: 'Docs', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Docs', exact: true })).toBeVisible()
    const prompt = page.getByRole('textbox', { name: 'Prompt', exact: true })
    await prompt.fill('Docs draft kept across a restart.')
    await page.getByLabel('Screenshot files').setInputFiles({ name: 'docs-shot.png', mimeType: 'image/png', buffer: PIXEL })
    await expect(page.getByRole('img', { name: 'docs-shot.png' })).toBeVisible()
    await sidebar.getByRole('button', { name: 'Workshop', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Workshop', exact: true })).toBeVisible()
    await expect(prompt).toHaveValue('')
    await prompt.fill('Workshop line one')
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.type('line two')
    await expect(prompt).toHaveValue('Workshop line one\nline two')
    await expect.poll(async () => (await page.evaluate(async () => (await window.sotto!.agents!.get()).threadDrafts ?? []))
      .map(draft => [draft.threadId, draft.text, draft.attachments.map(image => image.name)]).sort()).toEqual([
      ['docs', 'Docs draft kept across a restart.', ['docs-shot.png']],
      ['workshop', 'Workshop line one\nline two', []],
    ])
    await closeSotto(launched)

    launched = await launchSotto('success', profile)
    page = launched.page
    await page.evaluate(async () => window.sotto!.agents!.command({ type: 'connect' }))
    await openThreads(page)
    const reopened = page.getByRole('complementary', { name: 'Thread sidebar' })
    await reopened.getByRole('button', { name: 'Docs', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('Docs draft kept across a restart.')
    await expect(page.getByRole('img', { name: 'docs-shot.png' })).toBeVisible()
    await reopened.getByRole('button', { name: 'Workshop', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('Workshop line one\nline two')
    await expect(reopened.getByRole('button', { name: new RegExp(`^${title}`) })).toBeVisible()

    // The 760 px minimum recomposes the same page without shrinking type or clipping status and navigation.
    const typeSizes = () => page.evaluate(() => {
      // The status sentence is read-only text for assistive technology now. What a row still shows on its right is the
      // working clock or the words "needs you", and only while the thread is working or waiting.
      const slot = document.querySelector('.thread-nav__time, .thread-nav__attention')
      return {
        message: getComputedStyle(document.querySelector('#thread-workspace-prompt')!).fontSize,
        row: getComputedStyle(document.querySelector('.thread-nav__title')!).fontSize,
        slot: slot === null ? null : getComputedStyle(slot).fontSize,
      }
    })
    const wide = await typeSizes()
    await resize(launched, 760, 740)
    await expectNoHorizontalOverflow(page)
    // The scale is the theme's business (ADR-0011); what the minimum width must not do is shrink it.
    expect(await typeSizes()).toEqual(wide)
    // The page switch keeps its place in the sidebar foot at the minimum width.
    await expect(page.getByRole('tab', { name: 'Threads', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Send prompt', exact: true })).toBeInViewport()
    await page.screenshot({ animations: 'disabled', path: join(ARTIFACTS, 'projects-760.png') })
  } finally {
    await closeSotto(launched)
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true })
    await rm(folder, { recursive: true, force: true })
  }
})

test('delivery states stay truthful: an unconfirmed send is never repeated and a disconnected provider keeps its history', async () => {
  const launched = await launchSotto()
  const { page } = launched
  try {
    await connectAndOpenThreads(page)
    await page.getByRole('button', { name: 'Docs', exact: true }).click()
    const prompt = page.getByRole('textbox', { name: 'Prompt', exact: true })
    await prompt.fill('First, delivered.')
    await page.keyboard.press('Enter')
    await expect(prompt).toHaveValue('')
    // The composer empties on the press; the provider holds the prompt a moment later, and the reply has to follow it.
    await expect.poll(() => userMessageTexts(page, 'docs')).toContain('First, delivered.')
    await page.evaluate(async () => window.sottoE2E!.agentEvent!({ type: 'ready', threadId: 'docs', text: 'Delivered reply.' }))
    // The reply has to reach the window before the next prompt, or Enter queues it behind the turn instead of sending.
    await expect(page.getByRole('button', { name: 'Send prompt', exact: true })).toBeVisible()
    await page.evaluate(async () => window.sottoE2E!.agentEvent!({ type: 'uncertain', threadId: 'docs', text: '' }))
    await prompt.fill('Maybe delivered.')
    await page.keyboard.press('Enter')
    const pending = page.getByLabel('Pending message')
    await expect(pending).toContainText('Unconfirmed')
    await expect(pending.getByRole('button', { name: 'Check again' })).toBeVisible()
    // The prompt left the composer on the press and is read in its own message while it is unconfirmed.
    await expect(pending).toContainText('Maybe delivered.')
    await expect(prompt).toHaveValue('')
    await prompt.fill('Edited while unconfirmed.')
    // Sending or queuing: nothing new leaves while the earlier prompt is unconfirmed.
    await expect(page.getByRole('button', { name: /^(Send|Queue) prompt$/ })).toBeDisabled()
    await page.keyboard.press('Enter')
    await mkdir(ARTIFACTS, { recursive: true })
    await page.screenshot({ animations: 'disabled', path: join(ARTIFACTS, 'delivery-unconfirmed.png') })
    // Enter on newer text does not start a second send while the first is unconfirmed.
    const afterEnter = await page.evaluate(async () => window.sotto!.agents!.get())
    expect(afterEnter.deliveries!.filter(delivery => delivery.threadId === 'docs').map(delivery => delivery.status).sort()).toEqual(['accepted', 'uncertain'])
    expect(afterEnter.followups ?? []).toEqual([])
    expect(await userMessageTexts(page, 'docs')).toEqual(['First, delivered.'])
    await expect.poll(async () => (await page.evaluate(async () => (await window.sotto!.agents!.get()).threadDrafts ?? [])).find(draft => draft.threadId === 'docs')?.text).toBe('Edited while unconfirmed.')

    await page.evaluate(async () => window.sottoE2E!.agentEvent!({ type: 'disconnect', threadId: 'docs', text: '' }))
    await expect(page.getByLabel('Thread transcript')).toContainText('Delivered reply.')
    // The provider recorded the unconfirmed prompt; it is shown once, with its delivery state beneath it.
    await expect(page.getByLabel('Thread transcript').getByText('Maybe delivered.', { exact: true })).toHaveCount(1)
    await expect(page.getByLabel('Pending message')).toContainText('Unconfirmed')
    await expect(page.getByText(/disconnected/).first()).toBeVisible()
    await expect(prompt).toBeEnabled()
    await expect(prompt).toHaveValue('Edited while unconfirmed.')
    await page.screenshot({ animations: 'disabled', path: join(ARTIFACTS, 'disconnected.png') })
  } finally { await closeSotto(launched) }
})

async function designProfile(prefix: string, settings: Record<string, unknown> = {}): Promise<string> {
  const profile = await mkdtemp(join(tmpdir(), prefix))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, ...settings }))
  await writeFile(join(profile, 'agents.json'), JSON.stringify({
    configuration: { ...defaultAgentConfiguration(), enabled: true, speak: false }, assignments: [], queue: [],
    activeThreadId: 'visual-gate', activeProjectId: 'workshop', draft: '', draftThreadId: null, draftRequestId: null, composing: false, pendingRequest: '', outbox: [],
  }))
  return profile
}

/**
 * WCAG contrast of the status ring's own colours against the painted sidebar and selected-row backgrounds. The row no
 * longer carries a provider glyph, so the ring is the only mark a reader has to be able to pick out. Each colour is
 * resolved through a throwaway span inside the row so a token written as a colour mix arrives as plain rgb.
 */
async function statusRingContrast(page: Page): Promise<{ role: string; background: string; ratio: number }[]> {
  return page.evaluate(() => {
    const probe = document.createElement('canvas').getContext('2d')!
    const rgb = (color: string): number[] => { probe.clearRect(0, 0, 1, 1); probe.fillStyle = '#000'; probe.fillStyle = color; probe.fillRect(0, 0, 1, 1); return [...probe.getImageData(0, 0, 1, 1).data.slice(0, 3)] }
    const luminance = (color: number[]): number => { const [r, g, b] = color.map(value => { const channel = value / 255; return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4 }); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! }
    const painted = (element: Element | null): string => {
      for (let node = element; node; node = node.parentElement) { const background = getComputedStyle(node).backgroundColor; if (background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent') return background }
      return getComputedStyle(document.body).backgroundColor
    }
    const resolved = (row: Element, token: string): string => {
      const span = document.createElement('span')
      span.style.color = `var(${token})`
      row.appendChild(span)
      const color = getComputedStyle(span).color
      span.remove()
      return color
    }
    const rows = new Map<Element, string>()
    for (const ring of document.querySelectorAll<HTMLElement>('.thread-nav__ring')) {
      const row = ring.closest('.thread-nav__row')
      if (row !== null) rows.set(row, row.hasAttribute('data-current') ? 'selected' : 'sidebar')
    }
    const readings: { role: string; background: string; ratio: number }[] = []
    for (const [row, background] of rows) {
      const behind = luminance(rgb(painted(row)))
      for (const role of ['--tt-activity', '--tt-attention']) {
        const [light, dark] = [luminance(rgb(resolved(row, role))), behind].sort((first, second) => second - first)
        readings.push({ role, background, ratio: Math.round(((light! + 0.05) / (dark! + 0.05)) * 100) / 100 })
      }
    }
    return readings
  })
}

test('status rings stay recognizable at 3:1 or more on the dark and light sidebars', async () => {
  const profile = await designProfile('sotto-e2e-workspace-marks-')
  const launched = await launchSotto('design-threads', profile)
  try {
    const { page } = launched
    await openThreads(page)
    await expect(page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: 'Visual gate flake', exact: true })).toBeVisible()
    const dark = await statusRingContrast(page)
    // The real light appearance, so the rings are measured against the tokens the light theme ships.
    await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'light' }))
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    const light = await statusRingContrast(page)
    await mkdir(ARTIFACTS, { recursive: true })
    await writeFile(join(ARTIFACTS, 'provider-mark-contrast.json'), `${JSON.stringify({ dark, light }, null, 2)}
`)
    // Both backgrounds a ring is ever drawn on: the plain sidebar and the selected row.
    expect(new Set(dark.map(item => item.background))).toEqual(new Set(['selected', 'sidebar']))
    for (const item of [...dark, ...light]) expect(item.ratio, `${item.role} on ${item.background}`).toBeGreaterThanOrEqual(3)
    await page.screenshot({ animations: 'disabled', path: join(ARTIFACTS, 'provider-marks-light-probe.png') })
  } finally {
    await closeSotto(launched)
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true })
  }
})

for (const scale of [125, 150]) {
  test(`the design fixture reads at ${scale}% display scaling with reduced motion at the 760 px minimum`, async () => {
    const profile = await designProfile(`sotto-e2e-workspace-scale-${scale}-`, { reducedMotion: 'on' })
    const launched = await launchSotto('design-threads', profile, {
      createProfile: async () => { throw new Error('This capture supplies an owned profile') },
      launch: options => electron.launch({ ...options, args: ['--disable-gpu', `--force-device-scale-factor=${scale / 100}`, ...(options?.args ?? [])] }),
      firstWindow: firstSottoWindow,
      removeProfile: async () => undefined,
    })
    try {
      const { page } = launched
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await expect.poll(() => page.evaluate<number>('devicePixelRatio')).toBeCloseTo(scale / 100, 2)
      await openThreads(page)
      await resize(launched, 760, 700)
      const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
      await expect(sidebar.getByRole('button', { name: 'Visual gate flake', exact: true })).toBeVisible()
      await sidebar.getByRole('button', { name: /^Settled/ }).click()
      await expect(sidebar.getByRole('region', { name: 'Settled' }).getByRole('button', { name: 'Release notes 1.4', exact: true })).toBeVisible()
      await expectNoHorizontalOverflow(page)
      // The working ring spins; under reduced motion it must rest.
      expect(await page.evaluate(() => [...new Set([...document.querySelectorAll('.thread-nav__ring')].map(node => getComputedStyle(node).animationName))])).toEqual(['none'])
      await mkdir(ARTIFACTS, { recursive: true })
      await page.screenshot({ animations: 'disabled', path: join(ARTIFACTS, `design-threads-760-${scale}.png`) })
    } finally {
      await closeSotto(launched)
      await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true })
    }
  })
}
