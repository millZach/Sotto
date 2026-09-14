import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { AgentState, ProviderId } from '../../src/shared/agents'
import { PROVIDER_LABELS } from '../../src/shared/agents'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { firstSottoWindow } from './support/sottoLaunch'

// Opt in separately from the single-provider smoke. Exactly three native turns;
// restore-only mode never creates a thread or sends another prompt.
test.describe.configure({ retries: 0, timeout: 360_000 })
const providers = ['codex', 'claude', 'grok'] as const
const prompt = 'Reply with exactly the one word READY. Do not use any tools, read any files, modify any files, or perform any other actions.'
const title = (provider: ProviderId): string => `Independent ${PROVIDER_LABELS[provider]} acceptance`

async function state(page: Page): Promise<AgentState> {
  return page.evaluate(async () => window.sotto!.agents!.get())
}

function identities(snapshot: AgentState) {
  return snapshot.host.threads.map(thread => ({ id: thread.id, title: thread.title, providerId: thread.providerId,
    projectId: thread.projectId, modelId: thread.modelId })).sort((left, right) => left.id.localeCompare(right.id))
}

function connections(snapshot: AgentState) {
  return providers.map(id => ({ id, connection: snapshot.host.providers?.find(provider => provider.id === id)?.connection }))
}

const allConnected = providers.map(id => ({ id, connection: 'connected' }))

async function settleProviders(page: Page): Promise<void> {
  const navigation = page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Providers', exact: true })
  await navigation.click()
  await expect(navigation).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tabpanel', { name: 'Providers', exact: true })).toBeVisible()
}


async function openProviders(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  await settleProviders(page)
}

async function captureProviders(page: Page, path: string): Promise<void> {
  await settleProviders(page)
  await page.screenshot({ animations: 'disabled', path })
}

async function providerAction(page: Page, provider: ProviderId, action: 'Connect' | 'Disconnect'): Promise<void> {
  await page.getByRole('button', { name: PROVIDER_LABELS[provider], exact: true }).click()
  const panel = page.getByRole('region', { name: 'Provider configuration', exact: true })
  await panel.getByRole('button', { name: `${action} ${PROVIDER_LABELS[provider]}`, exact: true }).click()
  await expect.poll(async () => (await state(page)).host.providers?.find(item => item.id === provider)?.connection,
    { timeout: 45_000 }).toBe(action === 'Connect' ? 'connected' : 'disconnected')
}

async function expectAllRows(page: Page): Promise<void> {
  const sidebar = page.getByRole('complementary', { name: 'Thread sidebar', exact: true })
  for (const provider of providers) await expect(sidebar.getByRole('button', { name: title(provider), exact: true })).toBeVisible()
}

async function openThread(page: Page, provider: ProviderId): Promise<void> {
  await page.getByRole('complementary', { name: 'Thread sidebar', exact: true })
    .getByRole('button', { name: title(provider), exact: true }).click()
  // A click is not the acknowledgement of an asynchronous thread selection.
  await expect(page.getByRole('heading', { name: title(provider), exact: true })).toBeVisible()
}

async function expectCompleted(page: Page, provider: ProviderId): Promise<void> {
  await openThread(page, provider)
  await expect(page.getByLabel('Thread transcript').locator('[data-role="assistant"]')).toContainText('READY', { timeout: 45_000 })
  await expect.poll(async () => {
    const thread = (await state(page)).host.threads.find(thread => thread.title === title(provider))
    return { status: thread?.status, users: thread?.messages.filter(message => message.role === 'user').length,
      ready: thread?.messages.some(message => message.role === 'assistant' && message.text.trim() === 'READY'), requests: thread?.requests.length }
  }, { timeout: 45_000 }).toEqual({ status: 'idle', users: 1, ready: true, requests: 0 })
}

async function registry(profile: string): Promise<unknown> {
  return JSON.parse(await readFile(join(profile, 'threads.json'), 'utf8'))
}

async function aliases(profile: string) {
  const result: Record<string, unknown> = {}
  for (const provider of providers) {
    const saved = JSON.parse(await readFile(join(profile, `${provider}-threads.json`), 'utf8')) as Record<string, Record<string, unknown>>
    result[provider] = Object.fromEntries(Object.entries(saved).map(([id, alias]) => [id,
      Object.fromEntries(['codexThreadId', 'sessionId', 'grokSessionId'].filter(key => key in alias).map(key => [key, alias[key]]))]))
  }
  return result
}

