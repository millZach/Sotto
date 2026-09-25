import React, { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, ExternalLink, Globe, MessageSquarePlus, Plus, RotateCw, Share2, X } from 'lucide-react'
import type { BrowserBridge, BrowserPage, BrowserCapture } from '../../../shared/browser'
import type { ToolsError } from '../../../shared/tools'
import { useOptionalAgents } from '../agents/AgentContext'
import { BrowserTaskDetails } from './BrowserTaskPreview'
import { appendBrowserFeedback, BrowserFeedback } from './BrowserFeedback'
import { useBrowserTasks, normalizeAddress, pageLabel, useThreadBrowser, type BrowserStore } from './browserStore'
import { ToolsChrome } from './ToolsChrome'

export interface BrowserSurfaceProps {
  readonly threadId: string
  readonly store: BrowserStore
  readonly bridge: BrowserBridge | undefined
  readonly onStatus: (message: string) => void
}

/** Anything drawn above the page that a native view would cover. Native views composite over all DOM. */
const OVERLAY_SELECTOR = '[role="dialog"], [role="alertdialog"], [role="menu"], dialog[open], [data-covers-native-view]'

function listProblem(error: ToolsError, bridge: boolean): string {
  if (!bridge) return 'Browser is not available in this window.'
  switch (error.code) {
    case 'thread-unavailable': return 'This thread is not available to the browser.'
    case 'workspace-unavailable': return 'The working folder is not available.'
    default: return error.message || 'The browser could not list its pages.'
  }
}

/**
 * The theme editor minimized to its bar is the one overlay that covers only what it overlaps: the reader keeps it up
 * while checking a theme against the page, so the page shows beside it and steps aside only under it.
 */
const COVERS_WHERE_IT_OVERLAPS = '[data-theme-editor-panel][data-minimized]'

/** Whether `element` reaches a pixel of the native page, which main draws at `viewport`'s rounded rectangle. */
function overlapsPage(element: HTMLElement, viewport: HTMLElement | null): boolean {
  if (!viewport) return true
  const box = element.getBoundingClientRect()
  const page = viewport.getBoundingClientRect()
  return Math.floor(box.left) < Math.round(page.right) && Math.ceil(box.right) > Math.round(page.left)
    && Math.floor(box.top) < Math.round(page.bottom) && Math.ceil(box.bottom) > Math.round(page.top)
}

/** True while an overlay outside `inside` covers the page at `viewport`, so the native page steps aside for it. */
function useOverlayOpen(inside: React.RefObject<HTMLElement | null>, viewport: React.RefObject<HTMLElement | null>): boolean {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    let frame = 0
    const check = (): void => {
      cancelAnimationFrame(frame)
      frame = 0
      const overlays = [...document.querySelectorAll<HTMLElement>(OVERLAY_SELECTOR)].filter(element => !inside.current?.contains(element) && element.getClientRects().length > 0)
      const bars = overlays.filter(element => element.matches(COVERS_WHERE_IT_OVERLAPS))
      const modal = bars.length < overlays.length
      setOpen(modal || bars.some(bar => overlapsPage(bar, viewport.current)))
      // A bar moves with no DOM change this observes (a drag, the window or panel resizing), so it is measured every
      // frame while it alone could cover the page.
      if (!modal && bars.length > 0) frame = requestAnimationFrame(check)
    }
    check()
    const observer = new MutationObserver(check)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['role', 'open', 'hidden', 'data-covers-native-view', 'data-minimized'] })
    return () => { observer.disconnect(); cancelAnimationFrame(frame) }
  }, [inside, viewport])
  return open
}

/**
 * Pages the thread opened, each a live page main keeps while it is hidden. One page shows at a time, drawn by
 * main at this surface's viewport; the address bar, history and page tabs stay in the app.
 */
