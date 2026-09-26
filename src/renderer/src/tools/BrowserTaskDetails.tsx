import React, { useState, type ReactNode } from 'react'
import type { BrowserBridge, BrowserTask } from '../../../shared/browser'
import { type BrowserStore } from './browserStore'
import './browserReview.css'

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
