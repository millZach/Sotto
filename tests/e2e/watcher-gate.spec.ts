import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { EMPTY_AGENT_HOST, defaultAgentConfiguration } from '../../src/shared/agents'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { emptyWatcherRecord } from '../../src/shared/watcher'
import { evidenceDirectory } from '../fixtures/evidence'
import { onReleaseTrack } from './support/releaseTrack'
import { ownedE2EProfile } from './support/e2eProfile'
import { closeSotto, launchSotto, openPage, openThreads } from './support/sottoLaunch'
import { resizeContentWindow } from './support/sottoWindow'
import { pageBoundProblems } from './support/designCapture'

const evidence = evidenceDirectory('artifacts/watcher-gate')
const special = [
  { id: 'watcher-current', kind: 'watcher' as const, title: 'Saved Watcher' },
  { id: 'watcher-earlier', kind: 'watcher-history' as const, title: 'Saved Watcher history' },
]
/** On Owl the current Watcher lives in Watcher's room, not in the Threads list; its history stays listed. Stable lists neither. */
const listed = (track: 'stable' | 'owl', thread: typeof special[number]): number => track === 'owl' && thread.kind === 'watcher-history' ? 1 : 0

async function settle(page: Page): Promise<void> {
  await page.mouse.move(0, 0)
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
  })
}

