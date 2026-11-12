import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { startHeadlessHost } from '../../src/host'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { E2EAgentHost } from '../../src/main/e2e/agentEffects'
import type { RemoteHostE2EConnection } from '../../src/main/e2e/remoteHost'
import type { AgentActivity } from '../../src/shared/agentActivity'
import { E2E_THREADS_NOW } from '../../src/shared/e2e'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { evidenceDirectory } from '../fixtures/evidence'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { hostKeysPerTest } from './support/hostKeys'
import { startMonitoredThread } from './support/monitoredThread'
import { OWL_E2E_VERSION, onReleaseTrack } from './support/releaseTrack'
import { closeSotto, launchSotto, openThreads, resizeWindow } from './support/sottoLaunch'

// A file link opens the file on this computer, and shows a paired host's file in Tools > Files with Download (ADR-0120, November 12 amendment).
const evidence = evidenceDirectory('artifacts/linked-files-open-and-remote')
const slashes = (path: string): string => path.replaceAll('\\', '/')
const hostKeys = hostKeysPerTest()
test.beforeEach(() => { hostKeys.reset() })
/** A PDF's first bytes and then bytes no text holds, so Files has no preview for it. */
const REPORT = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from(Array.from({ length: 300_000 }, (_, index) => index % 256))])

