import React, { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Search, X } from 'lucide-react'

import type { DictationRecord } from '../../../../shared/dictationRecord'
import type { HistoryEntry } from '../../../../shared/history'
import { PaneMenu } from '../../agents/PaneMenu'
import { Button } from '../../components/Button'
import { ConfirmationDialog } from '../../components/ConfirmationDialog'
import type { HistoryStatus } from '../../state/AppContext'
import {
  JOURNAL_DAYS_STEP,
  clockLabel,
  journalDays,
  journalRow,
  rowMeta,
  transcriptFacts,
  wordsLabel,
  type JournalRow,
} from './journalFacts'

export interface JournalProps {
  readonly entries: readonly HistoryEntry[]
  readonly records: readonly DictationRecord[]
  readonly historyEnabled: boolean
  readonly status: HistoryStatus
  /** The instant day labels and the seven-day window are measured against; captures pin it. */
  readonly now: number
  /** The apps the chips offer beside All, busiest first. */
  readonly chips: readonly string[]
  /** Controlled search text, when the app owns it so it survives leaving the room; otherwise the feed keeps its own. */
  readonly query?: string | undefined
  readonly onQueryChange?: ((query: string) => void) | undefined
  readonly onCopy: (text: string) => Promise<boolean>
  readonly onDelete: (id: string) => Promise<boolean>
  readonly onClear: () => Promise<boolean>
  readonly onOpenSettings: () => void
}

const COPIED_MS = 1_600
const ALL = 'All'

/**
 * The Journal: every transcript, grouped by day under that day's words and pace, a week at a time. Search and the
 * app chips narrow it, and the More menu beside the search holds Clear history. A row opens in place on its full
 * text, its facts, Copy and Delete, and Escape closes it again. The words come from saved transcripts; the stats
 * beside it come from dictation records, so with History off older transcripts stay listed and new ones are not.
 */
