import React, { useEffect, useLayoutEffect, useState, type ReactNode } from 'react'
import { ArrowUpRight, Globe, Pause, Play, X } from 'lucide-react'
import type { AgentState } from '../../../shared/agents'
import type { BrowserBridge, BrowserTask } from '../../../shared/browser'
import { useBrowserTasks, type BrowserStore } from './browserStore'
import { toolsTarget, useToolsPanelChrome, type ToolsPanelStore } from './toolsPanelStore'
import './browserReview.css'

/**
 * The corner preview of the focused thread's browser task, or the pinned Tools thread's. Another thread's task
 * never shows here: that thread's pane is where it belongs. With previews turned off nothing shows, but tasks are
 * still watched so Tools > Browser has them when it opens.
 */
export function BrowserTaskPreview({ state, focusedThreadId, bridge, store, enabled = true }: {
  readonly state: AgentState; readonly focusedThreadId: string | null; readonly bridge: BrowserBridge | undefined; readonly store: ToolsPanelStore
  readonly enabled?: boolean
}): ReactNode {
  const tasks = useBrowserTasks(store.browser)
  const chrome = useToolsPanelChrome(store)
  const [problem, setProblem] = useState<string | null>(null)
  const [placement, setPlacement] = useState<{ bottom: number; maxHeight: number } | undefined>(undefined)
  const ids = state.host.threads.map(thread => thread.id).join('\n')
  useEffect(() => { store.browser.watchTasks(bridge, ids.split('\n').filter(Boolean)) }, [bridge, store, ids])
  const shownThreads = [focusedThreadId, chrome.pinnedThreadId].filter((id): id is string => id !== null)
  const task = enabled ? tasks.find(item => shownThreads.includes(item.threadId) && !store.browser.isDismissed(item.id) && state.host.threads.some(thread => thread.id === item.threadId)) : undefined
  const hidden = task && chrome.open && chrome.surface === 'browser' && toolsTarget(chrome, focusedThreadId) === task.threadId
    && store.browser.thread(task.threadId)?.activePageId === task.pageId
  useLayoutEffect(() => {
    if (!task || hidden) return
    const composer = document.querySelector<HTMLElement>('.thread-pane[data-focused] .thread-prompt')
    if (!composer) { setPlacement(undefined); return }
    const place = (): void => {
      const rect = composer.getBoundingClientRect()
      // A growing draft keeps its space; a Tools pane to its right uses the ordinary corner placement.
      setPlacement(rect.width > 0 && rect.right > innerWidth - 328 ? { bottom: Math.max(16, Math.round(innerHeight - rect.top + 16)), maxHeight: Math.max(100, Math.round(rect.top - 80)) } : undefined)
    }
    place()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place)
    observer?.observe(composer); window.addEventListener('resize', place)
    return () => { observer?.disconnect(); window.removeEventListener('resize', place) }
  }, [task?.id, hidden, focusedThreadId])
  if (!task || hidden) return null
  const thread = state.host.threads.find(item => item.id === task.threadId)!
  const active = task.status === 'working' || task.status === 'paused'
  const action = task.pendingAction ? 'Waiting for your permission' : task.status === 'paused' ? 'Browser paused' : task.summary || task.description
  return <aside className="browser-corner" aria-label={`Browser preview for ${thread.title}`} data-status={task.status} data-covers-native-view style={placement}>
    <div className="browser-corner__head"><span title={thread.title}>{thread.title}</span>
      <button type="button" className="files-icon tt-focusable" aria-label="Dismiss browser preview" title="Dismiss preview; work continues" onClick={() => { document.querySelector<HTMLElement>('[aria-controls="sotto-tools-panel"]')?.focus(); store.browser.dismissTask(task.id) }}><X size={16} aria-hidden="true" /></button></div>
    <button type="button" className="browser-corner__open tt-focusable" aria-label={`Open browser task in Tools: ${action}`} onClick={() => {
      setProblem(null)
      void store.showBrowserTask(task, bridge).then(opened => { if (!opened) setProblem('This page is no longer available. Open Browser in Tools to start another page.'); else requestAnimationFrame(() => document.getElementById('tools-tab-browser')?.focus()) })
    }}>
      <div className="browser-corner__image">{task.thumbnail ? <img src={task.thumbnail} alt="" /> : <Globe size={32} aria-hidden="true" />}</div>
      <span className="browser-corner__action"><i aria-hidden="true" /><span>{action}</span><ArrowUpRight size={16} aria-hidden="true" /></span>
    </button>
    <div className="browser-corner__foot"><span>{task.status === 'failed' ? 'Needs attention' : task.status === 'completed' ? 'Finished' : `${task.steps.length} ${task.steps.length === 1 ? 'step' : 'steps'}`}</span>
      {active ? <button type="button" className="browser-review-link tt-focusable" onClick={() => void store.browser.controlTask(bridge, task, task.status === 'paused' ? 'resume' : 'pause').then(setProblem)}>
        {task.status === 'paused' ? <Play size={13} aria-hidden="true" /> : <Pause size={13} aria-hidden="true" />}{task.status === 'paused' ? 'Resume' : 'Pause'}</button> : null}</div>
    {problem ? <p className="browser-review-problem" role="alert">{problem}</p> : null}
  </aside>
}

