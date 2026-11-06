import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { fillPrompt, promptField } from './support/prompt'
import { ownedE2EProfile } from './support/e2eProfile'
import { firstSottoWindow, openThreads } from './support/sottoLaunch'
import { evidenceDirectory } from '../fixtures/evidence'

const evidenceRoot = evidenceDirectory('artifacts/council-from-thread')

// ADR-0177, amendment of November 5, 2026, with real providers: a real Claude Code thread asked "have the council review
// this" asks the Council through `sotto_council`, its pane opens the Council's tab, and the verdict comes back to it; a
// thread whose user did not ask for the Council is refused. Each run sends real subscription turns (a Council is about
// eleven), so it is opt-in: `npm run build`, then `SOTTO_COUNCIL_LIVE=1 npx playwright test tests/e2e/council-from-thread-live.spec.ts`,
// with Claude Code and Codex signed in. The production app runs over an isolated profile (tests/fixtures/nativeThreadsMain.cjs).
test.describe.configure({ retries: 0, timeout: 45 * 60_000 })
const enabled = process.env.SOTTO_COUNCIL_LIVE === '1'
// SOTTO_COUNCIL_PROVIDER=codex asks from a Codex thread; SOTTO_COUNCIL_LOOK=1 also checks the asked Council's record in
// light, with reduced motion, at the 820 by 560 minimum.
const origin = process.env.SOTTO_COUNCIL_PROVIDER === 'codex' ? 'codex' as const : 'claude' as const
const originLabel = origin === 'codex' ? 'Codex' : 'Claude Code'
const look = process.env.SOTTO_COUNCIL_LOOK === '1'
const CLIMB = 'Put README.md through a council climb: the goal is install steps a new user can follow without help. Start the Climb with Sotto\'s Council tool on README.md only, tell me you did, and end your turn.'

const ASKED = 'Have the council review README.md in this folder: are its install steps correct and complete for a new user? Ask the Council with Sotto\'s Council tool, tell me you did, and end your turn.'
// Names the tool but never the Council: "ask_council" is one word, so the user's message does not ask for the Council.
const NOT_ASKED = 'Call Sotto\'s ask_council tool once with the question "Is README.md clear?". Then reply with what the tool returned, word for word, and do nothing else.'

const TITLES = { 'asked': `a real ${originLabel} thread asked for the Council starts one and gets its verdict back`, 'not-asked': 'a real Claude thread whose user did not ask for the Council is refused',
  'climb': 'a real Claude thread asked for a council climb sets it up, waits for approval in the drawer, and hears how it ended' } as const