export function BrowserSurface({ threadId, store, bridge, onStatus }: BrowserSurfaceProps): ReactNode {
  const browser = useThreadBrowser(store, threadId)
  const tasks = useBrowserTasks(store)
  const agents = useOptionalAgents()
  const owningThread = agents?.state?.host.threads.find(item => item.id === threadId)
  const owningModel = agents?.state?.host.models.find(item => item.id === owningThread?.modelId)
  const agentToolsUnavailable = owningThread?.providerId === 'devin' || owningModel?.providerId === 'devin'
  const [feedback, setFeedback] = useState<BrowserCapture | null>(null)
  const [reviewBusy, setReviewBusy] = useState(false)
  const [stoppingGrant, setStoppingGrant] = useState(false)
  const address = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState<{ pageId: string | null; text: string } | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const surface = useRef<HTMLDivElement>(null)
  const active = browser?.pages.find(page => page.id === browser.activePageId) ?? null
  const activeId = active?.id ?? null
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
  const [selectedTask, setSelectedTask] = useState<string | null>(null)
  const pageTasks = tasks.filter(item => item.threadId === threadId && item.pageId === activeId)
  const task = pageTasks.find(item => item.id === selectedTask) ?? pageTasks[0]
  useEffect(() => { setFeedback(null) }, [activeId])

  // A different page, or a navigation the page made itself, shows its own address unless the reader is typing.
  useEffect(() => { setDraft(current => current !== null && current.pageId === activeId ? current : null); setProblem(null) }, [activeId])

  if (!browser || browser.status === 'loading' && browser.pages.length === 0) return <><ToolsChrome title="Browser" /><p className="files-preview__loading" role="status">Loading pages…</p></>
  if (browser.status === 'error' && browser.pages.length === 0) {
    return <><ToolsChrome title="Browser" /><div className="files-problem files-problem--root" role="status">
      <strong>{listProblem(browser.error ?? { code: 'unavailable', message: '' }, bridge !== undefined)}</strong>
      {bridge ? <button type="button" className="files-link tt-focusable" onClick={() => void store.activate(bridge, threadId)}>Try again</button> : null}
    </div></>
  }
  const { pages } = browser
  const newPage = creating || pages.length === 0
  const shown = draft !== null && draft.pageId === (newPage ? null : activeId) ? draft.text : newPage ? '' : active?.url ?? ''
  const full = pages.length >= 32

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const parsed = normalizeAddress(shown)
    if ('error' in parsed) { setProblem(parsed.error); address.current?.focus(); return }
    setProblem(null)
    const done = (ok: boolean): void => { if (ok) { setDraft(null); setCreating(false) } }
    if (newPage || !active) void store.create(bridge, threadId, parsed.url).then(done)
    else void store.navigate(bridge, threadId, active.id, parsed.url).then(done)
  }
  const openExternally = (url: string): void => {
    if (!bridge) return
    void bridge.openLink({ url, destination: 'external' }).then(result => { if (!result.ok) onStatus('Could not open the system browser') }, () => onStatus('Could not open the system browser'))
  }
  const focusTab = (id: string): void => document.getElementById(`browser-tab-${id}`)?.focus()
  // Stop takes its own line away, so focus goes to the address, the next thing the eye reads.
  const stopGrant = (): void => {
    setStoppingGrant(true); setProblem(null)
    void store.stopGrant(bridge, threadId).then(error => {
      if (error) setProblem(error)
      else requestAnimationFrame(() => address.current?.focus())
    }).finally(() => setStoppingGrant(false))
  }
  const startNew = (): void => {
    setCreating(true)
    setDraft({ pageId: null, text: '' })
    setProblem(null)
    requestAnimationFrame(() => address.current?.focus())
  }

  const reviewPage = async (action: 'share' | 'capture' | 'viewport', size?: string): Promise<void> => {
    if (!bridge || !active) return
    setReviewBusy(true); setProblem(null)
    const request = { threadId, workspaceId: active.workspace.workspaceId, pageId: active.id }
    try {
      if (action === 'capture') {
        const result = await bridge.capture(request)
        if (activeIdRef.current !== active.id) return
        if (result.ok) setFeedback(result.value)
        else setProblem(result.error.message)
      } else {
        const [width, height] = (size || '1280x800').split('x').map(Number)
        const result = action === 'share' ? await bridge.share({ ...request, enabled: !active.sharedOrigin }) : await bridge.viewport(size === 'fit' ? { ...request, reset: true } : { ...request, width: width!, height: height! })
        if (activeIdRef.current !== active.id) return
        if (result.ok) store.adopt(result.value)
        else setProblem(result.error.message)
      }
    } catch { setProblem('The browser did not answer. Try again.') }
    finally { setReviewBusy(false) }
  }

  return <div className="browser-surface" ref={surface}>
    {pages.length > 0 ? <div className="terminal-bar browser-bar tools-chrome">
      <div className="terminal-tabs" role="tablist" aria-label="Pages">
        {pages.map((page, index) => {
          const selected = page.id === activeId && !creating
          // With previews off, the tab is where a page's waiting request shows before the page is chosen.
          const waiting = tasks.some(item => item.threadId === threadId && item.pageId === page.id && item.pendingAction !== null)
          // The open page carries its own close, the way a tab closes, so the line's end holds only New page.
          return <span key={page.id} className="terminal-tabs__item" data-selected={selected || undefined}><button id={`browser-tab-${page.id}`} type="button" role="tab" className="terminal-tabs__tab browser-tabs__tab tt-focusable"
            aria-selected={selected} aria-controls="browser-page" tabIndex={page.id === activeId ? 0 : -1} data-status={page.status} title={`${pageLabel(page)}\n${page.url}`}
            onClick={() => { setCreating(false); store.select(threadId, page.id) }}
            onKeyDown={event => {
              const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
              const next = event.key === 'Home' ? pages[0] : event.key === 'End' ? pages.at(-1) : delta ? pages[(index + delta + pages.length) % pages.length] : undefined
              if (!next) return
              event.preventDefault()
              setCreating(false)
              store.select(threadId, next.id)
              focusTab(next.id)
            }}>
            <Globe size={14} aria-hidden="true" />
            <span className="terminal-tabs__name">{pageLabel(page)}</span>
            {waiting ? <><span className="browser-tabs__waiting" aria-hidden="true" /><span className="tt-visually-hidden">, waiting for your answer</span></> : null}
            {page.status === 'unavailable' ? <span className="tt-visually-hidden">, could not load</span> : page.status === 'loading' ? <span className="tt-visually-hidden">, loading</span> : null}
          </button>
          {selected ? <button type="button" className="terminal-tabs__close tt-focusable" aria-label={`Close page: ${pageLabel(page)}`} title="Close page" disabled={browser.busy}
            onClick={() => void store.close(bridge, threadId, page.id).then(() => { const next = store.thread(threadId)?.activePageId; if (next) focusTab(next) })}><X size={14} aria-hidden="true" /></button> : null}
          </span>
        })}
      </div>
      <div className="terminal-bar__actions tools-chrome__actions">
        {/* The page's review actions share the tab line; a narrow panel shows them as icons that keep their names. */}
        {active && !newPage ? <>
          <button type="button" className="tools-chrome__button tt-focusable" title="Comment on page" disabled={reviewBusy || feedback !== null || !agents} onClick={() => void reviewPage('capture')}>
            <MessageSquarePlus size={16} aria-hidden="true" /><span className="tools-chrome__button-label">Comment on page</span></button>
          {!agentToolsUnavailable ? <button type="button" className="tools-chrome__button tt-focusable" disabled={reviewBusy} aria-pressed={Boolean(active.sharedOrigin)}
            title={active.sharedOrigin ? 'Stop sharing page contents with the agent' : `Let the agent in this thread read page contents and screenshots.${browser.grant ? ' It can already open, click and type here without asking.' : ' Opening, clicking and typing still ask you.'}`} onClick={() => void reviewPage('share')}>
            <Share2 size={16} aria-hidden="true" /><span className="tools-chrome__button-label">{active.sharedOrigin ? 'Stop sharing' : 'Share with agent'}</span></button> : null}
        </> : null}
        <button type="button" className="files-icon tt-focusable" aria-label="New page" title={full ? 'Sotto keeps at most 32 pages' : 'New page'} aria-pressed={creating}
          disabled={full || !bridge} onClick={() => creating ? (setCreating(false), setDraft(null)) : startNew()}><Plus size={16} aria-hidden="true" /></button>
      </div>
    </div> : <ToolsChrome title="Browser" />}

    <form className="browser-toolbar" aria-label={newPage ? 'Open a page' : 'Page address'} onSubmit={submit} data-loading={(!newPage && active?.status === 'loading') || undefined}>
      {!newPage && active ? <>
        <button type="button" className="files-icon tt-focusable" aria-label="Back" title="Back" disabled={!active.canGoBack || browser.busy} onClick={() => void store.history(bridge, threadId, active.id, 'back')}><ArrowLeft size={16} aria-hidden="true" /></button>
        <button type="button" className="files-icon tt-focusable" aria-label="Forward" title="Forward" disabled={!active.canGoForward || browser.busy} onClick={() => void store.history(bridge, threadId, active.id, 'forward')}><ArrowRight size={16} aria-hidden="true" /></button>
        <button type="button" className="files-icon tt-focusable" aria-label="Reload" title="Reload" disabled={browser.busy} data-busy={active.status === 'loading' || undefined} onClick={() => void store.history(bridge, threadId, active.id, 'reload')}><RotateCw size={15} aria-hidden="true" /></button>
      </> : null}
      <input ref={address} className="browser-address tt-focusable" type="text" inputMode="url" spellCheck={false} autoComplete="off" autoCapitalize="off"
        aria-label={newPage ? 'Address for a new page' : 'Address'} placeholder={newPage ? 'localhost:5173 or example.com' : 'Address'} value={shown}
        aria-invalid={problem !== null || undefined} aria-describedby={problem ? 'browser-address-problem' : undefined}
        onFocus={event => event.currentTarget.select()}
        onChange={event => { setProblem(null); setDraft({ pageId: newPage ? null : activeId, text: event.currentTarget.value }) }}
        onKeyDown={event => {
          if (event.key !== 'Escape') return
          if (creating && pages.length > 0) { event.preventDefault(); event.stopPropagation(); setCreating(false); setDraft(null); if (activeId) focusTab(activeId) }
          else if (draft !== null) { event.preventDefault(); event.stopPropagation(); setDraft(null); setProblem(null) }
        }} />
      {newPage ? <button type="submit" className="tt-button tt-button--primary tt-focusable browser-go" disabled={browser.busy || !bridge}>Open</button>
        : active ? <>
          <button type="button" className="files-icon tt-focusable" aria-label="Open in system browser" title="Open in system browser" onClick={() => openExternally(active.url)}><ExternalLink size={16} aria-hidden="true" /></button>
          <select className="browser-viewport-size tt-focusable" aria-label="Browser viewport size" title="Browser viewport size" value={active.viewport ? `${active.viewport.width}x${active.viewport.height}` : 'fit'} disabled={reviewBusy || feedback !== null} onChange={event => void reviewPage('viewport', event.currentTarget.value)}>
            <option value="fit">Fit pane</option><option value="1600x1000">1600 x 1000</option><option value="1280x800">1280 x 800</option><option value="820x560">820 x 560</option><option value="390x844">390 x 844</option>
            {active.viewport && !['1600x1000', '1280x800', '820x560', '390x844'].includes(`${active.viewport.width}x${active.viewport.height}`) ? <option value={`${active.viewport.width}x${active.viewport.height}`}>{active.viewport.width} x {active.viewport.height}</option> : null}
          </select>
        </> : null}
    </form>
    {browser.grant ? <div className="browser-grant">
      <span>This thread uses the browser without asking</span><span aria-hidden="true">·</span>
      <button type="button" className="browser-review-link tt-focusable" aria-label="Stop letting this thread use the browser without asking" title="This thread will ask before opening, clicking or typing again" disabled={stoppingGrant} onClick={stopGrant}>Stop</button>
    </div> : null}
    {active && !newPage && agentToolsUnavailable ? <p className="browser-review-unavailable">This Devin client does not support Sotto browser tools.</p> : null}
    {pageTasks.length > 1 && !feedback && !newPage ? <label className="browser-task-picker">Browser checks<select aria-label="Browser check" className="tt-focusable" value={task?.id ?? ''} onChange={event => setSelectedTask(event.currentTarget.value)}>{pageTasks.map(item => <option key={item.id} value={item.id}>{item.description} - {item.status}</option>)}</select></label> : null}
    {task && !feedback && !newPage ? <BrowserTaskDetails key={task.id} task={task} store={store} bridge={bridge} /> : null}
    {problem ? <p className="browser-problem" id="browser-address-problem" role="alert">{problem}</p> : null}
    {active?.error && active.status !== 'unavailable' && !task?.pendingAction ? <p className="browser-problem" role="status">{active.error}</p> : null}
    {browser.notice ? <p className="terminal-notice" role="alert">{browser.notice}</p> : null}

    {feedback && active && bridge ? <BrowserFeedback key={active.id} page={active} initial={feedback} bridge={bridge} onClose={() => { setFeedback(null); requestAnimationFrame(() => address.current?.focus()) }} onAdd={(capture, comment) => {
      if (!agents) return 'The draft for this thread is not available.'
      const thread = agents.state?.host.threads.find(item => item.id === threadId)
      const model = agents.state?.host.models.find(item => item.id === thread?.modelId)
      const error = appendBrowserFeedback(agents.threadDrafts, threadId, capture, comment, model?.supportsImages === true)
      if (!error) onStatus(`Added to the draft for ${thread?.title ?? 'this thread'}`)
      return error
    }} /> : newPage ? <div className="files-problem browser-empty" role="status">
      <strong>{pages.length === 0 ? 'Open a page' : 'Open another page'}</strong>
      <p>Enter a website or local server address above. Pages keep their place while you work elsewhere.</p>
    </div> : active ? <PageViewport key={active.id} page={active} threadId={threadId} store={store} bridge={bridge} surface={surface}
      refused={browser.placementProblem?.pageId === active.id ? browser.placementProblem.message : null} onOpenExternally={() => openExternally(active.url)} /> : null}
  </div>
}

