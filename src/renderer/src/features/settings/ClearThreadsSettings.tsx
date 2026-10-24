import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ArchiveX } from 'lucide-react'
import type { AgentCommand, AgentState } from '../../../../shared/agents'
import type { AppSettings, SettingsPatch } from '../../../../shared/settings'
import { CLEAR_SETTLED_THREADS_AFTER_DAYS, threadClearKeptWords, type ClearSettledThreadsAfterDays, type ClearThreadsAge, type ThreadClearPreview } from '../../../../shared/threadClear'
import { useOptionalAgents } from '../../agents/AgentContext'
import { Button } from '../../components/Button'
import { ConfirmationDialog } from '../../components/ConfirmationDialog'
import { Field } from '../../components/Field'
import { SegmentedControl } from '../../components/SegmentedControl'
import { Select } from '../../components/Select'
import { SettingsGroup } from './SettingsGroup'
import '../../agents/threadClear.css'

type Command = (command: AgentCommand) => Promise<AgentState | null>

/** Clear now's ages, in the order offered; 0 is any age. */
const AGES: readonly { readonly days: ClearThreadsAge; readonly label: string }[] = [
  { days: 7, label: '7 days' }, { days: 30, label: '30 days' }, { days: 90, label: '90 days' }, { days: 0, label: 'Any age' },
]
const PREVIEW_FAILED = 'Sotto could not list the settled threads. Nothing was deleted. Close this and try again.'
const CLEAR_UNCONFIRMED = 'Sotto could not confirm the clear. Threads still listed under Settled were not deleted.'
const DAY_MS = 86_400_000

/** How long ago a thread went quiet, as the list says it: "today", "41 days ago", "2 months ago". */
export function quietAgo(quietSince: string, now: number): string {
  const days = Math.floor((now - Date.parse(quietSince)) / DAY_MS)
  if (!Number.isFinite(days) || days < 1) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 60) return `${days} days ago`
  if (days < 730) return `${Math.round(days / 30)} months ago`
  return `${Math.floor(days / 365)} years ago`
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/**
 * Settings → Threads, Clearing threads (ADR-0126; Owl only, Zach's pick C): Clear settled threads after, the rule that
 * clears on its own, and Clear now, which lists what would go before anything does. Both act on this computer's threads.
 */
export function ClearThreadsSettings({ settings, onSave, onNotice }: {
  readonly settings: AppSettings
  readonly onSave: (patch: SettingsPatch, successText?: string) => Promise<boolean>
  /** Says what a clear did on the page's own notice line. */
  readonly onNotice: (text: string) => void
}): ReactNode {
  const agents = useOptionalAgents()
  const [age, setAge] = useState<ClearThreadsAge>(30)
  const [open, setOpen] = useState(false)
  const opener = useRef<HTMLButtonElement>(null)
  const headingId = useId()
  const ageId = useId()
  const after = settings.clearSettledThreadsAfterDays
  return <SettingsGroup title="Clearing threads" icon={ArchiveX} note="For settled threads on this computer. A cleared thread can’t be brought back.">
    <Field label="Clear settled threads after" description="Deletes a settled thread’s history once it has been quiet this long. Never clears one with uncommitted work or an open pull request. Checked every hour.">
      <Select value={after === null ? 'never' : String(after)} onChange={event => {
        const value = event.currentTarget.value
        void onSave({ clearSettledThreadsAfterDays: value === 'never' ? null : Number(value) as NonNullable<ClearSettledThreadsAfterDays> })
      }}>
        <option value="never">Never</option>
        {CLEAR_SETTLED_THREADS_AFTER_DAYS.map(days => <option key={days} value={String(days)}>{days} days</option>)}
      </Select>
    </Field>
    <div className="thread-clear-now" role="group" aria-labelledby={headingId}>
      <div>
        <h3 id={headingId}>Clear now</h3>
        <p className="thread-clear-now__age">
          <label htmlFor={ageId}>Settled threads on this computer quiet longer than</label>
          <Select id={ageId} value={String(age)} onChange={event => setAge(Number(event.currentTarget.value) as ClearThreadsAge)}>
            {AGES.map(item => <option key={item.days} value={String(item.days)}>{item.days === 0 ? 'any age' : item.label}</option>)}
          </Select>
        </p>
      </div>
      <Button ref={opener} variant="secondary" disabled={agents === null} onClick={() => setOpen(true)}>Clear now…</Button>
    </div>
    {open && agents ? <ClearThreadsDialog command={agents.command} age={age} onAge={setAge} fallbackFocusRef={opener}
      onCleared={onNotice} onClose={() => setOpen(false)} /> : null}
  </SettingsGroup>
}

/**
 * Clear settled threads (ADR-0126 decision 2): the age to clear past, the threads that go and the ones kept with why, and
 * what clearing keeps. Main makes both lists, and checks each thread again as it goes; one that changed is kept.
 */
