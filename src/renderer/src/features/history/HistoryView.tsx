import React, { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Search, X } from 'lucide-react'

import type { HistoryEntry } from '../../../../shared/history'
import { Button } from '../../components/Button'
import { ConfirmationDialog } from '../../components/ConfirmationDialog'
import { languageLabel } from '../../languages'
import type { HistoryStatus } from '../../state/AppContext'
import { countWords } from '../dictate/DictateRoom'

export interface HistoryViewProps {
  readonly entries: readonly HistoryEntry[]
  readonly enabled: boolean
  readonly status: HistoryStatus
  /** Controlled search text, when the app owns it; otherwise the view keeps its own. */
  readonly query?: string | undefined
  readonly onQueryChange?: ((query: string) => void) | undefined
  /** Controlled "Clear history?" dialog, when the footer opens it; otherwise the view keeps its own. */
  readonly clearOpen?: boolean | undefined
  readonly onClearOpenChange?: ((open: boolean) => void) | undefined
  /** The instant day labels are measured against; the design capture pins it. */
  readonly now?: number | undefined
  readonly onCopy: (text: string) => Promise<boolean>
  readonly onDelete: (id: string) => Promise<boolean>
  readonly onClear: () => Promise<boolean>
  readonly onOpenDictate?: (() => void) | undefined
  readonly onOpenSettings?: (() => void) | undefined
}

const COPIED_MS = 1_600

/** Day labels: Today, Yesterday, then the weekday and date. */
export function dayLabel(createdAt: number, now: number): string {
  const date = new Date(createdAt)
  if (!Number.isFinite(date.valueOf())) return 'Saved'
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  if (createdAt >= startOfToday.valueOf()) return 'Today'
  const yesterday = new Date(startOfToday)
  yesterday.setDate(yesterday.getDate() - 1)
  if (createdAt >= yesterday.valueOf()) return 'Yesterday'
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
}

/** The row's clock: "2:32 pm" in a 12-hour locale, "14:32" in a 24-hour one. */
export function clockLabel(createdAt: number): { dateTime?: string; time: string; full: string } {
  const date = new Date(createdAt)
  if (!Number.isFinite(date.valueOf())) return { time: 'Saved', full: 'Saved transcript' }
  return {
    dateTime: date.toISOString(),
    time: date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/u, (period) => period.toLowerCase()),
    full: date.toLocaleString(),
  }
}

/** Older entries may carry presets the catalog no longer lists. */
function modelLabel(preset: HistoryEntry['modelPreset']): string {
  if (preset === 'mai') return 'MAI-Transcribe-2'
  return preset === 'instant' ? 'Moonshine' : 'Whisper'
}

