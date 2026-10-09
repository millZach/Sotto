import { agentState } from './support/agentAccess'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeSotto, launchSotto, openThreads, resizeWindow } from './support/sottoLaunch'
import { evidenceDirectory } from '../fixtures/evidence'

const run = evidenceDirectory('artifacts/review-385')

/**
 * Every capture this spec takes; the verification note cites a few, copied to artifacts/staged-images/.
 * See "E2e evidence" in docs/ci.md for default, publish and root override paths.
 */
const RUN = evidenceDirectory('artifacts/staged-images-run')

test('repairs a missing staged screenshot when the user attaches the same image again', async () => {
  await mkdir(run, { recursive: true })
  const icon = await readFile('build/icon.png')
  const image = icon.toString('base64')
  const launched = await launchSotto()
  try {
    const { page } = launched
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload(); await openThreads(page)
    await page.getByRole('button', { name: 'Workshop', exact: true }).click()
    await paste(page, image, 'Repair.png')
    await thumbnail(page, 'Repair.png')
    await expect.poll(async () => (await agentState(page)).threadDrafts?.[0]?.attachments[0]?.name).toBe('Repair.png')
    const draft = (await agentState(page)).threadDrafts![0]!
    const handle = draft.attachments[0]!
    const file = join(launched.userData, 'attachments', `${handle.digest}.png`)
    await rm(file)
    // The E2E provider does not resolve image bytes. Exercise the real preload/main content boundary that a
    // restored thumbnail uses, so it discovers the missing file without fabricating a refusal or changing the host.
    expect(await page.evaluate(async request => window.sotto!.agents!.attachmentContent!(request), { threadId: draft.threadId, digest: handle.digest })).toBeNull()
    await page.getByRole('button', { name: 'Send prompt', exact: true }).click()
    await expect(page.getByRole('article', { name: 'Pending message' })).toContainText('An image in this message is no longer kept on this computer. Remove it and attach it again. Nothing else was changed. It is back in the composer.')
    await page.screenshot({ path: `${run}/missing.png`, animations: 'disabled' })
    await expect(page.getByLabel('Thread transcript', { exact: true }).getByAltText('Repair.png')).toHaveCount(0)
    await page.getByRole('button', { name: 'Remove Repair.png', exact: true }).click()
    await paste(page, image, 'Repair.png')
    await thumbnail(page, 'Repair.png')
    await expect.poll(async () => readFile(file).catch(() => null)).toEqual(icon)
    await page.getByRole('button', { name: 'Send prompt', exact: true }).click()
    await expect(page.getByLabel('Thread transcript', { exact: true }).getByAltText('Repair.png')).toBeVisible()
    await expect(page.getByLabel('Thread transcript', { exact: true }).getByAltText('Repair.png')).toHaveCount(1)
    await expect(page.getByLabel('Attached screenshots')).toHaveCount(0)
    await page.screenshot({ path: `${run}/repaired.png`, animations: 'disabled' })
  } finally { await closeSotto(launched) }
})

async function paste(page: Page, image: string, name: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Prompt', exact: true }).evaluate((element, data) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([Uint8Array.from(atob(data.image), char => char.charCodeAt(0))], data.name, { type: 'image/png' }))
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
  }, { image, name })
}

/** The chip's thumbnail as the window drew it: its source and its own pixel size. */
async function thumbnail(page: Page, name: string): Promise<{ src: string; width: number; height: number }> {
  const chip = page.getByLabel('Attached screenshots').getByAltText(name)
  await expect(chip).toBeVisible()
  await expect.poll(() => chip.evaluate(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBe(true)
  return chip.evaluate(image => ({ src: (image as HTMLImageElement).src, width: (image as HTMLImageElement).naturalWidth, height: (image as HTMLImageElement).naturalHeight }))
}

test('stages a pasted screenshot once, carries its handle, and restores its chip after a reload and a restart (ADR-0031)', async () => {
  test.setTimeout(120_000)
  await mkdir(RUN, { recursive: true })
  const icon = await readFile('build/icon.png')
  const image = icon.toString('base64')
  let launched = await launchSotto()
  const profile = launched.userData
  try {
    const { page } = launched
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload(); await openThreads(page)
    await page.getByRole('button', { name: 'Workshop', exact: true }).click()
    await paste(page, image, 'Staged.png')
    // The chip's thumbnail is the window's own bounded copy, not the image.
    const drawn = await thumbnail(page, 'Staged.png')
    expect(Math.max(drawn.width, drawn.height)).toBeLessThanOrEqual(256)
    expect(drawn.src).not.toContain(image.slice(0, 200))
    // What main holds and publishes names the image; its bytes are in the store, once.
    await expect.poll(async () => (await agentState(page)).threadDrafts?.[0]?.attachments[0]).toMatchObject({ name: 'Staged.png', sizeBytes: icon.length })
    const state = await agentState(page)
    expect(JSON.stringify(state)).not.toContain(image.slice(0, 200))
    const digest = state.threadDrafts![0]!.attachments[0]!.digest
    expect(await readdir(join(profile, 'attachments'))).toEqual(expect.arrayContaining([`${digest}.png`, 'index.json']))
    expect(await readFile(join(profile, 'agents.json'), 'utf8')).not.toContain(image.slice(0, 200))

    await page.emulateMedia({ reducedMotion: 'reduce' })
    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
      await resizeWindow(launched, width, height)
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), appearance)
        await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
        await expect(page.getByLabel('Attached screenshots').getByAltText('Staged.png')).toBeInViewport()
        await expect(page.getByRole('button', { name: 'Send prompt', exact: true })).toBeInViewport()
        await page.screenshot({ path: `${RUN}/attached-${width}-${appearance}.png`, animations: 'disabled' })
      }
    }

    // A reload forgets the window's thumbnails: the chip reads the staged image back and draws it again.
    await page.reload(); await openThreads(page)
    await page.getByRole('button', { name: 'Workshop', exact: true }).click()
    const redrawn = await thumbnail(page, 'Staged.png')
    expect(Math.max(redrawn.width, redrawn.height)).toBeLessThanOrEqual(256)
    await page.screenshot({ path: `${RUN}/after-reload.png`, animations: 'disabled' })

    // A restart keeps the draft and its image: the content was on disk before the draft named it.
    await launched.app.close()
    launched = await launchSotto('success', profile)
    const restarted = launched.page
    await restarted.evaluate(async () => { await window.sotto!.agents!.command({ type: 'connect' }) })
    await openThreads(restarted)
    await restarted.getByRole('button', { name: 'Workshop', exact: true }).click()
    await thumbnail(restarted, 'Staged.png')
    await restarted.screenshot({ path: `${RUN}/after-restart.png`, animations: 'disabled' })

    // Sent, the image reaches the provider and shows as the message's preview.
    await restarted.getByRole('button', { name: 'Send prompt', exact: true }).click()
    const transcript = restarted.getByLabel('Thread transcript', { exact: true })
    await expect(transcript.getByAltText('Staged.png')).toBeVisible()
    await expect(restarted.getByLabel('Attached screenshots')).toHaveCount(0)
    await restarted.screenshot({ path: `${RUN}/sent.png`, animations: 'disabled' })
  } finally {
    // The profile is this spec's own from the first launch, whichever launch is open now.
    await closeSotto({ ...launched, ownsUserData: true })
  }
})
