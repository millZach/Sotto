import React, { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, Check, ExternalLink, Globe, Hand, History, ImagePlus, MoreHorizontal, Pause, PictureInPicture2, Play, Plus, RotateCw, Share2, SquareDashedMousePointer, X } from 'lucide-react'
import { useLingui } from '@lingui/react/macro'
import { BROWSER_WAITING_TO_OPEN, type BrowserBridge, type BrowserPage, type BrowserPointPick, type BrowserTask } from '../../../shared/browser'
import { threadTakesSottoTools } from '../../../shared/agents'
import { resolveModel } from '../../../shared/modelCatalog'
import { useOptionalAgents } from '../agents/AgentContext'
import { PaneMenu, type PaneMenuItem } from '../agents/PaneMenu'
import { appendBrowserFeedback } from './BrowserFeedback'
import { outlinedCapture, PointComment, PointLine, pointedWords, themeRgb, type PointedName } from './BrowserPoint'
import { browserPages, normalizeAddress, pageLabel, useBrowserTasks, useOpenedAddresses, useThreadBrowser, type BrowserStore } from './browserStore'
import { changePage, listProblem, PageViewport } from './browserPageView'
import { browsingWords, shortAddress } from './browserSteps'
import type { BrowserSurfaceProps } from './BrowserSurface'
import { ToolsChrome } from './ToolsChrome'
import { shownNotice } from './toolsWords'
import './browserReview.css'
import './browserPane.css'

const SIZES = ['1600x1000', '1280x800', '820x560', '390x844'] as const

/**
 * Tools > Browser as the quiet browser pane (ADR-0154; Owl): one row above the page (Back, Forward, Reload, the
 * address with the page's title muted after it, Point at something, Screenshot to message and More), tabs on a line
 * above it only with two or more pages, and while an agent works on the page, one strip at its foot. With no page, the
 * pane is an address field and the addresses this thread's browser opened this session.
 */
