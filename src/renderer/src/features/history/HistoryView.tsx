import React, { useMemo, useState, type ReactNode } from 'react'
import { Clipboard, Search, Trash2 } from 'lucide-react'

import type { HistoryEntry } from '../../../../shared/history'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { ConfirmationDialog } from '../../components/ConfirmationDialog'
import type { HistoryStatus } from '../../state/AppContext'

export interface HistoryViewProps {
  readonly entries: readonly HistoryEntry[]
  readonly enabled: boolean
  readonly status: HistoryStatus
  readonly onCopy: (text: string) => Promise<boolean>
  readonly onDelete: (id: string) => Promise<boolean>
  readonly onClear: () => Promise<boolean>
}

function accessibleExcerpt(text: string): string {
  const normalized = text.replace(/\s+/gu, ' ').trim()
  return normalized.length <= 48 ? normalized : `${normalized.slice(0, 45)}...`
}

function timestamp(createdAt: number): { dateTime?: string; label: string } {
  const date = new Date(createdAt)
  if (!Number.isFinite(date.valueOf())) return { label: 'Saved transcript' }
  return { dateTime: date.toISOString(), label: date.toLocaleString() }
}

export function HistoryView({ entries, enabled, status, onCopy, onDelete, onClear }: HistoryViewProps): ReactNode {
  const [query, setQuery] = useState('')
  const [deleteEntry, setDeleteEntry] = useState<HistoryEntry | null>(null)
  const [clearOpen, setClearOpen] = useState(false)
  const [copyingId, setCopyingId] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filtered = useMemo(() => entries.filter((entry) => (
    normalizedQuery.length === 0 || entry.text.toLocaleLowerCase().includes(normalizedQuery)
  )), [entries, normalizedQuery])

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
  else if (status === 'degraded') body = <div className="management-empty"><h2>History could not be loaded</h2><p>Dictation still works. Reopen TalkType to try loading local history again.</p></div>
  else if (entries.length === 0) body = <div className="management-empty"><h2>{enabled ? 'No saved transcripts yet' : 'History is turned off'}</h2><p>{enabled ? 'Your newest dictations will appear here when history is enabled.' : 'New transcripts are not stored. You can turn local history back on in Settings.'}</p></div>
  else if (filtered.length === 0) body = <div className="management-empty"><h2>No transcripts match that search</h2><p>Try a different word or clear the search.</p></div>
  else body = (
    <ol className="history-list">
      {filtered.map((entry) => (
        <li key={entry.id}>
          <Card as="article" className="history-entry">
            <div className="history-entry__meta">
              {(() => { const value = timestamp(entry.createdAt); return <time {...(value.dateTime === undefined ? {} : { dateTime: value.dateTime })}>{value.label}</time> })()}
              <span>{entry.language.slice(0, 12).toUpperCase()} / {entry.modelPreset}</span>
            </div>
            <p>{entry.text}</p>
            <div className="history-entry__actions">
              <Button variant="secondary" disabled={copyingId !== null} aria-label={`Copy ${accessibleExcerpt(entry.text)}`} onClick={() => void copy(entry)}><Clipboard size={16} />Copy</Button>
              <Button variant="ghost" aria-label={`Delete ${accessibleExcerpt(entry.text)}`} onClick={() => setDeleteEntry(entry)}><Trash2 size={16} />Delete</Button>
            </div>
          </Card>
        </li>
      ))}
    </ol>
  )

  return (
    <div className="management-view history-view">
      <header className="management-view__header">
        <div><p className="management-eyebrow">Local only</p><h1>History</h1><p>Search, copy, or remove transcripts stored on this computer.</p></div>
        {status === 'ready' && entries.length > 0 ? <Button variant="danger" onClick={() => setClearOpen(true)}>Clear history</Button> : null}
      </header>
      {!enabled && status === 'ready' && entries.length > 0 ? <p className="history-privacy-notice">History is turned off. Existing local transcripts remain available until you clear them.</p> : null}
      {status === 'ready' && entries.length > 0 ? (
        <label className="history-search">
          <span className="tt-visually-hidden">Search transcripts</span>
          <Search size={18} aria-hidden="true" />
          <input className="tt-input tt-focusable" type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Search transcripts" />
        </label>
      ) : null}
      {notice === null ? null : <p className="history-notice" role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
      {body}
      {deleteEntry === null ? null : (
        <ConfirmationDialog
          title="Delete transcript?"
          description="This removes the selected transcript from this computer. It cannot be undone."
          cancelLabel="Keep transcript"
          confirmLabel="Delete transcript"
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
