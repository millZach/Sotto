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

const ASKED = 'Have the council review README.md in this folder: are its install steps correct and complete for a new user? Ask the Council with Sotto\'s Council tool, tell me you did, and end your turn.'
// Names the tool but never the Council: "ask_council" is one word, so the user's message does not ask for the Council.
const NOT_ASKED = 'Call Sotto\'s ask_council tool once with the question "Is README.md clear?". Then reply with what the tool returned, word for word, and do nothing else.'

for (const part of ['asked', 'not-asked'] as const) test(part === 'asked' ? 'a real Claude thread asked for the Council starts one and gets its verdict back' : 'a real Claude thread whose user did not ask for the Council is refused', async () => {
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
    const panel = await page.evaluate(async () => {
      const configured = await window.sotto!.agents!.command({ type: 'configure', patch: { provider: 'claude', enabled: true, enabledProviders: ['claude', 'codex'], reasoning: 'none' } })
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
      const chosen = { councilPanelists: [seat(claude), seat(codex)], councilChair: seat(pick('claude', /haiku|sonnet/i)) }
      await window.sotto!.updateSettings({ onboardingComplete: true, ...chosen })
      const defaulted = await window.sotto!.agents!.command({ type: 'configure', patch: { defaultModelId: claude!.id } })
      if (defaulted.error) throw new Error(defaulted.error)
      return chosen
    })
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

    if (part === 'asked') {
    // Asked: the agent asks the Council, and its pane opens the Council's tab with who asked.
    await newThread()
    await send(ASKED)
    const asked = page.getByText(/Asked by Claude Code in this thread, because you said/u)
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
    await page.screenshot({ path: join(artifacts, 'asked-drawer-opens.png') })
    const askedThread = (await state()).id
    // The verdict comes back as the Council's message once its fairness check is done, and the agent answers it. A seat's
    // permission card is answered here as the user would answer it, once, and recorded.
    const cards: string[] = []
    await expect.poll(async () => {
      cards.push(...await page.evaluate(async (origin) => {
        const current = await window.sotto!.agents!.get(), done: string[] = []
        for (const thread of current.host.threads.filter(item => item.delegatedBy === origin)) for (const request of thread.requests) {
          const result = await window.sotto!.agents!.command({ type: 'answer', threadId: thread.id, requestId: request.id, answer: 'Allow once', approved: true })
          done.push(`${thread.title}: ${request.text.split(/\r?\n/u)[0]!.slice(0, 160)}${result.error ? ` (${result.error})` : ''}`)
        }
        return done
      }, askedThread))
      return (await state()).messages.some(message => message.role === 'user' && message.text.startsWith('[Sotto Council]') && message.text.includes('has its verdict'))
    }, { timeout: 40 * 60_000, intervals: [10_000] }).toBe(true)
    await expect.poll(async () => (await state()).status, { timeout: 300_000 }).toBe('idle')
    const answered = await state()
    const verdictAt = answered.messages.findIndex(message => message.role === 'user' && message.text.startsWith('[Sotto Council]'))
    expect(answered.messages.slice(verdictAt + 1).some(message => message.role === 'assistant' && message.text.trim().length > 0)).toBe(true)
    await page.getByLabel('Thread transcript').getByText(/has its verdict/u).first().scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(artifacts, 'verdict-back.png') })
    expect(await councils()).toBe(1)
    await writeFile(join(artifacts, 'asked-messages.json'), JSON.stringify({ panel, askedThread, cards,
      messages: answered.messages.map(message => ({ role: message.role, text: message.text.slice(0, 2_000) })) }, null, 2))
    expect(opened, 'the pane opened its Council tab when the agent asked').toBe(true)
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
