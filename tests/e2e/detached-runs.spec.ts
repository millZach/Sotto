import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import type { SottoE2EBridge } from '../../src/shared/e2e'
import { fakeClaudeLaunches, fakeClaudePrompts } from '../fixtures/fakeClaudeRecords'
import { writeProviderAction } from '../fixtures/providerRecords'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { fillPrompt, promptField } from './support/prompt'
import { closeSotto, launchSotto, openThreads, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'
import { hostKeysPerTest } from './support/hostKeys'
import { startMonitoredThread } from './support/monitoredThread'
import { resizeContentWindow } from './support/sottoWindow'
import { elementContrast } from './support/elementContrast'
import { evidenceDirectory } from '../fixtures/evidence'

/**
 * A detached run (#2476, variant 1 of docs/prototypes/detached-runs-prototype.html): a run the thread cut loose stands
 * under its last reply as background work, the readout counts it and the sidebar keeps the thread Working. The run is
 * given to the window as its host would publish it; finding one in the process table is covered by
 * tests/integration/detachedRunScan.test.ts, since a desktop journey's fake providers detach nothing.
 */
type HostEvent = Parameters<NonNullable<SottoE2EBridge['agentEvent']>>[0]
const evidence = evidenceDirectory('artifacts/detached-runs')
const hostKeys = hostKeysPerTest()
test.beforeEach(() => { hostKeys.reset() })
const pane = (page: Page): Locator => page.locator(`section.thread-pane[data-thread-id="${hostKeys.key('workshop')}"]`)
const run = {
  id: 'ced23e61-1ed2-577f-9219-04dcdf869f0d', label: 'tetherfall-art-director', type: 'detached-run' as const, startedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
  run: { client: 'Claude Code', model: 'claude-fable-5-2', effort: 'high', folder: '/home/zach/Projects/2.5 shooter/.claude/worktrees/art-push',
    command: 'claude -p --session-id fbb9b8df-81c0-44d6-8944-eada812138d5 --name tetherfall-art-director --model claude-fable-5-2 --effort high --permission-mode bypassPermissions "Read and do .zstack/studio/art-push/director.md"' },
}

async function event(page: Page, value: HostEvent): Promise<void> {
  await page.evaluate(async value => { await window.sottoE2E!.agentEvent!(value) }, value)
}
async function capture(launched: LaunchedSotto, name: string): Promise<void> {
  await mkdir(evidence, { recursive: true })
  await launched.page.mouse.move(0, 0)
  await launched.page.screenshot({ path: join(evidence, `${name}.png`), animations: 'disabled', caret: 'hide' })
}

test('a detached run stands under the last reply, counts in the readout and keeps the thread Working', async () => {
  test.setTimeout(180_000)
  const launched = await launchSotto()
  try {
    const { page } = launched
    await startMonitoredThread(launched, hostKeys.read, pane)
    const at = (ago: number): string => new Date(Date.now() - ago).toISOString()
    await event(page, { type: 'history', threadId: 'workshop', text: '', status: 'idle', activities: [], messages: [
      { id: 'ask', role: 'user', text: 'Push the art direction across the whole Tetherfall set. Run it as its own director so it keeps going after this turn.', createdAt: at(22 * 60_000) },
      { id: 'reply', role: 'assistant', text: 'The art director is running on its own now, in .claude/worktrees/art-push. I will leave it to finish.', createdAt: at(20 * 60_000) },
    ] })
    await event(page, { type: 'background-work', threadId: 'workshop', text: '', backgroundWork: [run], status: 'idle' })

    const still = pane(page).getByRole('region', { name: 'Still working after this reply' })
    const row = still.getByRole('listitem', { name: 'Detached run: tetherfall-art-director, Working' })
    await expect(row).toBeVisible({ timeout: 30_000 })
    await expect(row).toContainText('Claude Code')
    await expect(row).toContainText('claude-fable-5-2, high')
    await expect(row).toContainText('running 20m')
    await expect(row).toContainText('Started from this thread and left running after its turn.')
    await expect(pane(page).locator('.thread-monitor__status')).toHaveText('Working · 1 detached run')
    // The sidebar keeps the thread under Working now, named from its first message, though no turn runs.
    const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
    await expect(sidebar.getByRole('button', { name: 'Working now 1 thread' })).toBeVisible()
    await expect(sidebar.getByRole('button', { name: /^Push the art direction/u })).toHaveAccessibleDescription(/Working/u)

    // The keyboard reaches Stop and the command's disclosure, in the order the eye does.
    const stop = row.getByRole('button', { name: 'Stop the detached run tetherfall-art-director' })
    const summary = row.locator('summary')
    await stop.focus()
    await page.keyboard.press('Tab')
    await expect(summary).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(row.locator('details')).toHaveAttribute('open', '')
    await expect(row.locator('details code')).toContainText('Read and do .zstack/studio/art-push/director.md')

    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
      await resizeContentWindow(launched, width, height, [700, 500])
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(appearance => window.sotto!.updateSettings({ appearance }), appearance)
        await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
        const overflow = await pane(page).evaluate(element => [...element.querySelectorAll<HTMLElement>('.thread-workspace__transcript, .delegated-work__row, .delegated-work__command code')]
          .filter(item => item.scrollWidth > item.clientWidth + 1).map(item => item.className))
        expect(overflow, `${appearance} ${width}x${height}`).toEqual([])
        for (const part of ['.delegated-work__kind', '.delegated-work__name > :last-child', '.delegated-work__state', '.delegated-work__stop', '.delegated-work__meta', '.delegated-work__line', '.delegated-work__command summary', '.delegated-work__command code']) {
          expect(await elementContrast(row.locator(part).first()), `${part}, ${appearance} ${width}x${height}`).toBeGreaterThanOrEqual(4.5)
        }
        await row.scrollIntoViewIfNeeded()
        await capture(launched, `detached-run-${appearance}-${width}x${height}`)
      }
    }

    // Stop reaches main. A desktop journey looks for no runs, so main says what happened and that nothing was stopped.
    await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark' }))
    await stop.click()
    await expect(row.getByRole('alert')).toContainText('Nothing was stopped.')

    // The run ends: its row goes and the thread reads Done again.
    await event(page, { type: 'background-work', threadId: 'workshop', text: '', backgroundWork: [], status: 'idle' })
    await expect(still).toHaveCount(0)
    await expect(pane(page).locator('.thread-monitor')).toHaveCount(0)
  } finally {
    await closeSotto(launched)
  }
})

