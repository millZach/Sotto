import React, { useState, type ReactNode } from 'react'
import { plural } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import type { BrowserBridge, BrowserTask } from '../../../shared/browser'
import { type BrowserStore } from './browserStore'
import './browserReview.css'

/** Actions require the user's exact answer; task descriptions and evidence never answer for them. */
export function BrowserTaskDetails({ task, store, bridge }: { readonly task: BrowserTask; readonly store: BrowserStore; readonly bridge: BrowserBridge | undefined }): ReactNode {
  const { t } = useLingui()
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const active = task.status === 'working' || task.status === 'paused'
  const answer = (allow: boolean, forThread = false): void => {
    setBusy(true); setProblem(null)
    void store.answerAction(bridge, task, allow, forThread).then(error => { setProblem(error); if (!error) requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.browser-address')?.focus()) }).finally(() => setBusy(false))
  }
  const steps = task.steps.length
  const unchecked = task.unchecked.length
  const uncheckedList = task.unchecked.join('; ')
  return <div className="browser-task" data-status={task.status}>
    <div className="browser-task__line"><span>{task.status === 'paused' ? t`Browser paused` : task.summary || task.description}</span>
      {active ? <button type="button" className="browser-review-link tt-focusable" onClick={() => void store.controlTask(bridge, task, task.status === 'paused' ? 'resume' : 'pause').then(setProblem)}>{task.status === 'paused' ? t({ message: 'Resume', comment: 'Lets a paused browser task carry on.' }) : t({ message: 'Pause', comment: 'Pauses a browser task.' })}</button> : null}</div>
    {task.pendingAction ? <div className="browser-action-request" role="group" aria-label={t`Browser action permission`}>
      <p>{task.pendingAction.description}</p><div><button type="button" className="tt-button tt-button--primary tt-focusable" disabled={busy || task.status === 'paused'} onClick={() => answer(true)}>{t`Allow once`}</button>
        <button type="button" className="tt-button tt-focusable" disabled={busy || task.status === 'paused'} title={t`Let this thread open, navigate, click and type in Sotto's browser without asking, and see every page in its browser, until you stop it or Sotto closes.`} onClick={() => answer(true, true)}>{t`Allow this thread to use the browser`}</button>
        <button type="button" className="tt-button tt-focusable" disabled={busy} onClick={() => answer(false)}>{t`Deny`}</button></div></div> : null}
    {task.steps.length || task.unchecked.length ? <details className="browser-task__evidence"><summary className="tt-focusable">{unchecked ? t`${plural(steps, { other: '# recorded steps' })}, ${plural(unchecked, { other: '# unchecked' })}` : plural(steps, { other: '# recorded steps' })}</summary>
      <ol>{task.steps.map(step => { const action = step.action; return <li key={step.id}><span>{step.status === 'failed' ? t({ message: `Failed: ${action}`, comment: '{action} is a step a browser task took, in the agent\'s words.' }) : action}</span>{step.detail ? <span>{step.detail}</span> : null}</li> })}</ol>
      {unchecked ? <p>{t`Not checked: ${uncheckedList}`}</p> : null}
      {task.evidence?.length ? <div className="browser-task__captures">{task.evidence.map(evidence => { const width = evidence.viewport?.width ?? evidence.width, height = evidence.viewport?.height ?? evidence.height; return <figure key={evidence.id}><img src={evidence.image} alt={t`Captured page at ${width} by ${height}`} /><figcaption>{evidence.viewport?.width ?? evidence.width} x {evidence.viewport?.height ?? evidence.height} - {new Date(evidence.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</figcaption></figure> })}</div> : task.thumbnail ? <img src={task.thumbnail} alt={t`Last captured page for this browser task`} /> : null}
    </details> : null}
    {problem ? <p className="browser-review-problem" role="alert">{problem}</p> : null}
  </div>
}
