import React, { useMemo, useRef, useState, type ReactNode } from 'react'
import { Clipboard, Search, Trash2 } from 'lucide-react'

import type { HistoryEntry } from '../../../../shared/history'
import { MODEL_CATALOG } from '../../../../shared/modelCatalog'
import { Button } from '../../components/Button'
import { ConfirmationDialog } from '../../components/ConfirmationDialog'
import { languageLabel } from '../../languages'
import type { HistoryStatus } from '../../state/AppContext'

export interface HistoryViewProps {
  readonly entries: readonly HistoryEntry[]
  readonly enabled: boolean
  readonly status: HistoryStatus
  /** Controlled search text, when the titlebar owns it; otherwise the view keeps its own. */
  readonly query?: string | undefined
  readonly onQueryChange?: ((query: string) => void) | undefined
  readonly onCopy: (text: string) => Promise<boolean>
  readonly onDelete: (id: string) => Promise<boolean>
  readonly onClear: () => Promise<boolean>
}

const DAY_MS = 86_400_000

/**
 * The roll stamp is split into a date line and a 24-hour clock line rather
 * than one long locale string. `full` stays on the element as its accessible
 * name, so assistive tech still hears the whole date.
 */
function timestamp(createdAt: number): { dateTime?: string; date: string; time: string; full: string } {
  const date = new Date(createdAt)
  if (!Number.isFinite(date.valueOf())) return { date: 'Saved', time: 'transcript', full: 'Saved transcript' }
  return {
    dateTime: date.toISOString(),
    date: date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    time: date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
    full: date.toLocaleString(),
  }
}

/** Roll headers: Today, Yesterday, then the weekday and date. */
function dayLabel(createdAt: number, now: number): string {
  const date = new Date(createdAt)
  if (!Number.isFinite(date.valueOf())) return 'Saved'
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  if (createdAt >= startOfToday.valueOf()) return 'Today'
  if (createdAt >= startOfToday.valueOf() - DAY_MS) return 'Yesterday'
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
}

/** Older entries may carry presets the catalog no longer lists. */
function modelLabel(preset: HistoryEntry['modelPreset']): string {
  return preset in MODEL_CATALOG ? MODEL_CATALOG[preset as keyof typeof MODEL_CATALOG].label : 'Whisper'
}

function countWords(text: string): number {
  const trimmed = text.trim()
  return trimmed === '' ? 0 : trimmed.split(/\s+/u).length
}