test('three native providers coexist independently of Sotto reasoning and survive restart', async () => {
  test.skip(process.env.SOTTO_MULTI_PROVIDER_LIVE !== '1', 'Explicit three-provider native subscription smoke opt-in required.')
  const restoreRoot = process.env.SOTTO_MULTI_PROVIDER_RESTORE_ROOT
  const root = restoreRoot ? requireOwnedE2EProfile(restoreRoot) : await mkdtemp(join(tmpdir(), 'sotto-e2e-native-'))
  const profile = join(root, 'profile')
  const project = join(root, 'project')
  if (!restoreRoot) {
    await mkdir(profile); await mkdir(project)
    // Prevent legacy-profile migration; all provider connections use the real UI.
    await writeFile(join(profile, 'settings.json'), JSON.stringify({ onboardingComplete: true }))
  }
  const artifacts = resolve('artifacts/multi-provider-live')
  await mkdir(artifacts, { recursive: true })
  const evidence: Record<string, unknown> = { root, project, syntheticOnly: true, restoreOnly: !!restoreRoot,
    startedAt: new Date().toISOString(), submittedProviders: [] }
  const saveEvidence = () => writeFile(join(artifacts, restoreRoot ? 'restore-evidence.json' : 'evidence.json'), JSON.stringify(evidence, null, 2))
  let app: ElectronApplication | undefined
  let page: Page | undefined
  const launch = async (): Promise<Page> => {
    app = await electron.launch({ args: [resolve('tests/fixtures/nativeThreadsMain.cjs')], env: Object.fromEntries(Object.entries({
      ...process.env, SOTTO_NATIVE_THREADS_LIVE: '1', SOTTO_NATIVE_THREADS_ROOT: root,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE')) })
    const target = await firstSottoWindow(app)
    target.setDefaultTimeout(15_000)
    await target.waitForFunction(() => !!window.sotto?.agents)
    expect(await target.evaluate(() => typeof window.sottoE2E)).toBe('undefined')
    expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(profile)
    return target
  }
  try {
    const restoredRegistry = restoreRoot ? await registry(profile) : undefined
    const restoredAliases = restoreRoot ? await aliases(profile) : undefined
    page = await launch()
    if (!restoreRoot) {
      // Keep speech and automatic supervision out of this manual three-turn check.
      await page.evaluate(async () => {
        const result = await window.sotto!.agents!.command({ type: 'configure', patch: { speak: false, followupLimit: 0, reasoning: 'none' } })
        if (result.error) throw new Error(result.error)
      })
      await openProviders(page)
      await captureProviders(page, join(artifacts, 'initial-providers.png'))
      for (const provider of providers) {
        await providerAction(page, provider, 'Connect')
        await expect(page.getByRole('tab', { name: 'Configuration', exact: true })).toBeVisible()
        await page.getByRole('tab', { name: 'Models', exact: true }).click()
        await expect.poll(async () => (await state(page!)).host.models.filter(model => model.providerId === provider && model.ready).length).toBeGreaterThan(0)
        await captureProviders(page, join(artifacts, `${provider}-models.png`))
        await page.getByRole('tab', { name: 'Configuration', exact: true }).click()
      }
      await expect.poll(async () => connections(await state(page!))).toEqual(allConnected)
      expect([...((await state(page)).configuration.enabledProviders ?? [])].sort()).toEqual([...providers].sort())
      await page.getByRole('link', { name: 'Threads', exact: true }).click()
      for (const [index, provider] of providers.entries()) {
        const model = (await state(page)).host.models.find(model => model.providerId === provider && model.ready)
        expect(model, `${provider} must expose a native ready model`).toBeTruthy()
        await page.getByRole('button', { name: 'New thread', exact: true }).first().click()
        const dialog = page.getByRole('dialog', { name: 'New thread', exact: true })
        await dialog.getByRole('button', { name: /Local folder/ }).click()
        await expect(dialog).toContainText(project)
        await dialog.getByRole('textbox', { name: 'Thread name', exact: true }).fill(title(provider))
        await dialog.getByRole('combobox', { name: 'Thread model', exact: true }).click()
        const picker = page.getByRole('dialog', { name: 'Choose model', exact: true })
        await picker.getByRole('navigation', { name: 'Model providers', exact: true })
          .getByRole('button', { name: model!.provider, exact: true }).click()
        await picker.getByRole('option', { name: model!.name, exact: true }).click()
        await expect(dialog.getByRole('combobox', { name: 'Thread model', exact: true })).toContainText(model!.name)
        await dialog.getByRole('combobox', { name: 'Thread permissions', exact: true }).selectOption(provider === 'codex' ? 'full-access' : 'approval-required')
        await dialog.getByRole('button', { name: 'Create thread', exact: true }).click()
        await expect(dialog).toHaveCount(0, { timeout: 45_000 })
        await expect(page.getByRole('heading', { name: title(provider), exact: true })).toBeVisible()
        const created = await state(page)
        expect(created.host.threads).toHaveLength(index + 1)
        expect(created.assignments).toHaveLength(0)
        expect(created.host.threads.find(thread => thread.id === created.activeThreadId)).toMatchObject({ providerId: provider, modelId: model!.id })
        await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill(prompt)
        // Persist intent before the paid action. A failed run is investigated or
        // restored without automatically resubmitting uncertain native turns.
        evidence.submittedProviders = [...providers.slice(0, index + 1)]
        await saveEvidence()
        await page.getByRole('button', { name: 'Send prompt', exact: true }).click()
        await expect(page.getByLabel('Thread transcript').locator('[data-role="assistant"]')).toContainText('READY', { timeout: 90_000 })
        await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('', { timeout: 15_000 })
        await expect(page.getByLabel('Pending message')).toHaveCount(0)
        await expectCompleted(page, provider)
        await page.screenshot({ animations: 'disabled', path: join(artifacts, `${provider}-reply.png`) })
      }
    } else {
      await expect.poll(async () => connections(await state(page!)), { timeout: 45_000 }).toEqual(allConnected)
      await page.getByRole('link', { name: 'Threads', exact: true }).click()
      for (const provider of providers) await expectCompleted(page, provider)
      expect(await registry(profile)).toEqual(restoredRegistry)
      expect(await aliases(profile)).toEqual(restoredAliases)
    }
    await expectAllRows(page)
    const before = await state(page)
    expect(before.host.threads).toHaveLength(3)
    const expectedIdentities = identities(before)
    const expectedModels = before.host.models.map(model => ({ id: model.id, providerId: model.providerId })).sort((a, b) => a.id.localeCompare(b.id))
    const bindingBefore = await registry(profile)
    const aliasesBefore = await aliases(profile)
    evidence.created = expectedIdentities
    evidence.connected = connections(before)
    await page.screenshot({ animations: 'disabled', path: join(artifacts, 'three-providers.png') })

    await openProviders(page)
    await page.getByRole('button', { name: 'Claude Code', exact: true }).click()
    await captureProviders(page, join(artifacts, 'all-connected-claude-configuration.png'))
    await page.getByRole('tab', { name: 'Models', exact: true }).click()
    await captureProviders(page, join(artifacts, 'all-connected-claude-models.png'))
    await page.getByRole('tab', { name: 'Configuration', exact: true }).click()
    const previousSize = await app!.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!
      const size = window.getSize(); const minimum = window.getMinimumSize()
      window.setMinimumSize(760, 600); window.setSize(760, 740); return { size, minimum }
    })
    await expect.poll(() => page!.evaluate(() => innerWidth)).toBe(760)
    await captureProviders(page, join(artifacts, 'providers-760.png'))
    expect(await page.locator('.settings-scroll').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await app!.evaluate(({ BrowserWindow }, previous) => {
      const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!
      window.setMinimumSize(previous.minimum[0]!, previous.minimum[1]!)
      window.setSize(previous.size[0]!, previous.size[1]!)
    }, previousSize)


    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Agents', exact: true }).click()
    const configuration = page.locator('#settings-agents')
    for (const coordinator of ['codex', 'claude'] as const) {
      await configuration.getByRole('combobox', { name: 'Reasoning account', exact: true }).selectOption(coordinator)
      await expect.poll(async () => (await state(page!)).configuration.reasoning).toBe(coordinator)
      const changed = await state(page)
      expect(identities(changed)).toEqual(expectedIdentities)
      expect(connections(changed)).toEqual(allConnected)
      expect(changed.host.models.map(model => ({ id: model.id, providerId: model.providerId })).sort((a, b) => a.id.localeCompare(b.id))).toEqual(expectedModels)
      expect(await registry(profile)).toEqual(bindingBefore)
    }
    await page.screenshot({ animations: 'disabled', path: join(artifacts, 'independent-coordinator.png') })

    await page.getByRole('tablist', { name: 'Mode', exact: true }).getByRole('tab', { name: 'Agents', exact: true }).click()
    await page.getByRole('button', { name: 'Not now', exact: true }).click()
    await page.getByRole('button', { name: 'Configure agents', exact: true }).click()
    const agentControl = page.getByRole('dialog', { name: 'Agent configuration', exact: true })
    if (!(await state(page)).configuration.enabled) {
      await agentControl.getByRole('button', { name: 'Enable agent control', exact: true }).click()
      await expect.poll(async () => (await state(page!)).configuration.enabled).toBe(true)
    }
    await agentControl.getByRole('button', { name: 'Turn off agent control', exact: true }).click()
    await expect.poll(async () => (await state(page!)).configuration.enabled).toBe(false)
    expect(connections(await state(page))).toEqual(allConnected)
    expect(identities(await state(page))).toEqual(expectedIdentities)
    await page.screenshot({ animations: 'disabled', path: join(artifacts, 'coordinator-off.png') })
    await agentControl.getByRole('button', { name: 'Close Agent configuration', exact: true }).click()
    evidence.coordinatorOffPreservesProviders = true


    // Disconnect only a completed provider; other native connections and all
    // three materialized transcripts must remain usable without another turn.
    await openProviders(page)
    await providerAction(page, 'claude', 'Disconnect')
    await captureProviders(page, join(artifacts, 'disabled-claude-configuration.png'))
    expect((await state(page)).configuration.enabled).toBe(false)
    expect(connections(await state(page))).toEqual(providers.map(id => ({ id, connection: id === 'claude' ? 'disconnected' : 'connected' })))
    await page.getByRole('link', { name: 'Threads', exact: true }).click()
    await expectAllRows(page)
    for (const provider of providers) await expectCompleted(page, provider)
    expect(identities(await state(page))).toEqual(expectedIdentities)
    await page.screenshot({ animations: 'disabled', path: join(artifacts, 'one-provider-disconnected.png') })
    await openProviders(page)
    await providerAction(page, 'claude', 'Connect')
    await expect.poll(async () => connections(await state(page!))).toEqual(allConnected)
    expect((await state(page)).configuration.enabled).toBe(false)
    evidence.disconnectIsolation = true

    // Every native thread has a confirmed assistant reply before restarting.
    await app!.close(); app = undefined
    page = await launch()
    await expect.poll(async () => connections(await state(page!)), { timeout: 45_000 }).toEqual(allConnected)
    await page.getByRole('link', { name: 'Threads', exact: true }).click()
    await expectAllRows(page)
    for (const provider of providers) await expectCompleted(page, provider)
    const restored = await state(page)
    expect(identities(restored)).toEqual(expectedIdentities)
    expect(restored.configuration.reasoning).toBe('claude')
    expect(restored.configuration.enabled).toBe(false)
    expect(restored.assignments).toHaveLength(0)
    expect(await registry(profile)).toEqual(bindingBefore)
    expect(await aliases(profile)).toEqual(aliasesBefore)
    expect(await readdir(project)).toEqual([])
    evidence.restored = { sameBindings: true, sameNativeSessions: true, sameModels: true, noAdditionalTurns: true, noProjectFiles: true, coordinatorStillOff: true }
    evidence.passed = true
    await page.screenshot({ animations: 'disabled', path: join(artifacts, 'restart.png') })
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error)
    if (page && !page.isClosed()) await page.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => undefined)
    throw error
  } finally {
    await saveEvidence()
    await app?.close().catch(() => undefined)
    // Retain this synthetic root for diagnosis and paid-call-free restore checks.
    console.log(`Multi-provider native evidence: ${artifacts}; synthetic root: ${root}`)
  }
})
