import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { firstSottoWindow, openThreads } from './support/sottoLaunch'

/**
 * Production main and the production Claude adapter over the scripted Claude Code CLI (#768). The CLI streams a
 * thinking block and holds its reply, so the thread is seen with only the thinking arrived: the Thinking row must be
 * there before any reply text. The words are invented.
 */
const evidence = resolve('artifacts/show-thinking')
const wait = { timeout: 30_000 }
const THINKING = 'Check the parser before the tests, then compare the two outputs.'
const REPLY = 'The parser keeps the trailing newline.'
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const

test('a Claude thread shows its thinking as a row before the first reply text', async () => {
  test.setTimeout(180_000)
  // The scripted entry point accepts only a folder it can prove is its own, named this way.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sotto-e2e-usage-thinking-')))
  const profile = join(root, 'profile'), project = join(root, 'project'), client = join(root, 'client'), home = join(root, 'home')
  let app: ElectronApplication | undefined
  try {
    for (const path of [profile, project, client, join(home, '.local', 'bin'), join(home, 'appdata'), join(home, 'localappdata'), evidence]) await mkdir(path, { recursive: true })
    const placeholder = join(home, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')
    await writeFile(placeholder, 'Scripted Claude placeholder; never executed.\n'); await chmod(placeholder, 0o700)
    await writeFile(join(client, 'models.json'), JSON.stringify([{ value: 'claude-sonnet-4-6', displayName: 'Synthetic Claude', supportsEffort: true, supportedEffortLevels: ['low'] }]))
    await writeFile(join(profile, 'settings.json'), JSON.stringify({ onboardingComplete: true, historyEnabled: true, threadTitles: false, appearance: 'dark', reducedMotion: 'off' }))
    const inherited = new Set(['systemroot', 'windir', 'comspec', 'temp', 'tmp', 'lang', 'lc_all', 'display', 'xauthority', 'wayland_display', 'xdg_runtime_dir'])
    app = await electron.launch({ args: [resolve('tests/fixtures/nativeUsageElectronMain.cjs')], env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && inherited.has(key.toLowerCase()))),
      HOME: home, USERPROFILE: home, APPDATA: join(home, 'appdata'), LOCALAPPDATA: join(home, 'localappdata'),
      SOTTO_USAGE_FIXTURE_ROOT: root, SOTTO_USAGE_FIXTURE_NODE: process.execPath,
    } })
    const page = await firstSottoWindow(app)
    await page.waitForFunction(() => !!window.sotto?.agents)
    await expect(async () => expect(await page.evaluate(() => window.sotto!.agents!.get())).toHaveProperty('host')).toPass(wait)
    const size = async (width: number, height: number) => {
      await app!.evaluate(({ BrowserWindow }, [width, height]) => {
        BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.setContentSize(width, height)
      }, [width, height] as const)
      await expect.poll(() => page.evaluate(() => `${innerWidth}x${innerHeight}`)).toBe(`${width}x${height}`)
    }
    await size(1280, 800)
    await page.evaluate(async () => {
      const configured = await window.sotto!.agents!.command({ type: 'configure', patch: { provider: 'claude', enabledProviders: ['claude'], enabled: true, speak: false, reasoning: 'none', followupLimit: 0 } })
      if (configured.error) throw new Error(configured.error)
      const connected = await window.sotto!.agents!.command({ type: 'connect', provider: 'claude' })
      if (connected.error) throw new Error(connected.error)
    })
    const id = await page.evaluate(async path => {
      const agents = window.sotto!.agents!
      const created = await agents.command({ type: 'create-project', provider: 'claude', title: 'Parser', path, useExisting: true })
      if (created.error) throw new Error(created.error)
      const state = await agents.get()
      const project = state.host.projects.find(value => value.title === 'Parser')!
      const model = state.host.models.find(value => value.providerId === 'claude' && value.ready)!
      const thread = await agents.command({ type: 'create-thread', projectId: project.id, title: 'Trailing newline', titleSource: 'user', modelId: model.id,
        workingCopy: 'shared', runtimeMode: 'approval-required', managed: false })
      if (thread.error) throw new Error(thread.error)
      await agents.command({ type: 'select-thread', threadId: thread.activeThreadId! })
      await agents.command({ type: 'observe-threads', threadIds: [thread.activeThreadId!] })
      return thread.activeThreadId!
    }, project)
    await openThreads(page)
    const composer = page.getByRole('textbox', { name: 'Prompt', exact: true })
    await expect(composer).toBeEditable()
    await composer.fill('Why does the parser keep the newline?')
    await page.getByRole('button', { name: 'Send prompt', exact: true }).click()
    const transcript = page.getByLabel('Thread transcript')
    await expect(transcript).toContainText('Why does the parser keep the newline?')

    // The scripted CLI is told what to stream once it has the prompt.
    let session = ''
    await expect(async () => {
      const aliases = JSON.parse(await readFile(join(profile, 'claude-threads.json'), 'utf8')) as Record<string, { sessionId: string; origins: unknown[] }>
      const alias = Object.values(aliases)[0]!
      expect(alias.origins).toHaveLength(1)
      const requests = (await readFile(join(client, 'requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { method: string })
      expect(requests.some(request => request.method === 'user')).toBe(true)
      session = alias.sessionId
    }).toPass(wait)
    await writeFile(join(client, `control-${session}.json`), JSON.stringify({ id: randomUUID(), type: 'complete', text: REPLY, thinking: THINKING,
      holdInThinking: 'release-thinking', holdAfterThinking: 'release-reply' }))

    // Mid-thought: the row is on screen and running, named for what it is, with the words so far, and no reply text is.
    const firstHalf = THINKING.slice(0, Math.ceil(THINKING.length / 2)).trim()
    const running = transcript.getByRole('button', { name: `Thinking, ${firstHalf}, Running`, exact: true })
    await expect(running).toBeVisible(wait)
    await expect(running.locator('xpath=ancestor::li[1]')).toHaveAttribute('data-kind', 'reasoning')
    await expect(running.locator('xpath=ancestor::li[1]')).toHaveAttribute('data-status', 'running')
    await expect(transcript).not.toContainText(REPLY)
    const userMessage = transcript.locator('.thread-message').filter({ hasText: 'Why does the parser keep the newline?' })
    expect(await userMessage.evaluate((message, target) => !!(message.compareDocumentPosition(target!) & Node.DOCUMENT_POSITION_FOLLOWING), await running.elementHandle())).toBe(true)

    const capture = async (name: string, shown = running) => {
      for (const [width, height] of SIZES) {
        await size(width, height)
        await expect(shown).toBeVisible()
        const overflow = await page.locator('section.thread-pane').first().evaluate(element => element.scrollWidth - element.clientWidth)
        expect(overflow).toBeLessThanOrEqual(1)
        await shown.scrollIntoViewIfNeeded()
        await page.mouse.move(0, height - 1)
        await page.screenshot({ path: join(evidence, `thinking-${name}-${width}x${height}.png`), animations: 'disabled', caret: 'hide' })
      }
    }
    await capture('dark')
    await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'light' }) })
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('light')
    await capture('light')
    await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark', reducedMotion: 'on' }) })
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.reducedMotion)).toBe('on')
    await capture('reduced-motion')
    await size(1280, 800)

    // The block finishes: the row settles with all its words, and still no reply text is shown. Opened, it reads them.
    await writeFile(join(client, 'release-thinking'), '')
    const thought = transcript.getByRole('button', { name: new RegExp(`^Thinking, ${THINKING.replace(/[.,]/gu, '.')}, completed`) })
    await expect(thought).toBeVisible(wait)
    await expect(transcript).not.toContainText(REPLY)
    await thought.click()
    await expect(transcript.locator('.thread-activity__open')).toContainText(THINKING)
    await page.mouse.move(0, 799)
    await page.screenshot({ path: join(evidence, 'thinking-opened-dark-1280x800.png'), animations: 'disabled', caret: 'hide' })

    // The reply follows the thinking, below it.
    await writeFile(join(client, 'release-reply'), '')
    await expect(transcript.getByText(REPLY, { exact: true })).toBeVisible(wait)
    const fold = transcript.getByRole('button', { name: /^Worked for/ })
    if (await fold.count()) await fold.click()
    const settled = transcript.getByRole('button', { name: new RegExp(`^Thinking, ${THINKING.slice(0, 20)}`) })
    if (!await settled.isVisible()) await transcript.getByRole('button', { name: /thought once/i }).click()
    const answer = transcript.locator('.thread-message').filter({ hasText: REPLY })
    expect(await settled.evaluate((target, reply) => !!(target.compareDocumentPosition(reply!) & Node.DOCUMENT_POSITION_FOLLOWING), await answer.elementHandle())).toBe(true)
    expect(await page.evaluate(async threadId => (await window.sotto!.agents!.get()).host.threads.find(thread => thread.id === threadId)?.status, id)).toBe('idle')
    expect(await readFile(join(client, 'violations.jsonl'), 'utf8').catch(() => '')).toBe('')
  } finally {
    if (app) await app.close()
    await rm(requireOwnedE2EProfile(await realpath(root)), { recursive: true, force: true })
  }
})
