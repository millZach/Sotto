import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { evidenceDirectory } from '../fixtures/evidence'
import { agentState, agentThreadDetail } from './support/agentAccess'
import { fillPrompt, promptField } from './support/prompt'
import { onReleaseTrack } from './support/releaseTrack'
import { closeSotto, launchSotto, openThreads } from './support/sottoLaunch'

const evidence = evidenceDirectory('artifacts/attach-any-file')
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 72 72]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n')
const LOG = Buffer.from('12:00:01 deploy started\n12:00:09 deploy finished\n')

test('on Owl, files join the composer as pills, send, and land in the working folder', async () => {
  test.setTimeout(90_000)
  await onReleaseTrack('owl', async () => {
    const launched = await launchSotto()
    const { page } = launched
    try {
      await page.evaluate(async () => {
        await window.sotto!.updateSettings({ onboardingComplete: true })
        await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true } })
        await window.sotto!.agents!.command({ type: 'connect' })
      })
      await page.reload(); await openThreads(page)
      await page.getByRole('button', { name: 'Workshop', exact: true }).click()
      const attach = page.getByRole('button', { name: 'Attach files', exact: true })
      await expect(attach).toBeEnabled()
      await page.getByLabel('Files to attach').setInputFiles([
        { name: 'quarterly-report.pdf', mimeType: 'application/pdf', buffer: PDF },
        { name: 'server.log', mimeType: '', buffer: LOG },
      ])
      const pills = page.getByRole('list', { name: 'Attached files' })
      await expect(pills.getByRole('button', { name: 'Remove quarterly-report.pdf' })).toBeVisible()
      await expect(pills.getByRole('button', { name: 'Remove server.log' })).toBeVisible()
      await page.emulateMedia({ reducedMotion: 'reduce' })
      for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]]) {
        await launched.app.evaluate(({ BrowserWindow }, size) => {
          BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.setContentSize(size.width!, size.height!)
        }, { width, height })
        for (const appearance of ['dark', 'light'] as const) {
          await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), appearance)
          await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
          await expect(page.getByRole('button', { name: 'Send prompt', exact: true })).toBeInViewport()
          await expect(pills).toBeInViewport()
          expect(await pills.evaluate(list => list.scrollWidth <= list.clientWidth + 1)).toBe(true)
          await page.screenshot({ path: join(evidence, `pills-${width}-${appearance}.png`), animations: 'disabled' })
        }
      }
      await fillPrompt(promptField(page), 'Compare the report with the log.')
      await page.getByRole('button', { name: 'Send prompt', exact: true }).click()
      const transcript = page.getByLabel('Thread transcript', { exact: true })
      await expect(transcript.getByText('quarterly-report.pdf')).toBeVisible()
      await expect(transcript.getByText('server.log')).toBeVisible()
      await expect(transcript).not.toContainText('sotto-attached-files')
      await expect(transcript).not.toContainText('No preview for this file type')
      await expect(pills).toHaveCount(0)
      await page.screenshot({ path: join(evidence, 'sent.png'), animations: 'disabled' })

      // The in-memory provider e2e runs on is not an adapter, so the copy into the working folder is checked by
      // tests/integration/adapterContract.ts against every adapter; here the sent message keeps both files' handles.
      const state = await agentState(page)
      const details = await Promise.all(state.host.threads.map(thread => agentThreadDetail(page, thread.id)))
      const sent = details.flatMap(detail => detail?.messages ?? []).find(message => message.text === 'Compare the report with the log.')
      expect(sent?.attachments?.map(attachment => [attachment.name, attachment.sizeBytes])).toEqual([['quarterly-report.pdf', PDF.length], ['server.log', LOG.length]])
    } finally { await closeSotto(launched) }
  })
})
