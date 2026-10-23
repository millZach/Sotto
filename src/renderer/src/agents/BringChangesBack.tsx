import React, { useEffect, useId, useRef, type ReactNode } from 'react'
import { AlertCircle, CheckCircle2, GitMerge, X } from 'lucide-react'
import { Button } from '../components/Button'
import { outcomeWords, questionWords, readyWords, fileCount, type BringBackView } from './bringChangesBack.logic'
import './bringChangesBack.css'

/**
 * Bring changes to <branch> (#1030), above the composer of a thread in a new worktree made from its parent's branch:
 * the offer, then the merge-commit question or the outcome in its place (pick B of the continue prototype, in place).
 * The Git action owns it and its menu offers the same press, so Git still acts from one place (ADR-0027).
 */
export function BringChangesBack({ view, parentTitle, machine, busy, takeFocus, onBring, onMergeCommit, onNotNow, onDismiss, onHide, onCommit, onOpenParent }: {
  readonly view: BringBackView
  readonly parentTitle: string
  /** The machine the thread it began from is on, when that is not this thread's own (#1030). */
  readonly machine?: string | undefined
  /** A press is on its way to the host. */
  readonly busy: boolean
  /** This pane pressed and is waiting for the answer: the question or outcome that arrives takes the focus. */
  readonly takeFocus: boolean
  readonly onBring: () => void
  readonly onMergeCommit: () => void
  readonly onNotNow: () => void
  readonly onDismiss: () => void
  readonly onHide: () => void
  readonly onCommit: () => void
  readonly onOpenParent: () => void
}): ReactNode {
  const titleId = useId(), reasonId = useId()
  const first = useRef<HTMLButtonElement>(null)
  const region = useRef<HTMLElement>(null)
  /** Not now or Dismiss was pressed here: the offer that comes back takes the focus, so the keyboard keeps its place. */
  const restore = useRef(false)
  const key = view.kind === 'asks' || view.kind === 'outcome' ? `${view.kind}:${view.record.actionId}` : view.kind
  // The answer to this pane's own press takes the focus: the question's Make merge commit, or the outcome itself.
  useEffect(() => {
    if (view.kind === 'ready' || view.kind === 'uncommitted') {
      if (restore.current) first.current?.focus()
      restore.current = false
      return
    }
    if (!takeFocus) return
    if (view.kind === 'asks') first.current?.focus()
    else region.current?.focus()
  }, [key, takeFocus, view.kind])
  const notNow = (): void => { restore.current = true; onNotNow() }
  const dismiss = (): void => { restore.current = true; onDismiss() }
  const { target } = view.found
  const bring = `Bring changes to ${target}`
  if (view.kind === 'ready' || view.kind === 'uncommitted') {
    const words = readyWords(view.found, parentTitle, machine)
    const blocked = view.kind === 'uncommitted'
    return <section ref={region} className="bring-back" aria-label="Bring changes back">
      <GitMerge size={16} aria-hidden="true" className="bring-back__icon" />
      <p id={reasonId} className="bring-back__text">
        {blocked
          ? <><strong>{view.found.branch}</strong> has uncommitted changes in {fileCount(view.files)}. Commit them first; Sotto won’t bring back uncommitted work.</>
          : <><strong>{view.found.branch}</strong> was made from <strong>{target}</strong>. {words.rest}</>}
      </p>
      <div className="bring-back__actions">
        {blocked ? <Button variant="secondary" onClick={onCommit}>Commit…</Button> : null}
        <Button ref={first} variant={blocked ? 'secondary' : 'primary'} aria-disabled={blocked || busy || undefined} aria-busy={busy || undefined}
          {...(blocked ? { 'aria-describedby': reasonId, title: `Commit the ${fileCount(view.files)} changed first.` } : {})}
          onClick={() => { if (!blocked && !busy) onBring() }}>
          <GitMerge size={15} aria-hidden="true" />{bring}
        </Button>
        {blocked ? null : <button type="button" className="bring-back__dismiss tt-focusable" aria-label="Hide until this branch changes" title="Hide until this branch changes" onClick={onHide}>
          <X size={14} aria-hidden="true" />
        </button>}
      </div>
    </section>
  }
  if (view.kind === 'asks') {
    const words = questionWords(view.record)
    return <section ref={region} className="bring-back" data-tone="ask" role="group" aria-labelledby={titleId}
      onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); notNow() } }}>
      <GitMerge size={16} aria-hidden="true" className="bring-back__icon" />
      <p className="bring-back__text"><strong id={titleId}>{words.title}</strong> {words.body}</p>
      <div className="bring-back__actions">
        <Button ref={first} variant="primary" aria-disabled={busy || undefined} aria-busy={busy || undefined} onClick={() => { if (!busy) onMergeCommit() }}>Make merge commit</Button>
        <Button variant="secondary" disabled={busy} onClick={notNow}>Not now</Button>
      </div>
    </section>
  }
  const words = outcomeWords(view.record, parentTitle, machine)
  const Icon = words.tone === 'error' ? AlertCircle : CheckCircle2
  return <section ref={region} tabIndex={-1} className="bring-back" data-tone={words.tone} role={words.tone === 'error' ? 'alert' : 'status'} aria-label={words.title}
    onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); dismiss() } }}>
    <Icon size={16} aria-hidden="true" className="bring-back__icon" />
    <div className="bring-back__text">
      <p><strong>{words.title}</strong> {words.body}</p>
      {words.gitSaid ? <pre className="bring-back__git-said">{words.gitSaid}</pre> : null}
    </div>
    <div className="bring-back__actions">
      {words.commit ? <Button variant="secondary" onClick={onCommit}>Commit…</Button> : null}
      {words.openParent ? <Button variant="secondary" onClick={onOpenParent}>Open {parentTitle}</Button> : null}
      <button type="button" className="bring-back__dismiss tt-focusable" aria-label="Dismiss" title="Dismiss" onClick={dismiss}>
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  </section>
}