/**
 * The whole way in the built app: the real Claude adapter over the fake CLI, a run started outside Sotto with that
 * thread's Claude Code session in its environment, as a thread's `nohup claude -p` keeps it, found by the watch after the
 * next turn ends, and ended by Stop. The stand-in is a script named `claude` that Node runs, which the scan knows as
 * Claude Code; this test starts it, so it is outside Sotto's process tree as a detached run is.
 */
test('finds a run started with a Claude thread\'s session after a turn ends, and Stop ends it', async () => {
  test.setTimeout(240_000)
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-detached-runs-' })).directory
  const root = join(profile, 'native-fixture')
  const claude = join(root, 'claude'), project = join(root, 'project'), runFolder = join(root, 'run')
  for (const folder of ['claude', 'codex', 'project', 'run']) await mkdir(join(root, folder), { recursive: true })
  await writeFile(join(runFolder, 'claude.mjs'), 'setInterval(() => {}, 1000)\n')
  const previous = { root: process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT, executable: process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE, runs: process.env.SOTTO_E2E_DETACHED_RUNS }
  process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT = root
  process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE = process.execPath
  process.env.SOTTO_E2E_DETACHED_RUNS = '1'
  let launched: LaunchedSotto | undefined
  let runPid: number | undefined
  try {
    launched = await launchSotto('success', profile)
    const { page } = launched
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
      const configured = await window.sotto!.agents!.command({ type: 'configure', patch: { provider: 'claude', enabled: true, enabledProviders: ['claude'] } })
      if (configured.error) throw new Error(configured.error)
      const connected = await window.sotto!.agents!.command({ type: 'connect', provider: 'claude' })
      if (connected.error) throw new Error(connected.error)
    })
    await page.reload()
    await resizeWindow(launched, 1280, 800)
    await page.evaluate(async path => {
      const agents = window.sotto!.agents!
      const created = await agents.command({ type: 'create-project', provider: 'claude', title: 'Tetherfall', path, useExisting: true })
      if (created.error) throw new Error(created.error)
      const projectId = created.host.projects.find(item => item.title === 'Tetherfall')!.id
      const model = (await agents.get()).host.models.find(item => item.providerId === 'claude' && item.ready)
      if (!model) throw new Error('No ready Claude model.')
      const thread = await agents.command({ type: 'create-thread', projectId, title: 'Art push', titleSource: 'user', modelId: model.id, workingCopy: 'shared' })
      if (thread.error || !thread.activeThreadId) throw new Error(thread.error ?? 'No thread was created.')
    }, project)
    await openThreads(page)
    await page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: 'Art push', exact: true }).click()
    const shown = page.locator('section.thread-pane:not([data-hidden])')
    const prompt = promptField(shown)
    await fillPrompt(prompt, 'Start the art director on its own.')
    await prompt.press('Enter')
    await expect.poll(() => fakeClaudePrompts(claude), { timeout: 30_000 }).toBe(1)
    const [launch] = await fakeClaudeLaunches(claude)
    expect(launch?.session).toBeTruthy()

    // During the turn, the run the thread cuts loose, with its session as Claude Code passes it to every command it runs.
    const run = spawn(process.execPath, [join(runFolder, 'claude.mjs'), '--name', 'e2e-art-director', '--model', 'claude-test'], {
      cwd: runFolder, detached: process.platform !== 'win32', stdio: 'ignore', windowsHide: true,
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: launch!.session },
    })
    run.unref()
    runPid = run.pid
    // The turn ends, and a few seconds later Sotto looks.
    await writeProviderAction(join(claude, `control-${launch!.session}.json`), { type: 'complete', text: 'The art director is running on its own now.' })
    await expect(shown.getByText('The art director is running on its own now.')).toBeVisible({ timeout: 30_000 })
    const row = shown.getByRole('listitem', { name: 'Detached run: e2e-art-director, Working' })
    await expect(row).toBeVisible({ timeout: 60_000 })
    await expect(row).toContainText('Claude Code')
    await expect(row).toContainText('claude-test')
    await expect(shown.locator('.thread-monitor__status')).toHaveText('Working · 1 detached run')
    await capture(launched, 'found-by-the-watch-dark-1280x800')

    await row.getByRole('button', { name: 'Stop the detached run e2e-art-director' }).click()
    await expect(row).toHaveCount(0, { timeout: 60_000 })
    expect(() => process.kill(runPid!, 0)).toThrow()
    runPid = undefined
    await expect(shown.locator('.thread-monitor')).toHaveCount(0)
  } finally {
    if (runPid !== undefined) try { process.kill(runPid) } catch { /* it has already ended */ }
    if (launched) await closeSotto(launched)
    for (const [name, value] of [['SOTTO_E2E_NATIVE_FIXTURE_ROOT', previous.root], ['SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE', previous.executable], ['SOTTO_E2E_DETACHED_RUNS', previous.runs]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value
    }
    await removeOwnedE2EProfile(profile)
  }
})
