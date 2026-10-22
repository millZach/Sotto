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
  REPORTED_USAGE_MODEL, SEEDED_USAGE_MODELS, SELECTED_USAGE_MODEL, chooseUsageFilter, seedUsageHistory, usageAssistantFrame, usageDashboardHarness,
  usageResultFrame, usageWait, waitForNativePrompt,
} from './support/usageDashboard'

const artifacts = evidenceDirectory('artifacts/usage-dashboard')
const splitArtifacts = evidenceDirectory('artifacts/usage-chart-split')

test('Owl Usage counts real accepted sends under their served model, filters by place and clears safely, and survives history off and restart', async () => {
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
    await expect(measures().getByRole('tab')).toHaveCount(7)
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
    // Claude Code answers get_usage with the same windows its passive events report below.
    await writeFile(join(harness.client, 'usage-script.json'), JSON.stringify({ rate_limits: {
      five_hour: { utilization: 0, resets_at: new Date(resetsAt * 1000).toISOString() },
      seven_day: { utilization: 20, resets_at: new Date((resetsAt + 86_400) * 1000).toISOString() } } }))
    await action(nativeId, { type: 'raw', frame: { type: 'rate_limit_event', session_id: nativeId,
      rate_limit_info: { rateLimitType: 'five_hour', status: 'allowed', utilization: 0, resetsAt } } })
    await action(nativeId, { type: 'raw', frame: { type: 'rate_limit_event', session_id: nativeId,
      rate_limit_info: { rateLimitType: 'seven_day', status: 'allowed', utilization: 0.2, resetsAt: resetsAt + 86_400 } } })
    await expect.poll(async () => (await activity()).totals.tokens.total.value, usageWait).toBe(3600)
    const initial = await activity()
    expect(initial.totals.tokens).toMatchObject({ input: { value: 3500 }, output: { value: 100 }, cached: { value: 2000 },
      cacheWrite: { value: 500 }, cacheWrite5m: { value: 0 }, cacheWrite1h: { value: 500 }, total: { value: 3600 } })
    // The prompt counts under the model that served it: the first token report after it in the thread.
    expect(initial.models).toHaveLength(1)
    expect(initial.models[0]!.modelId.endsWith(REPORTED_USAGE_MODEL)).toBe(true)
    expect(initial.models[0]).toMatchObject({ prompts: { user: 1 }, tokens: { total: { value: 3600 } } })
    expect(initial.models.some(row => row.modelId.endsWith(SELECTED_USAGE_MODEL))).toBe(false)

    await harness.open()
    await expect(measures().getByRole('tab', { name: /^Tokens 3,600 /u })).toBeVisible()
    await expect(measures().getByRole('tab', { name: /^From cache 57% /u })).toBeVisible()
    await expect(measures().getByRole('tab', { name: /^Room left 80% /u })).toBeVisible(usageWait)
    await expect(measures().getByRole('tab', { name: /^Where 100% in Sotto /u })).toBeVisible()
    await harness.capture(artifacts, 'overview-dark-1600.png', 1600, 1000, 'dark')

    const prompts = measures().getByRole('tab', { name: /^Prompts /u })
    await prompts.focus(); await prompts.press('End')
    await expect(measures().getByRole('tab', { name: /^Busiest hour /u })).toHaveAttribute('aria-selected', 'true')
    const hours = page.getByRole('group', { name: /^Prompts you sent, by weekday and hour\./u })
    await hours.focus(); await hours.press('ArrowRight')
    await expect(page.locator('.usage-when')).toContainText('Mondays, 10 AM to 11 AM')
    await hours.press('Escape'); await expect(page.locator('.usage-when')).toContainText('Busiest:')
    await measures().getByRole('tab', { name: /^Prompts /u }).click()
    const daily = page.getByRole('group', { name: /^Prompts per day, /u })
    await daily.focus(); await daily.press('End')
    await expect(page.locator('.usage-when')).toContainText('so far · 1 prompt')
    await daily.press('Escape'); await expect(page.locator('.usage-when')).toContainText('Under 1 a day')
    await expect(page.locator('.usage-split-block').filter({ hasText: 'Sent from' })).toContainText('Sotto1')

    await measures().getByRole('tab', { name: /^Tokens /u }).click()
    const fact = (label: string) => page.locator('.usage-tokens__legend div').filter({ has: page.getByText(label, { exact: true }) }).locator('dd')
    await expect(fact('Cache read')).toHaveText('2,000'); await expect(fact('Cache write')).toHaveText('500')
    await expect(fact('Uncached input')).toHaveText('1,000'); await expect(fact('Output')).toHaveText('100')
    await expect(page.getByRole('img', { name: '3,500 input tokens, including 2,000 cache read and 500 cache write, then 100 output tokens.', exact: true })).toBeVisible()
    await harness.capture(artifacts, 'tokens-dark-1280.png', 1280, 800, 'dark')

    const overview = views().getByRole('tab', { name: 'Overview', exact: true })
    await overview.focus(); await overview.press('ArrowRight')
    await expect(views().getByRole('tab', { name: 'Subscriptions', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('button', { name: /^Provider: /u })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Where: /u })).toHaveCount(0)
    const claude = page.getByRole('region', { name: 'Claude Code', exact: true })
    await expect(claude).toContainText('100%'); await expect(claude).toContainText('80%')
    await expect(claude.locator('.usage-window')).toHaveCount(2)
    await expect(claude).toContainText('of the time left')
    await expect(page.getByRole('region', { name: 'Devin', exact: true })).toContainText("Sotto can't read Devin's limits yet.")
    await harness.appearance('light'); await harness.resize(820, 560)
    await claude.locator('.usage-window').last().scrollIntoViewIfNeeded()
    await harness.capture(artifacts, 'subscriptions-light-820.png', 820, 560, 'light')
    await views().getByRole('tab', { name: 'Subscriptions', exact: true }).press('ArrowRight')
    await expect(views().getByRole('tab', { name: 'Models', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.usage-row')).toHaveCount(1)
    const about = page.getByText('About these numbers', { exact: true })
    await about.click()
    await expect(page.locator('.usage-about[open]')).toBeVisible()
    const aboutContrast = await textContrast(page.locator('.usage-about'), 'li', true)
    expect(aboutContrast).toHaveLength(7)
    expect(aboutContrast.filter(row => row.ratio < 4.5)).toEqual([])
    await about.press('Escape'); await expect(about).toBeFocused()
    await expect(page.locator('.usage-about[open]')).toHaveCount(0)
    await page.getByRole('radio', { name: 'Tokens', exact: true }).click()
    await expect(page.getByRole('radio', { name: 'Tokens', exact: true })).toHaveAttribute('aria-checked', 'true')
    const modelRow = page.locator('.usage-row__main').first()
    await expect(modelRow).toHaveAccessibleName(/^Claude Opus 5\.5, Claude Code: 1 prompt, 3,600 tokens, 57% from cache$/u)
    await modelRow.click(); await expect(modelRow).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('.usage-detail')).toContainText('Tokens per prompt3,600')
    await expect(page.locator('.usage-detail')).toContainText('Prompts per day')
    await expect(page.locator('.usage-view')).not.toContainText(REPORTED_USAGE_MODEL)
    await modelRow.press('Escape'); await expect(modelRow).toHaveAttribute('aria-expanded', 'false'); await expect(modelRow).toBeFocused()
    await harness.capture(artifacts, 'models-light-1280.png', 1280, 800, 'light')
    await views().getByRole('tab', { name: 'Models', exact: true }).press('Home')
    await expect(overview).toHaveAttribute('aria-selected', 'true')

    await chooseUsageFilter(page, 'Computer', 'This computer')
    await chooseUsageFilter(page, 'Provider', 'Devin')
    await expect(measures().getByRole('tab', { name: /^Tokens — /u })).toBeVisible()
    await expect(measures().getByRole('tab', { name: /^Prompts 0 /u })).toBeVisible()
    await chooseUsageFilter(page, 'Provider', 'Claude Code')
    await expect(measures().getByRole('tab', { name: /^Tokens 3,600 /u })).toBeVisible()
    await chooseUsageFilter(page, 'Where', 'Outside Sotto')
    await expect(measures().getByRole('tab', { name: /^Prompts 0 /u })).toBeVisible()
    await chooseUsageFilter(page, 'Where', 'In Sotto')
    await expect(measures().getByRole('tab', { name: /^Prompts 1 /u })).toBeVisible()
    await chooseUsageFilter(page, 'Where', 'Everywhere')
    const dates = await page.evaluate(() => {
      const format = (value: Date) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
      const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1)
      const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1)
      const yearStart = new Date(); yearStart.setDate(yearStart.getDate() - 365)
      return { tomorrow: format(tomorrow), yesterday: format(yesterday), today: format(new Date()), yearStart: format(yearStart) }
    })
    await chooseUsageFilter(page, 'Date range', 'Choose dates')
    await page.getByLabel('From', { exact: true }).fill(dates.yearStart); await page.getByLabel('Through', { exact: true }).fill(dates.today)
    await expect(page.locator('.usage-chart__column')).toHaveCount(366)
    await harness.resize(820, 560)
    expect(await page.locator('.usage-chart__plot').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await page.getByLabel('From', { exact: true }).fill(dates.tomorrow); await page.getByLabel('Through', { exact: true }).fill(dates.tomorrow)
    await expect(measures().getByRole('tab', { name: /^Prompts 0 /u })).toBeVisible()
    await expect(measures().getByRole('tab', { name: /^Tokens — /u })).toBeVisible()
    await page.getByLabel('Through', { exact: true }).fill(dates.yesterday)
    await expect(page.getByRole('alert')).toContainText('Choose an end date on or after the start date.')
    await chooseUsageFilter(page, 'Date range', 'Last 30 days')
    await chooseUsageFilter(page, 'Provider', 'All providers')
    await chooseUsageFilter(page, 'Computer', 'All computers')
    await expect(measures().getByRole('tab', { name: /^Tokens 3,600 /u })).toBeVisible()
    await harness.resize(820, 560)
    await measures().getByRole('tab', { selected: true }).focus()
    await page.keyboard.press('Home')
    for (let index = 0; index < 7; index++) {
      await expect.poll(async () => JSON.stringify(await measures().evaluate(element => {
        const strip = element.getBoundingClientRect()
        const selected = element.querySelector('[aria-selected="true"]')!.getBoundingClientRect()
        return { fits: selected.left >= strip.left - 1 && selected.right <= strip.right + 1,
          left: selected.left, right: selected.right, stripLeft: strip.left, stripRight: strip.right,
          index: [...element.children].findIndex(child => child.getAttribute('aria-selected') === 'true') }
      }))).toContain('"fits":true')
      if (index < 6) await page.keyboard.press('ArrowRight')
    }
    await measures().getByRole('tab', { name: /^Prompts /u }).click()
    await harness.capture(artifacts, 'overview-dark-820.png', 820, 560, 'dark')

    const more = page.getByRole('button', { name: 'More usage actions', exact: true })
    const clear = async (): Promise<void> => { await more.click(); await page.getByRole('menuitem', { name: 'Clear usage…', exact: true }).click() }
    await more.focus(); await more.press('ArrowDown')
    await expect(page.getByRole('menuitem', { name: 'Clear usage…', exact: true })).toBeFocused()
    await page.keyboard.press('Escape'); await expect(page.getByRole('menu')).toHaveCount(0); await expect(more).toBeFocused()
    await clear(); await expect(page.getByRole('dialog', { name: 'Clear saved usage?', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Keep usage', exact: true })).toBeFocused()
    await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0); await expect(more).toBeFocused()
    await clear()
    await action(nativeId, { type: 'raw', persist: true, frame: usageAssistantFrame(nativeId, 'first-accounting-request', 150) })
    await expect.poll(async () => (await activity()).totals.tokens.total.value, usageWait).toBe(3650)
    await page.getByRole('button', { name: 'Clear saved usage', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('Usage changed while the question was open.')
    expect((await activity()).totals.tokens.total.value).toBe(3650)
    await clear(); await page.getByRole('button', { name: 'Clear saved usage', exact: true }).click()
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

test('Owl Usage splits the Per day chart by model and provider, as bars or lines, and reads each series for a day', async () => {
  test.setTimeout(150_000)
  const harness = await usageDashboardHarness()
  try {
    await mkdir(splitArtifacts, { recursive: true })
    const seeded = await seedUsageHistory(harness.home)
    const page = await harness.launch()
    await harness.open()
    // The importer reads the seeded transcripts and rollout a few seconds after start.
    await expect.poll(async () => (await harness.activity()).totals.prompts.total, usageWait).toBe(seeded)
    await harness.open()
    const measures = page.getByRole('tablist', { name: 'Usage measures', exact: true })
    await expect(measures.getByRole('tab', { name: new RegExp(`^Prompts ${seeded} `, 'u') })).toBeVisible(usageWait)
    const show = page.getByRole('radiogroup', { name: 'Show on the chart', exact: true })
    const style = page.getByRole('radiogroup', { name: 'Draw the days as', exact: true })
    const plot = page.getByRole('group', { name: /^Prompts per day, /u })
    const values = page.getByRole('list', { name: /^Each model, /u })
    const row = (name: string) => values.getByRole('listitem').filter({ has: page.getByText(name, { exact: true }) }).locator('b')
    const sum = (model: typeof SEEDED_USAGE_MODELS[number]) => model.prompts.reduce((total, count) => total + count, 0)
    // At the minimum the stage sits below the index; bring the Per day block to the top before a capture.
    const toPerDay = async (width: number, height: number): Promise<void> => {
      await harness.resize(width, height)
      await page.locator('.usage-chart-head').evaluate(element => {
        const scroll = element.closest<HTMLElement>('.usage-scroll')!
        scroll.scrollTop += element.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 16
      })
    }
    await expect(show.getByRole('radio', { name: 'Total', exact: true })).toHaveAttribute('aria-checked', 'true')

    await show.getByRole('radio', { name: 'By model', exact: true }).click()
    await expect(values.getByRole('listitem')).toHaveCount(6)
    for (const model of SEEDED_USAGE_MODELS.slice(0, 5)) await expect(row(model.name)).toHaveText(String(sum(model)))
    await expect(row('Other (2)')).toHaveText(String(sum(SEEDED_USAGE_MODELS[5]!) + sum(SEEDED_USAGE_MODELS[6]!)))
    await expect(plot).toHaveAccessibleName(/Stacked by model: Claude Opus 5\.5, GPT-6\.1 Sol, Claude Sonnet 5\.5, Claude Fable 5, Claude Haiku 4\.5 and Other \(2\)\./u)
    await expect(plot).not.toHaveAttribute('aria-busy', 'true')
    await harness.capture(splitArtifacts, 'prompts-by-model-bars-light-1280.png', 1280, 800, 'light')

    await style.getByRole('radio', { name: 'Bars', exact: true }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(style.getByRole('radio', { name: 'Lines', exact: true })).toHaveAttribute('aria-checked', 'true')
    await expect(plot.locator('.usage-chart__line')).toHaveCount(6)
    await expect(plot.locator('.usage-chart__column')).toHaveCount(0)
    await plot.focus(); await plot.press('End'); await plot.press('ArrowLeft')
    const yesterday = SEEDED_USAGE_MODELS.map(model => model.prompts.at(-2)!)
    await expect(row('Claude Opus 5.5')).toHaveText(String(yesterday[0]))
    await expect(page.locator('.usage-view [aria-live="polite"]')).toContainText(`: ${yesterday.reduce((total, count) => total + count, 0)} prompts. Claude Opus 5.5 ${yesterday[0]}, GPT-6.1 Sol ${yesterday[1]},`)
    await harness.capture(splitArtifacts, 'prompts-by-model-lines-dark-1600.png', 1600, 1000, 'dark')
    await plot.press('Escape')
    await expect(row('Claude Opus 5.5')).toHaveText(String(sum(SEEDED_USAGE_MODELS[0]!)))
    // Each model's provider and what Other holds, in words: the next Tab stop after the chart opens them and Escape closes them.
    const more = page.locator('details.usage-values-more')
    const providerOf = (model: typeof SEEDED_USAGE_MODELS[number]): string => model.providerId === 'claude' ? 'Claude Code' : 'Codex'
    await page.keyboard.press('Tab')
    await expect(more.locator('summary')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(more).toHaveAttribute('open', '')
    await expect(more.getByRole('listitem').first()).toHaveText(`${SEEDED_USAGE_MODELS[0]!.name}, from ${providerOf(SEEDED_USAGE_MODELS[0]!)}`)
    await expect(more.getByRole('listitem').last()).toHaveText(`Other holds ${SEEDED_USAGE_MODELS.slice(5).map(model => `${model.name} from ${providerOf(model)}`).join(' and ')}.`)
    await harness.resize(820, 560)
    await more.evaluate(element => element.scrollIntoView({ block: 'end' }))
    await harness.capture(splitArtifacts, 'prompts-by-model-providers-dark-820.png', 820, 560, 'dark')
    await page.keyboard.press('Escape')
    await expect(more).not.toHaveAttribute('open', '')
    await expect(more.locator('summary')).toBeFocused()
    await toPerDay(820, 560)
    await harness.capture(splitArtifacts, 'prompts-by-model-lines-dark-820.png', 820, 560, 'dark')

    // The choice follows to Tokens; By provider there draws Claude Code and Codex as bars.
    await measures.getByRole('tab', { name: /^Tokens /u }).click()
    await expect(show.getByRole('radio', { name: 'By model', exact: true })).toHaveAttribute('aria-checked', 'true')
    await expect(style.getByRole('radio', { name: 'Lines', exact: true })).toHaveAttribute('aria-checked', 'true')
    await show.getByRole('radio', { name: 'By provider', exact: true }).click()
    await style.getByRole('radio', { name: 'Bars', exact: true }).click()
    const providers = page.getByRole('list', { name: /^Each provider, /u })
    await expect(providers.getByRole('listitem')).toHaveCount(2)
    await expect(providers.getByRole('listitem').first()).toContainText('Claude Code')
    await expect(page.getByRole('group', { name: /^Tokens per day, .* Stacked by provider: Claude Code and Codex\./u })).not.toHaveAttribute('aria-busy', 'true')
    await toPerDay(820, 560)
    await harness.capture(splitArtifacts, 'tokens-by-provider-bars-light-820.png', 820, 560, 'light')
    await harness.capture(splitArtifacts, 'tokens-by-provider-bars-dark-1280.png', 1280, 800, 'dark')
    expect(harness.pageErrors).toEqual([])
    await writeFile(join(splitArtifacts, 'verified.json'), JSON.stringify({ surface: 'production Electron main, renderer and history importer over seeded synthetic transcripts',
      syntheticOnly: true, networkDisabled: true, seededPrompts: seeded, models: SEEDED_USAGE_MODELS.map(model => ({ name: model.name, prompts: sum(model) })),
      captures: harness.captures, pageErrorCount: harness.pageErrors.length }, null, 2))
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
