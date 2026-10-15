import React, { createContext, useContext, useId, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronUp, FilePen, FileText } from 'lucide-react'
import type { AgentMessage } from '../../../shared/agents'
import { watcherOwnChangeSchema, type WatcherOwnChange } from '../../../shared/watcher'

/** Watcher's changes to files, by the reply they belong to; only Watcher's own pane provides it. */
export const WatcherOwnChangesContext = createContext<ReadonlyMap<string, WatcherOwnChange> | null>(null)

const files = (count: number): string => `${count} ${count === 1 ? 'file' : 'files'}`
/** The line's first words, which say what Sotto saw whether or not Watcher said so. */
export const ownChangeHeadline = (count: number): string => `Watcher changed ${files(count)} itself.`

/**
 * The mark for one reply: the room's projection of it, or the one its history kept when the projection has moved on.
 * Nothing at all outside Watcher's own pane, or for a reply in which Watcher changed nothing.
 */
export function WatcherOwnChangeFor({ message }: { readonly message: AgentMessage }): ReactNode {
  const changes = useContext(WatcherOwnChangesContext)
  if (changes === null) return null
  const kept = watcherOwnChangeSchema.safeParse((message as Readonly<Record<string, unknown>>)['watcherOwnChange'])
  const change = changes.get(message.id) ?? (kept.success ? kept.data : undefined)
  return change === undefined ? null : <WatcherOwnChangeLine change={change} />
}

/**
 * One quiet line under a reply in which Watcher changed files itself (Zach's pick on October 13, 2026, mark B): how
 * many, then its reason when its reply gave one, or that it gave none, said in the needs-you colour since Watcher is
 * meant to hand changes to a thread. Sotto marks it from the provider's own record of file changes in that turn, so
 * the line is there whatever the reply says. The file names show on request, and Escape folds them again.
 */
export function WatcherOwnChangeLine({ change }: { readonly change: WatcherOwnChange }): ReactNode {
  const [open, setOpen] = useState(false)
  const toggle = useRef<HTMLButtonElement>(null)
  const listId = useId()
  const count = Math.max(change.fileCount, change.files.length)
  const unnamed = count - change.files.length
  const what = count === 1 ? 'the file' : `the ${files(count)}`
  return <div className="watcher-own" data-reply-id={change.replyMessageId}
    onKeyDown={event => {
      if (!open || event.key !== 'Escape' || event.nativeEvent.isComposing) return
      event.preventDefault(); event.stopPropagation(); setOpen(false); toggle.current?.focus()
    }}>
    <p className="watcher-own__line">
      <FilePen size={14} aria-hidden="true" className="watcher-own__icon" />
      <span className="watcher-own__words"><strong>{ownChangeHeadline(count)}</strong>{' '}
        {change.reason === null ? <span className="watcher-own__none">It gave no reason.</span>
          : <><span className="watcher-own__said">Its reason:</span> “{change.reason}”</>}</span>
      {change.files.length > 0 ? <button ref={toggle} type="button" className="watcher-own__toggle tt-focusable" aria-expanded={open} aria-controls={open ? listId : undefined}
        onClick={() => setOpen(value => !value)}>
        {open ? `Hide ${what}` : `Show ${what}`}{open ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
      </button> : null}
    </p>
    {open ? <ul id={listId} className="watcher-own__files" aria-label="Files Watcher changed">
      {change.files.map(file => <li key={file}><FileText size={13} aria-hidden="true" /><code title={file}>{file}</code></li>)}
      {unnamed > 0 ? <li className="watcher-own__more">and {files(unnamed)} more</li> : null}
    </ul> : null}
  </div>
}
