import { ownedE2EProfile } from './support/e2eProfile'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { captureWindow, firstSottoWindow, openThreads } from './support/sottoLaunch'
import type { ProviderId } from '../../src/shared/agents'
import { evidenceDirectory } from '../fixtures/evidence'

const evidenceRoot = evidenceDirectory('artifacts/visuals-live')

// A real Claude Code, Codex or Grok Build thread asked to draw a visual through `visualize`, in the production app
// over an isolated profile (tests/fixtures/nativeThreadsMain.cjs). Each run sends real subscription turns, so it is
// opt-in: `npm run build`, then `SOTTO_VISUALS_LIVE=1 npx playwright test tests/e2e/visuals-live.spec.ts`, with
// SOTTO_VISUALS_PROVIDER to pick one provider. Claude's run also turns the setting off and on and restarts the app.
test.describe.configure({ retries: 0, timeout: 420_000 })
const enabled = process.env.SOTTO_VISUALS_LIVE === '1'
const selected = process.env.SOTTO_VISUALS_PROVIDER

const BEFORE = 'Here is the round trip.'
const AFTER = 'That is the whole trip.'
const ask = (title: string) => [
  // The way a user asks: by what they want, not by the tool's name, which some clients then call without its server.
  `Draw this as a visual in the thread with Sotto's visual tool, exactly once: kind "diagram", title "${title}", a one-sentence intro and three steps.`,
  'The source is a Mermaid sequence diagram with participants Browser, Server and Database and four arrows: the browser asks the server, the server queries the database, the database answers, the server answers the browser.',
  // Without this the agent often sends steps as words alone, and the walkthrough has nothing to light.
  'Give every step a highlight list naming the participants or arrow numbers it is about.',
  `Before you call the tool, write exactly: ${BEFORE} After the tool answers, write exactly: ${AFTER}`,
  'Do not read or change any files and do not use any other tool.',
].join(' ')