function PageViewport({ page, threadId, store, bridge, surface, refused, onOpenExternally }: {
  readonly page: BrowserPage; readonly threadId: string; readonly store: BrowserStore; readonly bridge: BrowserBridge | undefined
  readonly surface: React.RefObject<HTMLDivElement | null>; readonly refused: string | null; readonly onOpenExternally: () => void
}): ReactNode {
  const host = useRef<HTMLDivElement>(null)
  const covered = useOverlayOpen(surface, host)
  const show = page.status !== 'unavailable' && !covered
  const pageId = page.id

  // Main draws the page where this element sits. Layout can move it without resizing it (the panel's edge, a
  // pane split), so the rectangle is read every frame while shown and sent only when it changes.
  useLayoutEffect(() => {
    if (!show) { store.mount(bridge, threadId, pageId, null); return }
    let frame = 0
    const place = (): void => {
      const element = host.current
      if (element) {
        const rect = element.getBoundingClientRect()
        const x = Math.max(0, Math.round(rect.left))
        const y = Math.max(0, Math.round(rect.top))
        const width = Math.round(rect.right) - x
        const height = Math.round(rect.bottom) - y
        store.mount(bridge, threadId, pageId, width >= 1 && height >= 1 && document.visibilityState !== 'hidden' ? { x, y, width, height } : null)
      }
      frame = requestAnimationFrame(place)
    }
    place()
    return () => { cancelAnimationFrame(frame); store.mount(bridge, threadId, pageId, null) }
  }, [show, store, bridge, threadId, pageId])

  return <div className="browser-page" id="browser-page" role="tabpanel" aria-label={pageLabel(page)} data-status={page.status}>
    {page.status === 'unavailable' ? <div className="files-problem browser-unavailable" role="status">
      <strong>This page could not load.</strong>
      {page.error ? <p>{page.error}</p> : null}
      <p className="browser-unavailable__url">{page.url}</p>
      <div className="browser-unavailable__actions">
        <button type="button" className="files-link tt-focusable" onClick={() => void store.history(bridge, threadId, pageId, 'reload')}>Try again</button>
        <button type="button" className="files-link tt-focusable" onClick={onOpenExternally}>Open in system browser</button>
      </div>
    </div> : <div ref={host} className="browser-viewport" data-covered={covered || undefined} data-refused={refused !== null || undefined}>
      {refused !== null ? <div className="files-problem browser-unavailable" role="alert">
        <strong>This page could not be shown.</strong>{' '}
        <p>{refused}</p>
        <div className="browser-unavailable__actions">
          <button type="button" className="files-link tt-focusable" onClick={() => store.retryPlacement(threadId, pageId)}>Try again</button>
          <button type="button" className="files-link tt-focusable" onClick={onOpenExternally}>Open in system browser</button>
        </div>
      </div> : covered ? <p className="browser-viewport__covered">The page steps aside while a menu or dialog is open.</p> : null}
    </div>}
  </div>
}
