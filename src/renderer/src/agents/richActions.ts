import { useCallback, useEffect, useRef, useState } from 'react'

const FEEDBACK_MS = 1_600

/** A short-lived status message, cleared after a moment and on unmount. */
export function useTransientFlag(): [string | null, (value: string) => void] {
  const [value, setValue] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  const show = useCallback((next: string) => {
    if (timer.current) clearTimeout(timer.current)
    setValue(next)
    timer.current = setTimeout(() => { setValue(null); timer.current = null }, FEEDBACK_MS)
  }, [])
  return [value, show]
}

/** Parts of a rendered message that carry controls or status, never content. */
const PLAIN_TEXT_SKIP = '.rich-code__bar, .rich-message__feedback, .tt-visually-hidden, [aria-hidden="true"]'
/** Blocks that end a line in the plain-text form. */
const PLAIN_TEXT_BREAK = 'p, li, h1, h2, h3, h4, h5, h6, tr, pre, blockquote, .rich-code, .rich-table, ul, ol, hr'

/**
 * What a rendered message would read as plain text: the words on screen with fences, markers and
 * controls dropped, table cells separated by tabs. A DOM walk rather than innerText so it runs the
 * same in the window and in tests.
 */
export function renderedPlainText(root: Element): string {
  const walk = (node: Node, into: string[], pre: boolean): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.nodeValue ?? ''
      into.push(pre ? value : value.replace(/\s+/gu, ' '))
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const element = node as Element
    if (element.matches(PLAIN_TEXT_SKIP)) return
    if (element.tagName === 'BR') { into.push('\n'); return }
    if (element.tagName === 'TR') {
      const cells = [...element.children].filter(cell => cell.tagName === 'TD' || cell.tagName === 'TH')
        .map(cell => { const parts: string[] = []; for (const child of cell.childNodes) walk(child, parts, false); return parts.join('').trim() })
      into.push(cells.join('\t'), '\n')
      return
    }
    for (const child of element.childNodes) walk(child, into, pre || element.tagName === 'PRE')
    if (element.matches(PLAIN_TEXT_BREAK)) into.push('\n')
  }
  const parts: string[] = []
  for (const child of root.childNodes) walk(child, parts, false)
  return parts.join('').replace(/[ \t]+\n/gu, '\n').replace(/\n{3,}/gu, '\n\n').trim()
}

export async function writeClipboard(text: string): Promise<void> {
  // The production renderer deliberately denies browser clipboard permission.
  // Use the same main-owned, copy-only output path as the History page.
  if (window.sotto?.deliverOutput) {
    const result = await window.sotto.deliverOutput({ text, autoPaste: false, pasteDelayMs: 50 })
    if (result !== 'copied') throw new Error('Clipboard unavailable')
    return
  }
  if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
  await navigator.clipboard.writeText(text)
}

/**
 * Puts an image on the clipboard through main, which owns it. The window redraws the image as a PNG first, so any
 * format it can show (PNG, JPEG, WebP, GIF) arrives in the one format every app pastes.
 */
export async function writeClipboardImage(source: string): Promise<void> {
  const copy = window.sotto?.copyImage
  if (!copy) throw new Error('Clipboard unavailable')
  const result = await copy({ dataUrl: await pngDataUrl(source) })
  if (!result.ok) throw new Error('Clipboard unavailable')
}

/** Copy image with its feedback: "Copied image", or what went wrong and what to do. */
export function useCopyImage(): [string | null, (source: string) => void] {
  const [feedback, showFeedback] = useTransientFlag()
  const copy = useCallback((source: string): void => {
    void writeClipboardImage(source).then(() => showFeedback(COPIED_IMAGE), () => showFeedback('Could not copy the image. Try again.'))
  }, [showFeedback])
  return [feedback, copy]
}
export const COPIED_IMAGE = 'Copied image'

async function pngDataUrl(source: string): Promise<string> {
  if (source.startsWith('data:image/png;base64,')) return source
  const image = new Image()
  image.src = source
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Image could not be drawn')
  context.drawImage(image, 0, 0)
  return canvas.toDataURL('image/png')
}
