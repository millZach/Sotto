import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '@lingui/core/macro'
import { MAX_OUTPUT_IMAGE_DATA_URL } from '../../../shared/contracts'
import { useInterfaceLanguageState } from '../state/interfaceLanguage'
import { shownWords, type LaterWords } from './interfaceWords'

const FEEDBACK_MS = 1_600

/**
 * A short-lived status, cleared after a moment and on unmount. It holds text, or what happened as a key or a message
 * whose words are read when shown, so a change of language rewords it (ADR-0123).
 */
export function useTransientFlag<T extends string | object = string>(): [T | null, (value: T) => void] {
  const [value, setValue] = useState<T | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  const show = useCallback((next: T) => {
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
  const dataUrl = await pngDataUrl(source)
  if (dataUrl.length > MAX_OUTPUT_IMAGE_DATA_URL) throw new ImageTooLargeError()
  const result = await copy({ dataUrl })
  if (!result.ok) throw new Error('Clipboard unavailable')
}

/** The image is too large, redrawn as a PNG, to hand to the clipboard. */
export class ImageTooLargeError extends Error {
  constructor() { super('Image too large to copy') }
}

/** How the latest copy of an image went, or other words shown in its place; the words are read when shown (ADR-0123). */
type ImageCopyStatus = { readonly copy: 'copied' | 'too-large' | 'failed' } | { readonly said: LaterWords }

/**
 * Copy image with its feedback: "Copied image", or what went wrong and what to do. Only the latest copy's result is
 * shown, so an older copy that fails late cannot cover a newer one that worked. `say` shows any other status there.
 * The last element is whether the latest copy went through.
 */
export function useCopyImage(): [string | null, (source: string) => void, (words: LaterWords) => void, boolean] {
  useInterfaceLanguageState()
  const [status, show] = useTransientFlag<ImageCopyStatus>()
  const latest = useRef(0)
  const copy = useCallback((source: string): void => {
    const request = ++latest.current
    const settle = (outcome: 'copied' | 'too-large' | 'failed'): void => { if (request === latest.current) show({ copy: outcome }) }
    void writeClipboardImage(source).then(() => settle('copied'), error => settle(error instanceof ImageTooLargeError ? 'too-large' : 'failed'))
  }, [show])
  const say = useCallback((words: LaterWords): void => show({ said: words }), [show])
  const feedback = status === null ? null
    : 'said' in status ? shownWords(status.said)
      : status.copy === 'copied' ? t`Copied image`
        : status.copy === 'too-large' ? t`This image is too large to copy. Nothing was put on the clipboard.`
          : t`Could not copy the image. Try again.`
  return [feedback, copy, say, status !== null && 'copy' in status && status.copy === 'copied']
}

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
  const png = canvas.toDataURL('image/png')
  // Let go of the full-size bitmap now rather than whenever the canvas is collected.
  canvas.width = 0
  canvas.height = 0
  return png
}
