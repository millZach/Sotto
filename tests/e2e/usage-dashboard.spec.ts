// Run after npm run build: npx playwright test tests/e2e/usage-dashboard.spec.ts
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { evidenceDirectory } from '../fixtures/evidence'
import { fillPrompt, promptField } from './support/prompt'
import { openThreads } from './support/sottoLaunch'
import { textContrast } from './support/textContrast'
import {
  REPORTED_USAGE_MODEL, SELECTED_USAGE_MODEL, usageAssistantFrame, usageDashboardHarness,
  usageResultFrame, usageWait, waitForNativePrompt,
} from './support/usageDashboard'

const artifacts = evidenceDirectory('artifacts/usage-dashboard')

test('Owl Usage counts real accepted sends and native cache tokens, filters and clears safely, and survives history off and restart', async () => {
  test.setTimeout(180_000)
  const harness = await usageDashboardHarness()
  const { action, activity } = harness
  try {
    await mkdir(artifacts, { recursive: true })
    let page = await harness.launch()
    expect(await page.evaluate(() => typeof window.sotto?.usage?.read)).toBe('function')
    expect(await harness.currentApp().evaluate(({ app }) => app.getVersion())).toBe('0.1.38-owl.20261012.1')
    await harness.open()
    const measures = () => page.getByRole('tablist', { name: 'Usage measures', exact: true })
    const views = () => page.getByRole('tablist', { name: 'Usage views', exact: true })
    await expect(measures().getByRole('tab')).toHaveCount(6)
    await expect(measures().getByRole('tab', { name: /^Prompts 0 /u })).toBeVisible()
    await expect(measures().getByRole('tab', { name: /^Tokens — /u })).toBeVisible()
    expect((await activity()).totals.prompts.user).toBe(0)

    await harness.connect()
    const threadId = await page.evaluate(async path => {
      const agents = window.sotto!.agents!
      const created = await agents.command({ type: 'create-project', provider: 'claude', title: 'Usage fixture project', path, useExisting: true })
      if (created.error) throw new Error(created.error)
      const state = await agents.get()
      const project = state.host.projects.find(value => value.title === 'Usage fixture project')!
      const model = state.host.models.find(value => value.providerId === 'claude' && value.ready)!
      const result = await agents.command({ type: 'create-thread', projectId: project.id, title: 'Usage fixture', titleSource: 'user', modelId: model.id,
        workingCopy: 'shared', runtimeMode: 'approval-required' })
      if (result.error) throw new Error(result.error)
      const id = result.activeThreadId!
      await agents.command({ type: 'select-thread', threadId: id }); await agents.command({ type: 'observe-threads', threadIds: [id] })
      return id
    }, harness.project)
    await openThreads(page)
    await expect(promptField(page)).toBeEditable()
    await fillPrompt(promptField(page), 'Exercise isolated usage accounting.')
    await page.getByRole('button', { name: 'Send prompt', exact: true }).click()
    const nativeId = await waitForNativePrompt(harness, 1)
    await expect.poll(async () => (await activity()).totals.prompts.user, usageWait).toBe(1)
    const first = usageAssistantFrame(nativeId, 'first-accounting-request')
    await action(nativeId, { type: 'raw', persist: true, frame: first })
    const resetsAt = Math.floor(Date.now() / 1000) + 18_000
    await action(nativeId, { type: 'raw', frame: { type: 'rate_limit_event', session_id: nativeId,
      rate_limit_info: { rateLimitType: 'five_hour', status: 'allowed', utilization: 0, resetsAt } } })
    await action(nativeId, { type: 'raw', frame: { type: 'rate_limit_event', session_id: nativeId,
      rate_limit_info: { rateLimitType: 'seven_day', status: 'allowed', utilization: 0.2, resetsAt: resetsAt + 86_400 } } })
    await expect.poll(async () => (await activity()).totals.tokens.total.value, usageWait).toBe(3600)
    const initial = await activity()
    expect(initial.totals.tokens).toMatchObject({ input: { value: 3500 }, output: { value: 100 }, cached: { value: 2000 },
      cacheWrite: { value: 500 }, cacheWrite5m: { value: 0 }, cacheWrite1h: { value: 500 }, total: { value: 3600 } })
    expect(initial.models.find(row => row.modelId.endsWith(SELECTED_USAGE_MODEL))).toMatchObject({ prompts: { user: 1 } })
    expect(initial.models.find(row => row.modelId.endsWith(SELECTED_USAGE_MODEL))!.tokens.total.value).toBeUndefined()
    expect(initial.models.find(row => row.modelId.endsWith(REPORTED_USAGE_MODEL))).toMatchObject({ prompts: { user: 0 }, tokens: { total: { value: 3600 } } })

    await harness.open()
    await page.getByRole('button', { name: 'Refresh subscription limits', exact: true }).click()
    await expect(measures().getByRole('tab', { name: /^Tokens 3,600 /u })).toBeVisible()
    await expect(measures().getByRole('tab', { name: /^From cache 57% /u })).toBeVisible()
    await expect(measures().getByRole('tab', { name: /^Room left 80% /u })).toBeVisible()
    await harness.capture(artifacts, 'overview-dark-1600.png', 1600, 1000, 'dark')

    const prompts = measures().getByRole('tab', { name: /^Prompts /u })
    await prompts.focus(); await prompts.press('End')
    await expect(measures().getByRole('tab', { name: /^Busiest hour /u })).toHaveAttribute('aria-selected', 'true')
    const hours = page.getByRole('group', { name: 'Your prompts by weekday and hour', exact: true })
    await hours.focus(); await hours.press('ArrowRight')
    const hoursDescription = await hours.getAttribute('aria-describedby')
    await expect(page.locator(`[id="${hoursDescription}"]`)).toContainText('1am')
    await measures().getByRole('tab', { name: /^Prompts /u }).click()
    const daily = page.getByRole('group', { name: 'Your prompts per day', exact: true })
    await daily.focus(); await daily.press('End')
    const dailyDescription = await daily.getAttribute('aria-describedby')
    await expect(page.locator(`[id="${dailyDescription}"]`)).toContainText('1 prompts from you')
    await daily.press('Escape'); await expect(page.locator(`[id="${dailyDescription}"]`)).toContainText('Point to a day')
    const dailySummary = page.getByText('Read daily counts', { exact: true })
    await dailySummary.click(); await expect(page.locator('.usage-chart__table[open]')).toBeVisible()
    await dailySummary.press('Escape'); await expect(dailySummary).toBeFocused(); await expect(page.locator('.usage-chart__table[open]')).toHaveCount(0)

    await measures().getByRole('tab', { name: /^Tokens /u }).click()
    const fact = (label: string) => page.locator('.usage-token-facts div').filter({ has: page.getByText(label, { exact: true }) }).locator('dd')
    await expect(fact('Input')).toHaveText('3,500'); await expect(fact('Output')).toHaveText('100')
    await expect(fact('Cache read')).toHaveText('2,000'); await expect(fact('Cache write')).toHaveText('500')
    await expect(fact('Cache write · 5 minutes')).toHaveText('0')
    await harness.capture(artifacts, 'tokens-dark-1280.png', 1280, 800, 'dark')

    const overview = views().getByRole('tab', { name: 'Overview', exact: true })
    await overview.focus(); await overview.press('ArrowRight')
    await expect(views().getByRole('tab', { name: 'Subscriptions', exact: true })).toHaveAttribute('aria-selected', 'true')
    const claude = page.locator('.usage-subscription').filter({ has: page.getByRole('heading', { name: 'Claude Code', exact: true }) })
    await expect(claude).toContainText('100%'); await expect(claude).toContainText('80%')
    await expect(claude).toContainText('Updates when Claude Code reports limits.')
    await expect(page.locator('.usage-subscription').filter({ has: page.getByRole('heading', { name: 'Devin', exact: true }) })).toContainText('not connected')
    await page.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('claude')
    await expect(page.locator('.usage-subscription')).toHaveCount(1)
    await harness.appearance('light'); await harness.resize(820, 560)
    await claude.locator('.usage-window').last().scrollIntoViewIfNeeded()
    await harness.capture(artifacts, 'subscriptions-light-820.png', 820, 560, 'light')
    const about = page.getByText('About these figures', { exact: true })
    await about.click()
    await expect(page.locator('.usage-about[open]')).toBeVisible()
    const aboutContrast = await textContrast(page.locator('.usage-about'), 'p', true)
    expect(aboutContrast).toHaveLength(3)
    expect(aboutContrast.filter(row => row.ratio < 4.5)).toEqual([])
    await about.press('Escape'); await expect(about).toBeFocused()
    await expect(page.locator('.usage-about[open]')).toHaveCount(0)
    await page.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('all')
    await views().getByRole('tab', { name: 'Subscriptions', exact: true }).press('ArrowRight')
    await expect(views().getByRole('tab', { name: 'Models', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.usage-model')).toHaveCount(2)
    await page.getByRole('combobox', { name: 'Sort models by', exact: true }).selectOption('tokens')
    const modelRow = page.locator('.usage-model__main').first()
    await modelRow.click(); await expect(modelRow).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('.usage-model__id')).toContainText(REPORTED_USAGE_MODEL)
    await modelRow.press('Escape'); await expect(modelRow).toHaveAttribute('aria-expanded', 'false'); await expect(modelRow).toBeFocused()
    await harness.capture(artifacts, 'models-light-1280.png', 1280, 800, 'light')
    await views().getByRole('tab', { name: 'Models', exact: true }).press('Home')
    await expect(overview).toHaveAttribute('aria-selected', 'true')

    const localHost = (await harness.read()).hosts[0]!.hostId
    await page.getByRole('combobox', { name: 'Computer', exact: true }).selectOption(localHost)
    await page.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('devin')
    await expect(measures().getByRole('tab', { name: /^Tokens — /u })).toBeVisible()
    await expect(measures().getByRole('tab', { name: /^Prompts 0 /u })).toBeVisible()
    await page.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('claude')
    await expect(measures().getByRole('tab', { name: /^Tokens 3,600 /u })).toBeVisible()
    const dates = await page.evaluate(() => {
      const format = (value: Date) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
      const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1)
      const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1)
      const yearStart = new Date(); yearStart.setDate(yearStart.getDate() - 365)
      return { tomorrow: format(tomorrow), yesterday: format(yesterday), today: format(new Date()), yearStart: format(yearStart) }
    })
    await page.getByRole('combobox', { name: 'Date range', exact: true }).selectOption('custom')
    await page.getByLabel('From', { exact: true }).fill(dates.yearStart); await page.getByLabel('Through', { exact: true }).fill(dates.today)
    await expect(page.locator('.usage-chart__column')).toHaveCount(366)
    await harness.resize(820, 560)
    expect(await page.locator('.usage-chart__plot').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await page.getByLabel('From', { exact: true }).fill(dates.tomorrow); await page.getByLabel('Through', { exact: true }).fill(dates.tomorrow)
    await expect(measures().getByRole('tab', { name: /^Prompts 0 /u })).toBeVisible()
    await expect(measures().getByRole('tab', { name: /^Tokens — /u })).toBeVisible()
    await page.getByLabel('Through', { exact: true }).fill(dates.yesterday)
    await expect(page.getByRole('alert')).toContainText('Choose an end date on or after the start date.')
    await page.getByRole('combobox', { name: 'Date range', exact: true }).selectOption('30')
    await page.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('all')
    await page.getByRole('combobox', { name: 'Computer', exact: true }).selectOption('all')
    await expect(measures().getByRole('tab', { name: /^Tokens 3,600 /u })).toBeVisible()
    await harness.resize(820, 560)
    await measures().getByRole('tab', { selected: true }).focus()
    await page.keyboard.press('Home')
    for (let index = 0; index < 6; index++) {
      await expect.poll(async () => JSON.stringify(await measures().evaluate(element => {
        const strip = element.getBoundingClientRect()
        const selected = element.querySelector('[aria-selected="true"]')!.getBoundingClientRect()
        return { fits: selected.left >= strip.left - 1 && selected.right <= strip.right + 1,
          left: selected.left, right: selected.right, stripLeft: strip.left, stripRight: strip.right,
          index: [...element.children].findIndex(child => child.getAttribute('aria-selected') === 'true') }
      }))).toContain('"fits":true')
      if (index < 5) await page.keyboard.press('ArrowRight')
    }
    await measures().getByRole('tab', { name: /^Prompts /u }).click()
    await harness.capture(artifacts, 'overview-dark-820.png', 820, 560, 'dark')

    const clear = page.getByRole('button', { name: 'Clear usage', exact: true })
    await clear.click(); await expect(page.getByRole('dialog', { name: 'Clear saved usage?', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Keep usage', exact: true })).toBeFocused()
    await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0); await expect(clear).toBeFocused()
    await clear.click()
    await action(nativeId, { type: 'raw', persist: true, frame: usageAssistantFrame(nativeId, 'first-accounting-request', 150) })
    await expect.poll(async () => (await activity()).totals.tokens.total.value, usageWait).toBe(3650)
    await page.getByRole('button', { name: 'Clear saved usage', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('Usage changed while the question was open.')
    expect((await activity()).totals.tokens.total.value).toBe(3650)
    await expect(clear).toBeEnabled(); await clear.click(); await page.getByRole('button', { name: 'Clear saved usage', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('Saved usage figures were cleared')
    expect((await activity()).totals.tokenRecords).toBe(0); expect((await activity()).totals.prompts.total).toBe(0)
    await action(nativeId, { type: 'raw', persist: true, frame: usageAssistantFrame(nativeId, 'first-accounting-request', 200) })
    await action(nativeId, { type: 'raw', frame: usageResultFrame(nativeId) })
    // The final result is an observable native fence, not an arbitrary wait for the buffer.
    await expect.poll(async () => (await page.evaluate(() => window.sotto!.agents!.get())).host.threads.find(thread => thread.id === threadId)?.status, usageWait).toBe('idle')
    expect((await activity()).totals.tokenRecords).toBe(0)
    const afterClear = await activity()

    await openThreads(page); await expect(promptField(page)).toBeEditable()
    await fillPrompt(promptField(page), 'Start a new counted native turn after clear.')
    await page.getByRole('button', { name: 'Send prompt', exact: true }).click()
    await waitForNativePrompt(harness, 2)
    const second = usageAssistantFrame(nativeId, 'second-accounting-request')
    await action(nativeId, { type: 'raw', persist: true, frame: second }); await action(nativeId, { type: 'raw', frame: usageResultFrame(nativeId) })
    await expect.poll(async () => (await activity()).totals.tokens.total.value, usageWait).toBe(3600)
    expect((await activity()).totals.prompts.user).toBe(1)
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    await page.getByRole('tab', { name: 'Application', exact: true }).click()
    const history = page.getByRole('switch', { name: 'Keep local history', exact: true })
    await expect(history).toHaveAttribute('aria-checked', 'true'); await history.click(); await expect(history).toHaveAttribute('aria-checked', 'false')
    await expect.poll(() => page.evaluate(async () => (await window.sotto!.getSettings()).historyEnabled)).toBe(false)
    await harness.open()
    await expect(measures().getByRole('tab', { name: /^Tokens 3,600 /u })).toBeVisible()
    const beforeQuit = await activity()
    expect(beforeQuit.totals.prompts.user).toBe(1); expect(beforeQuit.totals.tokens.total.value).toBe(3600)
    await harness.close()

    page = await harness.launch(); await harness.connect()
    await page.evaluate(async threadId => {
      await window.sotto!.agents!.command({ type: 'select-thread', threadId }); await window.sotto!.agents!.command({ type: 'observe-threads', threadIds: [threadId] })
    }, threadId)
    await harness.open()
    const restored = await activity()
    expect(restored.totals.tokens.total.value).toBe(3600); expect(restored.totals.prompts.user).toBe(1)
    await openThreads(page)
    // Opening the observed thread starts the owned fake process; no new user prompt is sent on this restart.
    await expect.poll(() => readFile(join(harness.client, `alive-${nativeId}.json`)).then(() => true, () => false), usageWait).toBe(true)
    await action(nativeId, { type: 'raw-burst', frames: [first, second, { ...usageResultFrame(nativeId), duration_ms: 333 }] })
    await expect.poll(async () => (await page.evaluate(() => window.sotto!.agents!.get())).host.threads.find(thread => thread.id === threadId)?.usage?.elapsedMs, usageWait).toBe(333)
    expect((await activity()).totals.tokens.total.value).toBe(3600)
    expect((await activity()).totals.prompts.user).toBe(1)
    await harness.open()
    const afterReplay = await activity()
    expect(afterReplay.totals.tokenRecords).toBe(1)
    expect(await readFile(join(harness.client, 'violations.jsonl'), 'utf8').catch(() => '')).toBe('')
    expect(harness.pageErrors).toEqual([])
    await writeFile(join(artifacts, 'verified.json'), JSON.stringify({ surface: 'production Electron main and native Claude adapter, scripted external client',
      version: '0.1.38-owl.20261012.1', syntheticOnly: true, networkDisabled: true, productTestBridgeAbsent: true,
      contentSizeTolerance: 2, contrastVisibleOnly: true, openedAboutContrast: aboutContrast,
      selectedModel: SELECTED_USAGE_MODEL, reportedModel: REPORTED_USAGE_MODEL, initial: initial.totals, afterClear: afterClear.totals,
      newTurn: beforeQuit.totals, afterRestart: restored.totals, afterReplay: afterReplay.totals, captures: harness.captures,
      historyOffRetained: true, staleClearRefused: true, activeAndReplayedGroupsSuppressed: true, pageErrorCount: harness.pageErrors.length }, null, 2))
  } finally { await harness.cleanup() }
})

test('stable hides Usage and its preload bridge while preserving an Owl numeric database', async () => {
  test.setTimeout(90_000)
  const harness = await usageDashboardHarness()
  try {
    let page = await harness.launch()
    await harness.open(); expect((await harness.activity()).metadata.generation).toBe(0)
    await harness.close()
    const path = join(harness.profile, 'usage.sqlite')
    const digest = async () => createHash('sha256').update(await readFile(path)).digest('hex')
    const before = await digest()
    page = await harness.launch(false)
    expect(await harness.currentApp().evaluate(({ app }) => app.getVersion())).not.toContain('-owl.')
    await expect(page.getByRole('link', { name: 'Usage', exact: true })).toHaveCount(0)
    expect(await page.evaluate(() => typeof window.sotto?.usage)).toBe('undefined')
    await harness.close(); expect(await digest()).toBe(before)
    expect(harness.pageErrors).toEqual([])
  } finally { await harness.cleanup() }
})
