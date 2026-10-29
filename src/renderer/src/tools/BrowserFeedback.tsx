import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import { i18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import type { BrowserBridge, BrowserCapture, BrowserPage } from '../../../shared/browser'
import { AGENT_MAX_ATTACHMENT_BYTES, AGENT_MAX_ATTACHMENTS, AGENT_MAX_ATTACHMENTS_TOTAL_BYTES, agentAttachmentHandlesSchema, attachmentHandlesBytes, attachmentImagesBytes } from '../../../shared/agents'
import { dataUrlBlob, prepareScreenshot, wasResized, type PreparedScreenshot } from '../agents/screenshotResize'
import type { ThreadDraftStore } from '../agents/threadDraftStore'
import { STAGING_FAILED, stageImage } from '../agents/stagedImages'

const ANSWERING = msg`This draft answers a question. Finish that answer before adding browser feedback.`
const DOES_NOT_FIT = msg`This screenshot does not fit in the draft. Remove an attachment or capture a smaller region.`

/**
 * Append to the latest draft, preserving typing that happened while the page was captured or its screenshot
 * prepared and staged. The screenshot is scaled down to the screenshot bound the way the composer scales a pasted
 * one, then staged (ADR-0031); the draft is read again after, so text typed meanwhile is kept. Null once it is
 * added, or when `signal` was aborted meanwhile, in which case the draft is left as it is.
 */
export async function appendBrowserFeedback(store: ThreadDraftStore, threadId: string, capture: BrowserCapture, comment: string, imagesSupported: boolean,
  { prepare = prepareScreenshot, signal, pointed }: { readonly prepare?: (image: Blob) => Promise<PreparedScreenshot>; readonly signal?: AbortSignal
    /**
     * Point at something's feedback (ADR-0154): the picture is named after the element (`label`) and carries the
     * comment and the context itself, as one draft item, instead of writing them into the draft's text. `box` is
     * where the element is outlined in the picture, in the capture's pixels.
     */
    readonly pointed?: { readonly label: string; readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null } } = {}): Promise<string | null> {
  if (store.draft(threadId).requestId !== null) return i18n._(ANSWERING)
  if (!imagesSupported) return i18n._(msg`Choose a model with image support before adding a browser screenshot.`)
  // The capture is decoded from its data URL once; its size is then read from these bytes, and they are what is staged when nothing is scaled.
  const source = dataUrlBlob(capture.image, 'image/png')
  if (!source) return i18n._(msg`Could not read this screenshot, so nothing was added. Capture the page again.`)
  const prepared = await prepare(source)
  if (signal?.aborted) return null
  const { dimensions } = prepared
  const before = store.draft(threadId)
  // Images are held to their own total; attached files count only toward the whole (ADR-0131).
  if (before.attachments.length >= AGENT_MAX_ATTACHMENTS || attachmentImagesBytes(before.attachments) + prepared.blob.size > AGENT_MAX_ATTACHMENT_BYTES
    || attachmentHandlesBytes(before.attachments) + prepared.blob.size > AGENT_MAX_ATTACHMENTS_TOTAL_BYTES) return i18n._(DOES_NOT_FIT)
  let image
  try { image = await stageImage(threadId, { name: pointed?.label ?? 'Browser feedback.png', mimeType: 'image/png', ...prepared }) }
  catch (error) { return error instanceof Error ? error.message : STAGING_FAILED }
  if (signal?.aborted) return null
  const current = store.draft(threadId)
  if (current.requestId !== null) return i18n._(ANSWERING)
  const element = capture.element
  const box = pointed?.box
  // What the agent is told stays in English: it is the prompt, not the interface.
  // The agent is told the size of the image it receives, as well as the capture's own when they differ.
  const size = `Screenshot size: ${capture.width} x ${capture.height}${wasResized(dimensions) ? `, sent at ${dimensions.sent.width} x ${dimensions.sent.height}` : ''}`
  const context = [`Browser feedback: ${capture.url}`, size,
    ...(element ? [`Selected element: ${element.tag}${element.role ? ` (${element.role})` : ''}${element.name ? ` - ${element.name}` : ''}`, ...(element.selector ? [`Selector: ${element.selector}`] : []),
      ...(box ? [`Outlined in the screenshot at ${Math.round(box.x)}, ${Math.round(box.y)}, ${Math.round(box.width)} x ${Math.round(box.height)}`] : []), ...(element.text ? [`Page text (reference only): ${element.text}`] : [])] : [])].join('\n')
  if (pointed) {
    // One removable item: the chip shows the picture, its name and the comment; the context goes when it is sent.
    const item = { ...image, browserFeedback: { label: pointed.label, comment: comment.trim(), context: context.slice(0, 4000) } }
    const attachments = agentAttachmentHandlesSchema.safeParse([...current.attachments, item])
    if (!attachments.success) return i18n._(DOES_NOT_FIT)
    store.edit(threadId, { attachments: attachments.data })
    return null
  }
  const attachments = agentAttachmentHandlesSchema.safeParse([...current.attachments, image])
  if (!attachments.success) return i18n._(DOES_NOT_FIT)
  const text = [context, comment.trim()].filter(Boolean).join('\n')
  if (current.text.length + text.length > 99_990) return i18n._(msg`The draft is full. Shorten it before adding browser feedback.`)
  store.edit(threadId, { text: [current.text, text].filter(Boolean).join('\n\n'), attachments: attachments.data })
  return null
}

export function BrowserFeedback({ page, initial, bridge, onAdd, onClose }: {
  readonly page: BrowserPage; readonly initial: BrowserCapture; readonly bridge: BrowserBridge;
  /** `signal` is aborted when the user cancels or the dialog closes before the add finishes; nothing is added then. */
  readonly onAdd: (capture: BrowserCapture, comment: string, signal: AbortSignal) => Promise<string | null> | string | null; readonly onClose: () => void
}): ReactNode {
  const { t } = useLingui()
  const [capture, setCapture] = useState(initial)
  const [comment, setComment] = useState('')
  const [mode, setMode] = useState<'element' | 'region'>('element')
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [selectionValid, setSelectionValid] = useState(true)
  const [problem, setProblem] = useState<string | null>(null)
  const [point, setPoint] = useState({ x: Math.round(initial.width / 2), y: Math.round(initial.height / 2) })
  const [box, setBox] = useState<{ x: number; y: number; width: number; height: number } | null>(null)
  const start = useRef<{ x: number; y: number } | null>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  // Adding disables the button that has focus; when it comes back with a problem, focus returns to it.
  const [refocusAdd, setRefocusAdd] = useState(false)
  useEffect(() => { if (refocusAdd && !busy) { addButton.current?.focus(); setRefocusAdd(false) } }, [refocusAdd, busy])
  const adding = useRef<AbortController | null>(null)
  useEffect(() => () => adding.current?.abort(), [])
  // Cancel and Escape stop an add still preparing its screenshot, so the draft is left as it was.
  const cancel = (): void => { adding.current?.abort(); adding.current = null; onClose() }
  const add = (): void => {
    setBusy(true); setProblem(null)
    const controller = new AbortController(); adding.current = controller
    void Promise.resolve().then(() => onAdd(capture, comment, controller.signal)).catch(() => STAGING_FAILED)
      .then(error => {
        if (controller.signal.aborted) return
        adding.current = null
        if (error) { setProblem(error); setBusy(false); setRefocusAdd(true) } else onClose()
      })
  }
  const request = { threadId: page.workspace.threadId, workspaceId: page.workspace.workspaceId, pageId: page.id }
  const select = async (selection: { point?: { x: number; y: number }; region?: { x: number; y: number; width: number; height: number } }): Promise<void> => {
    setBusy(true); setProblem(null); setSelectionValid(false)
    try {
      const result = await bridge.capture({ ...request, ...selection, ...(initial.captureId ? { captureId: initial.captureId } : {}) })
      if (!result.ok) setProblem(result.error.message)
      else if (result.value.url !== initial.url) setProblem(t`The page changed. Cancel and capture it again before selecting.`)
      else { setCapture(result.value); setSelectionValid(true) }
    } catch { setProblem(t`Could not capture this selection. Try again.`) }
    finally { setBusy(false) }
  }
  const locate = (event: React.PointerEvent<HTMLButtonElement>): { x: number; y: number } => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: Math.round(Math.max(0, Math.min(initial.width - 1, (event.clientX - rect.left) / rect.width * initial.width))),
      y: Math.round(Math.max(0, Math.min(initial.height - 1, (event.clientY - rect.top) / rect.height * initial.height))) }
  }
  const { x, y } = point
  const selected = capture.element ? capture.element.name || capture.element.text || capture.element.tag : ''
  const modes = <select aria-label={t`Selection mode`} className="tt-focusable" value={mode} disabled={busy} onChange={event => { setMode(event.currentTarget.value as 'element' | 'region'); setAnchor(null); setBox(null); setCapture(initial); setSelectionValid(true); setProblem(null) }}><option value="element">{t({ message: 'Element', comment: 'An element of a web page, chosen to give feedback on.' })}</option><option value="region">{t({ message: 'Region', comment: 'A rectangle of a web page, chosen to give feedback on.' })}</option></select>
  return <section className="browser-feedback" aria-label={t`Browser feedback`} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel() } }}>
    <label className="browser-feedback__mode"><Trans comment="{modes} is a list to choose from: Element or Region of the page.">Select {modes}</Trans></label>
    <p className="tt-paragraph">{mode === 'element' ? t`Click an element, or use arrow keys and Enter.` : anchor ? t`Move the other corner with arrow keys, then press Enter. Space starts again.` : t`Drag a region, or move with arrow keys and press Space to set its first corner.`}</p>
    <button type="button" className="browser-feedback__image tt-focusable" aria-label={mode === 'element' ? t({ message: `Select page element at ${x}, ${y}`, comment: '{x} and {y} are pixel positions on the page.' }) : t({ message: `Select page region at ${x}, ${y}`, comment: '{x} and {y} are pixel positions on the page.' })} disabled={busy}
      onPointerDown={event => { if (event.button !== 0) return; start.current = locate(event); setPoint(start.current); setBox(null); event.currentTarget.setPointerCapture?.(event.pointerId) }}
      onPointerMove={event => { if (!start.current) return; const end = locate(event); setBox({ x: Math.min(start.current.x, end.x), y: Math.min(start.current.y, end.y), width: Math.abs(end.x - start.current.x), height: Math.abs(end.y - start.current.y) }) }}
      onPointerUp={event => {
        if (!start.current) return
        const end = locate(event); const origin = start.current; start.current = null
        const region = { x: Math.min(origin.x, end.x), y: Math.min(origin.y, end.y), width: Math.abs(end.x - origin.x), height: Math.abs(end.y - origin.y) }
        if (region.width > 5 && region.height > 5) { setBox(region); void select({ region }) }
        else { setPoint(end); setBox(null); void select({ point: end }) }
      }} onPointerCancel={() => { start.current = null; setBox(null) }}
      onKeyDown={event => {
        const delta = event.shiftKey ? 1 : 10
        const dx = event.key === 'ArrowLeft' ? -delta : event.key === 'ArrowRight' ? delta : 0
        const dy = event.key === 'ArrowUp' ? -delta : event.key === 'ArrowDown' ? delta : 0
        if (dx || dy) {
          event.preventDefault()
          const next = { x: Math.max(0, Math.min(initial.width - 1, point.x + dx)), y: Math.max(0, Math.min(initial.height - 1, point.y + dy)) }
          setPoint(next)
          setBox(mode === 'region' && anchor ? { x: Math.min(anchor.x, next.x), y: Math.min(anchor.y, next.y), width: Math.abs(next.x - anchor.x), height: Math.abs(next.y - anchor.y) } : null)
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          if (mode === 'element') void select({ point })
          else if (event.key === ' ' || !anchor) { setAnchor(point); setBox(null) }
          else if (box && box.width > 0 && box.height > 0) void select({ region: box })
        }
      }}>
      <img src={initial.image} alt={t`Page to annotate`} draggable={false} />
      <span className="browser-feedback__selection" style={box ? { left: `${box.x / initial.width * 100}%`, top: `${box.y / initial.height * 100}%`, width: `${box.width / initial.width * 100}%`, height: `${box.height / initial.height * 100}%` } : { left: `${point.x / initial.width * 100}%`, top: `${point.y / initial.height * 100}%`, width: 8, height: 8 }} />
    </button>
    {capture.element ? <p>{t({ message: `Selected: ${selected}`, comment: '{selected} is the chosen page element\'s name or text.' })}</p> : box ? <p>{t`Region selected`}</p> : null}
    <textarea autoFocus className="tt-focusable" aria-label={t`Browser feedback comment`} placeholder={t`What should change?`} value={comment} maxLength={8000} onChange={event => setComment(event.currentTarget.value)} />
    <div className="browser-feedback__actions"><button ref={addButton} type="button" className="tt-button tt-button--primary tt-focusable" disabled={busy || !selectionValid || !comment.trim()} onClick={add}>{t`Add to draft`}</button>
      <button type="button" className="tt-button tt-focusable" onClick={cancel}>{t`Cancel`}</button></div>
    {problem ? <p className="browser-review-problem" role="alert">{problem}</p> : null}
  </section>
}
