import { expect, type Locator, type Page } from '@playwright/test'
import type { AgentAttachmentHandle } from '../../src/shared/agents'
import { openThreads } from '../e2e/support/sottoLaunch'

export interface DrawnScreenshot {
  readonly name: string
  readonly type: 'image/png' | 'image/jpeg'
  readonly width: number
  readonly height: number
  /** The fraction of the width, on the right, filled with a photograph-like noisy gradient. */
  readonly photo: number
}

export interface PastedScreenshot {
  /** The size of the file pasted, in bytes. */
  readonly fileBytes: number
  /** From the paste event to its thumbnail appearing in the composer, in milliseconds. */
  readonly ms: number
}

/**
 * Pastes a screenshot-like image into `target` (a prompt), drawn in the window's own canvas: lines of text on a
 * flat panel, with a photograph-like strip down the right `photo` fraction of it. A capture of flat panels and
 * text alone compresses so well as a PNG that a scaled-down copy can come out larger; a photograph, a
 * wallpaper or a video frame in the capture is what makes a real one megabytes. The drawing is seeded, so the
 * same size draws the same pixels every time. Resolves when the composer shows the image's thumbnail.
 */
export async function pasteDrawnScreenshot(target: Locator, screenshot: DrawnScreenshot): Promise<PastedScreenshot> {
  return target.evaluate(async (element, image) => {
    const canvas = new OffscreenCanvas(image.width, image.height)
    const context = canvas.getContext('2d')!
    context.fillStyle = '#1e1f24'; context.fillRect(0, 0, image.width, image.height)
    let seed = 7
    const next = () => (seed = (seed * 48271) % 2147483647) / 2147483647
    const strip = Math.round(image.width * image.photo)
    if (strip > 0) {
      const pixels = context.createImageData(strip, image.height)
      for (let y = 0; y < image.height; y += 1) for (let x = 0; x < strip; x += 1) {
        const index = (y * strip + x) * 4, noise = next() * 24
        pixels.data[index] = 60 + 120 * x / strip + noise; pixels.data[index + 1] = 90 + 80 * y / image.height + noise
        pixels.data[index + 2] = 140 + noise; pixels.data[index + 3] = 255
      }
      context.putImageData(pixels, image.width - strip, 0)
    }
    const line = Math.max(14, Math.round(image.height / 90))
    context.font = `${Math.round(line * 0.75)}px monospace`
    for (let y = line * 2; y < image.height; y += line) {
      context.fillStyle = next() > 0.8 ? '#8ab4f8' : '#c9ccd4'
      const words = Array.from({ length: 4 + Math.floor(next() * 10) }, () => Math.floor(next() * 36 ** 5).toString(36)).join(' ')
      context.fillText(words, Math.round(image.width * 0.05), y)
    }
    const blob = await canvas.convertToBlob({ type: image.type, quality: 0.92 })
    const shown = () => [...document.querySelectorAll('img')].some(img => img.getAttribute('alt') === image.name)
    const appeared = new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => { observer.disconnect(); reject(new Error(`${image.name} did not appear in the composer.`)) }, 30_000)
      const observer = new MutationObserver(() => { if (shown()) { observer.disconnect(); clearTimeout(deadline); resolve() } })
      observer.observe(document.body, { childList: true, subtree: true })
    })
    const transfer = new DataTransfer()
    transfer.items.add(new File([blob], image.name, { type: image.type }))
    const started = performance.now()
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
    await appeared
    return { fileBytes: blob.size, ms: performance.now() - started }
  }, screenshot)
}

/** Turns the thread view on in the launched app and opens the Workshop thread's composer, ready for a paste. */
export async function openWorkshopComposer(page: Page): Promise<Locator> {
  await page.evaluate(async () => {
    await window.sotto!.updateSettings({ onboardingComplete: true })
    await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, } })
    await window.sotto!.agents!.command({ type: 'connect' })
  })
  await page.reload(); await openThreads(page)
  await page.getByRole('button', { name: 'Workshop', exact: true }).click()
  return page.getByRole('textbox', { name: 'Prompt', exact: true })
}

/** The staged image named `name` on any saved thread draft, once the draft carrying it has been saved (ADR-0031). */
export async function savedAttachment(page: Page, name: string): Promise<AgentAttachmentHandle> {
  let found: AgentAttachmentHandle | undefined
  await expect.poll(async () => {
    const state = await page.evaluate(async () => window.sotto!.agents!.get())
    found = state.threadDrafts?.flatMap(draft => draft.attachments).find(attachment => attachment.name === name)
    return found !== undefined
  }, { timeout: 30_000 }).toBe(true)
  return found!
}

/** The pixel size of the bytes main staged for a handle, read back and decoded in the window. Sizes only. */
export async function decodedSize(page: Page, handle: Pick<AgentAttachmentHandle, 'digest'>): Promise<{ width: number, height: number }> {
  return page.evaluate(async digest => {
    const content = await window.sotto!.agents!.attachmentContent!({ threadId: null, digest })
    if (!content) throw new Error('The staged image is no longer kept.')
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(content.bytes)], { type: content.mimeType }))
    const size = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return size
  }, handle.digest)
}