for (const part of ['asked', 'not-asked', 'climb'] as const) test(TITLES[part], async () => {
  test.skip(!enabled, 'Explicit live Council opt-in required.')
  const root = (await ownedE2EProfile({ prefix: 'sotto-e2e-native-' })).directory
  const profile = join(root, 'profile'), project = join(root, 'project')
  await mkdir(profile); await mkdir(project)
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ onboardingComplete: true }))
  // A small project on a branch, as a Council's snapshot needs, with a README whose install steps miss a step.
  await writeFile(join(project, 'README.md'), '# Synthetic tool\n\nInstall:\n\n1. Clone the repository.\n2. Run `npm start`.\n')
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'synthetic-tool', scripts: { start: 'node index.js' }, dependencies: { zod: '^4.0.0' } }, null, 2))
  await writeFile(join(project, 'index.js'), 'require(\'zod\')\nconsole.log(\'Synthetic tool\')\n')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: project, stdio: 'ignore' })
  git('init', '-q'); git('add', '.'); git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'Start'); git('switch', '-q', '-c', 'feat/readme')
  const artifacts = evidenceRoot
  await mkdir(artifacts, { recursive: true })
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({ args: [resolve('tests/fixtures/nativeThreadsMain.cjs'), ...process.platform === 'linux' ? ['--disable-gpu'] : []], env: Object.fromEntries(Object.entries({
      ...process.env, SOTTO_NATIVE_THREADS_LIVE: '1', SOTTO_NATIVE_THREADS_ROOT: root, SOTTO_OWL_FEATURES: 'council=1',
    }).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE')) })
    const page = await firstSottoWindow(app)
    // The window's own errors, so a failed run says what threw.
    const errors: string[] = []
    page.on('pageerror', error => { errors.push(`${error.message}\n${error.stack ?? ''}`.slice(0, 4_000)) })
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text().slice(0, 4_000)) })
    await page.waitForFunction(() => !!window.sotto?.agents && !!window.sotto?.council)
    // Claude Code and Codex connected; the panel in Settings → Council is two quick seats and a chair, so the run is short.
    const panel = await page.evaluate(async ({ originProvider, claudeOnly }: { originProvider: 'claude' | 'codex'; claudeOnly: boolean }) => {
      const configured = await window.sotto!.agents!.command({ type: 'configure', patch: { provider: originProvider, enabled: true, enabledProviders: ['claude', 'codex'], reasoning: 'none' } })
      if (configured.error) throw new Error(configured.error)
      for (const provider of ['claude', 'codex'] as const) {
        const connected = await window.sotto!.agents!.command({ type: 'connect', provider })
        if (connected.error) throw new Error(connected.error)
      }
      const models = (await window.sotto!.agents!.get()).host.models.filter(model => model.ready && !model.legacy)
      const pick = (provider: string, name: RegExp) => { const ready = models.filter(model => model.providerId === provider); return ready.find(model => name.test(model.name)) ?? ready[0] }
      const seat = (model: (typeof models)[number] | undefined) => {
        if (!model) throw new Error('A provider has no ready model; nothing was sent.')
        const efforts = (model.reasoningEfforts ?? []).filter(effort => effort !== 'ultracode')
        return { modelId: model.id, reasoningEffort: efforts.find(effort => effort === 'low') ?? efforts[0] ?? null }
      }
      const claude = pick('claude', /sonnet/i), codex = pick('codex', /mini|codex/i)
      // SOTTO_COUNCIL_CLAUDE_ONLY=1 seats only Claude models, so a Climb's judges are all Claude.
      const chosen = { councilPanelists: [seat(claude), seat(claudeOnly ? pick('claude', /haiku|opus/i) : codex)], councilChair: seat(pick('claude', /haiku|sonnet/i)) }
      await window.sotto!.updateSettings({ onboardingComplete: true, ...chosen })
      const defaulted = await window.sotto!.agents!.command({ type: 'configure', patch: { defaultModelId: (originProvider === 'codex' ? pick('codex', /sol/i) : claude)!.id } })
      if (defaulted.error) throw new Error(defaulted.error)
      return chosen
    }, { originProvider: part === 'asked' ? origin : 'claude', claudeOnly: process.env.SOTTO_COUNCIL_CLAUDE_ONLY === '1' })
    await page.reload()
    await openThreads(page)
    const state = () => page.evaluate(async () => {
      const current = await window.sotto!.agents!.get()
      const thread = current.host.threads.find(item => item.id === current.activeThreadId)
      const detail = current.activeThreadId ? await window.sotto!.agents!.threadDetail!(current.activeThreadId) : undefined
      return { id: current.activeThreadId, status: thread?.status, requests: thread?.requests.length ?? 0,
        messages: (detail?.messages ?? []).map(message => ({ role: message.role, text: message.text })) }
    })
    const newThread = async () => {
      await page.getByRole('button', { name: 'New thread', exact: true }).first().click()
      await page.getByRole('dialog', { name: 'New thread', exact: true }).getByRole('button', { name: /Local folder/ }).click()
      await page.getByRole('dialog', { name: /Choose a folder for the new thread/ }).getByRole('button', { name: /Browse with/ }).click()
      await expect(promptField(page)).toBeVisible({ timeout: 45_000 })
      const notNow = page.getByRole('button', { name: 'Not now', exact: true })
      if (await notNow.isVisible().catch(() => false)) await notNow.click()
    }
    const send = async (prompt: string) => {
      await fillPrompt(promptField(page), prompt)
      await page.getByRole('button', { name: 'Send prompt', exact: true }).click()
      await expect(page.getByLabel('Thread transcript')).toContainText(prompt.slice(0, 40), { timeout: 15_000 })
    }
    const councils = () => page.evaluate(async () => (await window.sotto!.council!.read()).length)
    /** Answers every waiting permission card once, as the user would, and says what each asked. */
    const answerCards = () => page.evaluate(async () => {
      const done: string[] = []
      for (const thread of (await window.sotto!.agents!.get()).host.threads) for (const request of thread.requests) {
        const result = await window.sotto!.agents!.command({ type: 'answer', threadId: thread.id, requestId: request.id, answer: 'Allow once', approved: true })
        done.push(`${thread.title}: ${request.text.split(/\r?\n/u)[0]!.slice(0, 160)}${result.error ? ` (${result.error})` : ''}`)
      }
      return done
    })

    if (part === 'asked') {
    // Asked: the agent asks the Council, and its pane opens the Council's tab with who asked.
    await newThread()
    await send(ASKED)
    const asked = page.getByText(new RegExp(`Asked by ${originLabel}:`, 'u'))
    await expect.poll(councils, { timeout: 300_000, intervals: [2_000] }).toBe(1)
    let opened = true
    try { await expect(asked).toBeVisible({ timeout: 30_000 }) } catch {
      // Record what the window holds, then open the Council by hand, so the run still proves the rest and says what failed.
      opened = false
      await writeFile(join(artifacts, 'failed-drawer.json'), JSON.stringify(await page.evaluate(() => ({
        href: location.href, visibility: document.visibilityState, stored: localStorage.getItem('sotto.paneTerminal'),
        drawers: document.querySelectorAll('.pane-terminal').length, entries: document.querySelectorAll('.council-entry').length,
        buttons: [...document.querySelectorAll('button')].map(item => item.getAttribute('aria-label') ?? item.textContent).filter(Boolean).slice(0, 60),
        text: document.body.innerText.slice(0, 3_000) })), null, 2))
      await writeFile(join(artifacts, 'failed-errors.json'), JSON.stringify(errors, null, 2))
      await page.screenshot({ path: join(artifacts, 'failed-asked.png') })
      await page.getByRole('button', { name: /^(Show )?Council/u }).first().click()
      await expect(asked).toBeVisible({ timeout: 30_000 })
    }
    await page.screenshot({ path: join(artifacts, `asked-drawer-opens-${origin}.png`) })
    const askedThread = (await state()).id
    if (look) {
      // Light, reduced motion and the minimum window: the line stays readable and nothing in the drawer overflows.
      await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'light', reducedMotion: 'on' }))
      await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) if (window.isVisible()) window.setSize(820, 560) })
      await expect.poll(() => page.evaluate(() => window.innerWidth), { timeout: 10_000 }).toBeLessThanOrEqual(820)
      await asked.scrollIntoViewIfNeeded()
      const measured = await page.evaluate(() => {
        // Any CSS colour, oklab included, as the sRGB a canvas paints it.
        const paint = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!
        const rgb = (value: string) => { paint.clearRect(0, 0, 1, 1); paint.fillStyle = value; paint.fillRect(0, 0, 1, 1); const [r, g, b, alpha] = paint.getImageData(0, 0, 1, 1).data; return [r!, g!, b!, alpha! / 255] }
        const luminance = ([r, g, b]: number[]) => [r!, g!, b!].map(channel => { const c = channel / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }).reduce((sum, c, index) => sum + c * [0.2126, 0.7152, 0.0722][index]!, 0)
        const line = document.querySelector('.council-entry__asked') as HTMLElement
        let surface: Element | null = line, background = 'rgba(0, 0, 0, 0)'
        while (surface && rgb(background)[3] === 0) { background = getComputedStyle(surface).backgroundColor; surface = surface.parentElement }
        const [fore, back] = [luminance(rgb(getComputedStyle(line).color)), luminance(rgb(background))]
        const box = line.getBoundingClientRect(), drawer = document.querySelector('.pane-terminal') as HTMLElement
        return { contrast: (Math.max(fore, back) + 0.05) / (Math.min(fore, back) + 0.05), color: getComputedStyle(line).color, background,
          window: [innerWidth, innerHeight], line: [box.left, box.right, box.width], drawerOverflow: drawer.scrollWidth - drawer.clientWidth,
          pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, reducedMotion: document.documentElement.dataset.reducedMotion ?? null,
          appearance: document.documentElement.dataset.appearance ?? document.documentElement.className }
      })
      const scene = () => page.locator('.council-chamber__scene').evaluate(canvas => (canvas as HTMLCanvasElement).toDataURL())
      const still = (await scene()) === (await page.waitForTimeout(1_500).then(scene))
      await writeFile(join(artifacts, 'look.json'), JSON.stringify({ ...measured, chamberStillOverOneAndAHalfSeconds: still }, null, 2))
      await page.screenshot({ path: join(artifacts, 'look-light-820x560.png') })
      expect(measured.contrast).toBeGreaterThanOrEqual(4.5)
      expect(measured.drawerOverflow).toBeLessThanOrEqual(0)
      expect(measured.pageOverflow).toBeLessThanOrEqual(0)
      expect(measured.line[1]).toBeLessThanOrEqual(measured.window[0]!)
    }
    // The verdict comes back as the Council's message once its fairness check is done, and the agent answers it. A seat's
    // permission card is answered here as the user would answer it, once, and recorded.
    const cards: string[] = []
    await expect.poll(async () => {
      cards.push(...await answerCards())
      return (await state()).messages.some(message => message.role === 'user' && message.text.startsWith('[Sotto Council]') && message.text.includes('has its verdict'))
    }, { timeout: 40 * 60_000, intervals: [10_000] }).toBe(true)
    // The agent answers the verdict; a card it raises doing so is answered as the user would.
    try { await expect.poll(async () => { cards.push(...await answerCards()); return (await state()).status }, { timeout: 600_000, intervals: [5_000] }).toBe('idle') } catch (error) {
      await page.screenshot({ path: join(artifacts, `failed-not-idle-${origin}.png`) })
      await writeFile(join(artifacts, `failed-not-idle-${origin}.json`), JSON.stringify({ cards, seen: await state() }, null, 2))
      throw error
    }
    const answered = await state()
    const verdictAt = answered.messages.findIndex(message => message.role === 'user' && message.text.startsWith('[Sotto Council]'))
    expect(answered.messages.slice(verdictAt + 1).some(message => message.role === 'assistant' && message.text.trim().length > 0)).toBe(true)
    await page.getByLabel('Thread transcript').getByText(/has its verdict/u).first().scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(artifacts, `verdict-back-${origin}.png`) })
    expect(await councils()).toBe(1)
    await writeFile(join(artifacts, `asked-messages-${origin}.json`), JSON.stringify({ panel, askedThread, cards,
      messages: answered.messages.map(message => ({ role: message.role, text: message.text.slice(0, 2_000) })) }, null, 2))
    expect(opened, 'the pane opened its Council tab when the agent asked').toBe(true)
    } else if (part === 'climb') {
    // Climb: the agent starts only the setup; nothing is judged until the user approves it in the drawer.
    const climbs = () => page.evaluate(async () => (await window.sotto!.council!.climb!({ type: 'read' })).climbs ?? [])
    await newThread()
    await send(CLIMB)
    await expect.poll(async () => (await climbs()).length, { timeout: 300_000, intervals: [2_000] }).toBe(1)
    const builder = (await state()).id
    await expect(page.getByText(/Asked by Claude Code:/u)).toBeVisible({ timeout: 30_000 })
    await expect.poll(async () => (await climbs())[0]?.phase, { timeout: 15 * 60_000, intervals: [5_000] }).toBe('approval')
    expect((await climbs())[0]!.rounds).toHaveLength(0)
    const approve = page.getByRole('button', { name: 'Approve & start round 0' })
    await expect(approve).toBeVisible()
    await page.screenshot({ path: join(artifacts, 'climb-waits-for-approval.png') })
    // Approved here as the user would: one attempt, so the run ends after one fix brief and one assessment.
    await page.getByRole('slider', { name: 'Attempts' }).fill('0')
    await page.getByRole('checkbox', { name: /Allow fix briefs to this builder/u }).check()
    await approve.click()
    const cards: string[] = []
    // A card on the builder pauses the Climb until the user answers it and presses Continue Climb, as here.
    const continued: string[] = []
    await expect.poll(async () => {
      cards.push(...await answerCards())
      const record = (await climbs())[0]!
      const resume = page.getByRole('button', { name: 'Continue Climb' })
      if (record.phase === 'paused' && /needs your attention/u.test(record.reason ?? '') && continued.length < 5 && await resume.isVisible().catch(() => false)) {
        continued.push(record.reason!); await resume.click(); return 'running'
      }
      return ['done', 'stopped', 'paused'].includes(record.phase) ? record.phase : 'running'
    }, { timeout: 40 * 60_000, intervals: [10_000] }).not.toBe('running')
    const ended = (await climbs())[0]!
    await expect.poll(async () => (await state()).messages.some(message => message.role === 'user' && message.text.startsWith('[Sotto Council]') && message.text.includes('has ended')),
      { timeout: 15 * 60_000, intervals: [10_000] }).toBe(ended.phase === 'done')
    const seen = await state()
    await page.screenshot({ path: join(artifacts, 'climb-ended.png') })
    await writeFile(join(artifacts, 'climb.json'), JSON.stringify({ builder, cards, continued, phase: ended.phase, reason: ended.reason, rounds: ended.rounds.length, completedTurns: ended.completedTurns,
      messages: seen.messages.map(message => ({ role: message.role, text: message.text.slice(0, 1_500) })) }, null, 2))
    expect(ended.phase).toBe('done')
    } else {

    // Not asked: the same tool, called from a thread whose user never named the Council, is refused and starts nothing.
    await newThread()
    await send(NOT_ASKED)
    // Its turn has begun and ended once a reply of Claude's is in and the thread rests.
    await expect.poll(async () => { const seen = await state(); return seen.status === 'idle' && seen.messages.some(message => message.role === 'assistant' && message.text.trim()) }, { timeout: 300_000, intervals: [2_000] }).toBe(true)
    const refused = await state()
    const reply = refused.messages.filter(message => message.role === 'assistant').map(message => message.text).join('\n')
    expect(reply).toMatch(/does not ask for the Council|refused/iu)
    expect(await councils()).toBe(0)
    await page.screenshot({ path: join(artifacts, 'not-asked-refused.png') })
    await writeFile(join(artifacts, 'not-asked-messages.json'), JSON.stringify(refused.messages.map(message => ({ role: message.role, text: message.text.slice(0, 2_000) })), null, 2))
    }
  } finally {
    await app?.close().catch(() => undefined)
  }
})
