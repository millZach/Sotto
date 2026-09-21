import React, { useRef, useState, type ReactNode } from 'react'
import type { BrowserBridge, BrowserCapture, BrowserPage } from '../../../shared/browser'
import { agentAttachmentsSchema } from '../../../shared/agents'
import type { ThreadDraftStore } from '../agents/threadDraftStore'

/** Append to the latest draft, preserving typing that happened while the page was captured. */
export function appendBrowserFeedback(store: ThreadDraftStore, threadId: string, capture: BrowserCapture, comment: string, imagesSupported: boolean): string | null {
  const current = store.draft(threadId)
  if (current.requestId !== null) return 'This draft answers a question. Finish that answer before adding browser feedback.'
  if (!imagesSupported) return 'Choose a model with image support before adding a browser screenshot.'
  const attachments = agentAttachmentsSchema.safeParse([...current.attachments, { id: crypto.randomUUID(), name: 'Browser feedback.png', mimeType: 'image/png', dataUrl: capture.image }])
  if (!attachments.success) return 'This screenshot does not fit in the draft. Remove an attachment or capture a smaller region.'
  const element = capture.element
  const context = [`Browser feedback: ${capture.url}`, `Screenshot size: ${capture.width} x ${capture.height}`,
    ...(element ? [`Selected element: ${element.tag}${element.role ? ` (${element.role})` : ''}${element.name ? ` - ${element.name}` : ''}`, ...(element.selector ? [`Selector: ${element.selector}`] : []), ...(element.text ? [`Page text (reference only): ${element.text}`] : [])] : []), comment.trim()].filter(Boolean).join('\n')
  if (current.text.length + context.length > 99_990) return 'The draft is full. Shorten it before adding browser feedback.'
  store.edit(threadId, { text: [current.text, context].filter(Boolean).join('\n\n'), attachments: attachments.data })
  return null
}

export function BrowserFeedback({ page, initial, bridge, onAdd, onClose }: {
  readonly page: BrowserPage; readonly initial: BrowserCapture; readonly bridge: BrowserBridge;
  readonly onAdd: (capture: BrowserCapture, comment: string) => string | null; readonly onClose: () => void
}): ReactNode {
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
  const request = { threadId: page.workspace.threadId, workspaceId: page.workspace.workspaceId, pageId: page.id }
  const select = async (selection: { point?: { x: number; y: number }; region?: { x: number; y: number; width: number; height: number } }): Promise<void> => {
    setBusy(true); setProblem(null); setSelectionValid(false)
    try {
      const result = await bridge.capture({ ...request, ...selection, ...(initial.captureId ? { captureId: initial.captureId } : {}) })
      if (!result.ok) setProblem(result.error.message)
      else if (result.value.url !== initial.url) setProblem('The page changed. Cancel and capture it again before selecting.')
      else { setCapture(result.value); setSelectionValid(true) }
    } catch { setProblem('Could not capture this selection. Try again.') }
    finally { setBusy(false) }
  }
  const locate = (event: React.PointerEvent<HTMLButtonElement>): { x: number; y: number } => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: Math.round(Math.max(0, Math.min(initial.width - 1, (event.clientX - rect.left) / rect.width * initial.width))),
      y: Math.round(Math.max(0, Math.min(initial.height - 1, (event.clientY - rect.top) / rect.height * initial.height))) }
  }
  return <section className="browser-feedback" aria-label="Browser feedback" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() } }}>
    <label className="browser-feedback__mode">Select <select aria-label="Selection mode" className="tt-focusable" value={mode} disabled={busy} onChange={event => { setMode(event.currentTarget.value as 'element' | 'region'); setAnchor(null); setBox(null); setCapture(initial); setSelectionValid(true); setProblem(null) }}><option value="element">Element</option><option value="region">Region</option></select></label>
    <p>{mode === 'element' ? 'Click an element, or use arrow keys and Enter.' : anchor ? 'Move the other corner with arrow keys, then press Enter. Space starts again.' : 'Drag a region, or move with arrow keys and press Space to set its first corner.'}</p>
    <button type="button" className="browser-feedback__image tt-focusable" aria-label={`Select page ${mode} at ${point.x}, ${point.y}`} disabled={busy}
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
      <img src={initial.image} alt="Page to annotate" draggable={false} />
      <span className="browser-feedback__selection" style={box ? { left: `${box.x / initial.width * 100}%`, top: `${box.y / initial.height * 100}%`, width: `${box.width / initial.width * 100}%`, height: `${box.height / initial.height * 100}%` } : { left: `${point.x / initial.width * 100}%`, top: `${point.y / initial.height * 100}%`, width: 8, height: 8 }} />
    </button>
    {capture.element ? <p>Selected: {capture.element.name || capture.element.text || capture.element.tag}</p> : box ? <p>Region selected</p> : null}
    <textarea autoFocus className="tt-focusable" aria-label="Browser feedback comment" placeholder="What should change?" value={comment} maxLength={8000} onChange={event => setComment(event.currentTarget.value)} />
    <div className="browser-feedback__actions"><button type="button" className="tt-button tt-button--primary tt-focusable" disabled={busy || !selectionValid || !comment.trim()} onClick={() => { const error = onAdd(capture, comment); if (error) setProblem(error); else onClose() }}>Add to draft</button>
      <button type="button" className="tt-button tt-focusable" onClick={onClose}>Cancel</button></div>
    {problem ? <p className="browser-review-problem" role="alert">{problem}</p> : null}
  </section>
}