test.describe('Watcher follows the running release track', () => {
  test.setTimeout(120_000)
  for (const track of ['stable', 'owl'] as const) test(`${track} keeps saved special kinds and ordinary thread actions`, async () => {
    await onReleaseTrack(track, async () => {
      const profile = await ownedE2EProfile({ prefix: 'sotto-e2e-watcher-gate-', settings: {
        ...DEFAULT_SETTINGS, onboardingComplete: true, appearance: 'dark', reducedMotion: 'on', showWidgetWhenIdle: false,
      } })
      let launched: Awaited<ReturnType<typeof launchSotto>> | undefined
      try {
        const projectPath = join(profile.directory, 'agent-workspaces', 'project')
        await mkdir(projectPath, { recursive: true })
        const configuration = { ...defaultAgentConfiguration(), enabled: true, checkClientUpdates: false }
        await writeFile(join(profile.directory, 'agents.json'), JSON.stringify({ configuration, watcher: emptyWatcherRecord(),
          activeThreadId: special[0]!.id, activeProjectId: 'project', draft: '', draftThreadId: null,
          draftRequestId: null, composing: false, outbox: [] }), 'utf8')
        await writeFile(join(profile.directory, 'workspace.json'), JSON.stringify({ snapshot: { ...structuredClone(EMPTY_AGENT_HOST),
          models: [{ id: 'claude:test', provider: 'Claude', name: 'Claude Test', ready: false }],
          projects: [{ id: 'project', title: 'Sotto test', path: projectPath }],
          threads: [...special, { id: 'saved-ordinary', kind: 'project', title: 'Saved ordinary' }].map(thread => ({ ...thread, projectId: 'project', modelId: 'claude:test', status: 'idle', messages: [], requests: [] })),
        }, projectAliases: [], creations: [] }), 'utf8')
        launched = await launchSotto('success', profile.directory)
        const { page } = launched
        await openThreads(page)
        await expect.poll(async () => {
          const update = await page.evaluate(() => window.sotto!.getUpdateStatus())
          return 'watcherEnabled' in update ? update.watcherEnabled : undefined
        }).toBe(track === 'owl')
        expect(await page.evaluate(() => Boolean(window.sotto!.watcher))).toBe(track === 'owl')
        if (track === 'owl') expect(await page.evaluate(() => window.sotto!.watcher!.get())).toMatchObject({ status: 'ok', state: { current: null } })
        const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
        await expect(sidebar.getByRole('button', { name: 'Workshop', exact: true })).toBeVisible()
        for (const thread of special) await expect(sidebar.getByRole('button', { name: thread.title, exact: true })).toHaveCount(listed(track, thread))
        if (track === 'stable') {
          await expect(page.getByLabel('Thread transcript')).toHaveCount(0)
          await sidebar.getByRole('searchbox').fill('Saved Watcher')
          await expect(sidebar.getByRole('button', { name: /Saved Watcher/ })).toHaveCount(0)
          await sidebar.getByRole('searchbox').fill('')
          const outcomes = await page.evaluate(async ids => {
            const agents = window.sotto!.agents!, state = await agents.get()
            return Promise.all(ids.map(async id => {
              const threadId = state.clientScoped ? `host:${state.hostId}:${id}` : id
              // Early start is deliberately silent; its returned shell still contains no Watcher.
              const started = await agents.command({ type: 'start-thread-session', threadId })
              let refusal: string | null
              try { refusal = (await agents.command({ type: 'manual-send', threadId, text: 'Synthetic refused Watcher turn.' })).error }
              catch (error) { refusal = String(error) }
              return { visible: started.host.threads.some(thread => thread.id === threadId), refusal }
            }))
          }, special.map(thread => thread.id))
          expect(outcomes.every(result => !result.visible && result.refusal?.includes('Sotto Owl'))).toBe(true)
        }
        // Owl's switch is Dictate | Watcher | Threads; stable keeps Dictate | Threads.
        await expect(page.getByRole('tab', { name: 'Watcher', exact: true })).toHaveCount(track === 'owl' ? 1 : 0)
        await sidebar.getByRole('button', { name: 'Workshop', exact: true }).click()
        await expect(page.getByRole('region', { name: 'Workshop', exact: true })).toBeVisible()
        const workshopId = await page.evaluate(async () => (await window.sotto!.agents!.get()).activeThreadId!)
        const prompt = page.getByRole('textbox', { name: 'Prompt', exact: true })
        await prompt.fill('Ordinary thread works on either release track.')
        await page.getByRole('button', { name: 'Send prompt', exact: true }).click()
        await expect(page.getByLabel('Thread transcript')).toContainText('Ordinary thread works on either release track.')
        await page.evaluate(async () => { await window.sottoE2E!.agentEvent!({ type: 'ready', threadId: 'workshop', text: 'Ordinary reply on either release track.' }) })
        await expect(page.getByLabel('Thread transcript')).toContainText('Ordinary reply on either release track.')
        for (const appearance of ['dark', 'light'] as const) {
          await page.evaluate(async appearance => { await window.sotto!.updateSettings({ appearance }) }, appearance)
          await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
          for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
            // Leave native frame and scaling space below the exact content size we capture.
            await resizeContentWindow(launched, width, height, [800, 540])
            await settle(page)
            expect(await pageBoundProblems(page)).toEqual([])
            for (const thread of special) await expect(sidebar.getByRole('button', { name: thread.title, exact: true })).toHaveCount(listed(track, thread))
            await mkdir(evidence, { recursive: true })
            await page.screenshot({ path: join(evidence, `${track}-${appearance}-${width}x${height}.png`), animations: 'disabled' })
          }
        }
        await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'on')
        await openPage(page, 'Settings')
        await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Threads', exact: true }).click()
        // Threads holds nothing of Watcher on either track. Stable shows nothing of Watcher anywhere in Settings; Owl has
        // Settings, under Watcher (#1097's worker roles), and every mention of Watcher it shows is that section or its tab,
        // or night falls under Appearance (ADR-0119), which names the move into Watcher's room.
        await expect(page.locator('#settings-agents').getByText(/Watcher|Watched by Watcher/)).toHaveCount(0)
        if (track === 'stable') await expect(page.getByText(/Watcher|Watched by Watcher/)).toHaveCount(0)
        else {
          await expect(page.locator('#settings-watcher')).toHaveCount(1)
          expect(await page.getByText(/Watcher|Watched by Watcher/).evaluateAll(elements => elements
            .filter(element => element.closest('#settings-watcher, #tab-settings-watcher, #settings-night-falls') === null).map(element => element.textContent))).toEqual([])
        }
        await expect(page.getByRole('spinbutton', { name: /Watcher/ })).toHaveCount(0)
        if (track === 'stable') {
          await resizeContentWindow(launched, 1600, 1000)
          await openThreads(page)
          const paneIds = await page.evaluate(async ({ special, workshopId }) => {
            const state = await window.sotto!.agents!.get()
            const workshop = state.host.threads.find(thread => thread.id === workshopId)!
            const other = state.host.threads.find(thread => thread.id !== workshop.id)!
            const hidden = special.map(id => state.clientScoped ? `host:${state.hostId}:${id}` : id)
            const layout = { version: 1, panes: [hidden[0], workshop.id, hidden[1], other.id], arrangement: 'grid',
              sizes: [0.25, 0.25, 0.25, 0.25], grid: { rows: [0.5, 0.5], columns: [[0.5, 0.5], [0.5, 0.5]] },
              zoomed: false, focused: hidden[0] }
            localStorage.setItem('sotto.threadWorkspace.layout', JSON.stringify(layout))
            return { workshop: workshop.id, other: other.id, otherTitle: other.title, hidden }
          }, { special: special.map(thread => thread.id), workshopId })
          await page.reload()
          await openThreads(page)
          const shown = page.locator('section.thread-pane[role="region"]')
          await expect(shown).toHaveCount(2)
          const divider = page.locator('.thread-panes [role="separator"][aria-orientation="vertical"]').first()
          await expect(divider).toHaveAttribute('aria-valuenow', '50')
          await divider.focus()
          await page.keyboard.press('ArrowRight')
          await expect(divider).toHaveAttribute('aria-valuenow', '55')
          await page.reload()
          await openThreads(page)
          await expect(divider).toHaveAttribute('aria-valuenow', '55')
          const savedSplit = await page.evaluate(() => JSON.parse(localStorage.getItem('sotto.threadWorkspace.layout')!))
          for (const id of paneIds.hidden) expect(savedSplit.panes).not.toContain(id)
          await page.getByRole('button', { name: `Close ${paneIds.otherTitle} pane`, exact: true }).click()
          await page.reload()
          await openThreads(page)
          await expect(page.getByLabel('Thread transcript')).toContainText('Ordinary reply on either release track.')
          const savedLayout = await page.evaluate(() => JSON.parse(localStorage.getItem('sotto.threadWorkspace.layout')!))
          expect(savedLayout.panes).not.toContain(paneIds.other)
          for (const id of paneIds.hidden) expect(savedLayout.panes).not.toContain(id)
          // Main records return to Owl; stable does not restore Watcher panes dropped by ordinary layout edits.
          await closeSotto(launched)
          launched = undefined
          await onReleaseTrack('owl', async () => {
            launched = await launchSotto('success', profile.directory)
            await resizeContentWindow(launched, 1600, 1000)
            await openThreads(launched.page)
            const restored = launched.page.locator('section.thread-pane[role="region"]')
            await expect(restored).toHaveCount(1)
            for (const thread of special) {
              await expect(launched.page.getByRole('region', { name: thread.title, exact: true })).toHaveCount(0)
              await expect(launched.page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: thread.title, exact: true })).toHaveCount(listed('owl', thread))
            }
            await expect(launched.page.getByRole('region', { name: paneIds.otherTitle, exact: true })).toHaveCount(0)
          })
        }
        const saved = JSON.parse(await readFile(join(profile.directory, 'workspace.json'), 'utf8'))
        for (const thread of special) expect(saved.snapshot.threads.find((value: { id: string }) => value.id === thread.id)).toMatchObject(thread)
      } finally {
        if (launched) await closeSotto(launched)
        await profile.dispose()
      }
    })
  })
})


