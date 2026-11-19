import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { fillPrompt, promptField } from './support/prompt'
import { ownedE2EProfile } from './support/e2eProfile'
import { firstSottoWindow, openThreads } from './support/sottoLaunch'
import { evidenceDirectory } from '../fixtures/evidence'

const evidenceRoot = evidenceDirectory('artifacts/plan-checklist-claude-codex')

// ADR-0134, November 19, 2026 amendment, with real providers: a real Claude Code thread and a real Codex thread that make a
// plan show it as the checklist above the working line, and the checklist follows the plan as its steps finish. Each run
// sends one real subscription turn per provider, so it is opt-in: `npm run build`, then
// `SOTTO_PLAN_LIVE=1 npx playwright test tests/e2e/plan-checklist-live.spec.ts`, with Claude Code and Codex signed in.
// The production app runs over an isolated profile (tests/fixtures/nativeThreadsMain.cjs).
test.describe.configure({ retries: 0, timeout: 15 * 60_000 })
const enabled = process.env.SOTTO_PLAN_LIVE === '1'
const PROMPT = 'Track this work with your plan or task tool: a three-step plan, one step per file. Then, one step at a time: mark the step in progress, run `sleep 5`, create the file (a.txt containing a, then b.txt containing b, then c.txt containing c), and mark the step done before starting the next. Ask me nothing.'

type Item = { text: string; status: string }
for (const provider of ['claude', 'codex'] as const) test(`a real ${provider} thread shows its plan as the checklist and follows it`, async () => {
  test.skip(!enabled, 'Explicit live plan checklist opt-in required.')
  const root = (await ownedE2EProfile({ prefix: 'sotto-e2e-native-' })).directory
  const profile = join(root, 'profile'), project = join(root, 'project')
  await mkdir(profile); await mkdir(project)
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ onboardingComplete: true }))
  await mkdir(evidenceRoot, { recursive: true })
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({ args: [resolve('tests/fixtures/nativeThreadsMain.cjs'), ...process.platform === 'linux' ? ['--disable-gpu'] : []], env: Object.fromEntries(Object.entries({
      ...process.env, SOTTO_NATIVE_THREADS_LIVE: '1', SOTTO_NATIVE_THREADS_ROOT: root,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE')) })
    const page = await firstSottoWindow(app)
    await page.waitForFunction(() => !!window.sotto?.agents)
    const model = await page.evaluate(async (chosen: 'claude' | 'codex') => {
      const configured = await window.sotto!.agents!.command({ type: 'configure', patch: { provider: chosen, enabled: true, enabledProviders: [chosen], reasoning: 'none' } })
      if (configured.error) throw new Error(configured.error)
      const connected = await window.sotto!.agents!.command({ type: 'connect', provider: chosen })
      if (connected.error) throw new Error(connected.error)
      const ready = (await window.sotto!.agents!.get()).host.models.filter(item => item.ready && !item.legacy && item.providerId === chosen)
      const pick = ready.find(item => (chosen === 'claude' ? /sonnet/i : /sol/i).test(item.name)) ?? ready[0]
      if (!pick) throw new Error('The provider has no ready model; nothing was sent.')
      const defaulted = await window.sotto!.agents!.command({ type: 'configure', patch: { defaultModelId: pick.id } })
      if (defaulted.error) throw new Error(defaulted.error)
      return pick.name
    }, provider)
    await page.reload()
    await openThreads(page)
    await page.getByRole('button', { name: 'New thread', exact: true }).first().click()
    await page.getByRole('dialog', { name: 'New thread', exact: true }).getByRole('button', { name: /Local folder/ }).click()
    await page.getByRole('dialog', { name: /Choose a folder for the new thread/ }).getByRole('button', { name: /Browse with/ }).click()
    await expect(promptField(page)).toBeVisible({ timeout: 45_000 })
    const notNow = page.getByRole('button', { name: 'Not now', exact: true })
    if (await notNow.isVisible().catch(() => false)) await notNow.click()
    await fillPrompt(promptField(page), PROMPT)
    await page.getByRole('button', { name: 'Send prompt', exact: true }).click()

    // Every state the checklist shows while the turn runs, in order, with a picture of each. The opt-in is the user's
    // answer for this one synthetic thread in its own profile: a card its turn raises (the `sleep`, a file write) is
    // allowed once, and a card from anything else fails the run unanswered.
    const states: Item[][] = []
    const checklist = page.locator('.thread-activity-live__plan')
    const deadline = Date.now() + 10 * 60_000
    let status: string | undefined
    do {
      status = await page.evaluate(async () => {
        const current = await window.sotto!.agents!.get()
        for (const thread of current.host.threads) for (const request of thread.requests) {
          if (thread.id !== current.activeThreadId) throw new Error('A card came from another thread; it was left unanswered.')
          await window.sotto!.agents!.command({ type: 'answer', threadId: thread.id, requestId: request.id, answer: 'Allow once', approved: true })
        }
        return current.host.threads.find(item => item.id === current.activeThreadId)?.status
      })
      const items = await checklist.first().locator(':scope > li').evaluateAll(rows => rows.map(row => ({
        text: row.querySelector('.thread-activity__step-text')?.textContent ?? '', status: row.getAttribute('data-status') ?? '' }))).catch(() => [] as Item[])
      if (items.length && JSON.stringify(items) !== JSON.stringify(states.at(-1))) {
        states.push(items)
        await page.screenshot({ path: join(evidenceRoot, `${provider}-${states.length}.png`) })
      }
      await page.waitForTimeout(500)
    } while ((status === 'running' || states.length === 0) && Date.now() < deadline)
    const fold = await page.getByLabel('Thread transcript').innerText()
    await page.screenshot({ path: join(evidenceRoot, `${provider}-ended.png`) })
    await writeFile(join(evidenceRoot, `${provider}.json`), JSON.stringify({ model, states, foldMentionsPlan: /plan \d+ of \d+ done/u.test(fold) }, null, 2))

    // The plan showed as a three-item checklist, and it moved on while the turn ran: an item done while another was not.
    expect(states.length, 'the checklist showed').toBeGreaterThan(0)
    expect(states.some(items => items.length === 3)).toBe(true)
    expect(states.length, 'the checklist changed as the plan did').toBeGreaterThan(1)
    expect(states.some(items => items.some(item => item.status === 'completed') && items.some(item => item.status !== 'completed'))).toBe(true)
  } finally {
    await app?.close().catch(() => undefined)
  }
})
