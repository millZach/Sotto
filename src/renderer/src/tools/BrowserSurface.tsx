import React, { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, ExternalLink, Globe, MessageSquarePlus, PictureInPicture2, Plus, RotateCw, Share2, X } from 'lucide-react'
import { i18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import { BROWSER_WAITING_TO_OPEN, type BrowserBounds, type BrowserBridge, type BrowserPage, type BrowserCapture } from '../../../shared/browser'
import type { ToolsError } from '../../../shared/tools'
import { threadTakesSottoTools } from '../../../shared/agents'
import { resolveModel } from '../../../shared/modelCatalog'
import { useOptionalAgents } from '../agents/AgentContext'
import { BrowserTaskDetails } from './BrowserTaskDetails'
import { appendBrowserFeedback, BrowserFeedback } from './BrowserFeedback'
import { browserPages, useBrowserTasks, normalizeAddress, pageLabel, useThreadBrowser, type BrowserStore } from './browserStore'
import { useBrowserPageMount } from './useBrowserPageMount'
import { useOverlayOpen } from './browserOverlay'
import { ToolsChrome } from './ToolsChrome'

export interface BrowserSurfaceProps {
  readonly threadId: string
  readonly store: BrowserStore
  readonly bridge: BrowserBridge | undefined
  readonly onStatus: (message: string) => void
  /**
   * Set only when this surface shows the focused thread's own page and that thread has a player to return to:
   * the way back from Tools for a task the player itself can show. It never pins.
   */
  readonly onFloat?: (() => void) | undefined
}

function listProblem(error: ToolsError, bridge: boolean): string {
  if (!bridge) return i18n._(msg`Browser is not available in this window.`)
  switch (error.code) {
    case 'thread-unavailable': return i18n._(msg`This thread is not available to the browser.`)
    case 'workspace-unavailable': return i18n._(msg`The working folder is not available.`)
    default: return error.message || i18n._(msg`The browser could not list its pages.`)
  }
}

/**
 * Pages the thread opened, each a live page main keeps while it is hidden. One page shows at a time, drawn by
 * main at this surface's viewport; the address bar, history and page tabs stay in the app.
 */
export function BrowserSurface({ threadId, store, bridge, onStatus, onFloat }: BrowserSurfaceProps): ReactNode {
  const { t } = useLingui()
  const browserTitle = t({ message: 'Browser', comment: 'The Tools surface that shows a thread\'s browser pages.' })
  const browser = useThreadBrowser(store, threadId)
  const tasks = useBrowserTasks(store)
  const agents = useOptionalAgents()
  const owningThread = agents?.state?.host.threads.find(item => item.id === threadId)
  const agentToolsUnavailable = !threadTakesSottoTools(owningThread)
  const [feedback, setFeedback] = useState<BrowserCapture | null>(null)
  const [reviewBusy, setReviewBusy] = useState(false)
  const [stoppingGrant, setStoppingGrant] = useState(false)
  const address = useRef<HTMLInputElement>(null)
  const shareButton = useRef<HTMLButtonElement>(null)
  const [draft, setDraft] = useState<{ pageId: string | null; text: string } | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const surface = useRef<HTMLDivElement>(null)
  const active = browser?.pages.find(page => page.id === browser.activePageId && !page.device) ?? null
  const activeId = active?.id ?? null
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
  const [selectedTask, setSelectedTask] = useState<string | null>(null)
  const pageTasks = tasks.filter(item => item.threadId === threadId && item.pageId === activeId && !item.device)
  const task = pageTasks.find(item => item.id === selectedTask) ?? pageTasks[0]
  useEffect(() => { setFeedback(null) }, [activeId])

  // A different page, or a navigation the page made itself, shows its own address unless the reader is typing.
  useEffect(() => { setDraft(current => current !== null && current.pageId === activeId ? current : null); setProblem(null) }, [activeId])

  if (!browser || browser.status === 'loading' && browserPages(browser.pages).length === 0) return <><ToolsChrome title={browserTitle} /><p className="files-preview__loading" role="status">{t`Loading pages…`}</p></>
  if (browser.status === 'error' && browserPages(browser.pages).length === 0) {
    return <><ToolsChrome title={browserTitle} /><div className="files-problem files-problem--root" role="status">
      <strong>{listProblem(browser.error ?? { code: 'unavailable', message: '' }, bridge !== undefined)}</strong>
      {bridge ? <button type="button" className="files-link tt-focusable" onClick={() => void store.activate(bridge, threadId)}>{t`Try again`}</button> : null}
    </div></>
  }
  // The test iPhone is the thread's too, but Tools > iPhone shows it (ADR-0045).
  const pages = browserPages(browser.pages)
  const newPage = creating || pages.length === 0
  const shown = draft !== null && draft.pageId === (newPage ? null : activeId) ? draft.text : newPage ? '' : active?.url ?? ''
  const full = browser.pages.length >= 32
  // Under the grant every page is shared, so an unshared one is a page the user made private (ADR-0029). A page an
  // agent asked to open and nobody has opened yet, its request waiting, denied or expired, is not, so it says nothing.
  const madePrivate = Boolean(browser.grant && active && !newPage && !active.sharedOrigin && !agentToolsUnavailable && !task?.pendingAction && active.error !== BROWSER_WAITING_TO_OPEN)
  const shareTitle = browser.grant ? active?.sharedOrigin ? t`The agent in this thread can see and use this page. Stop sharing keeps it private.` : t`This page is private. Share it with the agent in this thread.`
    : active?.sharedOrigin ? t`Stop sharing page contents with the agent` : t`Let the agent in this thread read page contents and screenshots. Opening, clicking and typing still ask you.`
  const shareWithAgent = t`Share with agent`
  const openInSystemBrowser = t`Open in system browser`

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
    void bridge.openLink({ url, destination: 'external' }).then(result => { if (!result.ok) onStatus(t`Could not open the system browser`) }, () => onStatus(t`Could not open the system browser`))
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
    } catch { setProblem(t`The browser did not answer. Try again.`) }
    finally { setReviewBusy(false) }
  }

  return <div className="browser-surface" ref={surface}>
    {pages.length > 0 ? <div className="terminal-bar browser-bar tools-chrome">
      <div className="terminal-tabs" role="tablist" aria-label={t({ message: 'Pages', comment: 'The tabs of a thread\'s browser pages.' })}>
        {pages.map((page, index) => {
          const selected = page.id === activeId && !creating
          // With previews off, the tab is where a page's waiting request shows before the page is chosen.
          const waiting = tasks.some(item => item.threadId === threadId && item.pageId === page.id && item.pendingAction !== null)
          const label = pageLabel(page)
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
            {waiting ? <><span className="browser-tabs__waiting" aria-hidden="true" /><span className="tt-visually-hidden">{t({ message: ', waiting for your answer', comment: 'Read after a browser tab\'s name.' })}</span></> : null}
            {page.status === 'unavailable' ? <span className="tt-visually-hidden">{t({ message: ', could not load', comment: 'Read after a browser tab\'s name.' })}</span> : page.status === 'loading' ? <span className="tt-visually-hidden">{t({ message: ', loading', comment: 'Read after a browser tab\'s name.' })}</span> : null}
          </button>
          {selected ? <button type="button" className="terminal-tabs__close tt-focusable" aria-label={t({ message: `Close page: ${label}`, comment: '{label} is a page\'s title or host.' })} title={t`Close page`} disabled={browser.busy}
            onClick={() => void store.close(bridge, threadId, page.id).then(() => { const next = store.thread(threadId)?.activePageId; if (next) focusTab(next) })}><X size={14} aria-hidden="true" /></button> : null}
          </span>
        })}
      </div>
      <div className="terminal-bar__actions tools-chrome__actions">
        {/* The page's review actions share the tab line; a narrow panel shows them as icons that keep their names. */}
        {active && !newPage ? <>
          <button type="button" className="tools-chrome__button tt-focusable" title={t`Comment on page`} disabled={reviewBusy || feedback !== null || !agents} onClick={() => void reviewPage('capture')}>
            <MessageSquarePlus size={16} aria-hidden="true" /><span className="tools-chrome__button-label">{t`Comment on page`}</span></button>
          {!agentToolsUnavailable ? <button ref={shareButton} type="button" className="tools-chrome__button tt-focusable" disabled={reviewBusy} aria-pressed={Boolean(active.sharedOrigin)}
            title={shareTitle} onClick={() => void reviewPage('share')}>
            <Share2 size={16} aria-hidden="true" /><span className="tools-chrome__button-label">{active.sharedOrigin ? t`Stop sharing` : shareWithAgent}</span></button> : null}
        </> : null}
        {onFloat ? <button type="button" className="files-icon tt-focusable" aria-label={t`Float the browser over the thread`} title={t`Float the browser over the thread`} onClick={onFloat}><PictureInPicture2 size={16} aria-hidden="true" /></button> : null}
        <button type="button" className="files-icon tt-focusable" aria-label={t`New page`} title={full ? t`Sotto keeps at most 32 pages` : t`New page`} aria-pressed={creating}
          disabled={full || !bridge} onClick={() => creating ? (setCreating(false), setDraft(null)) : startNew()}><Plus size={16} aria-hidden="true" /></button>
      </div>
    </div> : <ToolsChrome title={browserTitle} />}

    <form className="browser-toolbar" aria-label={newPage ? t`Open a page` : t`Page address`} onSubmit={submit} data-loading={(!newPage && active?.status === 'loading') || undefined}>
      {!newPage && active ? <>
        <button type="button" className="files-icon tt-focusable" aria-label={t({ message: 'Back', comment: 'Goes back a page in the browser.' })} title={t({ message: 'Back', comment: 'Goes back a page in the browser.' })} disabled={!active.canGoBack || browser.busy} onClick={() => void store.history(bridge, threadId, active.id, 'back')}><ArrowLeft size={16} aria-hidden="true" /></button>
        <button type="button" className="files-icon tt-focusable" aria-label={t({ message: 'Forward', comment: 'Goes forward a page in the browser.' })} title={t({ message: 'Forward', comment: 'Goes forward a page in the browser.' })} disabled={!active.canGoForward || browser.busy} onClick={() => void store.history(bridge, threadId, active.id, 'forward')}><ArrowRight size={16} aria-hidden="true" /></button>
        <button type="button" className="files-icon tt-focusable" aria-label={t`Reload`} title={t`Reload`} disabled={browser.busy} data-busy={active.status === 'loading' || undefined} onClick={() => void store.history(bridge, threadId, active.id, 'reload')}><RotateCw size={15} aria-hidden="true" /></button>
      </> : null}
      <input ref={address} className="browser-address tt-focusable" type="text" inputMode="url" spellCheck={false} autoComplete="off" autoCapitalize="off"
        aria-label={newPage ? t`Address for a new page` : t`Address`} placeholder={newPage ? t`localhost:5173 or example.com` : t`Address`} value={shown}
        aria-invalid={problem !== null || undefined} aria-describedby={problem ? 'browser-address-problem' : undefined}
        onFocus={event => event.currentTarget.select()}
        onChange={event => { setProblem(null); setDraft({ pageId: newPage ? null : activeId, text: event.currentTarget.value }) }}
        onKeyDown={event => {
          if (event.key !== 'Escape') return
          if (creating && pages.length > 0) { event.preventDefault(); event.stopPropagation(); setCreating(false); setDraft(null); if (activeId) focusTab(activeId) }
          else if (draft !== null) { event.preventDefault(); event.stopPropagation(); setDraft(null); setProblem(null) }
        }} />
      {newPage ? <button type="submit" className="tt-button tt-button--primary tt-focusable browser-go" disabled={browser.busy || !bridge}>{t({ message: 'Open', comment: 'Opens the address typed beside it as a new browser page.' })}</button>
        : active ? <>
          <button type="button" className="files-icon tt-focusable" aria-label={openInSystemBrowser} title={openInSystemBrowser} onClick={() => openExternally(active.url)}><ExternalLink size={16} aria-hidden="true" /></button>
          <select className="browser-viewport-size tt-focusable" aria-label={t`Browser viewport size`} title={t`Browser viewport size`} value={active.viewport ? `${active.viewport.width}x${active.viewport.height}` : 'fit'} disabled={reviewBusy || feedback !== null} onChange={event => void reviewPage('viewport', event.currentTarget.value)}>
            <option value="fit">{t`Fit pane`}</option><option value="1600x1000">1600 x 1000</option><option value="1280x800">1280 x 800</option><option value="820x560">820 x 560</option><option value="390x844">390 x 844</option>
            {active.viewport && !['1600x1000', '1280x800', '820x560', '390x844'].includes(`${active.viewport.width}x${active.viewport.height}`) ? <option value={`${active.viewport.width}x${active.viewport.height}`}>{active.viewport.width} x {active.viewport.height}</option> : null}
          </select>
        </> : null}
    </form>
    {browser.grant ? <div className="browser-grant">
      <span>{t`This thread uses the browser without asking`}</span><span aria-hidden="true">·</span>
      <button type="button" className="browser-review-link tt-focusable" aria-label={t`Stop letting this thread use the browser without asking`} title={t`This thread will ask before opening, clicking or typing again`} disabled={stoppingGrant} onClick={stopGrant}>{t({ message: 'Stop', comment: 'Stops letting this thread use the browser without asking.' })}</button>
    </div> : null}
    {/* Sharing takes this line away, so focus goes to the Share button that now shows the page shared. */}
    {madePrivate ? <div className="browser-grant">
      <span>{t`This page is private. The agent cannot see it`}</span><span aria-hidden="true">·</span>
      <button type="button" className="browser-review-link tt-focusable" disabled={reviewBusy} onClick={() => void reviewPage('share').then(() => requestAnimationFrame(() => shareButton.current?.focus()))}>{shareWithAgent}</button>
    </div> : null}
    {active && !newPage && agentToolsUnavailable ? <p className="browser-review-unavailable">{t`This provider does not support Sotto browser tools.`}</p> : null}
    {pageTasks.length > 1 && !feedback && !newPage ? <label className="browser-task-picker">{t`Browser checks`}<select aria-label={t`Browser check`} className="tt-focusable" value={task?.id ?? ''} onChange={event => setSelectedTask(event.currentTarget.value)}>{pageTasks.map(item => <option key={item.id} value={item.id}>{item.description} - {item.status}</option>)}</select></label> : null}
    {task && !feedback && !newPage ? <BrowserTaskDetails key={task.id} task={task} store={store} bridge={bridge} /> : null}
    {problem ? <p className="browser-problem" id="browser-address-problem" role="alert">{problem}</p> : null}
    {active?.error && active.status !== 'unavailable' && !task?.pendingAction ? <p className="browser-problem" role="status">{active.error}</p> : null}
    {browser.notice ? <p className="terminal-notice" role="alert">{browser.notice}</p> : null}

    {feedback && active && bridge ? <BrowserFeedback key={active.id} page={active} initial={feedback} bridge={bridge} onClose={() => { setFeedback(null); requestAnimationFrame(() => address.current?.focus()) }} onAdd={async (capture, comment, signal) => {
      if (!agents) return t`The draft for this thread is not available.`
      const thread = agents.state?.host.threads.find(item => item.id === threadId)
      const model = resolveModel(agents.state?.host.models ?? [], thread?.modelId)
      const error = await appendBrowserFeedback(agents.threadDrafts, threadId, capture, comment, model?.supportsImages === true, { signal })
      const title = thread?.title
      if (!error && !signal.aborted) onStatus(title !== undefined ? t({ message: `Added to the draft for ${title}`, comment: '{title} is a thread\'s title.' }) : t`Added to the draft for this thread`)
      return error
    }} /> : newPage ? <div className="files-problem browser-empty" role="status">
      <strong>{pages.length === 0 ? t`Open a page` : t`Open another page`}</strong>
      <p className="tt-paragraph">{t`Enter a website or local server address above. Pages keep their place while you work elsewhere.`}</p>
    </div> : active ? <PageViewport key={active.id} page={active} threadId={threadId} store={store} bridge={bridge} surface={surface}
      refused={browser.placementProblem?.pageId === active.id ? browser.placementProblem.message : null} onOpenExternally={() => openExternally(active.url)} /> : null}
  </div>
}

