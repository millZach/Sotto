import { randomUUID } from 'node:crypto'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { evidenceDirectory } from '../fixtures/evidence'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { closeSotto, launchSotto, openThreads, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'

const evidence = evidenceDirectory('artifacts/cursor-background-subagent')
const TITLE = 'Supercar showroom assembly video'

interface Seen { status: string; lastTurn?: string; background: string[]; subagent?: string; agent?: string }
/** What the window's state says of the thread: its status, its background work and its subagent row. */
async function seen(page: Page, threadId: string): Promise<Seen> {
  return page.evaluate(async id => {
    const agents = window.sotto!.agents!
    const thread = (await agents.get()).host.threads.find(item => item.id === id)
    const row = (await agents.threadDetail(id))?.activities?.find(item => item.kind === 'subagent')
    return { status: thread?.status ?? 'missing', ...(thread?.lastTurn ? { lastTurn: thread.lastTurn.status } : {}), background: (thread?.backgroundWork ?? []).map(work => `${work.type}:${work.label}`),
      ...(row ? { subagent: row.status, agent: row.agents?.[0]?.status ?? 'none' } : {}) }
  }, threadId)
}

/**
 * #2631, by hand in the built app over the fake Cursor client: a Task subagent Cursor moves to the background reads
 * Working, in the sidebar, the readout and its row, until Cursor says it ended, and the turn finishes only then.
 */
test('shows a Cursor subagent moved to the background as working until Cursor says it ended', async () => {
  test.setTimeout(240_000)
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-cursor-bg-' })).directory
  const root = join(profile, 'cursor-fixture')
  const projectPath = join(root, 'SuperCar')
  await mkdir(projectPath, { recursive: true })
  await mkdir(evidence, { recursive: true })
  const previous = { root: process.env.SOTTO_E2E_CURSOR_ROOT, executable: process.env.SOTTO_E2E_CURSOR_EXECUTABLE, owl: process.env.SOTTO_OWL_FEATURES }
  process.env.SOTTO_E2E_CURSOR_ROOT = root
  process.env.SOTTO_E2E_CURSOR_EXECUTABLE = process.execPath
  process.env.SOTTO_OWL_FEATURES = 'cursor=1'
  const journey: Record<string, unknown> = {}
  let launched: LaunchedSotto | undefined
  try {
    launched = await launchSotto('success', profile)
    const { page } = launched
    await page.evaluate(() => window.sotto!.updateSettings({ onboardingComplete: true, threadListGrouping: 'project', appearance: 'dark', reducedMotion: 'on' }))
    await page.reload()
    const threadId = await page.evaluate(async ({ path, title }) => {
      const agents = window.sotto!.agents!
      const configured = await agents.command({ type: 'configure', patch: { provider: 'cursor', enabled: true, enabledProviders: ['claude', 'cursor'], checkClientUpdates: false } })
      if (configured.error) throw new Error(configured.error)
      let model
      for (let tries = 0; tries < 100 && !model; tries++) {
        model = (await agents.get()).host.models.find(item => item.providerId === 'cursor' && item.ready)
        if (!model) await new Promise(done => setTimeout(done, 100))
      }
      if (!model) throw new Error('Cursor offers no ready model.')
      const opened = await agents.command({ type: 'create-project', title: 'SuperCar', path, useExisting: true, provider: 'cursor' })
      if (opened.error || !opened.activeProjectId) throw new Error(opened.error ?? 'Could not open the project.')
      const created = await agents.command({ type: 'create-thread', projectId: opened.activeProjectId, modelId: model.id, title, titleSource: 'user', workingCopy: 'shared' })
      if (created.error || !created.activeThreadId) throw new Error(created.error ?? 'Could not create the thread.')
      const sent = await agents.command({ type: 'manual-send', threadId: created.activeThreadId, draftId: crypto.randomUUID(), text: 'Make the dimensioned GT3 RS drawing in the background, then sync the drop.' })
      if (sent?.error) throw new Error(sent.error)
      return created.activeThreadId
    }, { path: projectPath, title: TITLE })
    await openThreads(page)
    await resizeWindow(launched, 1280, 800)
    await expect.poll(() => seen(page, threadId).then(state => state.status)).toBe('running')

    // The fake Cursor process holds the session; the test drives it through its control file, as the integration tests do.
    const sessions = await readdir(join(root, 'sessions'))
    expect(sessions).toHaveLength(1)
    const sessionId = sessions[0]!.replace(/\.json$/u, '')
    const act = (value: Record<string, unknown>) => writeFile(join(root, 'control.json'), JSON.stringify({ id: randomUUID(), sessionId, ...value }))
    await act({ type: 'background-task', text: 'GT3 RS dimensioned drawing' })
    await expect.poll(() => seen(page, threadId)).toMatchObject({ status: 'running', background: ['subagent:GT3 RS dimensioned drawing'], subagent: 'running', agent: 'running' })
    const row = page.getByRole('listitem').filter({ hasText: TITLE }).first()
    await expect(page.getByText('Started it in the background.')).toBeVisible()
    await expect(row).toContainText('Working')
    journey.whileRunning = await seen(page, threadId)
    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(value => window.sotto!.updateSettings({ appearance: value }), appearance)
      await page.mouse.move(0, 0)
      await page.screenshot({ animations: 'disabled', path: join(evidence, `running-1280-${appearance}.png`) })
    }

    // Cursor says the subagent ended; its agent replies with the result and only then answers the prompt.
    await act({ type: 'background-task-end' })
    await expect.poll(() => seen(page, threadId)).toMatchObject({ status: 'idle', lastTurn: 'completed', background: [], subagent: 'completed', agent: 'completed' })
    await expect(page.getByText('The drawing is done.')).toBeVisible()
    journey.afterEnd = await seen(page, threadId)
    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(value => window.sotto!.updateSettings({ appearance: value }), appearance)
      await page.mouse.move(0, 0)
      await page.screenshot({ animations: 'disabled', path: join(evidence, `ended-1280-${appearance}.png`) })
    }
  } finally {
    await writeFile(join(evidence, 'journey.json'), `${JSON.stringify(journey, null, 2)}\n`)
    if (launched) await closeSotto(launched)
    for (const [key, value] of [['SOTTO_E2E_CURSOR_ROOT', previous.root], ['SOTTO_E2E_CURSOR_EXECUTABLE', previous.executable], ['SOTTO_OWL_FEATURES', previous.owl]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await removeOwnedE2EProfile(profile)
  }
})