export function ClearThreadsDialog({ command, age, onAge, onCleared, onClose, fallbackFocusRef, now = Date.now() }: {
  readonly command: Command
  readonly age: ClearThreadsAge
  readonly onAge: (age: ClearThreadsAge) => void
  readonly onCleared: (notice: string) => void
  readonly onClose: () => void
  readonly fallbackFocusRef?: React.RefObject<HTMLElement | null>
  readonly now?: number
}): ReactNode {
  const [preview, setPreview] = useState<ThreadClearPreview | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [clearError, setClearError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    setFailure(null)
    void command({ type: 'preview-clear-threads', olderThanDays: age }).then(result => {
      if (!active) return
      if (result?.error || !result?.threadClearPreview) setFailure(result?.error ?? PREVIEW_FAILED)
      else setPreview(result.threadClearPreview)
    }).catch(() => { if (active) setFailure(PREVIEW_FAILED) })
    return () => { active = false }
  }, [command, age])
  // The last list stays on screen, dimmed, while the next age is checked, so the dialog does not jump.
  const checking = failure === null && preview?.olderThanDays !== age
  const go = preview?.go ?? []
  const kept = preview?.kept ?? []
  const one = go.length === 1
  const folders = go.filter(item => item.removesWorktree).length
  const clear = async (): Promise<boolean> => {
    if (!preview || checking || go.length === 0) return false
    setClearError(null)
    const threadIds = go.map(item => item.threadId)
    const result = await command({ type: 'clear-threads', olderThanDays: preview.olderThanDays, threadIds }).catch(() => null)
    const outcome = result?.threadClearResult
    if (!result || result.error || !outcome) { setClearError(result?.error ?? CLEAR_UNCONFIRMED); return false }
    // A thread that changed between the list and the press is kept, and the notice says how many.
    const changed = outcome.kept.filter(item => threadIds.includes(item.threadId)).length
    onCleared(`Cleared ${count(outcome.cleared, 'thread', 'threads')}.${changed ? ` ${count(changed, 'thread', 'threads')} changed since the list was made and ${changed === 1 ? 'was' : 'were'} kept.` : ''}`)
    return true
  }
  return <ConfirmationDialog title="Clear settled threads" danger {...(fallbackFocusRef ? { fallbackFocusRef } : {})}
    confirmLabel={go.length ? `Clear ${count(go.length, 'thread', 'threads')}` : 'Clear threads'} cancelLabel="Cancel"
    confirmDisabled={checking || go.length === 0} pendingStatus="Clearing…" failureMessage={clearError ?? CLEAR_UNCONFIRMED}
    description={<div className="thread-clear">
      <div className="thread-clear__age">
        <span aria-hidden="true">Quiet longer than</span>
        <SegmentedControl label="Quiet longer than" value={String(age)} onChange={value => onAge(Number(value) as ClearThreadsAge)}
          options={AGES.map(item => ({ value: String(item.days), label: item.label }))} />
      </div>
      {failure ? <p role="alert">{failure}</p> : null}
      {!preview && checking ? <p role="status">Checking settled threads…</p> : null}
      {preview && !failure ? <div className={checking ? 'thread-clear__stale' : undefined} aria-busy={checking || undefined}>
        {go.length ? <>
          <h3 className="thread-clear__heading">{count(go.length, 'thread goes', 'threads go')}</h3>
          <ul className="thread-clear__list" aria-label="Threads that go">{go.map(item => <li key={item.threadId}>
            <span className="thread-clear__title" title={item.title}>{item.title || 'Untitled thread'}</span>
            <span className="thread-clear__note">{quietAgo(item.quietSince, now)}</span>
          </li>)}</ul>
        </> : <p>{kept.length ? 'None of them can go yet.' : 'No settled thread on this computer has been quiet that long.'}</p>}
        {kept.length ? <>
          <h3 className="thread-clear__heading">Kept</h3>
          <ul className="thread-clear__list thread-clear__list--kept" aria-label="Threads kept">{kept.map(item => <li key={item.threadId}>
            <span className="thread-clear__title" title={item.title}>{item.title || 'Untitled thread'}</span>
            <span className="thread-clear__note">{threadClearKeptWords(item.reason)}</span>
          </li>)}</ul>
        </> : null}
        {go.length ? <ul className="thread-clear__facts">
          <li>{one ? 'Its' : 'Their'} messages and activity leave Sotto and can’t be brought back.</li>
          {folders ? <li>{one ? 'Removes the worktree folder it made. Its branch and commits stay.'
            : `Removes ${folders === 1 ? 'the one worktree folder' : `the ${folders} worktree folders`} these threads made. Branches and their commits stay.`}</li> : null}
          <li>Usage keeps its numbers. {one ? 'Its provider keeps its own copy of the session.' : 'Providers keep their own copies of the sessions.'}</li>
        </ul> : null}
      </div> : null}
    </div>}
    onConfirm={clear} onCancel={onClose} />
}