for (const provider of ['claude', 'codex', 'grok'] as const) {
  test(`${provider}: a real thread draws a visual between its words`, async () => {
    test.skip(!enabled || (!!selected && selected !== provider), 'Explicit live visuals opt-in required.')
    const root = (await ownedE2EProfile({ prefix: 'sotto-e2e-native-' })).directory
    const profile = join(root, 'profile')
    const project = join(root, 'project')
    await mkdir(profile); await mkdir(project)
    await writeFile(join(profile, 'settings.json'), JSON.stringify({ onboardingComplete: true }))
    // Outside test-results, which Playwright clears at every run, so each provider's run keeps its captures.
    const artifacts = join(evidenceRoot, provider)
    await mkdir(artifacts, { recursive: true })
    let app: ElectronApplication | undefined
    let current: Page | undefined
    const launch = async (): Promise<Page> => {
      app = await electron.launch({ args: [resolve('tests/fixtures/nativeThreadsMain.cjs')], env: Object.fromEntries(Object.entries({
        ...process.env, SOTTO_NATIVE_THREADS_LIVE: '1', SOTTO_NATIVE_THREADS_ROOT: root,
      }).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE')) })
      const page = await firstSottoWindow(app)
      current = page
      await page.waitForFunction(() => !!window.sotto?.agents)
      expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(profile)
      return page
    }
    const state = (page: Page) => page.evaluate(async () => {
      const current = await window.sotto!.agents!.get()
      const thread = current.host.threads.find(item => item.id === current.activeThreadId)
      // The shell carries no messages; the open thread's detail does.
      const detail = current.activeThreadId ? await window.sotto!.agents!.threadDetail!(current.activeThreadId) : undefined
      return { status: thread?.status, requests: thread?.requests ?? [],
        messages: (detail?.messages ?? []).map(message => ({ id: message.id, role: message.role, text: message.text, visual: !!(message as { visual?: unknown }).visual })) }
    })
    const idle = (page: Page) => expect.poll(async () => (await state(page)).status, { timeout: 240_000 }).toBe('idle')
    const send = async (page: Page, prompt: string) => {
      await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill(prompt)
      await page.getByRole('button', { name: 'Send prompt', exact: true }).click()
      await expect(page.getByLabel('Thread transcript')).toContainText(prompt.slice(0, 40), { timeout: 15_000 })
    }
    try {
      let page = await launch()
      const model = await page.evaluate(async (chosen: ProviderId) => {
        await window.sotto!.updateSettings({ onboardingComplete: true, visualsInThreads: true })
        const configured = await window.sotto!.agents!.command({ type: 'configure', patch: {
          provider: chosen, enabled: true, enabledProviders: [chosen], reasoning: 'none', } })
        if (configured.error) throw new Error(configured.error)
        const connected = await window.sotto!.agents!.command({ type: 'connect', provider: chosen })
        if (connected.error) throw new Error(connected.error)
        const ready = (await window.sotto!.agents!.get()).host.models.filter(item => item.providerId === chosen && item.ready)
        const pick = ready.find(item => /sonnet|gpt-5|grok-4|grok-code/i.test(item.name)) ?? ready[0]
        if (!pick) throw new Error(`No ready ${chosen} model; no turn sent.`)
        const defaulted = await window.sotto!.agents!.command({ type: 'configure', patch: { defaultModelId: pick.id } })
        if (defaulted.error) throw new Error(defaulted.error)
        return pick.name
      }, provider)
      await page.reload()
      await openThreads(page)
      await page.getByRole('button', { name: 'New thread', exact: true }).first().click()
      const dialog = page.getByRole('dialog', { name: 'New thread', exact: true })
      await dialog.getByRole('button', { name: /Local folder/ }).click()
      await page.getByRole('dialog', { name: /Choose a folder for the new thread/ }).getByRole('button', { name: 'Browse with File Explorer' }).click()
      // Choosing the folder creates the thread at once, in the provider's default permissions.
      await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toBeVisible({ timeout: 45_000 })
      const notNow = page.getByRole('button', { name: 'Not now', exact: true })
      if (await notNow.isVisible().catch(() => false)) await notNow.click()

      await send(page, ask('A request round trip'))
      const log = page.getByRole('log', { name: 'Thread transcript' })
      const card = log.getByRole('region', { name: 'Visual: A request round trip' })
      // Grok asks before a use_tool call whose name it has not resolved: a guessed or bare name rather than the full
      // `sotto_visual__visualize`, which Sotto answers itself. That prompt is answered here the way a user would, and
      // counted, so a run says how often it happened and whether Grok still drew.
      const prompts: string[] = []
      const allow = page.locator('[data-choice-kind="allow-once"]').first()
      await expect.poll(async () => {
        if (await card.isVisible()) return true
        if (provider === 'grok' && await allow.isVisible().catch(() => false)) {
          prompts.push((await state(page)).requests.map(request => request.text.split(/\r?\n/u)[0]).join(', '))
          await allow.click()
        }
        return false
      }, { timeout: 240_000, intervals: [2_000] }).toBe(true)
      await expect(card.getByRole('img', { name: /A request round trip/u })).toBeVisible({ timeout: 30_000 })
      await captureWindow(app!, join(artifacts, 'drawn.png'))
      await idle(page)
      const drawn = await state(page)
      expect(drawn.requests).toHaveLength(0)
      const before = drawn.messages.findIndex(message => message.role === 'assistant' && !message.visual && message.text.includes(BEFORE))
      const visual = drawn.messages.findIndex(message => message.visual)
      const after = drawn.messages.findIndex(message => message.role === 'assistant' && !message.visual && message.text.includes(AFTER))
      await writeFile(join(artifacts, 'messages.json'), JSON.stringify({ model, prompts, before, visual, after, messages: drawn.messages.map(({ id, role, visual, text }) => ({ id, role, visual, text: text.slice(0, 120) })) }, null, 2))
      expect(visual).toBeGreaterThan(-1)
      expect(before).toBeGreaterThan(-1)
      expect(after).toBeGreaterThan(visual)
      expect(before).toBeLessThan(visual)
      await captureWindow(app!, join(artifacts, 'settled.png'))

      if (provider !== 'claude') return
      // The walkthrough: step 2 lights what Claude named for it, and its capture is kept.
      const walkthrough = card.getByRole('group', { name: 'Walkthrough' })
      await expect(walkthrough).toContainText('Step 1 of 3')
      await card.getByRole('button', { name: 'Next', exact: true }).click()
      await expect(walkthrough).toContainText('Step 2 of 3')
      const lit = (): Promise<number> => card.locator('.visual-card__layers img[data-layer]:not([data-layer="leaving"])').evaluate(element => {
        const svg = new TextDecoder().decode(Uint8Array.from(atob((element as HTMLImageElement).src.split(',')[1]!), char => char.charCodeAt(0)))
        return new DOMParser().parseFromString(svg, 'image/svg+xml').querySelectorAll('.sotto-step-lit').length
      })
      await expect.poll(lit).toBeGreaterThan(0)
      await card.scrollIntoViewIfNeeded()
      await captureWindow(app!, join(artifacts, 'walkthrough-step-2.png'))

      // Off: the running session's call is refused and nothing is drawn. On again: it draws.
      await page.evaluate(async () => { await window.sotto!.updateSettings({ visualsInThreads: false }) })
      await send(page, ask('Switched off'))
      await idle(page)
      await expect(log.getByRole('region', { name: 'Visual: Switched off' })).toHaveCount(0)
      expect((await state(page)).requests).toHaveLength(0)
      await page.evaluate(async () => { await window.sotto!.updateSettings({ visualsInThreads: true }) })
      await send(page, ask('Switched on'))
      await expect(log.getByRole('region', { name: 'Visual: Switched on' })).toBeVisible({ timeout: 240_000 })
      await idle(page)
      await captureWindow(app!, join(artifacts, 'switched.png'))

      // Kept with the thread: back after a restart, with no new turn.
      await app!.close(); app = undefined
      page = await launch()
      await page.evaluate(async () => {
        const current = await window.sotto!.agents!.get()
        if (current.connection !== 'connected') await window.sotto!.agents!.command({ type: 'connect' })
      })
      await openThreads(page)
      await expect(page.getByRole('log', { name: 'Thread transcript' }).getByRole('region', { name: 'Visual: Switched on' })).toBeVisible({ timeout: 60_000 })
      await captureWindow(app!, join(artifacts, 'restarted.png'))
    } catch (error) {
      // What the thread showed when it failed: a request waiting, a refused call, or no call at all.
      if (current && !current.isClosed()) {
        await current.screenshot({ path: join(artifacts, 'failed.png') }).catch(() => undefined)
        const shown = await current.evaluate(async () => {
          const now = await window.sotto!.agents!.get()
          const thread = now.host.threads.find(item => item.id === now.activeThreadId)
          const detail = now.activeThreadId ? await window.sotto!.agents!.threadDetail!(now.activeThreadId) : undefined
          return { status: thread?.status, requests: thread?.requests, error: now.error,
            messages: detail?.messages.map(message => ({ role: message.role, id: message.id, text: message.text.slice(0, 300) })),
            activities: detail?.activities?.map(activity => ({ kind: activity.kind, title: activity.title, status: activity.status, output: activity.output?.slice(0, 600) })) }
        }).catch(reason => ({ unreadable: String(reason) }))
        await writeFile(join(artifacts, 'failed.json'), JSON.stringify(shown, null, 2)).catch(() => undefined)
      }
      throw error
    } finally {
      await app?.close()
    }
  })
}