export function lengthLabel(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1_000))
  if (seconds < 60) return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`
}

function wordsLabel(words: number): string {
  return `${words} ${words === 1 ? 'word' : 'words'}`
}

/**
 * The facts line under an open transcript, built only from what the entry
 * records: length, words and pace in bold, then language, model and where it
 * is kept. Where the text went (pasted, copied, sent) is not stored, so it is
 * not claimed.
 */
export function transcriptFacts(entry: HistoryEntry): { lead: string; rest: string } {
  const words = countWords(entry.text)
  const minutes = entry.durationMs / 60_000
  const pace = minutes > 0 && words > 0 ? ` at ${Math.round(words / minutes)} wpm` : ''
  const lead = entry.durationMs > 0
    ? `${lengthLabel(entry.durationMs)}, ${wordsLabel(words)}${pace}.`
    : `${wordsLabel(words)}.`
  return { lead, rest: `${languageLabel(entry.language)}, ${modelLabel(entry.modelPreset)} model. Kept on this computer only.` }
}

export interface HistoryFooterProps {
  readonly enabled: boolean
  readonly status: HistoryStatus
  readonly count: number
  readonly onClear: () => void
}

/**
 * The footer's sentence for the History page, with Clear history beside it
 * whenever there is something to clear.
 */
export function HistoryFooter({ enabled, status, count, onClear }: HistoryFooterProps): ReactNode {
  const clearable = status === 'ready' && count > 0
  let sentence = 'Kept on this computer only.'
  if (!enabled) sentence = clearable ? 'History is off. Older transcripts are still here.' : 'History is off.'
  return (
    <span className="history-footer">
      {sentence}
      {clearable ? <button type="button" className="history-footer__clear tt-focusable" onClick={onClear}>Clear history</button> : null}
    </span>
  )
}

interface DayGroup {
  readonly label: string
  readonly entries: HistoryEntry[]
}

/**
 * History as the Dictate room's last-transcript row, continued: one reading
 * column, day labels, and every transcript a row that opens in place with its
 * facts, Copy and Delete. Search lives in the head; Clear history in the
 * footer (HistoryFooter), which opens the confirmation this view renders.
 */
export function HistoryView({
  entries,
  enabled,
  status,
  query: controlledQuery,
  onQueryChange,
  clearOpen: controlledClearOpen,
  onClearOpenChange,
  now,
  onCopy,
  onDelete,
  onClear,
  onOpenDictate,
  onOpenSettings,
}: HistoryViewProps): ReactNode {
  const [ownQuery, setOwnQuery] = useState('')
  const [ownClearOpen, setOwnClearOpen] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [deleteEntry, setDeleteEntry] = useState<HistoryEntry | null>(null)
  const [copying, setCopying] = useState<{ id: string; done: boolean } | null>(null)
  const [copyProblem, setCopyProblem] = useState<string | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const toggleRefs = useRef(new Map<string, HTMLButtonElement>())
  const factsBase = useId()

  const query = controlledQuery ?? ownQuery
  const setQuery = (value: string): void => {
    setOwnQuery(value)
    onQueryChange?.(value)
  }
  const clearOpen = controlledClearOpen ?? ownClearOpen
  const setClearOpen = (open: boolean): void => {
    setOwnClearOpen(open)
    onClearOpenChange?.(open)
  }

  const clock = now ?? Date.now()
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const searching = normalizedQuery.length > 0
  const filtered = useMemo(() => [...entries]
    .sort((first, second) => second.createdAt - first.createdAt)
    .filter((entry) => !searching || entry.text.toLocaleLowerCase().includes(normalizedQuery)),
  [entries, normalizedQuery, searching])

  const groups = useMemo(() => {
    const result: DayGroup[] = []
    for (const entry of filtered) {
      const label = dayLabel(entry.createdAt, clock)
      const group = result.at(-1)
      if (group !== undefined && group.label === label) group.entries.push(entry)
      else result.push({ label, entries: [entry] })
    }
    return result
  }, [filtered, clock])

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

  const toggle = (entry: HistoryEntry): void => {
    setOpenId((current) => (current === entry.id ? null : entry.id))
  }

  const onRowKey = (event: KeyboardEvent<HTMLElement>, entry: HistoryEntry): void => {
    if (event.key !== 'Escape' || openId !== entry.id) return
    event.preventDefault()
    setOpenId(null)
    toggleRefs.current.get(entry.id)?.focus()
  }

  const total = entries.length
  const countText = searching
    ? `${filtered.length} of ${total}`
    : `${total} ${total === 1 ? 'transcript' : 'transcripts'}`

  let empty: { title: string; detail: string; action?: ReactNode; busy?: boolean } | null = null
  if (status === 'loading') empty = { title: 'Loading history.', detail: 'Your local transcripts are being read.', busy: true }
  else if (status === 'degraded') empty = { title: 'History could not be loaded.', detail: 'Dictation still works. Reopen Sotto to try reading local history again.' }
  else if (total === 0 && !enabled) {
    empty = {
      title: 'History is off.',
      detail: 'New transcripts are not being stored. Turn history back on in Settings.',
      action: onOpenSettings === undefined ? undefined : <Button variant="secondary" onClick={onOpenSettings}>Open settings</Button>,
    }
  } else if (total === 0) {
    empty = {
      title: 'Nothing here yet.',
      detail: 'Dictate something and it will be kept here, on this computer.',
      action: onOpenDictate === undefined ? undefined : <Button onClick={onOpenDictate}>Start dictation</Button>,
    }
  }
  const showHead = empty === null

  return (
    <div className="history-view">
      <section className="history-roll" aria-label="Transcript history" data-empty={empty === null ? undefined : 'true'}>
        <div className={showHead ? 'history-head' : 'tt-visually-hidden'}>
          <h1 ref={headingRef} tabIndex={-1} className="history-head__title">History</h1>
          {showHead ? (
            <>
              <small className="history-head__count" aria-live="polite">{countText}</small>
              <label className="history-find" data-filled={searching ? '1' : '0'}>
                <span className="tt-visually-hidden">Search transcripts</span>
                <Search size={16} aria-hidden="true" />
                <input
                  ref={searchRef}
                  className="history-find__input tt-focusable"
                  type="search"
                  value={query}
                  placeholder="Search transcripts"
                  onChange={(event) => setQuery(event.currentTarget.value)}
                />
                {searching ? (
                  <button
                    type="button"
                    className="history-find__clear tt-focusable"
                    aria-label="Clear search"
                    onClick={() => { setQuery(''); searchRef.current?.focus() }}
                  >
                    <X size={16} aria-hidden="true" />
                  </button>
                ) : null}
              </label>
            </>
          ) : null}
        </div>
        {copyProblem === null ? null : <p className="history-alert" role="alert">{copyProblem}</p>}
        {copying?.done ? <p className="tt-visually-hidden" role="status">Transcript copied.</p> : null}

        {empty !== null ? (
          <div className="history-empty" aria-busy={empty.busy ? 'true' : undefined}>
            <h2>{empty.title}</h2>
            <p>{empty.detail}</p>
            {empty.action}
          </div>
        ) : filtered.length === 0 ? (
          <div className="history-empty">
            <h2>Nothing matches &ldquo;{query.trim()}&rdquo;.</h2>
            <p>Try another word, or clear the search.</p>
          </div>
        ) : groups.map((group) => (
          <section key={group.label} className="history-day" aria-label={group.label}>
            <h2 className="history-day__label">{group.label}</h2>
            <ol className="history-list">
              {group.entries.map((entry) => {
                const stamp = clockLabel(entry.createdAt)
                const words = countWords(entry.text)
                const open = entry.id === openId
                const facts = open ? transcriptFacts(entry) : null
                const factsId = `${factsBase}-${entry.id}`
                const copyState = copying?.id === entry.id ? copying : null
                return (
                  <li key={entry.id}>
                    <article
                      className="history-entry"
                      aria-current={open ? 'true' : undefined}
                      onKeyDown={(event) => onRowKey(event, entry)}
                    >
                      <button
                        ref={(node) => { if (node === null) toggleRefs.current.delete(entry.id); else toggleRefs.current.set(entry.id, node) }}
                        type="button"
                        className="history-entry__toggle tt-focusable"
                        aria-expanded={open}
                        aria-controls={open ? factsId : undefined}
                        aria-label={`Transcript from ${stamp.full}, ${wordsLabel(words)}`}
                        onClick={() => toggle(entry)}
                      />
                      <div className="history-entry__when" aria-hidden="true">
                        <b>{stamp.dateTime === undefined ? stamp.time : <time dateTime={stamp.dateTime}>{stamp.time}</time>}</b>
                        {wordsLabel(words)}
                      </div>
                      <p className="history-entry__text">{entry.text}</p>
                      <Button
                        variant="secondary"
                        className="history-entry__copy"
                        aria-label="Copy transcript"
                        disabled={copyState !== null && !copyState.done}
                        onClick={() => void copy(entry)}
                      >
                        {copyState?.done ? 'Copied' : 'Copy'}
                      </Button>
                      {facts === null ? null : (
                        <>
                          <p className="history-entry__facts" id={factsId}><b>{facts.lead}</b> {facts.rest}</p>
                          <div className="history-entry__more">
                            <Button variant="danger" aria-label="Delete saved transcript" onClick={() => setDeleteEntry(entry)}>Delete</Button>
                          </div>
                        </>
                      )}
                    </article>
                  </li>
                )
              })}
            </ol>
          </section>
        ))}
      </section>

      {deleteEntry === null ? null : (
        <ConfirmationDialog
          title="Delete transcript?"
          description="This removes the transcript from this computer. It cannot be undone."
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
          description="This permanently removes every saved transcript from this computer. Your settings are unchanged."
          cancelLabel="Keep history"
          confirmLabel="Clear all transcripts"
          failureMessage="History could not be cleared. Your saved transcripts are unchanged."
          fallbackFocusRef={headingRef}
          onCancel={() => setClearOpen(false)}
          onConfirm={async () => {
            const cleared = await onClear().catch(() => false)
            if (cleared) setOpenId(null)
            return cleared
          }}
        />
      )}
    </div>
  )
}
