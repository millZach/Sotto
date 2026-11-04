import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { startHeadlessHost } from '../../src/host'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { E2EAgentHost } from '../../src/main/e2e/agentEffects'
import type { RemoteHostE2EConnection } from '../../src/main/e2e/remoteHost'
import type { AgentActivity } from '../../src/shared/agentActivity'
import { E2E_THREADS_NOW } from '../../src/shared/e2e'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { withSotto } from '../fixtures/designCaptureProfile'
import { evidenceDirectory } from '../fixtures/evidence'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { OWL_E2E_VERSION, onReleaseTrack } from './support/releaseTrack'
import { closeSotto, launchSotto, openThreads, resizeWindow } from './support/sottoLaunch'
import { resizeContentWindow } from './support/sottoWindow'
import { seedWatcherRoom } from './support/watcherRoom'

// A press on a link to a Markdown file opens it read only in the side panel (ADR-0120, November 3 amendment).
const evidence = evidenceDirectory('artifacts/markdown-side-panel')
const PLAN = '# The plan\n\nThe bars animate from a CSS loop.\n\n- Pin the capture.\n- Run the gate.\n\n![a picture](https://example.com/a.png)\n'

test('a link in a paired host\'s thread opens that host\'s file in Tools > Files', async () => {
  test.setTimeout(180_000)
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-markdown-panel-' })).directory
  let host: Awaited<ReturnType<typeof startHeadlessHost>> | undefined
  let launched: Awaited<ReturnType<typeof launchSotto>> | undefined
  try {
    await onReleaseTrack('owl', async () => {
      await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, localHostEnabled: false, reducedMotion: 'on' }))
      const native = new E2EAgentHost()
      await native.initializeWorkingFolders(join(profile, 'working-folders', 'codex'))
      host = await startHeadlessHost({ dataDirectory: join(profile, 'remote-host'), port: 0, providers: { codex: native }, sottoVersion: OWL_E2E_VERSION })
      const url = `http://127.0.0.1:${host.descriptor!.port}`
      const paired = await SocketHostService.pair(url, host.pairing.issuePairingCode().code, 'Synthetic laptop')
      await writeFile(join(profile, 'remote-hosts.json'), JSON.stringify([{ id: randomUUID(), name: 'Forge fixture', target: 'forge', identityFile: '',
        installPath: '/opt/sotto', dataDirectory: '/data/sotto', enabled: false, hostId: paired.hostId, clientId: paired.clientId }]))
      const setup = new SocketHostService({ url, token: paired.token, expectedHostId: paired.hostId, catchUpEvents: false, clientVersion: OWL_E2E_VERSION })
      await setup.connect()
      await setup.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } })
      await setup.command({ type: 'connect', provider: 'codex' })
      const shell = setup.shell().host
      const thread = shell.threads.find(item => item.title === 'Workshop')!
      await setup.command({ type: 'rename-thread', threadId: thread.id, title: 'Forge plan fixture' })
      const folder = thread.workingDirectory ?? shell.projects.find(project => project.id === thread.projectId)!.path
      await setup.close()

      await mkdir(join(folder, 'docs'), { recursive: true })
      await writeFile(join(folder, 'docs', 'plan.md'), PLAN)
      const outside = await mkdtemp(join(tmpdir(), 'sotto-e2e-outside-'))
      await writeFile(join(outside, 'kept.md'), '# Kept outside\n')
      await writeFile(join(outside, 'key.txt'), 'secret')
      try {
        const thought: AgentActivity = { id: 'remote-thought', turnId: 'turn', sequence: 0, kind: 'reasoning', status: 'completed', title: 'Thinking',
          text: `Wrote [the plan](docs/plan.md), kept a note at [kept](<${join(outside, 'kept.md').replaceAll('\\', '/')}>) and [a text file](<${join(outside, 'key.txt').replaceAll('\\', '/')}>). The old one was \`docs/gone.md\`.` }
        native.event({ type: 'ready', threadId: 'workshop', text: 'Done.', status: 'idle', activities: [thought] })

        launched = await launchSotto('success', profile)
        const { app, page } = launched
        const connection: RemoteHostE2EConnection = { url, token: paired.token, hostId: paired.hostId }
        await app.evaluate(async (_, input) => { await globalThis.sottoRemoteHostE2E!.connect(input) }, connection)
        await resizeWindow(launched, 1280, 800)
        await openThreads(page)
        await page.getByRole('button', { name: 'Forge plan fixture', exact: true }).click()

        const log = page.getByRole('log', { name: 'Thread transcript' })
        // A thought's text is drawn by the same MessageContent, under the same ThreadWebLinks, as a reply's words.
        const row = log.getByRole('button', { name: /Thinking/u })
        await expect(log.locator('.thread-work__summary, .thread-activity__summary').first()).toBeVisible()
        if (!await row.isVisible()) await log.locator('.thread-work__summary, .thread-activity__summary').first().click()
        await row.click()
        const link = log.getByRole('link', { name: 'Open docs/plan.md in the side panel' })
        await link.click()
        const preview = page.getByRole('region', { name: 'Preview of plan.md' })
        await expect(preview.getByRole('heading', { name: 'The plan' })).toBeVisible()
        await expect(preview.getByText(/Read only · on Forge/u)).toBeVisible()
        // It is on the host, so there is no folder to show; the picture in it stays unloaded, and it took focus to be read.
        await expect(preview.getByRole('button', { name: /Show in File Explorer/u })).toHaveCount(0)
        await expect(preview.locator('img')).toHaveCount(0)
        await expect(preview.getByLabel('plan.md contents')).toBeFocused()
        await page.screenshot({ path: join(evidence, 'threads-paired-host-1280.png'), animations: 'disabled' })

        await preview.getByRole('button', { name: 'Source' }).click()
        await expect(preview.locator('pre')).toContainText('# The plan')
        await preview.getByRole('button', { name: 'Source' }).click()

        // Escape puts the file away and focus goes back to the link; Files is what stays.
        await page.keyboard.press('Escape')
        await expect(preview).toHaveCount(0)
        await expect(link).toBeFocused()
        await expect(page.getByRole('tree', { name: /Files in/u })).toBeVisible()

        // A full path may name a Markdown file anywhere on the thread's machine.
        await log.getByRole('link', { name: /Open .*kept\.md in the side panel/u }).click()
        await expect(page.getByRole('region', { name: 'Preview of kept.md' }).getByRole('heading', { name: 'Kept outside' })).toBeVisible()
        await page.getByRole('button', { name: 'Close preview' }).click()

        // A file that is gone says so, and any other file does what it did: on a paired host, says it cannot be shown here.
        await log.getByRole('link', { name: 'Open docs/gone.md in the side panel' }).click()
        await expect(page.getByText('This file is not on the computer this thread runs on, or it has moved. Nothing was opened.')).toBeVisible()
        await page.screenshot({ path: join(evidence, 'threads-file-gone-1280.png'), animations: 'disabled' })
        await page.getByRole('button', { name: 'Close preview' }).click()
        await log.getByRole('link', { name: /key\.txt/u }).click()
        await expect(page.getByText('This file is on the host machine, so it cannot be shown in a folder here. Nothing was opened.')).toBeVisible()

        // Its menu, by the keyboard.
        await link.focus()
        await page.keyboard.press('Shift+F10')
        await expect(page.getByRole('menuitem', { name: 'Open in side panel' })).toBeFocused()
        await page.screenshot({ path: join(evidence, 'threads-link-menu-1280.png'), animations: 'disabled' })
        await page.keyboard.press('Escape')
        await expect(link).toBeFocused()

        await resizeWindow(launched, 820, 560)
        await link.click()
        await expect(page.getByRole('region', { name: 'Preview of plan.md' })).toBeVisible()
        await page.screenshot({ path: join(evidence, 'threads-paired-host-820.png'), animations: 'disabled' })
      } finally {
        await rm(outside, { recursive: true, force: true })
      }
    })
  } finally {
    if (launched) await closeSotto(launched)
    await host?.close()
    await removeOwnedE2EProfile(profile)
  }
})

