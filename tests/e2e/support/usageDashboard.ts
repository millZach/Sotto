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
      return { documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        roomOverflow: room.scrollWidth > room.clientWidth + 1, scrollOverflow: scroll.scrollWidth > scroll.clientWidth + 1,
        clippedNumbers: [...room.querySelectorAll<HTMLElement>('.usage-index__value:not(.usage-index__value--text),.usage-token-facts dd,.usage-window__head b')]
          .filter(element => element.scrollWidth > element.clientWidth + 1).map(element => element.className) }
    })
    expect(layout).toEqual({ documentOverflow: false, roomOverflow: false, scrollOverflow: false, clippedNumbers: [] })
    // Closed native details defer descendant styles; measure the rendered text.
    const ratios = await textContrast(currentPage().locator('.usage-view'), 'h1,h2,h3,p,dt,dd,button,select,label,summary,th,td,.usage-index__label,.usage-index__note', true)
    const nonempty = ratios.filter(row => row.text.trim().length > 0)
    expect(nonempty.filter(row => row.ratio < 4.5)).toEqual([])
    const minimumContrast = Math.min(...nonempty.map(row => row.ratio))
    await currentPage().screenshot({ path: join(directory, name), animations: 'disabled' })
    const actual = await currentPage().evaluate(() => ({ width: innerWidth, height: innerHeight }))
    captures.push({ name, width: actual.width, height: actual.height, targetWidth: width, targetHeight: height, appearance: mode, minimumContrast })
  }
  return { root, profile, project, client, home, currentPage, currentApp, launch, connect, close, cleanup, action, read, activity, open, resize, appearance, capture, pageErrors, captures }
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