export function Journal({
  entries,
  records,
  historyEnabled,
  status,
  now,
  chips,
  query: controlledQuery,
  onQueryChange,
  onCopy,
  onDelete,
  onClear,
  onOpenSettings,
}: JournalProps): ReactNode {
  const [ownQuery, setOwnQuery] = useState('')
  const [app, setApp] = useState(ALL)
  const [daysShown, setDaysShown] = useState(JOURNAL_DAYS_STEP)
  const [openId, setOpenId] = useState<string | null>(null)
  const [deleteEntry, setDeleteEntry] = useState<HistoryEntry | null>(null)
  const [clearOpen, setClearOpen] = useState(false)
  const [copying, setCopying] = useState<{ id: string; done: boolean } | null>(null)
  const [copyProblem, setCopyProblem] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  // Where focus goes when a delete or a clear takes away the control that opened it.
  const headingRef = useRef<HTMLHeadingElement>(null)
  const toggleRefs = useRef(new Map<string, HTMLButtonElement>())
  const factsBase = useId()

  const query = controlledQuery ?? ownQuery
  const setQuery = (value: string): void => {
    setOwnQuery(value)
    onQueryChange?.(value)
  }
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const searching = normalizedQuery.length > 0
  // A chip for an app that no longer has words in the window falls back to All rather than hiding everything.
  const chosenApp = app !== ALL && chips.includes(app) ? app : ALL

  // A new search or another chip starts again from the first week.
  useEffect(() => { setDaysShown(JOURNAL_DAYS_STEP) }, [normalizedQuery, chosenApp])

  const recordsById = useMemo(() => new Map(records.map((record) => [record.id, record])), [records])
  // Each transcript's words are counted once: main hands back new objects with every change, so a new dictation
  // costs one count. The counts are kept by id only, never with the text, and only for transcripts still listed, so
  // a deleted or cleared transcript leaves nothing behind.
  const wordCounts = useRef(new Map<string, number>())
  const rows = useMemo(() => {
    const counted = new Map<string, number>()
    const built = entries.map((entry) => {
      const row = journalRow(entry, recordsById.get(entry.id), wordCounts.current.get(entry.id))
      counted.set(entry.id, row.words)
      return row
    })
    wordCounts.current = counted
    return built
  }, [entries, recordsById])
  const matching = useMemo(() => rows.filter((row) => (chosenApp === ALL || row.app === chosenApp)
    && (!searching || row.entry.text.toLocaleLowerCase().includes(normalizedQuery))), [rows, chosenApp, searching, normalizedQuery])
  const { days, more } = useMemo(() => journalDays(matching, now, daysShown), [matching, now, daysShown])

  useEffect(() => {
    if (copying === null || !copying.done) return
    const timer = setTimeout(() => setCopying(null), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copying])

  const copy = async (entry: HistoryEntry): Promise<void> => {
    if (copying !== null && !copying.done) return
    setCopying({ id: entry.id, done: false })
    setCopyProblem(null)
    const copied = await onCopy(entry.text).catch(() => false)
    if (copied) setCopying({ id: entry.id, done: true })
    else {
      setCopying(null)
      setCopyProblem('Transcript could not be copied. Try again.')
    }
  }

  const onRowKey = (event: KeyboardEvent<HTMLElement>, entry: HistoryEntry): void => {
    if (event.key !== 'Escape' || openId !== entry.id) return
    event.preventDefault()
    setOpenId(null)
    toggleRefs.current.get(entry.id)?.focus()
  }

  const ready = status === 'ready'
  // The search is there whenever the transcripts are read, so Ctrl+K always has somewhere to land; Clear history,
  // which removes every record as well as every transcript, is offered while either is kept.

  let empty: { title: string; detail?: string; busy?: boolean } | null = null
  if (status === 'loading') empty = { title: 'Loading transcripts.', detail: 'Your transcripts on this computer are being read.', busy: true }
  else if (status === 'degraded') empty = { title: 'Transcripts could not be loaded.', detail: 'Dictation still works. Reopen Sotto to try reading them again.' }
  else if (entries.length === 0 && historyEnabled) empty = { title: 'Nothing here yet.', detail: 'Dictate something and it will be kept here, on this computer.' }

  return (
    <div className="journal">
      <h2 ref={headingRef} tabIndex={-1} className="tt-visually-hidden">Transcripts</h2>
      {historyEnabled ? null : (
        <p className="journal-note">
          <span>{entries.length > 0
            ? 'History is off. New dictations keep their numbers only; older transcripts stay here until you delete them.'
            : 'History is off. New dictations keep their numbers only.'}</span>
          <Button variant="ghost" onClick={onOpenSettings}>Open Settings</Button>
        </p>
      )}
      {ready ? (
        <div className="journal-tools">
          <label className="journal-search" data-filled={searching ? '1' : '0'}>
            <span className="tt-visually-hidden">Search transcripts</span>
            <Search size={15} aria-hidden="true" />
            <input
              ref={searchRef}
              className="journal-search__input tt-focusable"
              type="search"
              value={query}
              placeholder="Search transcripts"
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => { if (event.key === 'Escape' && query !== '') { event.preventDefault(); setQuery('') } }}
            />
            {searching ? (
              <button type="button" className="journal-search__clear tt-focusable" aria-label="Clear search" title="Clear search"
                onClick={() => { setQuery(''); searchRef.current?.focus() }}>
                <X size={14} aria-hidden="true" />
              </button>
            ) : null}
          </label>
          {records.length === 0 && entries.length === 0 ? null : <PaneMenu className="journal-more" label="More transcript actions"
            groups={[[{ id: 'clear', label: 'Clear history', tone: 'danger', run: () => setClearOpen(true) }]]} />}
          {chips.length > 0 && entries.length > 0 ? (
            <div className="journal-chips" role="group" aria-label="Show transcripts from">
              {[ALL, ...chips].map((name) => (
                <button key={name} type="button" className="journal-chip tt-focusable" aria-pressed={chosenApp === name}
                  onClick={() => setApp(name)}>{name}</button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {copyProblem === null ? null : <p className="journal-alert" role="alert">{copyProblem}</p>}
      {copying?.done ? <p className="tt-visually-hidden" role="status">Transcript copied.</p> : null}

      {empty !== null ? (
        <div className="journal-empty" aria-busy={empty.busy ? 'true' : undefined}>
          <h2>{empty.title}</h2>
          {empty.detail === undefined ? null : <p>{empty.detail}</p>}
        </div>
      ) : entries.length === 0 ? null : days.length === 0 ? (
        <div className="journal-empty">
          <h2>{searching ? <>Nothing matches &ldquo;{query.trim()}&rdquo;.</> : `No transcripts from ${chosenApp}.`}</h2>
          <p>{!searching ? 'Choose All to see every transcript.' : chosenApp === ALL ? 'Try another word, or clear the search.' : 'Try another word, or choose All.'}</p>
        </div>
      ) : (
        <>
          {days.map((day) => (
            <section key={day.day} className="journal-day" aria-label={day.label}>
              <div className="journal-day__head">
                <h2>{day.label}</h2>
                <span>{wordsLabel(day.words)}{day.wpm === null ? '' : ` · ${day.wpm} wpm`}</span>
              </div>
              <ol className="journal-list">
                {day.rows.map((row) => (
                  <JournalEntry
                    key={row.entry.id}
                    row={row}
                    open={row.entry.id === openId}
                    factsId={`${factsBase}-${row.entry.id}`}
                    copyState={copying?.id === row.entry.id ? copying : null}
                    toggleRef={(node) => { if (node === null) toggleRefs.current.delete(row.entry.id); else toggleRefs.current.set(row.entry.id, node) }}
                    onToggle={() => setOpenId((current) => (current === row.entry.id ? null : row.entry.id))}
                    onKeyDown={(event) => onRowKey(event, row.entry)}
                    onCopy={() => void copy(row.entry)}
                    onDelete={() => setDeleteEntry(row.entry)}
                  />
                ))}
              </ol>
            </section>
          ))}
          {more ? <Button variant="secondary" className="journal-more-days" onClick={() => setDaysShown((shown) => shown + JOURNAL_DAYS_STEP)}>Show the 7 days before</Button> : null}
        </>
      )}

      {deleteEntry === null ? null : (
        <ConfirmationDialog
          title="Delete transcript?"
          description="This removes the transcript and its numbers from this computer. It cannot be undone."
          cancelLabel="Keep transcript"
          confirmLabel="Delete transcript"
          failureMessage="Transcript could not be deleted. Try again or keep the transcript."
          fallbackFocusRef={headingRef}
          onCancel={() => setDeleteEntry(null)}
          onConfirm={async () => {
            const removed = await onDelete(deleteEntry.id).catch(() => false)
            if (removed && openId === deleteEntry.id) setOpenId(null)
            return removed
          }}
        />
      )}
      {!clearOpen ? null : (
        <ConfirmationDialog
          title="Clear history?"
          description="This permanently removes every saved transcript, and the numbers the Dictate room counts, from this computer. Your settings are unchanged."
          cancelLabel="Keep history"
          confirmLabel="Clear all transcripts"
          failureMessage="History could not be cleared. Your saved transcripts are unchanged."
          fallbackFocusRef={headingRef}
          onCancel={() => setClearOpen(false)}
          onConfirm={async () => {
            const cleared = await onClear().catch(() => false)
            if (cleared) { setOpenId(null); setApp(ALL) }
            return cleared
          }}
        />
      )}
    </div>
  )
}

function JournalEntry({ row, open, factsId, copyState, toggleRef, onToggle, onKeyDown, onCopy, onDelete }: {
  readonly row: JournalRow
  readonly open: boolean
  readonly factsId: string
  readonly copyState: { readonly done: boolean } | null
  readonly toggleRef: (node: HTMLButtonElement | null) => void
  readonly onToggle: () => void
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
  readonly onCopy: () => void
  readonly onDelete: () => void
}): ReactNode {
  const stamp = clockLabel(row.entry.createdAt)
  const facts = open ? transcriptFacts(row) : null
  return (
    <li>
      <article className="journal-entry" aria-current={open ? 'true' : undefined} onKeyDown={onKeyDown}>
        <button
          ref={toggleRef}
          type="button"
          className="journal-entry__toggle tt-focusable"
          aria-expanded={open}
          aria-controls={open ? factsId : undefined}
          aria-label={`Transcript from ${stamp.full}, ${wordsLabel(row.words)}`}
          onClick={onToggle}
        />
        <span className="journal-entry__time" aria-hidden="true">
          {stamp.dateTime === undefined ? stamp.time : <time dateTime={stamp.dateTime}>{stamp.time}</time>}
        </span>
        <p className="journal-entry__text">{row.entry.text}</p>
        <p className="journal-entry__meta" aria-hidden="true">{rowMeta(row)}</p>
        <Button
          variant="secondary"
          className="journal-entry__copy"
          aria-label="Copy transcript"
          disabled={copyState !== null && !copyState.done}
          onClick={onCopy}
        >
          {copyState?.done ? 'Copied' : 'Copy'}
        </Button>
        {facts === null ? null : (
          <>
            <p className="journal-entry__facts" id={factsId}><b>{facts.lead}</b> {facts.rest}</p>
            <div className="journal-entry__delete">
              <Button variant="danger" aria-label="Delete saved transcript" onClick={onDelete}>Delete</Button>
            </div>
          </>
        )}
      </article>
    </li>
  )
}