function PageViewport({ page, threadId, store, bridge, surface, refused, onOpenExternally }: {
  readonly page: BrowserPage; readonly threadId: string; readonly store: BrowserStore; readonly bridge: BrowserBridge | undefined
  readonly surface: React.RefObject<HTMLDivElement | null>; readonly refused: string | null; readonly onOpenExternally: () => void
}): ReactNode {
  const { t } = useLingui()
  const host = useRef<HTMLDivElement>(null)
  const covered = useOverlayOpen(surface, host)
  const show = page.status !== 'unavailable' && covered === false
  const openInSystemBrowser = t`Open in system browser`
  const pageId = page.id

  const mount = useCallback((bounds: BrowserBounds | null) => store.mount(bridge, threadId, pageId, bounds), [store, bridge, threadId, pageId])
  useBrowserPageMount(host, show, mount)

  return <div className="browser-page" id="browser-page" role="tabpanel" aria-label={pageLabel(page)} data-status={page.status}>
    {page.status === 'unavailable' ? <div className="files-problem browser-unavailable" role="status">
      <strong>{t`This page could not load.`}</strong>
      {page.error ? <p>{page.error}</p> : null}
      <p className="browser-unavailable__url">{page.url}</p>
      <div className="browser-unavailable__actions">
        <button type="button" className="files-link tt-focusable" onClick={() => void store.history(bridge, threadId, pageId, 'reload')}>{t`Try again`}</button>
        <button type="button" className="files-link tt-focusable" onClick={onOpenExternally}>{openInSystemBrowser}</button>
      </div>
    </div> : <div ref={host} className="browser-viewport" data-covered={covered || undefined} data-refused={refused !== null || undefined}>
      {refused !== null ? <div className="files-problem browser-unavailable" role="alert">
        <strong>{t`This page could not be shown.`}</strong>{' '}
        <p>{refused}</p>
        <div className="browser-unavailable__actions">
          <button type="button" className="files-link tt-focusable" onClick={() => store.retryPlacement(threadId, pageId)}>{t`Try again`}</button>
          <button type="button" className="files-link tt-focusable" onClick={onOpenExternally}>{openInSystemBrowser}</button>
        </div>
      </div> : covered ? <p className="browser-viewport__covered">{t`The page steps aside while a menu or dialog is open.`}</p> : null}
    </div>}
  </div>
}
