import { focusedComposerField } from '../agents/promptSelection'
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { PanelRight, Pause, Play, RotateCw, Smartphone, Square, X } from 'lucide-react'
import { plural } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import type { AgentState } from '../../../shared/agents'
import { TEST_IPHONE, type BrowserBounds, type BrowserBridge, type BrowserPage } from '../../../shared/browser'
import { phonePage, useBrowserTasks, useThreadBrowser } from './browserStore'
import { useBrowserPageMount } from './useBrowserPageMount'
import { useOverlayOpen } from './browserOverlay'
import { bridgeCloudIphone, cloudIphoneStore, useCloudSession, type CloudIphoneBridgeLike, type CloudIphoneStore } from './cloudIphoneStore'
import type { ToolsPanelStore } from './toolsPanelStore'
import type { WindowSize } from './browserPlayerStore'
import { shownCount } from './toolsWords'
import {
  PHONE_PLAYER_CHROME_HEIGHT, PHONE_PLAYER_MOVE_STEP, PHONE_PLAYER_MOVE_STEP_LARGE, PHONE_SIZES, phoneLayout, phonePlayerStore,
  usePhonePlacement, usePhonePlayerOpen, type PhonePlayerStore,
} from './phonePlayerStore'
import './phonePlayer.css'

function windowSize(): WindowSize { return { width: window.innerWidth, height: window.innerHeight } }

function host(page: BrowserPage): string {
  try { return new URL(page.url).host || page.url } catch { return page.url }
}

const focusComposer = (): void => { requestAnimationFrame(() => focusedComposerField()?.focus()) }

export interface PhonePlayerProps {
  readonly state: AgentState
  readonly focusedThreadId: string | null
  readonly bridge: BrowserBridge | undefined
  readonly store: ToolsPanelStore
  /** **Show the browser and test iPhone when an agent uses them**: whether a new task opens the phone on its own. */
  readonly autoShow?: boolean
  readonly phoneStore?: PhonePlayerStore
  readonly cloudStore?: CloudIphoneStore
  readonly cloudBridge?: CloudIphoneBridgeLike
}

/**
 * The focused thread's test iPhone, floating over the window as Virtual iPhone's widget did (ADR-0045): a label to
 * drag it by, the framed phone with the live page in its screen, and what the agent is doing below. Only the focused
 * thread's, never another's. The page is the user's to use too; a tap or typing here reaches it directly.
 */
