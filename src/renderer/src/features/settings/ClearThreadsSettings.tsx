import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ArchiveX } from 'lucide-react'
import { msg, plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import type { AgentCommand, AgentState } from '../../../../shared/agents'
import type { AppSettings, SettingsPatch } from '../../../../shared/settings'
import { CLEAR_SETTLED_THREADS_AFTER_DAYS, CLEAR_THREADS_AGES, threadClearKeptWords, type ClearSettledThreadsAfterDays, type ClearThreadsAge, type ThreadClearPreview } from '../../../../shared/threadClear'
import { useOptionalAgents } from '../../agents/AgentContext'
import { Button } from '../../components/Button'
import { ConfirmationDialog } from '../../components/ConfirmationDialog'
import { Field } from '../../components/Field'
import { SegmentedControl } from '../../components/SegmentedControl'
import { Select } from '../../components/Select'
import { shownWords, type LaterWords } from './laterWords'
import { SettingsGroup } from './SettingsGroup'
import '../../agents/threadClear.css'

type Command = (command: AgentCommand) => Promise<AgentState | null>

/** Clear now's ages, in the order offered: the days first, then any age (0). */
const AGES: readonly ClearThreadsAge[] = [...CLEAR_THREADS_AGES.filter(days => days > 0), 0]
const PREVIEW_FAILED = msg`Sotto could not list the settled threads. Nothing was deleted. Close this and try again.`
const CLEAR_UNCONFIRMED = msg`Sotto could not confirm the clear. Threads still listed under Settled were not deleted.`
const DAY_MS = 86_400_000

/** A number of days as a choice reads: "7 days". */
const daysWords = (days: number): string => plural(days, { one: '# day', other: '# days' })

/**
 * How long ago a thread went quiet, in the interface language (`Intl`, ADR-0123): "today", "yesterday", "41 days ago",
 * then months from 60 days and years from two.
 */
export function quietAgo(quietSince: string, now: number, locale: string): string {
  const days = Math.max(0, Math.floor((now - Date.parse(quietSince)) / DAY_MS))
  const words = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  if (!Number.isFinite(days) || days < 60) return words.format(Number.isFinite(days) ? -days : 0, 'day')
  if (days < 730) return words.format(-Math.round(days / 30), 'month')
  return words.format(-Math.floor(days / 365), 'year')
}

/** What a clear did, for the page's notice: how many went, and how many changed since the list and were kept. */
function clearedWords(cleared: number, changed: number): LaterWords {
  return changed === 0
    ? msg`${plural(cleared, { one: 'Cleared # thread.', other: 'Cleared # threads.' })}`
    : msg`${plural(cleared, { one: 'Cleared # thread.', other: 'Cleared # threads.' })} ${plural(changed, { one: '# thread changed since the list was made and was kept.', other: '# threads changed since the list was made and were kept.' })}`
}

/**
 * Settings → Threads, Clearing threads (ADR-0126; Owl only, Zach's pick C): Clear settled threads after, the rule that
 * clears on its own, and Clear now, which lists what would go before anything does. Both act on this computer's threads.
 */
export function ClearThreadsSettings({ settings, onSave, onNotice }: {
  readonly settings: AppSettings
  readonly onSave: (patch: SettingsPatch, successText?: LaterWords) => Promise<boolean>
  /** Says what a clear did on the page's own notice line. */
  readonly onNotice: (words: LaterWords) => void
}): ReactNode {
  const { t } = useLingui()
  const agents = useOptionalAgents()
  const [age, setAge] = useState<ClearThreadsAge>(30)
  const [open, setOpen] = useState(false)
  const opener = useRef<HTMLButtonElement>(null)
  const headingId = useId()
  const ageId = useId()
  const after = settings.clearSettledThreadsAfterDays
  return <SettingsGroup title={t`Clearing threads`} icon={ArchiveX} note={t`For settled threads on this computer. A cleared thread can’t be brought back.`}>
    <Field setting="clear-settled-threads-after" label={t`Clear settled threads after`}
      description={t`Deletes a settled thread’s history once it has been quiet this long. Never clears one with uncommitted work or an open pull request. Checked every hour.`}>
      <Select value={after === null ? 'never' : String(after)} onChange={event => {
        const value = event.currentTarget.value
        void onSave({ clearSettledThreadsAfterDays: value === 'never' ? null : Number(value) as NonNullable<ClearSettledThreadsAfterDays> })
      }}>
        <option value="never">{t`Never`}</option>
        {CLEAR_SETTLED_THREADS_AFTER_DAYS.map(days => <option key={days} value={String(days)}>{daysWords(days)}</option>)}
      </Select>
    </Field>
    <div className="thread-clear-now" role="group" aria-labelledby={headingId} data-setting="clear-threads-now">
      <div>
        <h3 id={headingId}><Trans>Clear now</Trans></h3>
        <p className="thread-clear-now__age tt-paragraph">
          <label htmlFor={ageId}><Trans>Settled threads on this computer quiet longer than</Trans></label>
          <Select id={ageId} value={String(age)} onChange={event => setAge(Number(event.currentTarget.value) as ClearThreadsAge)}>
            {AGES.map(days => <option key={days} value={String(days)}>{days === 0 ? t`any age` : daysWords(days)}</option>)}
          </Select>
        </p>
      </div>
      <Button ref={opener} variant="secondary" disabled={agents === null} onClick={() => setOpen(true)}><Trans>Clear now…</Trans></Button>
    </div>
    {open && agents ? <ClearThreadsDialog command={agents.command} age={age} onAge={setAge} fallbackFocusRef={opener}
      onCleared={onNotice} onClose={() => setOpen(false)} /> : null}
  </SettingsGroup>
}

/**
 * Clear settled threads (ADR-0126 decision 2): the age to clear past, the threads that go and the ones kept with why, and
 * what clearing keeps. Main makes both lists, and checks each thread again as it goes; one that changed is kept. Thread
 * titles and main's reasons are shown as written.
 */
export function ClearThreadsDialog({ command, age, onAge, onCleared, onClose, fallbackFocusRef, now = Date.now() }: {
  readonly command: Command
  readonly age: ClearThreadsAge
  readonly onAge: (age: ClearThreadsAge) => void
  readonly onCleared: (notice: LaterWords) => void
  readonly onClose: () => void
  readonly fallbackFocusRef?: React.RefObject<HTMLElement | null>
  readonly now?: number
}): ReactNode {
  const { t, i18n } = useLingui()
  const [preview, setPreview] = useState<ThreadClearPreview | null>(null)
  const [failure, setFailure] = useState<LaterWords | null>(null)
  const [clearError, setClearError] = useState<LaterWords | null>(null)
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
  const count = go.length
  const one = count === 1
  const folders = go.filter(item => item.removesWorktree).length
  const clear = async (): Promise<boolean> => {
    if (!preview || checking || go.length === 0) return false
    setClearError(null)
    const threadIds = go.map(item => item.threadId)
    const result = await command({ type: 'clear-threads', olderThanDays: preview.olderThanDays, threadIds }).catch(() => null)
    const outcome = result?.threadClearResult
    if (!result || result.error || !outcome) { setClearError(result?.error ?? CLEAR_UNCONFIRMED); return false }
    onCleared(clearedWords(outcome.cleared, outcome.kept.filter(item => threadIds.includes(item.threadId)).length))
    return true
  }
  return <ConfirmationDialog title={t`Clear settled threads`} danger {...(fallbackFocusRef ? { fallbackFocusRef } : {})}
    confirmLabel={count ? plural(count, { one: 'Clear # thread', other: 'Clear # threads' }) : t`Clear threads`} cancelLabel={t`Cancel`}
    confirmDisabled={checking || go.length === 0} pendingStatus={t`Clearing…`} failureMessage={shownWords(clearError ?? CLEAR_UNCONFIRMED)}
    description={<div className="thread-clear">
      <div className="thread-clear__age">
        <span aria-hidden="true"><Trans>Quiet longer than</Trans></span>
        <SegmentedControl label={t`Quiet longer than`} value={String(age)} onChange={value => onAge(Number(value) as ClearThreadsAge)}
          options={AGES.map(days => ({ value: String(days), label: days === 0 ? t`Any age` : daysWords(days) }))} />
      </div>
      {failure ? <p className="tt-paragraph" role="alert">{shownWords(failure)}</p> : null}
      {!preview && checking ? <p className="tt-paragraph" role="status"><Trans>Checking settled threads…</Trans></p> : null}
      {preview && !failure ? <div className={checking ? 'thread-clear__stale' : undefined} aria-busy={checking || undefined}>
        {go.length ? <>
          <h3 className="thread-clear__heading">{plural(count, { one: '# thread goes', other: '# threads go' })}</h3>
          <ul className="thread-clear__list" aria-label={t`Threads that go`}>{go.map(item => <li key={item.threadId}>
            <span className="thread-clear__title" title={item.title}>{item.title || t`Untitled thread`}</span>
            <span className="thread-clear__note">{quietAgo(item.quietSince, now, i18n.locale)}</span>
          </li>)}</ul>
        </> : <p className="tt-paragraph">{kept.length ? t`None of them can go yet.` : t`No settled thread on this computer has been quiet that long.`}</p>}
        {kept.length ? <>
          <h3 className="thread-clear__heading"><Trans>Kept</Trans></h3>
          <ul className="thread-clear__list thread-clear__list--kept" aria-label={t`Threads kept`}>{kept.map(item => <li key={item.threadId}>
            <span className="thread-clear__title" title={item.title}>{item.title || t`Untitled thread`}</span>
            <span className="thread-clear__note">{threadClearKeptWords(item.reason)}</span>
          </li>)}</ul>
        </> : null}
        {go.length ? <ul className="thread-clear__facts tt-paragraph">
          <li>{one ? t`Its messages and activity leave Sotto and can’t be brought back.` : t`Their messages and activity leave Sotto and can’t be brought back.`}</li>
          {folders ? <li>{one ? t`Removes the worktree folder it made. Its branch and commits stay.`
            : plural(folders, { one: 'Removes the one worktree folder these threads made. Branches and their commits stay.', other: 'Removes the # worktree folders these threads made. Branches and their commits stay.' })}</li> : null}
          <li>{one ? t`Usage keeps its numbers. Its provider keeps its own copy of the session.` : t`Usage keeps its numbers. Providers keep their own copies of the sessions.`}</li>
        </ul> : null}
      </div> : null}
    </div>}
    onConfirm={clear} onCancel={onClose} />
}
