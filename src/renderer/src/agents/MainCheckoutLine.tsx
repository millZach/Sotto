import React, { useId, useRef, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import type { MainCheckoutBridge, MainCheckoutChanges, ProjectMainCheckout } from '../../../shared/mainCheckout'
import { behindWords, blockWords, showLabel } from './mainCheckoutLine.logic'

/**
 * Keep main up to date's line under a project's name (ADR-0123, variant A of the mock-up): why the default branch was
 * left behind, with Show changes listing what is in the way and Open folder beside it; or, after an update that changed a
 * lockfile, that dependencies changed, until dismissed. It says nothing otherwise.
 */
export function MainCheckoutLine({ line, title, bridge = window.sotto?.mainCheckout }: {
  readonly line: ProjectMainCheckout
  /** The project's title, for the accessible names of its presses. */
  readonly title: string
  readonly bridge?: MainCheckoutBridge | undefined
}): ReactNode {
  const listId = useId()
  const toggle = useRef<HTMLButtonElement>(null)
  const [changes, setChanges] = useState<MainCheckoutChanges | null>(null)
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  if (!bridge) return null
  const block = blockWords(line)
  const deps = line.dependencies
  if (!block && !deps) return null
  const close = (): void => { setOpen(false); toggle.current?.focus() }
  const show = (): void => {
    if (open) { setOpen(false); return }
    setOpen(true); setFailed(null)
    void bridge.changes(line.projectId).then(setChanges, () => { setChanges(null); setFailed('Sotto could not read the changes. Open the folder to look.') })
  }
  const openFolder = (): void => { void bridge.command({ type: 'open-folder', projectId: line.projectId }).catch(() => setFailed('Sotto could not open that folder.')) }
  const label = showLabel(line)
  const rows = block ? changes?.items ?? [] : deps?.map(text => ({ kind: 'changed', text })) ?? []
  return <div className="thread-folder__main" onKeyDown={event => { if (event.key === 'Escape' && open) { event.stopPropagation(); close() } }}>
    {block ? <p className="thread-folder__main-line">
      <span className="thread-folder__main-behind">{behindWords(line)}</span> · {block}
      {label ? <> · <button ref={toggle} type="button" className="thread-folder__main-press tt-focusable" aria-expanded={open} aria-controls={listId}
        aria-label={`${open ? 'Hide' : label} in ${title}`} onClick={show}>{open ? 'Hide' : label}</button></> : null}
    </p> : <p className="thread-folder__main-line">
      <span className="thread-folder__main-updated">Updated {line.branch}</span> · dependencies changed, run install ·{' '}
      <button ref={toggle} type="button" className="thread-folder__main-press tt-focusable" aria-expanded={open} aria-controls={listId}
        aria-label={`${open ? 'Hide' : 'What changed'} in ${title}`} onClick={() => setOpen(!open)}>{open ? 'Hide' : 'What changed'}</button>
      <button type="button" className="thread-folder__main-dismiss tt-focusable" aria-label={`Dismiss dependencies changed in ${title}`}
        onClick={() => { void bridge.command({ type: 'dismiss-dependencies', projectId: line.projectId }).catch(() => undefined) }}><X size={13} aria-hidden="true" /></button>
    </p>}
    {open ? <div id={listId} className="thread-folder__main-list">
      {failed ? <p className="thread-folder__main-failed" role="status">{failed}</p> : null}
      {rows.length ? <ul aria-label={block ? 'What blocks the update' : 'What changed'}>
        {rows.map(row => <li key={`${row.kind}\0${row.text}`}><span className="thread-folder__main-kind">{row.kind}</span><span className="thread-folder__main-path">{row.text}</span></li>)}
      </ul> : null}
      {block && changes && changes.more > 0 ? <p className="thread-folder__main-more">and {changes.more.toLocaleString()} more</p> : null}
      {block ? <button type="button" className="thread-folder__main-press tt-focusable" aria-label={`Open the ${title} folder`} onClick={openFolder}>Open folder</button> : null}
    </div> : null}
  </div>
}