/** Actions require the user's exact answer; task descriptions and evidence never answer for them. */
export function BrowserTaskDetails({ task, store, bridge }: { readonly task: BrowserTask; readonly store: BrowserStore; readonly bridge: BrowserBridge | undefined }): ReactNode {
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const active = task.status === 'working' || task.status === 'paused'
  const answer = (allow: boolean, forThread = false): void => {
    setBusy(true); setProblem(null)
    void store.answerAction(bridge, task, allow, forThread).then(error => { setProblem(error); if (!error) requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.browser-address')?.focus()) }).finally(() => setBusy(false))
  }
  return <div className="browser-task" data-status={task.status}>
    <div className="browser-task__line"><span>{task.status === 'paused' ? 'Browser paused' : task.summary || task.description}</span>
      {active ? <button type="button" className="browser-review-link tt-focusable" onClick={() => void store.controlTask(bridge, task, task.status === 'paused' ? 'resume' : 'pause').then(setProblem)}>{task.status === 'paused' ? 'Resume' : 'Pause'}</button> : null}</div>
    {task.pendingAction ? <div className="browser-action-request" role="group" aria-label="Browser action permission">
      <p>{task.pendingAction.description}</p><div><button type="button" className="tt-button tt-button--primary tt-focusable" disabled={busy || task.status === 'paused'} onClick={() => answer(true)}>Allow once</button>
        <button type="button" className="tt-button tt-focusable" disabled={busy || task.status === 'paused'} title="Let this thread open, navigate, click and type in Sotto's browser without asking until you stop it or Sotto closes." onClick={() => answer(true, true)}>Allow this thread to use the browser</button>
        <button type="button" className="tt-button tt-focusable" disabled={busy} onClick={() => answer(false)}>Deny</button></div></div> : null}
    {task.steps.length || task.unchecked.length ? <details className="browser-task__evidence"><summary className="tt-focusable">{task.steps.length} recorded steps{task.unchecked.length ? `, ${task.unchecked.length} unchecked` : ''}</summary>
      <ol>{task.steps.map(step => <li key={step.id}><span>{step.status === 'failed' ? 'Failed: ' : ''}{step.action}</span>{step.detail ? <span>{step.detail}</span> : null}</li>)}</ol>
      {task.unchecked.length ? <p>Not checked: {task.unchecked.join('; ')}</p> : null}
      {task.evidence?.length ? <div className="browser-task__captures">{task.evidence.map(evidence => <figure key={evidence.id}><img src={evidence.image} alt={`Captured page at ${evidence.viewport?.width ?? evidence.width} by ${evidence.viewport?.height ?? evidence.height}`} /><figcaption>{evidence.viewport?.width ?? evidence.width} x {evidence.viewport?.height ?? evidence.height} - {new Date(evidence.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</figcaption></figure>)}</div> : task.thumbnail ? <img src={task.thumbnail} alt="Last captured page for this browser task" /> : null}
    </details> : null}
    {problem ? <p className="browser-review-problem" role="alert">{problem}</p> : null}
  </div>
}