export function BrowserPane({ threadId, store, bridge, onStatus, onFloat }: BrowserSurfaceProps): ReactNode {
  const { t } = useLingui()
  const browserTitle = t({ message: 'Browser', comment: 'The Tools surface that shows a thread\'s browser pages.' })
  const browser = useThreadBrowser(store, threadId)
  const tasks = useBrowserTasks(store)
  const opened = useOpenedAddresses(store, threadId)
  const agents = useOptionalAgents()
  const owningThread = agents?.state?.host.threads.find(item => item.id === threadId)
  const agentToolsUnavailable = !threadTakesSottoTools(owningThread)
  const [busy, setBusy] = useState(false)
  const address = useRef<HTMLInputElement>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<{ pageId: string | null; text: string } | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const active = browser?.pages.find(page => page.id === browser.activePageId && !page.device) ?? null
  const activeId = active?.id ?? null
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
  // Point at something: on while `pointing`; `hover` names the element under the pointer, and `picked` is the one
  // clicked, its picture standing in the page's place with a comment until it is added or cancelled.
  const [pointing, setPointing] = useState(false)
  const [hover, setHover] = useState<PointedName | null>(null)
  const [picked, setPicked] = useState<BrowserPointPick | null>(null)
  const [pageShown, setPageShown] = useState(false)
  const pointButton = useRef<HTMLButtonElement>(null)
  const pickedRef = useRef(picked)
  pickedRef.current = picked
  const pointingRef = useRef(pointing)
  pointingRef.current = pointing
  const focusPoint = (): void => { requestAnimationFrame(() => pointButton.current?.focus()) }
  const pointTarget = active ? { threadId, workspaceId: active.workspace.workspaceId, pageId: active.id } : null
  const pointKey = pointTarget ? `${pointTarget.workspaceId}:${pointTarget.pageId}` : null
  /** Leaves point mode. `tell` is false when main ended it itself, so there is nothing to turn off. */
  const leavePoint = useCallback((tell = true): void => {
    setPointing(false); setHover(null); setPicked(null)
    const page = store.thread(threadId)?.pages.find(item => item.id === activeIdRef.current)
    if (tell && bridge && page) void bridge.point({ threadId, workspaceId: page.workspace.workspaceId, pageId: page.id, on: false }).catch(() => undefined)
  }, [bridge, store, threadId])
  // Another page, or none, ends point mode; main ends it for the page that is going.
  useEffect(() => { setPointing(false); setHover(null); setPicked(null) }, [activeId])
  useEffect(() => {
    if (!bridge || !activeId) return
    return bridge.onEvent(event => {
      if (event.type !== 'point' || event.pageId !== activeId || event.threadId !== threadId) return
      const point = event.point
      if (point.state === 'hover') setHover({ tag: point.tag, name: point.name })
      else if (point.state === 'picked') { if (pointingRef.current) { setHover(null); setPicked(point) } }
      else if (!pickedRef.current) {
        // Escape pressed in the page leaves point mode as Escape in the pane does; navigating or hiding the page just ends it.
        setPointing(false); setHover(null)
        if (point.reason === 'escape') focusPoint()
        if (point.reason === 'unavailable') setProblem(t`Point at something stopped because the page did not answer. Try again.`)
      }
    })
  }, [bridge, activeId, threadId, t])
  // While pointing and the live page shows, main's overlay is on; a click's picture covers the page, so it waits.
  const armed = pointing && picked === null && pageShown && pointKey !== null
  useEffect(() => {
    if (!armed || !bridge || !pointTarget) return
    let current = true
    // The overlay is tinted in the theme's accent; a window that cannot read it does not point.
    const color = themeRgb('--tt-accent')
    if (!color) { setProblem(t`Point at something could not read the theme's colours. Try again.`); setPointing(false); return }
    void bridge.point({ ...pointTarget, on: true, color }).then(result => {
      if (!current) return
      if (!result.ok) { setProblem(result.error.message); setPointing(false) }
      else if (!result.value.pointing) setPointing(false)
    }, () => { if (current) { setProblem(t`The browser did not answer. Try again.`); setPointing(false) } })
    return () => { current = false }
    // The target is read through its key, so a new object for the same page does not ask again.
  }, [armed, bridge, pointKey])
  // Leaving the pane turns the overlay off with it.
  useEffect(() => () => { if (pointingRef.current) leavePoint() }, [leavePoint])

  // A different page, or a navigation the page made itself, shows its own address unless the reader is typing.
  useEffect(() => { setDraft(current => current !== null && current.pageId === activeId ? current : null); setProblem(null) }, [activeId])
  // Tools turned to a page the agent just opened (it never does while focus is in Tools, so nothing typed is lost):
  // New page gives way to that page.
  const revealed = browser?.revealed ?? 0
  const seenReveal = useRef(revealed)
  useEffect(() => {
    if (seenReveal.current === revealed) return
    seenReveal.current = revealed
    if (document.activeElement === address.current) return
    setCreating(false)
    setDraft(null)
  }, [revealed])

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
  const page = newPage ? null : active
  const shown = draft !== null && draft.pageId === (newPage ? null : activeId) ? draft.text : page?.url ?? ''
  const showsAddress = page !== null && draft === null && !editing
  const full = browser.pages.length >= 32
  const pageTasks = tasks.filter(item => item.threadId === threadId && item.pageId === activeId && !item.device)
  // A request waiting for the user comes first; otherwise the newest task still working or paused speaks.
  const waiting = pageTasks.find(item => item.pendingAction !== null)
  const working = pageTasks.find(item => item.status === 'working' || item.status === 'paused')
  // The agent working or waiting on another of the thread's pages: the player stays away while Tools shows the
  // thread's browser, so the strip offers that page here rather than leaving it shown nowhere.
  const elsewhere = tasks.find(item => item.threadId === threadId && item.pageId !== activeId && !item.device
    && (item.pendingAction !== null || item.status === 'working' || item.status === 'paused') && pages.some(other => other.id === item.pageId))
  // Share lives in More, so a page the agent cannot see always says so: under the grant one the user made private
  // (ADR-0029), without it one not yet shared. A page an agent asked to open and nobody has opened yet says nothing.
  const madePrivate = Boolean(page && !page.sharedOrigin && !agentToolsUnavailable && !waiting && page.error !== BROWSER_WAITING_TO_OPEN)
  const shareWithAgent = t`Share with agent`
  const openInSystemBrowser = t`Open in system browser`
  const title = page ? page.title.trim() : ''

  const focusAddress = (): void => { requestAnimationFrame(() => address.current?.focus()) }
  const open = (url: string): void => {
    const done = (ok: boolean): void => { if (ok) { setDraft(null); setCreating(false) } }
    if (newPage || !active) void store.create(bridge, threadId, url).then(done)
    else void store.navigate(bridge, threadId, active.id, url).then(done)
  }
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const parsed = normalizeAddress(shown)
    if ('error' in parsed) { setProblem(parsed.error); address.current?.focus(); return }
    setProblem(null)
    open(parsed.url)
  }
  const openExternally = (url: string): void => {
    if (!bridge) return
    void bridge.openLink({ url, destination: 'external' }).then(result => { if (!result.ok) onStatus(t`Could not open the system browser`) }, () => onStatus(t`Could not open the system browser`))
  }
  const focusTab = (id: string): void => document.getElementById(`browser-tab-${id}`)?.focus()
  const startNew = (): void => {
    setCreating(true)
    setDraft({ pageId: null, text: '' })
    setProblem(null)
    focusAddress()
  }
  const closePage = (id: string): void => {
    void store.close(bridge, threadId, id).then(() => { const next = store.thread(threadId)?.activePageId; if (next && browserPages(store.thread(threadId)?.pages ?? []).length > 1) focusTab(next); else focusAddress() })
  }
  // Ends the thread's browser grant (ADR-0029). The menu puts focus back on its button; with no page, More held only
  // this and goes with the grant, so focus goes on to the address, the next thing the eye reads.
  const stopGrant = (): void => {
    setProblem(null)
    void store.stopGrant(bridge, threadId).then(error => {
      if (error) { setProblem(error); return }
      requestAnimationFrame(() => { if (!document.activeElement || document.activeElement === document.body) address.current?.focus() })
    })
  }
  const pageAction = async (action: 'share' | 'viewport', size?: string): Promise<void> => {
    if (!bridge || !active) return
    setBusy(true); setProblem(null)
    try {
      const result = await changePage(bridge, threadId, active, action, size)
      if (activeIdRef.current !== active.id) return
      if (result.ok) store.adopt(result.value)
      else setProblem(result.error.message)
    } catch { setProblem(t`The browser did not answer. Try again.`) }
    finally { setBusy(false) }
  }
  // Screenshot to message: the page as it looks now goes into the draft as browser feedback, with no comment step.
  const screenshotToMessage = async (): Promise<void> => {
    if (!bridge || !active || !agents) return
    setBusy(true); setProblem(null)
    try {
      const result = await bridge.capture({ threadId, workspaceId: active.workspace.workspaceId, pageId: active.id })
      if (activeIdRef.current !== active.id) return
      if (!result.ok) { setProblem(result.error.message); return }
      const thread = agents.state?.host.threads.find(item => item.id === threadId)
      const model = resolveModel(agents.state?.host.models ?? [], thread?.modelId)
      const error = await appendBrowserFeedback(agents.threadDrafts, threadId, result.value, '', model?.supportsImages === true)
      const threadTitle = thread?.title
      if (error) setProblem(error)
      else onStatus(threadTitle !== undefined ? t({ message: `Added to the draft for ${threadTitle}`, comment: '{threadTitle} is a thread\'s title.' }) : t`Added to the draft for this thread`)
    } catch { setProblem(t`The browser did not answer. Try again.`) }
    finally { setBusy(false) }
  }

  const current = active?.viewport ? `${active.viewport.width}x${active.viewport.height}` : 'fit'
  const sizes = [...SIZES, ...(SIZES.includes(current as typeof SIZES[number]) || current === 'fit' ? [] : [current])]
  const check = (on: boolean): ReactNode => on ? <Check size={15} aria-hidden="true" /> : <span className="browser-pane__no-check" aria-hidden="true" />
  const ask: PaneMenuItem[] = browser.grant ? [{ id: 'ask', label: t`Ask before this thread uses the browser`, icon: <Hand size={15} aria-hidden="true" />, run: stopGrant }] : []
  const menu: PaneMenuItem[][] = page ? [
    [
      ...(pages.length === 1 ? [{ id: 'new', label: t`New page`, icon: <Plus size={15} aria-hidden="true" />, disabled: full || !bridge, ...(full ? { hint: t`Sotto keeps at most 32 pages` } : {}), run: startNew },
        { id: 'close', label: t`Close page`, icon: <X size={15} aria-hidden="true" />, disabled: browser.busy, run: () => closePage(page.id) }] : []),
      { id: 'external', label: openInSystemBrowser, icon: <ExternalLink size={15} aria-hidden="true" />, run: () => openExternally(page.url) },
      ...(!agentToolsUnavailable ? [{ id: 'share', label: page.sharedOrigin ? t`Stop sharing` : shareWithAgent, icon: <Share2 size={15} aria-hidden="true" />, disabled: busy, run: () => void pageAction('share') }] : []),
      ...(onFloat ? [{ id: 'float', label: t`Float the browser over the thread`, icon: <PictureInPicture2 size={15} aria-hidden="true" />, run: onFloat }] : []),
    ],
    [
      { id: 'fit', label: t`Fit the pane`, checked: current === 'fit', icon: check(current === 'fit'), disabled: busy, run: () => void pageAction('viewport', 'fit') },
      ...sizes.map(size => {
        const [width, height] = size.split('x')
        const label = t({ message: `Show at ${width} x ${height}`, comment: 'A browser page size in CSS pixels, such as Show at 1280 x 800.' })
        return { id: size, label, checked: current === size, icon: check(current === size), disabled: busy, run: () => void pageAction('viewport', size) }
      }),
    ],
    ask,
  ] : [ask]

  const tabs = pages.length > 1 ? <div className="terminal-bar browser-bar tools-chrome browser-pane__tabs">
    <div className="terminal-tabs" role="tablist" aria-label={t({ message: 'Pages', comment: 'The tabs of a thread\'s browser pages.' })}>
      {pages.map((item, index) => {
        const selected = item.id === activeId && !creating
        const waitingHere = tasks.some(task => task.threadId === threadId && task.pageId === item.id && task.pendingAction !== null)
        const label = pageLabel(item)
        return <span key={item.id} className="terminal-tabs__item" data-selected={selected || undefined}><button id={`browser-tab-${item.id}`} type="button" role="tab" className="terminal-tabs__tab browser-tabs__tab tt-focusable"
          aria-selected={selected} aria-controls="browser-page" tabIndex={item.id === activeId ? 0 : -1} data-status={item.status} title={`${label}\n${item.url}`}
          onClick={() => { setCreating(false); store.select(threadId, item.id) }}
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
          <span className="terminal-tabs__name">{label}</span>
          {waitingHere ? <><span className="browser-tabs__waiting" aria-hidden="true" /><span className="tt-visually-hidden">{t({ message: ', waiting for your answer', comment: 'Read after a browser tab\'s name.' })}</span></> : null}
          {item.status === 'unavailable' ? <span className="tt-visually-hidden">{t({ message: ', could not load', comment: 'Read after a browser tab\'s name.' })}</span> : item.status === 'loading' ? <span className="tt-visually-hidden">{t({ message: ', loading', comment: 'Read after a browser tab\'s name.' })}</span> : null}
        </button>
        {selected ? <button type="button" className="terminal-tabs__close tt-focusable" aria-label={t({ message: `Close page: ${label}`, comment: '{label} is a page\'s title or host.' })} title={t`Close page`} disabled={browser.busy}
          onClick={() => closePage(item.id)}><X size={14} aria-hidden="true" /></button> : null}
        </span>
      })}
    </div>
    <div className="terminal-bar__actions tools-chrome__actions">
      <button type="button" className="files-icon tt-focusable" aria-label={t`New page`} title={full ? t`Sotto keeps at most 32 pages` : t`New page`} aria-pressed={creating}
        disabled={full || !bridge} onClick={() => creating ? (setCreating(false), setDraft(null)) : startNew()}><Plus size={16} aria-hidden="true" /></button>
    </div>
  </div> : null

  const back = t({ message: 'Back', comment: 'Goes back a page in the browser.' }), forward = t({ message: 'Forward', comment: 'Goes forward a page in the browser.' })
  const screenshot = t`Screenshot to message`
  const pointAtSomething = t({ message: 'Point at something', comment: 'Lets the user click an element on the browser page to tell the agent about it.' })
  const togglePoint = (): void => {
    setProblem(null)
    if (pointing) leavePoint()
    else setPointing(true)
  }
  // Add to message: the element, its picture with the element outlined, and the comment go into the draft.
  const addPoint = async (pick: BrowserPointPick, comment: string, signal: AbortSignal): Promise<string | null> => {
    if (!agents) return t`The draft for this thread is not available.`
    const thread = agents.state?.host.threads.find(item => item.id === threadId)
    const model = resolveModel(agents.state?.host.models ?? [], thread?.modelId)
    const element = pick.capture.element
    const label = element ? pointedWords(element) : t`Browser feedback`
    const capture = await outlinedCapture(pick.capture, pick.box)
    if (signal.aborted) return null
    // One draft item: the picture named after the element, carrying the comment and the context until it is sent.
    const error = await appendBrowserFeedback(agents.threadDrafts, threadId, capture, comment, model?.supportsImages === true, { signal, pointed: { label: label.slice(0, 200), box: pick.box } })
    if (error || signal.aborted) return error
    const threadTitle = thread?.title
    onStatus(threadTitle !== undefined ? t({ message: `Added to the draft for ${threadTitle}`, comment: '{threadTitle} is a thread\'s title.' }) : t`Added to the draft for this thread`)
    leavePoint(false)
    focusPoint()
    return null
  }
  const row = <div className={pages.length > 1 ? 'browser-pane__row' : 'tools-chrome browser-pane__row'} data-loading={page?.status === 'loading' || undefined}>
    <button type="button" className="files-icon tt-focusable" aria-label={back} title={back} disabled={!page?.canGoBack || browser.busy} onClick={() => page && void store.history(bridge, threadId, page.id, 'back')}><ArrowLeft size={16} aria-hidden="true" /></button>
    <button type="button" className="files-icon tt-focusable" aria-label={forward} title={forward} disabled={!page?.canGoForward || browser.busy} onClick={() => page && void store.history(bridge, threadId, page.id, 'forward')}><ArrowRight size={16} aria-hidden="true" /></button>
    <button type="button" className="files-icon tt-focusable" aria-label={t`Reload`} title={t`Reload`} disabled={!page || browser.busy} onClick={() => page && void store.history(bridge, threadId, page.id, 'reload')}><RotateCw size={15} aria-hidden="true" /></button>
    <form className="browser-pane__address" aria-label={newPage ? t`Open a page` : t`Page address`} onSubmit={submit} data-showing={showsAddress || undefined}>
      <Globe size={14} aria-hidden="true" />
      <input ref={address} className="browser-pane__input tt-focusable" type="text" inputMode="url" spellCheck={false} autoComplete="off" autoCapitalize="off"
        aria-label={newPage ? t`Address for a new page` : t`Address`} placeholder={t`Enter an address, such as localhost:5173`} value={shown}
        aria-invalid={problem !== null || undefined} aria-describedby={problem ? 'browser-address-problem' : undefined}
        onFocus={event => { setEditing(true); event.currentTarget.select() }} onBlur={() => setEditing(false)}
        onChange={event => { setProblem(null); setDraft({ pageId: newPage ? null : activeId, text: event.currentTarget.value }) }}
        onKeyDown={event => {
          if (event.key !== 'Escape') return
          if (creating && pages.length > 0) { event.preventDefault(); event.stopPropagation(); setCreating(false); setDraft(null); if (activeId && pages.length > 1) focusTab(activeId) }
          else if (draft !== null) { event.preventDefault(); event.stopPropagation(); setDraft(null); setProblem(null) }
        }} />
      {showsAddress && page ? <span className="browser-pane__shown" aria-hidden="true">
        <span className="browser-pane__url">{shortAddress(page.url)}</span>{title && title !== shortAddress(page.url) ? <span className="browser-pane__title">{title}</span> : null}
      </span> : null}
    </form>
    <button ref={pointButton} type="button" className="files-icon tt-focusable browser-point__toggle" aria-label={pointAtSomething} aria-pressed={pointing}
      title={pointing ? t`Stop pointing at the page` : t`Click something on the page to tell the agent about it`} disabled={!page || page.status === 'unavailable' || !bridge} onClick={togglePoint}><SquareDashedMousePointer size={16} aria-hidden="true" /></button>
    <button type="button" className="files-icon tt-focusable" aria-label={screenshot} title={t`Add a picture of this page to the message`} disabled={!page || busy || !agents || !bridge} onClick={() => void screenshotToMessage()}><ImagePlus size={16} aria-hidden="true" /></button>
    <PaneMenu groups={menu} label={t`More browser actions`} buttonClassName="files-icon" className="browser-pane__more" icon={<MoreHorizontal size={16} aria-hidden="true" />} />
  </div>

  const strip = page && waiting?.pendingAction ? <RequestStrip key={waiting.id} task={waiting} store={store} bridge={bridge} onAnswered={focusAddress} />
    : page && working ? <AgentStrip task={working} pageUrl={page.url} store={store} bridge={bridge} onProblem={setProblem} />
      : elsewhere ? <ElsewhereStrip task={elsewhere} page={pages.find(other => other.id === elsewhere.pageId)!} onShow={() => { setCreating(false); setDraft(null); store.select(threadId, elsewhere.pageId) }} /> : null

  // Escape leaves point mode once the comment, which answers Escape first, is closed.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || !pointing || picked || event.defaultPrevented) return
    event.preventDefault(); event.stopPropagation()
    leavePoint(); pointButton.current?.focus()
  }
  const cover = page && picked ? <PointComment key={picked.capture.captureId ?? 'pick'} pick={picked} onAdd={(comment, signal) => addPoint(picked, comment, signal)}
    onCancel={() => { setPicked(null); focusPoint() }} /> : null

  return <div className="browser-surface browser-pane" onKeyDown={onKeyDown}>
    {tabs}
    {row}
    {/* Sharing takes this line away, so focus goes to the address, the next thing the eye reads. */}
    {madePrivate ? <div className="browser-grant">
      <span>{t`This page is private. The agent cannot see it`}</span><span aria-hidden="true">·</span>
      <button type="button" className="browser-review-link tt-focusable" disabled={busy} onClick={() => void pageAction('share').then(focusAddress)}>{shareWithAgent}</button>
    </div> : null}
    {page && agentToolsUnavailable ? <p className="browser-review-unavailable tt-paragraph">{t`This provider does not support Sotto browser tools.`}</p> : null}
    {problem ? <p className="browser-problem" id="browser-address-problem" role="alert">{problem}</p> : null}
    {page?.error && page.status !== 'unavailable' && !waiting ? <p className="browser-problem" role="status">{page.error}</p> : null}
    {browser.notice ? <p className="terminal-notice tt-paragraph" role="alert">{shownNotice(browser.notice)}</p> : null}
    {page && pointing ? <PointLine hover={hover} /> : null}

    {page ? <PageViewport key={page.id} page={page} threadId={threadId} store={store} bridge={bridge} surface={null} cover={cover} onShown={setPageShown}
      refused={browser.placementProblem?.pageId === page.id ? browser.placementProblem.message : null} onOpenExternally={() => openExternally(page.url)}>{strip}</PageViewport>
      : <div className="browser-pane__empty">
        {opened.length > 0 ? <section className="browser-pane__opened" aria-labelledby="browser-pane-opened">
          <h2 id="browser-pane-opened">{t({ message: 'Opened this session', comment: 'Heads the addresses this thread\'s browser opened since Sotto started.' })}</h2>
          <ul>{opened.map(url => {
            const where = shortAddress(url)
            return <li key={url}><button type="button" className="browser-pane__recent tt-focusable" title={url} disabled={browser.busy || !bridge}
              aria-label={t({ message: `Open ${where}`, comment: '{where} is a page address, such as localhost:5173/notes.' })} onClick={() => open(url)}>
              <History size={15} aria-hidden="true" /><span>{where}</span></button></li>
          })}</ul>
        </section> : <p className="browser-pane__hint tt-paragraph">{t`Enter a website or local server address above. Pages keep their place while you work elsewhere.`}</p>}
      </div>}
  </div>
}

