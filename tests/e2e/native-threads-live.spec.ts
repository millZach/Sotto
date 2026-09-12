import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { firstSottoWindow } from './support/sottoLaunch'
import type { ProviderId } from '../../src/shared/agents'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'

// No automatic retries: every fresh run sends one native subscription turn per provider.
test.describe.configure({ retries: 0, timeout: 180_000 })
const enabled = process.env.SOTTO_NATIVE_THREADS_LIVE === '1'
const selected = process.env.SOTTO_NATIVE_THREADS_PROVIDER
const restoreRoot = process.env.SOTTO_NATIVE_THREADS_RESTORE_ROOT

for (const provider of ['codex', 'claude', 'grok'] as const) {
  test(`${provider}: actual native Threads create, send, reply and restart`, async () => {
    test.skip(!enabled || (!!selected && selected !== provider), 'Explicit native subscription smoke opt-in required.')
    if (restoreRoot && selected !== provider) throw new Error('Restore mode requires one explicitly selected provider.')
    const root = restoreRoot ? requireOwnedE2EProfile(restoreRoot) : await mkdtemp(join(tmpdir(), 'sotto-e2e-native-'))
    const profile = join(root, 'profile')
    const project = join(root, 'project')
    if (!restoreRoot) {
      await mkdir(profile); await mkdir(project)
      // Prevent legacy-profile migration, and bypass the microphone onboarding only.
      await writeFile(join(profile, 'settings.json'), JSON.stringify({ onboardingComplete: true }))
    }
    const artifacts = resolve('artifacts/native-threads-live', provider)
    await mkdir(artifacts, { recursive: true })
    const title = `Native ${provider} acceptance`
    const prompt = 'Reply with exactly the one word READY. Do not use any tools, read any files, modify any files, or perform any other actions.'
    let app: ElectronApplication | undefined
    let page: Page | undefined
    const evidence: Record<string, unknown> = { provider, root, project, startedAt: new Date().toISOString(), syntheticOnly: true }
    const launch = async () => {
      app = await electron.launch({ args: [resolve('tests/fixtures/nativeThreadsMain.cjs')], env: Object.fromEntries(Object.entries({
        ...process.env, SOTTO_NATIVE_THREADS_ROOT: root,
      }).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE')) })
      page = await firstSottoWindow(app)
      await page.waitForFunction(() => !!window.sotto?.agents)
      expect(await page.evaluate(() => typeof window.sottoE2E)).toBe('undefined')
      expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(profile)
      return page
    }
    const configure = async (target: Page, chosen: ProviderId) => target.evaluate(async provider => {
      await window.sotto!.updateSettings({ onboardingComplete: true })
      const result = await window.sotto!.agents!.command({ type: 'configure', patch: {
        provider, enabled: true, speak: false, reasoning: 'none', followupLimit: 0,
      } })
      if (result.error) throw new Error(result.error)
      const connected = await window.sotto!.agents!.command({ type: 'connect' })
      if (connected.error) throw new Error(connected.error)
      return { version: connected.host.version, models: connected.host.models.map(model => ({ id: model.id, ready: model.ready })), connection: connected.connection }
    }, chosen)
    try {
      const restoreBinding = restoreRoot ? JSON.parse(await readFile(join(profile, 'threads.json'), 'utf8')) : undefined
      page = await launch()
      if (restoreRoot) {
        await expect.poll(async () => (await page!.evaluate(async () => window.sotto!.agents!.get())).connection, { timeout: 30_000 }).toBe('connected')
        await page.getByRole('link', { name: 'Threads', exact: true }).click()
        await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
        await expect(page.getByLabel('Thread transcript').locator('[data-role="assistant"]')).toContainText('READY', { timeout: 30_000 })
        const state = await page.evaluate(async () => window.sotto!.agents!.get())
        expect(state.configuration.provider).toBe(provider)
        expect(state.activeThreadId).toBe(restoreBinding.bindings[0].threadId)
        expect(state.host.threads).toHaveLength(1)
        expect(state.host.threads[0]?.messages.filter(message => message.role === 'user')).toHaveLength(1)
        expect(state.assignments).toHaveLength(0)
        expect(JSON.parse(await readFile(join(profile, 'threads.json'), 'utf8'))).toEqual(restoreBinding)
        expect(await readdir(project)).toEqual([])
        await page.screenshot({ path: join(artifacts, 'restored-latest.png') })
        evidence.restored = { id: state.activeThreadId, sameBinding: true, noAdditionalTurn: true }
        evidence.passed = true
        return
      }
      evidence.connection = await configure(page, provider)
      await page.reload()
      await page.getByRole('link', { name: 'Threads', exact: true }).click()
      await page.getByRole('button', { name: 'New thread', exact: true }).first().click()
      const dialog = page.getByRole('dialog', { name: 'New thread', exact: true })
      await dialog.getByRole('button', { name: /Local folder/ }).click()
      await expect(dialog).toContainText(project)
      await dialog.getByRole('textbox', { name: 'Thread name' }).fill(title)
      await dialog.getByRole('combobox', { name: 'Thread permissions' }).selectOption('approval-required')
      await page.screenshot({ path: join(artifacts, 'create.png') })
      await dialog.getByRole('button', { name: 'Create thread' }).click()
      await expect(dialog).toHaveCount(0, { timeout: 45_000 })
      await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
      const before = await page.evaluate(async () => {
        const state = await window.sotto!.agents!.get()
        return { id: state.activeThreadId, assignments: state.assignments, count: state.host.threads.length }
      })
      expect(before.assignments).toHaveLength(0)
      expect(before.count).toBe(1)
      evidence.created = before
      // Observe actual rendered changes without slowing or replacing provider acknowledgements.
      await page.evaluate(() => {
        const observations: string[] = []
        Object.assign(window, { nativeSmokeObservations: observations })
        new MutationObserver(() => {
          const pending = document.querySelector('[aria-label="Pending message"]')?.textContent
          if (pending && observations.at(-1) !== pending) observations.push(pending)
        }).observe(document.body, { childList: true, subtree: true, characterData: true })
      })
      await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill(prompt)
      await page.getByRole('button', { name: 'Send prompt', exact: true }).click()
      await expect(page.getByLabel('Thread transcript')).toContainText(prompt, { timeout: 15_000 })
      await page.screenshot({ path: join(artifacts, 'sending.png') })
      await expect(page.getByLabel('Thread transcript').locator('[data-role="assistant"]')).toContainText('READY', { timeout: 90_000 })
      await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('', { timeout: 15_000 })
      await expect(page.getByLabel('Pending message')).toHaveCount(0)
      const completed = await page.evaluate(async () => {
        const state = await window.sotto!.agents!.get()
        return { thread: state.host.threads.find(thread => thread.id === state.activeThreadId), assignments: state.assignments,
          observations: (window as unknown as { nativeSmokeObservations: string[] }).nativeSmokeObservations }
      })
      expect(completed.thread?.messages.filter(message => message.role === 'user')).toHaveLength(1)
      expect(completed.thread?.messages.some(message => message.role === 'assistant' && message.text.trim() === 'READY')).toBe(true)
      expect(completed.thread?.messages.find(message => message.role === 'user')?.commandId).toBeTruthy()
      expect(completed.thread?.requests).toHaveLength(0)
      expect(completed.assignments).toHaveLength(0)
      expect(completed.observations.some(value => value.includes('Sending'))).toBe(true)
      evidence.completed = completed
      await page.screenshot({ path: join(artifacts, 'reply.png') })
      const bindingBefore = JSON.parse(await readFile(join(profile, 'threads.json'), 'utf8'))
      const aliasBefore = JSON.parse(await readFile(join(profile, `${provider}-threads.json`), 'utf8'))
      await app!.close(); app = undefined
      page = await launch()
      const state = await page.evaluate(async () => {
        const current = await window.sotto!.agents!.get()
        return current.connection === 'connected' ? current : window.sotto!.agents!.command({ type: 'connect' })
      })
      expect(state.configuration.provider).toBe(provider)
      await page.getByRole('link', { name: 'Threads', exact: true }).click()
      await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible({ timeout: 30_000 })
      await expect(page.getByLabel('Thread transcript').locator('[data-role="assistant"]')).toContainText('READY', { timeout: 30_000 })
      const restored = await page.evaluate(async () => {
        const state = await window.sotto!.agents!.get()
        return state.host.threads.find(thread => thread.id === state.activeThreadId)
      })
      expect(restored?.id).toBe(before.id)
      expect(restored?.messages.filter(message => message.role === 'user')).toHaveLength(1)
      expect(JSON.parse(await readFile(join(profile, 'threads.json'), 'utf8'))).toEqual(bindingBefore)
      const aliasAfter = JSON.parse(await readFile(join(profile, `${provider}-threads.json`), 'utf8'))
      expect(Object.keys(aliasAfter)).toEqual(Object.keys(aliasBefore))
      for (const id of Object.keys(aliasBefore)) {
        for (const key of ['codexThreadId', 'sessionId', 'grokSessionId']) expect(aliasAfter[id][key]).toEqual(aliasBefore[id][key])
      }
      expect(await readdir(project)).toEqual([])
      evidence.restored = { id: restored?.id, status: restored?.status, sameBinding: true, sameNativeSession: true, noProjectFiles: true }
      evidence.passed = true
      await page.screenshot({ path: join(artifacts, 'restart.png') })
    } catch (error) {
      evidence.error = error instanceof Error ? error.message : String(error)
      if (page && !page.isClosed()) await page.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => undefined)
      throw error
    } finally {
      await writeFile(join(artifacts, restoreRoot ? 'restore-evidence.json' : 'evidence.json'), JSON.stringify(evidence, null, 2))
      await app?.close().catch(() => undefined)
      // Keep only this synthetic profile for diagnosis; no native history deletion.
      console.log(`Native Threads ${provider} evidence: ${artifacts}; synthetic root: ${root}`)
    }
  })
}