async function linkInWatcher(page: Page, text: string): Promise<void> {
  await page.evaluate(async ({ text, now }) => {
    await window.sottoE2E!.agentEvent!({ type: 'history', threadId: 'release-notes', text: '', messages: [
      { id: 'asked', role: 'user' as const, text: 'Write up the plan.', createdAt: new Date(now - 60_000).toISOString() },
      { id: 'linked', role: 'assistant' as const, text, createdAt: new Date(now).toISOString() },
    ] })
  }, { text, now: E2E_THREADS_NOW })
}

for (const appearance of ['dark', 'light'] as const) {
  test(`in Watcher's room a linked file takes the beside pane's place, ${appearance}`, async () => {
    test.setTimeout(120_000)
    const folder = await mkdtemp(join(tmpdir(), 'sotto-e2e-watcher-file-'))
    const file = join(folder, 'plan.md').replaceAll('\\', '/')
    await writeFile(file, PLAN)
    try {
      await onReleaseTrack('owl', () => withSotto({ onboardingComplete: true, appearance, scenario: 'phase3-workspace', agents: 'design-threads', motion: 'reduced' }, async launched => {
        const { page } = launched
        await seedWatcherRoom(page, { watched: ['footer-links', 'visual-gate'], idPrefix: 'file' })
        await linkInWatcher(page, `The plan is in [plan.md](<${file}>).`)
        await page.getByRole('tablist', { name: 'Page' }).getByRole('tab', { name: 'Watcher', exact: true }).click()
        await expect(page.getByRole('heading', { level: 1, name: 'Watcher' })).toBeVisible()
        for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
          await resizeContentWindow(launched, width, height)
          const link = page.getByRole('link', { name: `Open ${file} in the side panel` })
          await link.click()
          const preview = page.getByRole('region', { name: 'Preview of plan.md' })
          await expect(preview.getByRole('heading', { name: 'The plan' })).toBeVisible()
          await expect(preview.getByRole('button', { name: /Show in (?:File Explorer|Finder|the file manager)/u })).toBeVisible()
          // The name stays readable when the head is short of room: the size gives way first, and nothing runs under Source.
          const name = await preview.locator('.files-preview__name').boundingBox()
          const source = await preview.getByRole('button', { name: 'Source' }).boundingBox()
          expect(name!.width).toBeGreaterThan(30)
          const title = await preview.locator('.files-preview__title').boundingBox()
          expect(title!.x + title!.width).toBeLessThanOrEqual(source!.x)
          // Nothing clips at any size, and the window's controls leave its close clear.
          const close = await preview.getByRole('button', { name: 'Close preview' }).boundingBox()
          expect(close!.x + close!.width).toBeLessThanOrEqual(width)
          expect(await preview.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
          await page.screenshot({ path: join(evidence, `watcher-file-${appearance}-${width}.png`), animations: 'disabled' })
          await page.keyboard.press('Escape')
          await expect(preview).toHaveCount(0)
          await expect(link).toBeFocused()
        }

        // A thread beside Watcher waits behind the file, and comes back.
        await resizeContentWindow(launched, 1280, 800)
        await page.getByRole('button', { name: /All threads/u }).first().click()
        await page.getByRole('dialog', { name: 'All threads' }).getByRole('button', { name: /^Open .* beside Watcher$/u }).first().click()
        const pane = page.locator('#watcher-beside-pane')
        await expect(pane.locator('.thread-workspace__transcript')).toBeVisible()
        await page.getByRole('link', { name: `Open ${file} in the side panel` }).click()
        const back = page.getByRole('button', { name: /^Back to /u })
        await expect(back).toBeVisible()
        await expect(pane.locator('.thread-workspace__transcript')).toHaveCount(0)
        await page.screenshot({ path: join(evidence, `watcher-file-over-thread-${appearance}-1280.png`), animations: 'disabled' })
        await back.click()
        await expect(pane.locator('.thread-workspace__transcript')).toBeVisible()
      }))
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })
}

test('on stable main refuses to read a linked Markdown file', async () => {
  test.setTimeout(90_000)
  await onReleaseTrack('stable', () => withSotto({ onboardingComplete: true, appearance: 'dark', scenario: 'phase3-workspace', agents: 'design-threads', motion: 'reduced' }, async ({ page }) => {
    const refused = await page.evaluate(async () => window.sotto!.files!.previewLink!({ threadId: 'release-notes', path: 'plan.md' }))
    expect(refused).toMatchObject({ ok: false, error: { code: 'unavailable', message: 'Opening Markdown files in the side panel is not part of this version of Sotto. Nothing was opened.' } })
  }))
})
