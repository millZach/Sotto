import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { defaultAgentConfiguration } from '../../src/shared/agents'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { closeSotto, firstSottoWindow, launchSotto, type LaunchedSotto } from './support/sottoLaunch'

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
  await page.getByRole('link', { name: 'Threads', exact: true }).click()
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
    await page.getByRole('link', { name: 'Threads', exact: true }).click()
    const reopened = page.getByRole('complementary', { name: 'Thread sidebar' })
    await reopened.getByRole('button', { name: 'Docs', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('Docs draft kept across a restart.')
    await expect(page.getByRole('img', { name: 'docs-shot.png' })).toBeVisible()
    await reopened.getByRole('button', { name: 'Workshop', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('Workshop line one\nline two')
    await expect(reopened.getByRole('button', { name: new RegExp(`^${title}`) })).toBeVisible()

    // The 760 px minimum recomposes the same page without shrinking type or clipping status and navigation.
    await resize(launched, 760, 740)
    await expectNoHorizontalOverflow(page)
    const sizes = await page.evaluate(() => ({
      message: getComputedStyle(document.querySelector('#thread-workspace-prompt')!).fontSize,
      row: getComputedStyle(document.querySelector('.thread-nav__title')!).fontSize,
      status: getComputedStyle(document.querySelector('.thread-nav__status')!).fontSize,
    }))
    expect(sizes).toEqual({ message: '16px', row: '14px', status: '12px' })
    await expect(page.getByRole('link', { name: 'Threads', exact: true })).toBeVisible()
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
    await page.evaluate(async () => window.sottoE2E!.agentEvent!({ type: 'ready', threadId: 'docs', text: 'Delivered reply.' }))
    await page.evaluate(async () => window.sottoE2E!.agentEvent!({ type: 'uncertain', threadId: 'docs', text: '' }))
    await prompt.fill('Maybe delivered.')
    await page.keyboard.press('Enter')
    const pending = page.getByLabel('Pending message')
    await expect(pending).toContainText('Unconfirmed')
    await expect(pending.getByRole('button', { name: 'Check again' })).toBeVisible()
    await expect(prompt).toHaveValue('Maybe delivered.')
    await prompt.fill('Edited while unconfirmed.')
    await expect(page.getByRole('button', { name: 'Send prompt', exact: true })).toBeDisabled()
    await page.keyboard.press('Enter')
    await mkdir(ARTIFACTS, { recursive: true })
    await page.screenshot({ animations: 'disabled', path: join(ARTIFACTS, 'delivery-unconfirmed.png') })
    // Enter on newer text does not start a second send while the first is unconfirmed.
    const afterEnter = await page.evaluate(async () => window.sotto!.agents!.get())
    expect(afterEnter.deliveries!.filter(delivery => delivery.threadId === 'docs').map(delivery => delivery.status).sort()).toEqual(['accepted', 'uncertain'])
    expect(afterEnter.host.threads.find(thread => thread.id === 'docs')!.messages.filter(message => message.role === 'user').map(message => message.text)).toEqual(['First, delivered.'])
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

for (const scale of [125, 150]) {
  test(`the design fixture reads at ${scale}% display scaling with reduced motion at the 760 px minimum`, async () => {
    const profile = await ownedProfile(`sotto-e2e-workspace-scale-${scale}-`)
    await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, reducedMotion: 'on' }))
    await writeFile(join(profile, 'agents.json'), JSON.stringify({
      configuration: { ...defaultAgentConfiguration(), enabled: true, speak: false }, assignments: [], queue: [],
      activeThreadId: 'visual-gate', activeProjectId: 'workshop', draft: '', draftThreadId: null, draftRequestId: null, composing: false, pendingRequest: '', outbox: [],
    }))
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
      await page.getByRole('link', { name: 'Threads', exact: true }).click()
      await resize(launched, 760, 700)
      const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
      await expect(sidebar.getByRole('button', { name: 'Visual gate flake', exact: true })).toBeVisible()
      await sidebar.getByRole('button', { name: /^Settled/ }).click()
      await expect(sidebar.getByRole('region', { name: 'Settled' }).getByRole('button', { name: 'Release notes 1.4', exact: true })).toBeVisible()
      await expectNoHorizontalOverflow(page)
      expect(await page.evaluate(() => [...new Set([...document.querySelectorAll('.thread-nav__status i')].map(node => getComputedStyle(node).animationName))])).toEqual(['none'])
      await mkdir(ARTIFACTS, { recursive: true })
      await page.screenshot({ animations: 'disabled', path: join(ARTIFACTS, `design-threads-760-${scale}.png`) })
    } finally {
      await closeSotto(launched)
      await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true })
    }
  })
}