export function PhonePlayer({ state, focusedThreadId, bridge, store, autoShow = true, phoneStore = phonePlayerStore, cloudStore = cloudIphoneStore, cloudBridge = bridgeCloudIphone() }: PhonePlayerProps): ReactNode {
  const { t } = useLingui()
  const tasks = useBrowserTasks(store.browser)
  // Its own subscription, though the Browser player beside it asks for the same: neither relies on the other being drawn.
  const ids = state.host.threads.filter(item => !item.remoteHost).map(item => item.id).join(' ')
  useEffect(() => { store.browser.watchTasks(bridge, ids.split(' ').filter(Boolean)) }, [bridge, store, ids])
  // Sotto's browser is this computer's, so a remote host's threads have no phone here.
  const thread = state.host.threads.find(item => item.id === focusedThreadId && !item.remoteHost)
  const threadId = thread?.id ?? null
  const task = threadId === null ? undefined : tasks.find(item => item.threadId === threadId && item.device === 'iphone')
  const taskId = task?.id
  useEffect(() => { if (threadId && taskId) phoneStore.taskSeen(threadId, taskId, autoShow) }, [threadId, taskId, autoShow, phoneStore])
  // Its own subscription to the cloud iPhone's events, same reasoning as the browser's above.
  useEffect(() => { if (threadId) cloudStore.watch(cloudBridge, threadId) }, [threadId, cloudStore, cloudBridge])
  const cloudSession = useCloudSession(threadId, cloudStore)
  const cloudLive = cloudSession !== undefined && (cloudSession.status === 'active' || cloudSession.status === 'starting')
  const cloudSessionId = cloudLive ? cloudSession!.id : undefined
  useEffect(() => { if (threadId && cloudSessionId) phoneStore.taskSeen(threadId, `cloud:${cloudSessionId}`, autoShow) }, [threadId, cloudSessionId, autoShow, phoneStore])
  const open = usePhonePlayerOpen(phoneStore, threadId)
  useEffect(() => { if (threadId && bridge && (open || taskId)) void store.browser.activate(bridge, threadId) }, [threadId, bridge, store, open, taskId])
  const threadBrowser = useThreadBrowser(store.browser, threadId)
  const page = phonePage(threadBrowser)
  // The newest task on the phone the player shows: one on an earlier phone the thread has since replaced says nothing here.
  const current = task && page && task.pageId === page.id ? task : undefined

  const placement = usePhonePlacement(phoneStore)
  const [size, setSize] = useState<WindowSize>(windowSize)
  useEffect(() => {
    const onResize = (): void => setSize(windowSize())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const root = useRef<HTMLElement>(null)
  // What the label and status take, measured, so a waiting request's buttons shrink the phone rather than push it off the window.
  const [chrome, setChrome] = useState(PHONE_PLAYER_CHROME_HEIGHT)
  const layout = phoneLayout(placement.size, size, chrome)
  const screen = useRef<HTMLDivElement>(null)
  // A cloud iPhone shows in place of the test iPhone while it is starting or running; otherwise this is the test iPhone the task opened.
  const shown = open && thread !== undefined && (cloudLive || page !== undefined)
  const covered = useOverlayOpen(root, screen, shown)
  const pageId = page?.id
  const mount = useCallback((bounds: BrowserBounds | null) => {
    if (cloudLive && cloudSession) cloudStore.mount(cloudBridge, cloudSession, bounds)
    else if (threadId && pageId) store.browser.mount(bridge, threadId, pageId, bounds)
  }, [store, bridge, threadId, pageId, cloudStore, cloudBridge, cloudLive, cloudSession])
  const mountActive = shown && covered === false && (cloudLive || page?.status !== 'unavailable')
  useBrowserPageMount(screen, mountActive, mount)
  useLayoutEffect(() => {
    const element = root.current
    if (!shown || !element) return
    const measure = (): void => {
      const phone = element.querySelector<HTMLElement>('.phone-player__phone')
      if (phone) setChrome(Math.ceil(element.getBoundingClientRect().height - phone.getBoundingClientRect().height))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    for (const part of element.children) observer.observe(part)
    return () => observer.disconnect()
  }, [shown])

  const [problem, setProblem] = useState<string | null>(null)
  const [answering, setAnswering] = useState(false)
  const [stoppingGrant, setStoppingGrant] = useState(false)
  const [endingSession, setEndingSession] = useState(false)
  useEffect(() => { setProblem(null) }, [taskId])

  if (!shown || !threadId) return null
  const point = phoneStore.pointFor(layout, size)
  const grant = threadBrowser?.grant ?? null
  const active = current?.status === 'working' || current?.status === 'paused'
  const actionText = cloudLive ? cloudSession!.steps.at(-1)?.detail ?? t`Starting…`
    : !current ? page!.status === 'loading' ? t({ message: 'Loading', comment: 'A page is loading on the test iPhone.' }) : t`Ready for you to use`
      : current.pendingAction ? t`Waiting for your answer` : current.status === 'paused' ? t({ message: 'Paused', comment: 'The agent\'s work on the test iPhone is paused.' }) : current.summary || current.description
  const dotState = cloudLive ? cloudSession!.status === 'starting' ? 'working' : 'idle'
    : current?.pendingAction ? 'waiting' : current?.status === 'working' ? 'working' : 'idle'
  const nextSize = PHONE_SIZES[(PHONE_SIZES.findIndex(item => item.id === placement.size) + 1) % PHONE_SIZES.length]!

  const hide = (): void => { phoneStore.hide(threadId); focusComposer() }
  const escape = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    event.preventDefault()
    hide()
  }
  const startDrag = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return
    event.preventDefault()
    const handle = event.currentTarget
    const startX = event.clientX, startY = event.clientY, start = point
    handle.setPointerCapture?.(event.pointerId)
    const move = (next: globalThis.PointerEvent): void => phoneStore.setPoint({ x: start.x + next.clientX - startX, y: start.y + next.clientY - startY }, layout, size)
    const end = (): void => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end) }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }
  const labelKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    escape(event)
    if (event.defaultPrevented || event.target !== event.currentTarget) return
    const step = event.shiftKey ? PHONE_PLAYER_MOVE_STEP_LARGE : PHONE_PLAYER_MOVE_STEP
    const delta: Partial<Record<string, [number, number]>> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
    const move = delta[event.key]
    if (!move) return
    event.preventDefault()
    phoneStore.setPoint({ x: point.x + move[0], y: point.y + move[1] }, layout, size)
  }
  const showInTools = (): void => {
    store.showPhone(threadId)
    requestAnimationFrame(() => document.getElementById('tools-tab-iphone')?.focus())
  }
  const answer = (allow: boolean, forThread = false): void => {
    if (!current) return
    setProblem(null); setAnswering(true)
    void store.browser.answerAction(bridge, current, allow, forThread).then(error => { if (error) setProblem(error) }).finally(() => setAnswering(false))
  }
  // Stop takes its own line away, so focus goes to the label, the player's first control.
  const stopGrant = (): void => {
    setStoppingGrant(true); setProblem(null)
    void store.browser.stopGrant(bridge, threadId).then(error => {
      if (error) setProblem(error)
      else requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('.phone-player__label')?.focus())
    }).finally(() => setStoppingGrant(false))
  }
  const endSession = (): void => {
    if (!cloudSession) return
    setEndingSession(true); setProblem(null)
    void cloudStore.end(cloudBridge, cloudSession).then(error => { if (error) setProblem(error) }).finally(() => setEndingSession(false))
  }

  const label = cloudLive ? t`iPhone · cloud` : TEST_IPHONE.name
  const dragLabel = cloudLive ? t`Move the cloud iPhone. Drag, or use the arrow keys; hold Shift to move further.`
    : t`Move the test iPhone. Drag, or use the arrow keys; hold Shift to move further.`
  const title = thread.title
  // The count in the interface language, and in English as it always read: a plural's own # would group its digits.
  const sessionMinutes = cloudSession?.minutes ?? 0, shownMinutes = shownCount(sessionMinutes)
  const sizeLabel = PHONE_SIZES.find(item => item.id === placement.size)!.label
  const resize = cloudLive
    ? nextSize.id === 'small' ? t`Make the cloud iPhone small` : nextSize.id === 'medium' ? t`Make the cloud iPhone medium` : t`Make the cloud iPhone large`
    : nextSize.id === 'small' ? t`Make the test iPhone small` : nextSize.id === 'medium' ? t`Make the test iPhone medium` : t`Make the test iPhone large`
  const width = TEST_IPHONE.width, height = TEST_IPHONE.height
  const pageHost = cloudLive ? '' : host(page!)
  const steppingAside = t`The phone steps aside while a menu or dialog is open.`

  return <aside ref={root} className="phone-player" aria-label={cloudLive ? t({ message: `Cloud iPhone for ${title}`, comment: '{title} is a thread\'s title.' }) : t({ message: `Test iPhone for ${title}`, comment: '{title} is a thread\'s title.' })} data-covers-native-view
    style={{ left: point.x, top: point.y, width: layout.width }} onKeyDown={escape}>
    <div className="phone-player__label" role="group" aria-roledescription={t({ message: 'drag handle', comment: 'What a screen reader calls the bar that moves a floating player, read after its name.' })} tabIndex={0}
      aria-label={dragLabel} title={t`Drag to move`} onPointerDown={startDrag} onKeyDown={labelKeyDown}>
      <span className="phone-player__grip" aria-hidden="true" />
      <Smartphone size={14} aria-hidden="true" />
      <span className="phone-player__name">{label}</span>
      {cloudLive ? <span className="phone-player__name" title={cloudSession!.device ?? undefined}>{plural(sessionMinutes, { other: `${shownMinutes} min` })}</span> : null}
      <button type="button" className="phone-player__size tt-focusable" aria-label={resize} title={t({ message: `Size: ${sizeLabel}`, comment: '{sizeLabel} is Small, Medium or Large.' })}
        onClick={() => phoneStore.setSize(nextSize.id)}>{sizeLabel}</button>
      <button type="button" className="files-icon tt-focusable" aria-label={cloudLive ? t`Show the cloud iPhone in Tools` : t`Show the test iPhone in Tools`} title={t`Show in Tools`} onClick={showInTools}><PanelRight size={14} aria-hidden="true" /></button>
      <button type="button" className="files-icon tt-focusable" aria-label={cloudLive ? t`Hide the cloud iPhone; the agent keeps working` : t`Hide the test iPhone; the agent keeps working`} title={t({ message: 'Hide', comment: 'Hides the phone player.' })} onClick={hide}><X size={14} aria-hidden="true" /></button>
    </div>
    <div className="phone-player__phone" style={{ padding: layout.bezel, borderRadius: Math.round(layout.screen.width * 0.12) + layout.bezel }}>
      <div ref={screen} className="phone-player__screen" title={cloudLive ? cloudSession!.device ?? t`Cloud iPhone` : t({ message: `${pageHost} at ${width} by ${height}`, comment: '{pageHost} is a web address\'s host; {width} and {height} are sizes in pixels.' })}
        style={{ width: layout.screen.width, height: layout.screen.height, borderRadius: Math.round(layout.screen.width * 0.12) }} data-covered={covered || undefined}>
        {cloudLive ? cloudSession!.status === 'starting' ? <p className="phone-player__note" role="status">{t`Starting…`}</p> : covered ? <p className="phone-player__note tt-paragraph">{steppingAside}</p> : null
          : page!.status === 'unavailable' ? <div className="phone-player__note" role="status">
            <p className="tt-paragraph">{t`This page could not load.`}</p>
            <button type="button" className="browser-review-link tt-focusable" onClick={() => void store.browser.history(bridge, threadId, page!.id, 'reload')}><RotateCw size={13} aria-hidden="true" />{t`Try again`}</button>
          </div> : covered ? <p className="phone-player__note tt-paragraph">{steppingAside}</p> : null}
      </div>
    </div>
    <div className="phone-player__status">
      {current?.pendingAction ? <div className="phone-player__request" role="group" aria-label={t`Test iPhone action permission`}>
        <p title={current.pendingAction.description}>{current.pendingAction.description}</p>
        <div className="phone-player__request-row">
          <button type="button" className="tt-button tt-button--primary tt-focusable" disabled={answering || current.status === 'paused'} onClick={() => answer(true)}>{t`Allow once`}</button>
          <button type="button" className="tt-button tt-focusable" aria-label={t`Allow this thread to use the browser and test iPhone without asking`} title={t`Allow this thread to use the browser and test iPhone without asking`} disabled={answering || current.status === 'paused'} onClick={() => answer(true, true)}>{t`Allow this thread`}</button>
          <button type="button" className="tt-button tt-focusable" disabled={answering} onClick={() => answer(false)}>{t`Deny`}</button>
        </div>
      </div> : null}
      <div className="phone-player__line">
        <span className="phone-player__dot" data-state={dotState} aria-hidden="true" /><span className="phone-player__action" title={actionText}>{actionText}</span>
        {cloudLive ? <button type="button" className="browser-review-link tt-focusable" disabled={endingSession} onClick={endSession}>
          <Square size={13} aria-hidden="true" />{t`End session`}</button> : null}
        {current && active ? <button type="button" className="browser-review-link tt-focusable" onClick={() => void store.browser.controlTask(bridge, current, current.status === 'paused' ? 'resume' : 'pause').then(error => setProblem(error))}>
          {current.status === 'paused' ? <Play size={13} aria-hidden="true" /> : <Pause size={13} aria-hidden="true" />}{current.status === 'paused' ? t({ message: 'Resume', comment: 'Lets a paused browser task carry on.' }) : t({ message: 'Pause', comment: 'Pauses a browser task.' })}</button> : null}
      </div>
      {!current?.pendingAction && grant && current ? <div className="phone-player__grant">
        <span>{t`Uses the browser without asking`}</span>
        <button type="button" className="browser-review-link tt-focusable" aria-label={t`Stop letting this thread use the browser and test iPhone without asking`} title={t`This thread will ask before opening, tapping or typing again`} disabled={stoppingGrant} onClick={stopGrant}>{t({ message: 'Stop', comment: 'Stops letting this thread use the browser and test iPhone without asking.' })}</button>
      </div> : null}
      {problem ? <p className="browser-review-problem" role="alert">{problem}</p> : null}
    </div>
  </aside>
}