/** The strip at the page's foot while an agent works on it: a steady dot, what it is doing, and Pause or Resume. */
function AgentStrip({ task, pageUrl, store, bridge, onProblem }: { readonly task: BrowserTask; readonly pageUrl: string; readonly store: BrowserStore; readonly bridge: BrowserBridge | undefined; readonly onProblem: (problem: string | null) => void }): ReactNode {
  const { t } = useLingui()
  const paused = task.status === 'paused'
  const { lead, last } = browsingWords(task, pageUrl)
  return <div className="browser-pane__strip" data-state={task.status}>
    <span className="browser-pane__dot" aria-hidden="true" />
    <span className="browser-pane__strip-text"><span className="browser-pane__lead">{lead}</span>{last ? <span className="browser-pane__last"> · {last}</span> : null}</span>
    <button type="button" className="tools-chrome__button tt-focusable" onClick={() => void store.controlTask(bridge, task, paused ? 'resume' : 'pause').then(onProblem)}>
      {paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
      {paused ? t({ message: 'Resume', comment: 'Lets a paused browser task carry on.' }) : t({ message: 'Pause', comment: 'Pauses a browser task.' })}
    </button>
  </div>
}

/** The agent is on another of the thread's pages: say which, and show it in one press. */
function ElsewhereStrip({ task, page, onShow }: { readonly task: BrowserTask; readonly page: BrowserPage; readonly onShow: () => void }): ReactNode {
  const { t } = useLingui()
  const label = pageLabel(page)
  return <div className="browser-pane__strip" data-state={task.pendingAction ? 'waiting' : task.status}>
    <span className="browser-pane__dot" aria-hidden="true" />
    <span className="browser-pane__strip-text"><span className="browser-pane__lead">{task.pendingAction
      ? t({ message: `Waiting for your answer on ${label}`, comment: '{label} is a browser page’s title or host.' })
      : t({ message: `Agent is browsing ${label}`, comment: '{label} is a browser page’s title or host.' })}</span></span>
    <button type="button" className="tools-chrome__button tt-focusable" aria-label={t({ message: `Show page: ${label}`, comment: '{label} is a browser page’s title or host.' })} onClick={onShow}>{t`Show page`}</button>
  </div>
}

/** A request waiting for the user takes the strip's place. Only the user's exact answer approves it. */
function RequestStrip({ task, store, bridge, onAnswered }: { readonly task: BrowserTask; readonly store: BrowserStore; readonly bridge: BrowserBridge | undefined; readonly onAnswered: () => void }): ReactNode {
  const { t } = useLingui()
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const paused = task.status === 'paused'
  const answer = (allow: boolean, forThread = false): void => {
    setBusy(true); setProblem(null)
    void store.answerAction(bridge, task, allow, forThread).then(error => { setProblem(error); if (!error) onAnswered() }).finally(() => setBusy(false))
  }
  return <div className="browser-pane__strip" data-state="waiting" role="group" aria-label={t`Browser action permission`}>
    <span className="browser-pane__dot" aria-hidden="true" />
    <p className="browser-pane__strip-text browser-pane__request">{task.pendingAction?.description}</p>
    <div className="browser-pane__answers">
      <button type="button" className="tt-button tt-button--primary tt-focusable" disabled={busy || paused} onClick={() => answer(true)}>{t`Allow once`}</button>
      <button type="button" className="tt-button tt-focusable" disabled={busy || paused} title={t`Let this thread open, navigate, click and type in Sotto's browser without asking, and see every page in its browser, until you stop it or Sotto closes.`} onClick={() => answer(true, true)}>{t`Allow this thread to use the browser`}</button>
      <button type="button" className="tt-button tt-focusable" disabled={busy} onClick={() => answer(false)}>{t`Deny`}</button>
    </div>
    {problem ? <p className="browser-review-problem" role="alert">{problem}</p> : null}
  </div>
}
