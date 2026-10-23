// Helpers for the production Electron Usage journey; the native client alone is scripted.
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { requireOwnedE2EProfile } from '../../../scripts/e2e-profile-policy.mjs'
import type { UsageDashboardRead, UsageLocalRead } from '../../../src/shared/usageDashboard'
import { ownedE2EProfile } from './e2eProfile'
import { firstSottoWindow } from './sottoLaunch'
import { agentState } from './agentAccess'
import { textContrast } from './textContrast'
import { claudeAssistant, claudeUser, codexMeta, codexTaskStarted, codexTokenCount, codexTurnContext, codexUserMessage, jsonl } from '../../fixtures/usageHistory/lines'

export const usageWait = { timeout: 30_000 }
export const SELECTED_USAGE_MODEL = 'claude-sonnet-4-6'
export const REPORTED_USAGE_MODEL = 'claude-opus-5-5'

export async function usageDashboardHarness() {
  const root = await realpath((await ownedE2EProfile({ prefix: 'sotto-e2e-usage-' })).directory)
  const profile = join(root, 'profile'), project = join(root, 'project'), client = join(root, 'client'), home = join(root, 'home')
  for (const path of [profile, project, client, join(home, '.local', 'bin'), join(home, 'appdata'), join(home, 'localappdata')]) await mkdir(path, { recursive: true })
  const placeholder = join(home, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')
  await writeFile(placeholder, 'Scripted Claude placeholder; never executed.\n'); await chmod(placeholder, 0o700)
  await writeFile(join(client, 'models.json'), JSON.stringify([{ value: SELECTED_USAGE_MODEL, displayName: 'Synthetic Claude', supportsEffort: true, supportedEffortLevels: ['low'] }]))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ onboardingComplete: true, historyEnabled: true, threadTitles: false, appearance: 'dark', reducedMotion: 'on' }))
  let app: ElectronApplication | undefined, page: Page | undefined
  const pageErrors: string[] = []
  const captures: Array<{ name: string; width: number; height: number; targetWidth: number; targetHeight: number; appearance: string; minimumContrast: number }> = []
  const currentPage = (): Page => { if (!page) throw new Error('Usage fixture window is not running'); return page }
  const currentApp = (): ElectronApplication => { if (!app) throw new Error('Usage fixture app is not running'); return app }
  const launch = async (dashboard = true): Promise<Page> => {
    const inherited = new Set(['systemroot', 'systemdrive', 'windir', 'comspec', 'temp', 'tmp', 'lang', 'lc_all', 'display', 'xauthority', 'wayland_display', 'xdg_runtime_dir'])
    app = await electron.launch({ args: [resolve('tests/fixtures/nativeUsageElectronMain.cjs')], env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && inherited.has(key.toLowerCase()))),
      HOME: home, USERPROFILE: home, APPDATA: join(home, 'appdata'), LOCALAPPDATA: join(home, 'localappdata'),
      SOTTO_USAGE_FIXTURE_ROOT: root, SOTTO_USAGE_FIXTURE_NODE: process.execPath,
      ...(dashboard ? { SOTTO_USAGE_DASHBOARD_FIXTURE: '1' } : {}),
    } })
    page = await firstSottoWindow(app)
    page.on('pageerror', error => pageErrors.push(error.name))
    await page.waitForFunction(() => !!window.sotto?.agents)
    await expect(async () => expect(await agentState(page!)).toHaveProperty('host')).toPass(usageWait)
    expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(profile)
    expect(await page.evaluate(() => typeof window.sottoE2E)).toBe('undefined')
    await resize(1280, 800)
    return page
  }
  const connect = async (): Promise<void> => {
    await currentPage().evaluate(async () => {
      const configured = await window.sotto!.agents!.command({ type: 'configure', patch: { provider: 'claude', enabledProviders: ['claude'], enabled: true, reasoning: 'none' } })
      if (configured.error) throw new Error(configured.error)
      const connected = await window.sotto!.agents!.command({ type: 'connect', provider: 'claude' })
      if (connected.error) throw new Error(connected.error)
    })
  }
  const close = async (): Promise<void> => { if (app) await app.close(); app = undefined; page = undefined }
  const cleanup = async (): Promise<void> => {
    await close()
    await rm(requireOwnedE2EProfile(await realpath(root)), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
  const action = async (nativeId: string, value: Record<string, unknown>): Promise<void> => {
    const path = join(client, `control-${nativeId}.json`)
    await expect.poll(() => readFile(path).then(() => false, () => true), usageWait).toBe(true)
    await writeFile(path, JSON.stringify({ id: randomUUID(), ...value }))
  }
  const read = async (): Promise<UsageDashboardRead> => currentPage().evaluate(() => window.sotto!.usage!.read({ includeDaily: true, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }))
  const activity = async (): Promise<UsageLocalRead> => {
    const result = await read()
    expect(result.hosts).toHaveLength(1)
    expect(result.hosts[0]!.status).toBe('ready')
    const value = result.hosts[0]!.activity
    expect(value).toBeDefined()
    return value!
  }
  const open = async (): Promise<void> => {
    const link = currentPage().getByRole('link', { name: 'Usage', exact: true })
    await expect(link).toBeVisible(); await link.click()
    await expect(currentPage().getByRole('heading', { name: 'Usage', exact: true })).toBeVisible()
    await expect(currentPage().getByRole('tablist', { name: 'Usage measures', exact: true })).toBeVisible()
    await expect(currentPage().locator('[aria-label="Usage"]').getByRole('tabpanel').first()).not.toHaveAttribute('aria-busy', 'true')
  }
  const resize = async (width: number, height: number): Promise<void> => {
    await currentApp().evaluate(({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows().find(value => value.webContents.getURL().endsWith('/index.html'))!
      window.setContentSize(size.width, size.height)
    }, { width, height })
    // Windows' minimum content size can round by two pixels at the current display scale.
    await expect.poll(() => currentPage().evaluate(size => Math.max(Math.abs(innerWidth - size.width), Math.abs(innerHeight - size.height)), { width, height }))
      .toBeLessThanOrEqual(2)
    // innerHeight moves a frame before 100vh does; measure once the shell has followed the window.
    await expect.poll(() => currentPage().evaluate(() => Math.abs(document.querySelector('.app-shell')!.getBoundingClientRect().height - innerHeight)))
      .toBeLessThanOrEqual(1)
  }
  const appearance = async (value: 'light' | 'dark'): Promise<void> => {
    await currentPage().evaluate(async value => { await window.sotto!.updateSettings({ appearance: value, reducedMotion: 'on' }) }, value)
    await expect.poll(() => currentPage().evaluate(() => document.documentElement.dataset.theme)).toBe(value)
  }
  const capture = async (directory: string, name: string, width: number, height: number, mode: 'light' | 'dark'): Promise<void> => {
    await appearance(mode); await resize(width, height)
    await currentPage().bringToFront()
    await currentApp().evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(value => value.webContents.getURL().endsWith('/index.html'))!
      window.show(); window.focus()
    })
    await expect.poll(() => currentPage().evaluate(() => document.visibilityState === 'visible' && document.hasFocus()), usageWait).toBe(true)
    const layout = await currentPage().evaluate(() => {
      const room = document.querySelector<HTMLElement>('.usage-view')!
      const scroll = document.querySelector<HTMLElement>('.usage-scroll')!
      // The document never scrolls: only the Usage page does, under a sidebar that fills the window.
      const root = document.documentElement
      return { documentOverflow: root.scrollWidth > root.clientWidth + 1 || root.scrollHeight > root.clientHeight + 1,
        roomOverflow: room.scrollWidth > room.clientWidth + 1, scrollOverflow: scroll.scrollWidth > scroll.clientWidth + 1,
        clippedNumbers: [...room.querySelectorAll<HTMLElement>('.usage-index__value:not([data-words]),.usage-tokens__legend dd,.usage-window__left b,.usage-row__n,.usage-split__item b')]
          .filter(element => element.scrollWidth > element.clientWidth + 1).map(element => element.className) }
    })
    expect(layout).toEqual({ documentOverflow: false, roomOverflow: false, scrollOverflow: false, clippedNumbers: [] })
    // Closed native details defer descendant styles; measure the rendered text.
    const ratios = await textContrast(currentPage().locator('.usage-view'), 'h1,h2,h3,p,dt,dd,li,button,label,summary,.usage-index__label,.usage-index__note,.usage-share__value,.usage-share__note', true)
    const nonempty = ratios.filter(row => row.text.trim().length > 0)
    expect(nonempty.filter(row => row.ratio < 4.5)).toEqual([])
    const minimumContrast = Math.min(...nonempty.map(row => row.ratio))
    await currentPage().screenshot({ path: join(directory, name), animations: 'disabled' })
    const actual = await currentPage().evaluate(() => ({ width: innerWidth, height: innerHeight }))
    captures.push({ name, width: actual.width, height: actual.height, targetWidth: width, targetHeight: height, appearance: mode, minimumContrast })
  }
  return { root, profile, project, client, home, currentPage, currentApp, launch, connect, close, cleanup, action, read, activity, open, resize, appearance, capture, pageErrors, captures }
}