function lengthLabel(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1_000))
  if (seconds < 60) return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`
}

function wordsLabel(entry: HistoryEntry): string {
  const words = countWords(entry.text)
  const minutes = entry.durationMs / 60_000
  return minutes > 0 && words > 0 ? `${words}, at ${Math.round(words / minutes)} wpm` : String(words)
}

/**
 * History as a roll and a reading pane: the roll lists every transcript under
 * day headers, the pane shows the selected one at reading size with its
 * facts. Copy and delete live in both places, so a transcript can be handled
 * without leaving the roll.
 */
export function HistoryView({
  entries,
  enabled,
  status,
  query: controlledQuery,
  onQueryChange,
  onCopy,
  onDelete,
  onClear,
}: HistoryViewProps): ReactNode {
  const [ownQuery, setOwnQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [deleteEntry, setDeleteEntry] = useState<HistoryEntry | null>(null)
  const [clearOpen, setClearOpen] = useState(false)
  const [copyingId, setCopyingId] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const query = controlledQuery ?? ownQuery
  const setQuery = (value: string): void => {
    setOwnQuery(value)
    onQueryChange?.(value)
  }
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filtered = useMemo(() => [...entries]
    .sort((first, second) => second.createdAt - first.createdAt)
    .filter((entry) => normalizedQuery.length === 0 || entry.text.toLocaleLowerCase().includes(normalizedQuery)),
  [entries, normalizedQuery])
  const selected = filtered.find((entry) => entry.id === selectedId) ?? filtered[0]
  const now = Date.now()

  const copy = async (entry: HistoryEntry): Promise<void> => {
    if (copyingId !== null) return
    setCopyingId(entry.id)
    const copied = await onCopy(entry.text).catch(() => false)
    setNotice(copied
      ? { text: 'Transcript copied. Paste it wherever you need it.', error: false }
      : { text: 'Transcript could not be copied. Try again.', error: true })
    setCopyingId(null)
  }

  let body: ReactNode
  if (status === 'loading') body = <div className="management-empty" aria-busy="true"><h2>Loading transcript history...</h2><p>Your local data is being prepared.</p></div>
  else if (status === 'degraded') body = <div className="management-empty"><h2>History could not be loaded</h2><p>Dictation still works. Reopen Sotto to try loading local history again.</p></div>
  else if (entries.length === 0) body = <div className="management-empty"><h2>{enabled ? 'No saved transcripts yet' : 'History is turned off'}</h2><p>{enabled ? 'Your newest dictations will appear here when history is enabled.' : 'New transcripts are not stored. You can turn local history back on in Settings.'}</p></div>
  else {
    const groups: Array<{ label: string; entries: HistoryEntry[] }> = []
    for (const entry of filtered) {
      const label = dayLabel(entry.createdAt, now)
      const group = groups.at(-1)
      if (group !== undefined && group.label === label) group.entries.push(entry)
      else groups.push({ label, entries: [entry] })
    }
    body = (
      <div className="history-split">
        <div className="history-roll">
          <div className="history-toolbar">
            <label className="history-search">
              <span className="tt-visually-hidden">Search transcripts</span>
              <Search size={14} aria-hidden="true" />
              <input className="tt-input tt-focusable" type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder={`Search ${entries.length} ${entries.length === 1 ? 'transcript' : 'transcripts'}`} />
            </label>
            <Button variant="danger" onClick={() => setClearOpen(true)}>Clear history</Button>
          </div>
          {filtered.length === 0
            ? <div className="management-empty"><h2>No transcripts match that search</h2><p>Try a different word or clear the search.</p></div>
            : groups.map((group) => (
              <React.Fragment key={group.label}>
                <p className="history-day tt-instrument">{group.label}</p>
                <ol className="history-list">
                  {group.entries.map((entry) => {
                    const stamp = timestamp(entry.createdAt)
                    const current = entry.id === selected?.id
                    return (
                      <li key={entry.id}>
                        <article className="history-entry" aria-current={current ? 'true' : undefined}>
                          <button
                            type="button"
                            className="history-entry__select tt-focusable"
                            aria-label={`Show transcript from ${stamp.full}`}
                            aria-pressed={current}
                            onClick={() => setSelectedId(entry.id)}
                          />
                          <div className="history-entry__meta">
                            <time aria-label={stamp.full} {...(stamp.dateTime === undefined ? {} : { dateTime: stamp.dateTime })}>
                              <span>{stamp.date}</span>
                              <span>{stamp.time}</span>
                            </time>
                          </div>
                          <p>{entry.text}</p>
                          <div className="history-entry__actions">
                            <Button variant="ghost" iconOnly disabled={copyingId !== null} aria-label="Copy transcript" onClick={() => void copy(entry)}><Clipboard size={14} aria-hidden="true" /></Button>
                            <Button variant="ghost" iconOnly aria-label="Delete saved transcript" onClick={() => setDeleteEntry(entry)}><Trash2 size={14} aria-hidden="true" /></Button>
                          </div>
                        </article>
                      </li>
                    )
                  })}
                </ol>
              </React.Fragment>
            ))}
        </div>
        {selected === undefined ? <div className="history-detail" /> : (() => {
          const stamp = timestamp(selected.createdAt)
          return (
            <article className="history-detail" aria-label={`Transcript from ${stamp.full}`}>
              <div className="history-detail__header">
                <h2>{dayLabel(selected.createdAt, now)}, {stamp.time}<span>{languageLabel(selected.language)} · {modelLabel(selected.modelPreset)}</span></h2>
                <div className="history-detail__actions">
                  <Button variant="secondary" disabled={copyingId !== null} aria-label="Copy transcript" onClick={() => void copy(selected)}><Clipboard size={14} aria-hidden="true" />Copy</Button>
                  <Button variant="danger" aria-label="Delete saved transcript" onClick={() => setDeleteEntry(selected)}><Trash2 size={14} aria-hidden="true" />Delete</Button>
                </div>
              </div>
              <p className="history-detail__text">{selected.text}</p>
              <dl className="history-meta">
                <div><dt>Length</dt><dd>{lengthLabel(selected.durationMs)}</dd></div>
                <div><dt>Words</dt><dd>{wordsLabel(selected)}</dd></div>
                <div><dt>Language</dt><dd>{languageLabel(selected.language)}</dd></div>
                <div><dt>Model</dt><dd>{modelLabel(selected.modelPreset)}, on device</dd></div>
                <div><dt>Saved</dt><dd>{stamp.full}</dd></div>
                <div><dt>Kept</dt><dd>On this computer only</dd></div>
              </dl>
            </article>
          )
        })()}
      </div>
    )
  }

  return (
    <div className="management-view history-view">
      <h1 ref={headingRef} tabIndex={-1} className="tt-visually-hidden">History</h1>
      {!enabled && status === 'ready' && entries.length > 0 ? <p className="history-privacy-notice">History is turned off. Existing local transcripts remain available until you clear them.</p> : null}
      {notice === null ? null : <p className="history-notice" role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
      {body}
      {deleteEntry === null ? null : (
        <ConfirmationDialog
          title="Delete transcript?"
          description="This removes the selected transcript from this computer. It cannot be undone."
          cancelLabel="Keep transcript"
          confirmLabel="Delete transcript"
          failureMessage="Transcript could not be deleted. Try again or keep the transcript."
          fallbackFocusRef={headingRef}
          onCancel={() => setDeleteEntry(null)}
          onConfirm={async () => {
            const removed = await onDelete(deleteEntry.id).catch(() => false)
            setNotice(removed ? { text: 'Transcript deleted.', error: false } : { text: 'Transcript could not be deleted.', error: true })
            return removed
          }}
        />
      )}
      {!clearOpen ? null : (
        <ConfirmationDialog
          title="Clear history?"
          description="This permanently removes every saved transcript from this computer. Your settings and downloaded models are unchanged."
          cancelLabel="Keep history"
          confirmLabel="Clear all transcripts"
          failureMessage="History could not be cleared. Your saved transcripts are unchanged."
          fallbackFocusRef={headingRef}
          onCancel={() => setClearOpen(false)}
          onConfirm={async () => {
            const cleared = await onClear().catch(() => false)
            setNotice(cleared ? { text: 'Transcript history cleared.', error: false } : { text: 'History could not be cleared.', error: true })
            return cleared
          }}
        />
      )}
    </div>
  )
}