for (const appearance of ['dark', 'light'] as const) {
  test(`a file link in a paired host's thread shows the file in Tools > Files, where it downloads, ${appearance}`, async () => {
    test.setTimeout(180_000)
    const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-linked-files-' })).directory
    let host: Awaited<ReturnType<typeof startHeadlessHost>> | undefined
    let launched: Awaited<ReturnType<typeof launchSotto>> | undefined
    try {
      await onReleaseTrack('owl', async () => {
        await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, localHostEnabled: false, reducedMotion: 'on', appearance }))
        const native = new E2EAgentHost()
        await native.initializeWorkingFolders(join(profile, 'working-folders', 'codex'))
        host = await startHeadlessHost({ dataDirectory: join(profile, 'remote-host'), port: 0, providers: { codex: native }, sottoVersion: OWL_E2E_VERSION })
        const url = `http://127.0.0.1:${host.descriptor!.port}`
        const paired = await SocketHostService.pair(url, host.pairing.issuePairingCode().code, 'Synthetic laptop')
        await writeFile(join(profile, 'remote-hosts.json'), JSON.stringify([{ id: randomUUID(), name: 'forge', target: 'forge', identityFile: '',
          installPath: '/opt/sotto', dataDirectory: '/data/sotto', enabled: false, hostId: paired.hostId, clientId: paired.clientId }]))
        const setup = new SocketHostService({ url, token: paired.token, expectedHostId: paired.hostId, catchUpEvents: false, clientVersion: OWL_E2E_VERSION })
        await setup.connect()
        await setup.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } })
        await setup.command({ type: 'connect', provider: 'codex' })
        const shell = setup.shell().host
        const thread = shell.threads.find(item => item.title === 'Workshop')!
        await setup.command({ type: 'rename-thread', threadId: thread.id, title: 'Quarterly report' })
        const folder = thread.workingDirectory ?? shell.projects.find(project => project.id === thread.projectId)!.path
        await setup.close()

        await mkdir(join(folder, 'out', 'figures'), { recursive: true }); await mkdir(join(folder, 'src'), { recursive: true })
        await writeFile(join(folder, 'out', 'q3-report.pdf'), REPORT)
        await writeFile(join(folder, 'src', 'build.ts'), 'export async function build(quarter: string): Promise<void> {\n  await writeReport(quarter)\n}\n')
        const outside = await mkdtemp(join(tmpdir(), 'sotto-e2e-exports-'))
        await writeFile(join(outside, 'sales.csv'), 'month,region,revenue\n2026-07,North,418200\n2026-07,South,377950\n')
        const sales = slashes(join(outside, 'sales.csv'))
        try {
          // A step's text is drawn by the same MessageContent, under the same ThreadWebLinks, as a reply's words.
          const wrote: AgentActivity = { id: 'remote-thought', turnId: 'turn', sequence: 0, kind: 'reasoning', status: 'completed', title: 'Thinking', text: [
            'The report is built. Here is what it wrote and read:', '',
            '- [q3-report.pdf](out/q3-report.pdf), the report itself',
            '- [build.ts](src/build.ts), the script that builds it',
            `- [the out folder](<${slashes(join(folder, 'out'))}>), with everything from this run`,
            `- [sales.csv](<${sales}>), the sales it read, which is outside this project`,
            '- [last year](out/q2-report.pdf), which is gone',
          ].join('\n') }
          native.event({ type: 'ready', threadId: 'workshop', text: 'Done.', status: 'idle', activities: [wrote] })

          launched = await launchSotto('success', profile)
          const { app, page } = launched
          const connection: RemoteHostE2EConnection = { url, token: paired.token, hostId: paired.hostId }
          await app.evaluate(async (_, input) => { await globalThis.sottoRemoteHostE2E!.connect(input) }, connection)
          await resizeWindow(launched, 1280, 800)
          await openThreads(page)
          await page.getByRole('button', { name: 'Quarterly report', exact: true }).click()
          const log = page.getByRole('log', { name: 'Thread transcript' })
          const snapshot = () => page.evaluate(async () => { const taken = await window.sottoE2E!.snapshot(); return { opened: taken.openedFiles ?? [], shown: taken.shownFiles ?? [] } })

          // A press shows the file where it is: Tools opens on Files, its folder open and the file chosen.
          const row = log.getByRole('button', { name: /Thinking/u })
          await expect(log.locator('.thread-work__summary, .thread-activity__summary').first()).toBeVisible()
          if (!await row.isVisible()) await log.locator('.thread-work__summary, .thread-activity__summary').first().click()
          await row.click()
          const report = log.getByRole('link', { name: 'Show out/q3-report.pdf in Files' })
          await report.click()
          const tree = page.getByRole('tree', { name: /Files in/u })
          await expect(tree.getByRole('treeitem', { name: 'q3-report.pdf' })).toHaveAttribute('aria-selected', 'true')
          await expect(tree.getByRole('treeitem', { name: 'out', exact: true })).toHaveAttribute('aria-expanded', 'true')
          let preview = page.getByRole('region', { name: 'Preview of q3-report.pdf' })
          await expect(preview.getByText('No preview for this file.')).toBeVisible()
          await expect(preview.getByText(/Download it to open it on this computer\./u)).toBeVisible()
          // Nothing on this computer can show or open it, and no download line stands before one is asked for.
          await expect(preview.getByRole('button', { name: /Show in (?:File Explorer|Finder|file manager)/u })).toHaveCount(0)
          await expect(preview.locator('.file-download')).toHaveCount(0)
          await page.screenshot({ path: join(evidence, `host-file-in-tree-${appearance}-1280.png`), animations: 'disabled' })

          // Download saves it whole to this computer's Downloads folder, which a journey keeps in its own profile.
          await preview.getByRole('button', { name: 'Download q3-report.pdf to this computer' }).click()
          await expect(preview.getByText('Saved q3-report.pdf to Downloads on this computer.')).toBeVisible()
          const downloads = join(profile, 'downloads')
          expect((await readFile(join(downloads, 'q3-report.pdf'))).equals(REPORT)).toBe(true)
          await page.screenshot({ path: join(evidence, `host-file-saved-${appearance}-1280.png`), animations: 'disabled' })
          // Open and Show in folder act on the saved file, which the window names only by main's handle.
          await preview.getByRole('button', { name: 'Open', exact: true }).click()
          await preview.getByRole('button', { name: /^Show in (?:File Explorer|Finder|file manager)$/u }).click()
          await expect.poll(snapshot).toEqual({ opened: [join(downloads, 'q3-report.pdf')], shown: [join(downloads, 'q3-report.pdf')] })
          // A name already taken gets a number, and nothing half-written is left beside it.
          await preview.getByRole('button', { name: 'Download q3-report.pdf to this computer' }).click()
          await expect(preview.getByText('Saved q3-report (1).pdf to Downloads on this computer.')).toBeVisible()
          expect((await readdir(downloads)).sort()).toEqual(['q3-report (1).pdf', 'q3-report.pdf'])

          // A file outside the thread's folder is shown alone, with its whole path and its text.
          await log.getByRole('link', { name: `Show ${sales} in Files` }).click()
          preview = page.getByRole('region', { name: 'Preview of sales.csv' })
          await expect(preview.getByText('2026-07,North,418200')).toBeVisible()
          await expect(preview.getByText(/Read only · on forge/iu)).toBeVisible()
          await expect(preview.locator('.linked-file__path')).toHaveText(sales)
          await expect(tree).toHaveCount(0)
          await page.screenshot({ path: join(evidence, `host-file-alone-${appearance}-1280.png`), animations: 'disabled' })
          await preview.getByRole('button', { name: 'Download sales.csv to this computer' }).click()
          await expect(preview.getByText('Saved sales.csv to Downloads on this computer.')).toBeVisible()
          await page.keyboard.press('Escape')
          await expect(preview).toHaveCount(0)

          // A link to a folder opens it in the tree, and a file that is gone says so beside the reply.
          await log.getByRole('link', { name: /Show .*\/out in Files/u }).click()
          await expect(tree.getByRole('treeitem', { name: 'figures' })).toBeVisible()
          await log.getByRole('link', { name: 'Show out/q2-report.pdf in Files' }).click()
          await expect(log.getByText('This file is not on the computer this thread runs on, or it has moved. Nothing was opened.')).toBeVisible()

          // The link's menu, by the keyboard: Download from it shows the file and saves it.
          const script = log.getByRole('link', { name: 'Show src/build.ts in Files' })
          await script.focus()
          await page.keyboard.press('Shift+F10')
          await expect(page.getByRole('menuitem')).toHaveText(['Show in Files', 'Download', 'Copy path'])
          await expect(page.getByRole('menuitem', { name: 'Show in Files' })).toBeFocused()
          await page.screenshot({ path: join(evidence, `host-link-menu-${appearance}-1280.png`), animations: 'disabled' })
          await page.getByRole('menuitem', { name: 'Download' }).click()
          preview = page.getByRole('region', { name: 'Preview of build.ts' })
          await expect(preview.getByText('export async function build')).toBeVisible()
          await expect(preview.getByText('Saved build.ts to Downloads on this computer.')).toBeVisible()
          await expect(tree.getByRole('treeitem', { name: 'build.ts' })).toHaveAttribute('aria-selected', 'true')

          // At the smallest window and the largest, the head keeps to one row's width and nothing runs off the panel.
          for (const [width, height] of [[820, 560], [1600, 1000]] as const) {
            await resizeWindow(launched, width, height)
            await report.click()
            preview = page.getByRole('region', { name: 'Preview of q3-report.pdf' })
            await expect(preview.getByText('Saved q3-report (1).pdf to Downloads on this computer.')).toBeVisible()
            expect(await preview.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
            const close = await preview.getByRole('button', { name: 'Close preview' }).boundingBox()
            expect(close!.x + close!.width).toBeLessThanOrEqual(width)
            await page.screenshot({ path: join(evidence, `host-file-saved-${appearance}-${width}.png`), animations: 'disabled' })
          }
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
}

test('a file link on this computer opens the file in its own app, and shows a program in its folder', async () => {
  test.setTimeout(120_000)
  const folder = await mkdtemp(join(tmpdir(), 'sotto-e2e-local-files-'))
  const report = slashes(join(folder, 'q3-report.pdf')), script = slashes(join(folder, 'build-report.bat'))
  await writeFile(report, REPORT); await writeFile(script, '@echo off\r\necho built\r\n')
  try {
    await onReleaseTrack('owl', async () => {
      const launched = await launchSotto()
      try {
      const { page } = launched
      await startMonitoredThread(launched, hostKeys.read, page => page.locator(`section.thread-pane[data-thread-id="${hostKeys.key('workshop')}"]`))
      await resizeWindow(launched, 1280, 800)
      await page.evaluate(async ({ text, now }) => {
        await window.sottoE2E!.agentEvent!({ type: 'history', threadId: 'workshop', text: '', status: 'idle', messages: [
          { id: 'asked', role: 'user' as const, text: 'Build the Q3 report and tell me where everything is.', createdAt: new Date(now - 60_000).toISOString() },
          { id: 'linked', role: 'assistant' as const, text, createdAt: new Date(now).toISOString() },
        ] })
      }, { now: E2E_THREADS_NOW, text: `The report is [q3-report.pdf](<${report}>), in [its folder](<${slashes(folder)}>), and [build-report.bat](<${script}>) builds it again.` })
      const log = page.getByRole('log', { name: 'Thread transcript' })
      const snapshot = () => page.evaluate(async () => { const taken = await window.sottoE2E!.snapshot(); return { opened: taken.openedFiles ?? [], shown: taken.shownFiles ?? [] } })

      // A press opens the file, and a folder; main opens each by the path it really is.
      await log.getByRole('link', { name: `Open ${report}`, exact: true }).click()
      await log.getByRole('link', { name: `Open ${slashes(folder)}`, exact: true }).click()
      await expect.poll(async () => (await snapshot()).opened.map(slashes).map(path => path.split('/').pop())).toEqual(['q3-report.pdf', folder.split(/[\\/]/u).pop()])
      expect((await snapshot()).shown).toEqual([])

      // A program is never opened: its link says so, a press shows it in its folder, and the reply says nothing was run.
      const program = log.getByRole('link', { name: new RegExp(`^Show ${script.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')} in `, 'u') })
      await program.click()
      await expect(log.getByText('build-report.bat is a program or script, so it was shown in its folder. Nothing was run.')).toBeVisible()
      const after = await snapshot()
      expect(after.shown.map(slashes).map(path => path.split('/').pop())).toEqual(['build-report.bat'])
      expect(after.opened).toHaveLength(2)
      await page.screenshot({ path: join(evidence, 'local-program-shown-dark-1280.png'), animations: 'disabled' })

      // The menu offers Open for a file and none for a program.
      await log.getByRole('link', { name: `Open ${report}`, exact: true }).click({ button: 'right' })
      await expect(page.getByRole('menuitem')).toHaveText(['Open', /^Show in /u, 'Copy path'])
      await page.screenshot({ path: join(evidence, 'local-link-menu-dark-1280.png'), animations: 'disabled' })
      await page.keyboard.press('Escape')
      await program.click({ button: 'right' })
      await expect(page.getByRole('menuitem')).toHaveText([/^Show in /u, 'Copy path'])
      await page.keyboard.press('Escape')
      } finally { await closeSotto(launched) }
    })
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})