/** Opens a Usage filter by its name and picks one of its choices, as a pointer does. */
export async function chooseUsageFilter(page: Page, name: string, choice: string): Promise<void> {
  await page.getByRole('button', { name: new RegExp(`^${name}: `, 'u') }).click()
  await page.getByRole('listbox', { name, exact: true }).getByRole('option', { name: choice, exact: true }).click()
  await expect(page.getByRole('button', { name: `${name}: ${choice}`, exact: true })).toBeFocused()
}

export function usageAssistantFrame(session: string, id: string, output = 100) {
  return { type: 'assistant', uuid: `fixture-${id}`, session_id: session, timestamp: new Date().toISOString(),
    message: { id, role: 'assistant', model: REPORTED_USAGE_MODEL, content: [{ type: 'text', text: 'Scripted native accounting reply.' }],
      usage: { input_tokens: 1000, output_tokens: output, cache_read_input_tokens: 2000, cache_creation_input_tokens: 500,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 500 } } } }
}
export const usageResultFrame = (session: string) => ({ type: 'result', subtype: 'success', session_id: session, is_error: false,
  duration_ms: 100, result: 'Scripted native accounting reply.', modelUsage: { [REPORTED_USAGE_MODEL]: { contextWindow: 200_000 } } })

export async function waitForNativePrompt(harness: Awaited<ReturnType<typeof usageDashboardHarness>>, count: number): Promise<string> {
  let nativeId = ''
  await expect(async () => {
    const aliases = JSON.parse(await readFile(join(harness.profile, 'claude-threads.json'), 'utf8')) as Record<string, { sessionId: string; cwd: string; modelId: string }>
    expect(Object.values(aliases)).toHaveLength(1)
    const alias = Object.values(aliases)[0]!
    expect(alias.cwd).toBe(harness.project); expect(alias.modelId).toBe(SELECTED_USAGE_MODEL)
    const records = (await readFile(join(harness.client, 'requests.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { method: string; params?: { frame?: { type?: string; session_id?: string } } })
    expect(records.filter(row => row.method === 'user' && row.params?.frame?.type === 'user' && row.params.frame.session_id === alias.sessionId)).toHaveLength(count)
    nativeId = alias.sessionId
  }).toPass(usageWait)
  return nativeId
}

/**
 * Seven models' prompts on each of the last fourteen days, oldest first: five Claude models in Claude Code's own
 * transcripts and two Codex models in a Codex CLI rollout, all outside Sotto. Invented numbers.
 */
export const SEEDED_USAGE_MODELS: ReadonlyArray<{ readonly providerId: 'claude' | 'codex'; readonly modelId: string; readonly name: string; readonly prompts: readonly number[]; readonly input: number; readonly output: number }> = [
  { providerId: 'claude', modelId: 'claude-opus-5-5', name: 'Claude Opus 5.5', prompts: [6, 8, 7, 0, 9, 10, 8, 3, 0, 11, 12, 9, 10, 5], input: 40_000, output: 900 },
  { providerId: 'codex', modelId: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', prompts: [3, 4, 2, 0, 5, 6, 4, 1, 0, 6, 7, 5, 6, 3], input: 30_000, output: 700 },
  { providerId: 'claude', modelId: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', prompts: [2, 2, 3, 0, 2, 3, 1, 1, 0, 3, 2, 2, 3, 1], input: 20_000, output: 500 },
  { providerId: 'claude', modelId: 'claude-fable-5', name: 'Claude Fable 5', prompts: [0, 0, 0, 0, 1, 2, 2, 1, 0, 2, 3, 2, 2, 1], input: 60_000, output: 1_200 },
  { providerId: 'claude', modelId: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', prompts: [1, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 1, 0, 1], input: 8_000, output: 300 },
  { providerId: 'codex', modelId: 'gpt-6-mini', name: 'GPT-6 Mini', prompts: [1, 1, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 1, 0], input: 6_000, output: 200 },
  { providerId: 'claude', modelId: 'claude-opus-4-6', name: 'Claude Opus 4.6', prompts: [1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], input: 30_000, output: 600 },
]

/** Writes the seeded history where the importer reads it, under the harness's own home. Returns every prompt it holds. */
export async function seedUsageHistory(home: string): Promise<number> {
  const claude = join(home, '.claude', 'projects', 'usage-fixture')
  await mkdir(claude, { recursive: true })
  // A day's prompts sit a few minutes apart before now on that calendar day, so today's never lands in the future.
  const at = (back: number, step: number): string => { const date = new Date(Date.now() - 20 * 60_000 - step * 7_000); date.setDate(date.getDate() - back); return date.toISOString() }
  let prompts = 0
  const codexTurns: Array<{ when: string; turn: string; modelId: string; last: { input: number; cached: number; output: number } }> = []
  for (const [order, model] of SEEDED_USAGE_MODELS.entries()) {
    for (const [index, count] of model.prompts.entries()) {
      if (count === 0) continue
      const back = model.prompts.length - 1 - index
      prompts += count
      if (model.providerId === 'claude') {
        const session = randomUUID()
        const lines = Array.from({ length: count }, (_, step) => [
          claudeUser({ session, uuid: randomUUID(), at: at(back, order * 20 + step * 2) }),
          claudeAssistant({ session, id: `msg_${model.modelId}_${index}_${step}`, model: model.modelId, at: at(back, order * 20 + step * 2 + 1),
            usage: { input: model.input / 10, read: model.input * 0.8, write: model.input / 10, output: model.output } }),
        ]).flat()
        await writeFile(join(claude, `${session}.jsonl`), jsonl(lines))
      } else {
        for (let step = 0; step < count; step++) {
          codexTurns.push({ when: at(back, order * 20 + step * 2), turn: `turn-${model.modelId}-${index}-${step}`, modelId: model.modelId,
            last: { input: model.input, cached: model.input * 0.7, output: model.output } })
        }
      }
    }
  }
  const sessions = join(home, '.codex', 'sessions', '2026', '10', '21')
  await mkdir(sessions, { recursive: true })
  // One Codex CLI session in time order, its running totals rising turn by turn as Codex writes them.
  let running = { input: 0, cached: 0, output: 0 }
  const turns = codexTurns.sort((a, b) => a.when.localeCompare(b.when)).flatMap(({ when, turn, modelId, last }) => {
    running = { input: running.input + last.input, cached: running.cached + last.cached, output: running.output + last.output }
    return [codexTaskStarted({ turn, at: when }), codexTurnContext({ turn, model: modelId, at: when }), codexUserMessage({ at: when }), codexTokenCount({ at: when, total: running, last })]
  })
  await writeFile(join(sessions, 'rollout-2026-10-21T09-00-00-usage-fixture.jsonl'), jsonl([codexMeta({ id: 'usage-fixture-codex', originator: 'codex-tui', at: at(14, 0) }), ...turns]))
  return prompts
}