test('Owl refuses the private room actions plainly when the local host is off', async () => {
  await onReleaseTrack('owl', async () => {
    const profile = await ownedE2EProfile({ prefix: 'sotto-e2e-watcher-gate-', settings: {
      ...DEFAULT_SETTINGS, onboardingComplete: true, localHostEnabled: false, showWidgetWhenIdle: false,
    } })
    let launched: Awaited<ReturnType<typeof launchSotto>> | undefined
    try {
      launched = await launchSotto('success', profile.directory)
      const results = await launched.page.evaluate(async () => {
        const room = window.sotto!.watcher!
        return [await room.get(), await room.open({ provider: 'codex', modelId: 'codex:test' }),
          await room.prepareStopAll(), await room.stopAll({ confirmationId: '24c7c937-b368-4bbb-9595-31c7c8463e29' })]
      })
      for (const result of results) expect(result).toMatchObject({ status: 'refused', code: 'HOST_FEATURE_UNAVAILABLE', message: expect.stringContaining('Run the local host') })
    } finally { if (launched) await closeSotto(launched); await profile.dispose() }
  })
})

test('Owl offers no limit on threads in flight to set (#1183)', async () => {
  await onReleaseTrack('owl', async () => {
    const profile = await ownedE2EProfile({ prefix: 'sotto-e2e-watcher-gate-', settings: {
      ...DEFAULT_SETTINGS, onboardingComplete: true, showWidgetWhenIdle: false,
    } })
    let launched: Awaited<ReturnType<typeof launchSotto>> | undefined
    try {
      launched = await launchSotto('success', profile.directory)
      const [room, settings] = await launched.page.evaluate(async () => [await window.sotto!.watcher!.get(), await window.sotto!.getSettings()] as const)
      expect(room).toMatchObject({ status: 'ok' })
      expect(room.status === 'ok' && 'inFlightLimit' in room.state).toBe(false)
      expect('watcherInFlightLimit' in settings).toBe(false)
      expect(await launched.page.evaluate(() => 'setLimit' in window.sotto!.watcher!)).toBe(false)
    } finally { if (launched) await closeSotto(launched); await profile.dispose() }
  })
})
