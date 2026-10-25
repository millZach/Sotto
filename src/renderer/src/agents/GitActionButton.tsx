import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { msg, ph, plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { ArrowDownToLine, ArrowUpFromLine, ChevronDown, FolderGit2, GitBranch, GitCommitHorizontal, GitPullRequestArrow, RefreshCw, Upload, X } from 'lucide-react'
import type { AgentState, AgentThread } from '../../../shared/agents'
import type { GitStackedAction } from '../../../shared/gitActions'
import type { GitChangedFile, GitChangedFiles } from '../../../shared/gitChangedFiles'
import type { GitStatus } from '../../../shared/gitStatus'
import { Button } from '../components/Button'
import { useDialogFocus } from '../components/useDialogFocus'
import { useOptionalApp } from '../state/AppContext'
import { chordClaimed, chordMatches } from './branchToolbar.logic'
import type { AgentConnection } from './AgentContext'
import { PaneMenu, type PaneMenuItem } from './PaneMenu'
import { commitLabel, commits, defaultBranchQuestion, fileCount, lineCounts, menuEntries, needsDefaultBranchConfirmation, noticeFor, quickAction, stackedFor, STATUS_LETTER, type GitNotice, type GitQuickKind } from './gitActionButton.logic'
import { leftToRight, shownWords, type LaterWords } from './interfaceWords'
import { shownCount } from '../state/interfaceNumbers'
import './gitActionButton.css'

type Command = AgentConnection['command']

/** The bridge call the dialog reads the changed files through; absent in a window without the preload. */
function changedFilesBridge(): ((request: { threadId: string }) => Promise<GitChangedFiles>) | undefined {
  return window.sotto?.agents?.gitChangedFiles
}

/** The glyph for each action, on the button and in its menu. */
const ICONS: Record<GitQuickKind, typeof GitCommitHorizontal> = {
  commit: GitCommitHorizontal, commit_push: GitCommitHorizontal, commit_push_pr: GitCommitHorizontal,
  push: ArrowUpFromLine, push_pr: ArrowUpFromLine, pull: ArrowDownToLine, create_pr: GitPullRequestArrow, view_pr: GitPullRequestArrow,
  publish: Upload, sync: RefreshCw, init: FolderGit2,
}

interface ActionRequest {
  readonly action: GitStackedAction
  readonly commitMessage?: string
  readonly filePaths?: readonly string[]
  readonly featureBranch?: boolean
  readonly allowDefaultBranch?: boolean
}
type Dialog = { readonly kind: 'commit'; readonly action: GitStackedAction } | { readonly kind: 'confirm'; readonly request: ActionRequest } | { readonly kind: 'publish' }

/**
 * T3's Git action in the pane header (ADR-0027): one button whose label follows the folder's status and
 * does what it says, a chevron menu with every action, the commit dialog, the default-branch question,
 * and one notice above the composer for the action as it runs and once it is over. Every action goes to
 * the host as a command; the record the host publishes is what the notice shows.
 */
export function GitActionButton({ thread, command, noticeSlot, onExplainedError }: {
  readonly thread: AgentThread
  readonly command: Command
  /** Where the notice is drawn: above the composer, in the pane's own flow. */
  readonly noticeSlot: HTMLElement | null
  /** The refusal the notice is showing, so the pane's own error line does not say it twice; null when none. */
  readonly onExplainedError?: ((error: string | null) => void) | undefined
}): ReactNode {
  const { t } = useLingui()
  const status = thread.worktree?.git
  const [dialog, setDialog] = useState<Dialog | null>(null)
  // This pane's own notice: Sotto's words kept as messages and read when shown, the host's as written.
  const [local, setLocal] = useState<LocalNotice | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [inFlight, setInFlight] = useState(false)
  const flight = useRef(false)
  useEffect(() => { setDialog(null); setLocal(null); setDismissed(null) }, [thread.id])
  const explained = useRef(onExplainedError)
  explained.current = onExplainedError
  const progress = thread.gitAction
  const shown: GitNotice | null = local ? shownNotice(local) : progress && progress.actionId !== dismissed ? noticeFor(progress) : null
  const explainedError = shown?.tone === 'error' ? shown.detail ?? shown.title : null
  useEffect(() => { explained.current?.(explainedError) }, [explainedError])
  useEffect(() => () => explained.current?.(null), [])
  const running = progress?.status === 'running' || inFlight
  const quick = quickAction(status)

  /** One command at a time from this pane; the answer, or the refusal in the host's words, becomes the notice. */
  const send = async (request: Parameters<Command>[0], onDone: (result: AgentState) => void, onRefused?: (result: AgentState) => boolean): Promise<void> => {
    if (flight.current) return
    flight.current = true; setInFlight(true); setLocal(null)
    try {
      const result = await command(request)
      if (!result) setLocal({ tone: 'error', title: ACTION_FAILED, detail: UNCONFIRMED_GIT_COMMAND })
      else if (result.error) { if (!onRefused?.(result)) setLocal({ tone: 'error', title: ACTION_FAILED, detail: result.error }) }
      else onDone(result)
    } catch { setLocal({ tone: 'error', title: ACTION_FAILED, detail: UNCONFIRMED_GIT_COMMAND }) }
    finally { flight.current = false; setInFlight(false) }
  }
  const runAction = (request: ActionRequest): void => {
    if (needsDefaultBranchConfirmation(status, request.action, request.featureBranch === true) && request.allowDefaultBranch !== true) { setDialog({ kind: 'confirm', request }); return }
    setDismissed(null)
    const actionId = crypto.randomUUID()
    void send({ type: 'git-action', threadId: thread.id, actionId, action: request.action,
      ...(request.commitMessage ? { commitMessage: request.commitMessage } : {}), ...(request.filePaths ? { filePaths: [...request.filePaths] } : {}),
      ...(request.featureBranch ? { featureBranch: true } : {}), ...(request.allowDefaultBranch ? { allowDefaultBranch: true } : {}) },
    () => undefined,
    // A refusal the host wrote onto the record shows from the record, once; only one it could not write (the lane was busy) is the command's own.
    result => result.host.threads.find(item => item.id === thread.id)?.gitAction?.actionId === actionId)
  }
  const openPullRequest = (): void => { const url = status?.pullRequest?.url; if (url) void window.sotto?.openExternalLink?.(url) }
  const press = (kind: GitQuickKind | 'view_pr'): void => {
    switch (kind) {
      case 'view_pr': openPullRequest(); return
      case 'pull': void send({ type: 'git-pull', threadId: thread.id }, result => setLocal({ tone: 'success', title: result.notice ?? msg({ message: 'Pulled', comment: 'A Git pull finished.' }) })); return
      case 'init': void send({ type: 'git-init', threadId: thread.id }, result => setLocal({ tone: 'success', title: result.notice ?? msg`Git initialized.` })); return
      case 'publish': setDialog({ kind: 'publish' }); return
      case 'sync': return
      default: {
        const action = stackedFor(kind)
        if (!action) return
        if (commits(action)) setDialog({ kind: 'commit', action })
        else runAction({ action })
      }
    }
  }
  const menu: PaneMenuItem[] = menuEntries(status).map(entry => {
    const EntryIcon = ICONS[entry.id]
    return { id: entry.id, label: entry.label, disabled: running || entry.hint !== undefined, ...(entry.hint ? { hint: entry.hint } : {}), icon: <EntryIcon size={15} aria-hidden="true" />, run: () => press(entry.id) }
  })

  const notice = shown ? <GitActionNotice notice={shown} running={running}
    onDismiss={() => { if (local) setLocal(null); else if (progress) setDismissed(progress.actionId) }}
    onRun={action => runAction({ action })} /> : null
  const Icon = quick ? ICONS[quick.kind] : null
  const disabled = running || quick?.hint !== undefined
  return <>
    {/* The button waits for the host's read of the folder; a notice or a dialog already open does not. */}
    {status && quick && Icon ? <div className="git-action" data-running={running || undefined}>
      <button type="button" className="git-action__quick tt-focusable" title={quick.hint ?? quick.label} aria-disabled={disabled || undefined} disabled={running}
        onClick={() => { if (!disabled) press(quick.kind) }}>
        <Icon size={15} aria-hidden="true" />
        <span className="git-action__label">{quick.label}</span>
        {quick.hint ? <span className="tt-visually-hidden">. {quick.hint}</span> : null}
      </button>
      {menu.length > 0 ? <PaneMenu groups={[menu]} label={t`More Git actions`} className="git-action__more" icon={<ChevronDown size={14} aria-hidden="true" />} /> : null}
    </div> : null}
    {noticeSlot && notice ? createPortal(notice, noticeSlot) : notice}
    {dialog?.kind === 'commit' && status ? <CommitDialog threadId={thread.id} status={status} action={dialog.action} onCancel={() => setDialog(null)}
      onCommit={(request) => { setDialog(null); runAction(request) }} /> : null}
    {dialog?.kind === 'confirm' && status ? <DefaultBranchDialog status={status} request={dialog.request} onCancel={() => setDialog(null)}
      onPush={() => { const request = dialog.request; setDialog(null); runAction({ ...request, allowDefaultBranch: true }) }}
      onFeatureBranch={() => { const request = dialog.request; setDialog(null); runAction({ ...request, featureBranch: true }) }} /> : null}
    {dialog?.kind === 'publish' ? <PublishDialog onCancel={() => setDialog(null)}
      onPublish={(repository, visibility) => { setDialog(null); void send({ type: 'git-publish', threadId: thread.id, repository, visibility }, result => setLocal({ tone: 'success', title: result.notice ?? msg`Repository published.` })) }} /> : null}
  </>
}

/** A notice this pane keeps itself, for a command's answer or refusal, until it is shown. */
interface LocalNotice { readonly tone: 'success' | 'error'; readonly title: LaterWords; readonly detail?: LaterWords }
const ACTION_FAILED = msg`Action failed`
const UNCONFIRMED_GIT_COMMAND = msg`Sotto could not confirm this Git command.`
const shownNotice = (notice: LocalNotice): GitNotice =>
  ({ tone: notice.tone, title: shownWords(notice.title), ...(notice.detail !== undefined ? { detail: shownWords(notice.detail) } : {}) })

/** The notice above the composer: the stage as it runs, then T3's toast with its next step, or the failure in the host's words. */
function GitActionNotice({ notice, running, onDismiss, onRun }: { readonly notice: GitNotice; readonly running: boolean; readonly onDismiss: () => void; readonly onRun: (action: GitStackedAction) => void }): ReactNode {
  const { t } = useLingui()
  const cta = notice.cta
  return <div className="git-action-notice" data-tone={notice.tone} role={notice.tone === 'error' ? 'alert' : 'status'}
    onKeyDown={event => { if (event.key === 'Escape' && notice.tone !== 'progress') { event.stopPropagation(); onDismiss() } }}>
    {notice.tone === 'progress' ? <span className="git-action-notice__spinner" aria-hidden="true" /> : null}
    <p className="tt-paragraph"><strong>{notice.title}</strong>{notice.detail ? <> {notice.detail}</> : null}</p>
    {cta?.kind === 'open_pr' ? <Button variant="secondary" onClick={() => void window.sotto?.openExternalLink?.(cta.url)}>{cta.label}</Button> : null}
    {cta?.kind === 'run_action' ? <Button variant="secondary" disabled={running} onClick={() => onRun(cta.action)}>{cta.label}</Button> : null}
    {notice.tone !== 'progress' ? <button type="button" className="git-action-notice__dismiss tt-focusable" aria-label={t`Dismiss the Git notice`} onClick={onDismiss}><X size={14} aria-hidden="true" /></button> : null}
  </div>
}

/**
 * T3's Commit changes dialog: the branch with its Default branch tag, the changed files with their counts
 * and an Edit mode that leaves files out, a message that may be left empty for the host to write, and
 * Cancel, Commit on new branch and the action itself.
 */
function CommitDialog({ threadId, status, action, onCancel, onCommit }: {
  readonly threadId: string; readonly status: GitStatus; readonly action: GitStackedAction
  readonly onCancel: () => void; readonly onCommit: (request: ActionRequest) => void
}): ReactNode {
  const { t } = useLingui()
  const [files, setFiles] = useState<GitChangedFiles | null>(null)
  const [failure, setFailure] = useState<LaterWords | null>(null)
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set())
  const [editing, setEditing] = useState(false)
  const [message, setMessage] = useState('')
  const [refusal, setRefusal] = useState<LaterWords | null>(null)
  const messageField = useRef<HTMLTextAreaElement>(null)
  const dialog = useDialogFocus({ onEscape: onCancel, initialFocus: messageField })
  const titleId = useId(), messageId = useId()
  // Ctrl+Enter (Cmd+Enter on a Mac) commits from the message, unless the dictation hotkey already means those keys.
  const app = useOptionalApp()
  const platform = app?.platform ?? 'win32'
  const submitChord = chordClaimed('mod+enter', app?.settings?.hotkey, platform) ? 'mod+enter' : null
  useEffect(() => {
    let live = true
    const read = changedFilesBridge()
    if (!read) { setFailure(msg`Changed files are not available in this window.`); return }
    read({ threadId }).then(listed => { if (live) setFiles(listed) }, () => { if (live) setFailure(msg`The changed files could not be read.`) })
    return () => { live = false }
  }, [threadId])
  const listed = files?.files ?? []
  const included = listed.filter(file => !excluded.has(file.path))
  const submit = (featureBranch: boolean): void => {
    if (files && listed.length > 0 && included.length === 0) { setRefusal(msg`Choose at least one file to commit.`); return }
    const trimmed = message.trim()
    onCommit({ action, ...(trimmed ? { commitMessage: trimmed } : {}), ...(excluded.size > 0 ? { filePaths: included.map(file => file.path) } : {}), ...(featureBranch ? { featureBranch: true } : {}) })
  }
  const toggle = (file: GitChangedFile): void => setExcluded(current => { const next = new Set(current); if (next.has(file.path)) next.delete(file.path); else next.add(file.path); return next })
  const nothing = files !== null && listed.length === 0
  const includedCount = included.length, total = listed.length
  const filesLine = files === null ? '' : excluded.size > 0
    ? files.truncated
      ? plural(includedCount, { one: `${{ files: shownCount(includedCount) }} file of ${{ total: shownCount(total) }} (more than Sotto lists)`, other: `${{ files: shownCount(includedCount) }} files of ${{ total: shownCount(total) }} (more than Sotto lists)` })
      : plural(includedCount, { one: `${{ files: shownCount(includedCount) }} file of ${{ total: shownCount(total) }}`, other: `${{ files: shownCount(includedCount) }} files of ${{ total: shownCount(total) }}` })
    : files.truncated ? plural(includedCount, { one: `${{ files: shownCount(includedCount) }} file (more than Sotto lists)`, other: `${{ files: shownCount(includedCount) }} files (more than Sotto lists)` }) : fileCount(includedCount)
  return <div className="tt-dialog-backdrop" role="presentation">
    <section ref={dialog} className="tt-dialog commit-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <h2 id={titleId}><Trans>Commit changes</Trans></h2>
      <p className="commit-dialog__branch"><GitBranch size={14} aria-hidden="true" /><span>{status.branch ?? t({ message: 'Detached HEAD', comment: 'Git\'s name for a checkout on no branch.' })}</span>{status.isDefaultBranch ? <span className="commit-dialog__tag"><Trans>Default branch</Trans></span> : null}</p>
      <div className="commit-dialog__files">
        <div className="commit-dialog__files-head">
          <span>{files ? filesLine : failure ? t`Changed files` : t`Reading changes…`}</span>
          {listed.length > 0 ? <button type="button" className="commit-dialog__edit tt-focusable" onClick={() => setEditing(value => !value)}>{editing ? t({ message: 'Done', context: 'finish choosing', comment: 'Finish choosing which files to commit.' }) : t({ message: 'Edit', comment: 'Choose which files to commit.' })}</button> : null}
        </div>
        {failure ? <p className="commit-dialog__note tt-paragraph" role="alert">{shownWords(failure)}</p> : null}
        {nothing ? <p className="commit-dialog__note tt-paragraph"><Trans>No changes to commit.</Trans></p> : null}
        {listed.length > 0 ? <ul className="commit-dialog__list" aria-label={t`Changed files`}>{listed.map(file => {
          const counts = lineCounts(file)
          const { letter, label } = STATUS_LETTER[file.status]
          const out = excluded.has(file.path)
          const path = file.path, added = file.insertions, removed = file.deletions
          return <li key={file.path} data-excluded={out || undefined}>
            {editing ? <input type="checkbox" className="tt-focusable" checked={!out} aria-label={t({ message: `Include ${ph({ path: leftToRight(path) })}`, comment: '{path} is a changed file\'s path.' })} onChange={() => toggle(file)} /> : null}
            <span className="commit-dialog__badge" data-status={file.status} role="img" aria-label={label} title={label}>{letter}</span>
            <span className="commit-dialog__path" dir="auto">{file.path}</span>
            {counts ? <span className="commit-dialog__counts" aria-label={t({ message: `${{ added: shownCount(added ?? 0) }} added, ${{ removed: shownCount(removed ?? 0) }} removed`, comment: 'Lines added to and removed from a changed file.' })}>{counts}</span> : null}
          </li>
        })}</ul> : null}
      </div>
      <label className="commit-dialog__message" htmlFor={messageId}><Trans>Commit message (optional)</Trans></label>
      <textarea ref={messageField} id={messageId} className="tt-focusable" rows={3} value={message} maxLength={10_000} placeholder={t`Leave empty to auto-generate`}
        onChange={event => setMessage(event.target.value)} onKeyDown={event => { if (submitChord && chordMatches(event, submitChord, platform)) { event.preventDefault(); submit(false) } }} />
      {refusal ? <div className="tt-dialog__status tt-dialog__status--error" role="alert">{shownWords(refusal)}</div> : null}
      <div className="tt-dialog__actions commit-dialog__actions">
        <Button variant="secondary" onClick={onCancel}><Trans>Cancel</Trans></Button>
        <Button variant="secondary" disabled={nothing || failure !== null} onClick={() => submit(true)}><Trans>Commit on new branch</Trans></Button>
        <Button variant="primary" disabled={nothing || failure !== null} onClick={() => submit(false)}>{commitLabel(action)}</Button>
      </div>
    </section>
  </div>
}

/** T3's "Push to default ref?": Abort, push there, or cut a feature branch and continue on it. */
function DefaultBranchDialog({ status, request, onCancel, onPush, onFeatureBranch }: {
  readonly status: GitStatus; readonly request: ActionRequest; readonly onCancel: () => void; readonly onPush: () => void; readonly onFeatureBranch: () => void
}): ReactNode {
  const { t } = useLingui()
  const abort = useRef<HTMLButtonElement>(null)
  const dialog = useDialogFocus({ onEscape: onCancel, initialFocus: abort })
  const titleId = useId(), descriptionId = useId()
  const words = defaultBranchQuestion(request.action, status.branch ?? status.defaultBranch ?? t({ message: 'the default branch', comment: 'Stands for a branch\'s name when Git gives none.' }))
  return <div className="tt-dialog-backdrop" role="presentation">
    <section ref={dialog} className="tt-dialog default-branch-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}>
      <h2 id={titleId}>{words.title}</h2>
      <div id={descriptionId} className="tt-dialog__description">{words.description}</div>
      <div className="tt-dialog__actions default-branch-dialog__actions">
        <Button ref={abort} variant="secondary" onClick={onCancel}><Trans>Abort</Trans></Button>
        <Button variant="secondary" onClick={onFeatureBranch}><Trans>Check out feature branch &amp; continue</Trans></Button>
        <Button variant="primary" onClick={onPush}>{words.confirm}</Button>
      </div>
    </section>
  </div>
}

/** Publish repository: the GitHub name and its visibility, nothing else (ADR-0027). */
function PublishDialog({ onCancel, onPublish }: { readonly onCancel: () => void; readonly onPublish: (repository: string, visibility: 'private' | 'public') => void }): ReactNode {
  const { t } = useLingui()
  const [repository, setRepository] = useState('')
  const [visibility, setVisibility] = useState<'private' | 'public'>('private')
  const [refusal, setRefusal] = useState<LaterWords | null>(null)
  const field = useRef<HTMLInputElement>(null)
  const dialog = useDialogFocus({ onEscape: onCancel, initialFocus: field })
  const titleId = useId(), fieldId = useId()
  const submit = (): void => {
    const name = repository.trim()
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/u.test(name)) { setRefusal(msg`Name the repository as owner/name.`); return }
    onPublish(name, visibility)
  }
  return <div className="tt-dialog-backdrop" role="presentation">
    <section ref={dialog} className="tt-dialog publish-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <h2 id={titleId}><Trans>Publish repository</Trans></h2>
      <div className="tt-dialog__description"><Trans>Creates the repository on GitHub through the gh command and your own sign-in, adds it as origin, and pushes the current branch.</Trans></div>
      <form onSubmit={event => { event.preventDefault(); submit() }}>
        <label htmlFor={fieldId}><Trans>Repository</Trans></label>
        <input ref={field} id={fieldId} className="tt-focusable" value={repository} placeholder={t({ message: 'owner/name', comment: 'The form a GitHub repository name takes.' })} maxLength={200} autoComplete="off" spellCheck={false} onChange={event => { setRepository(event.target.value); setRefusal(null) }} />
        <fieldset className="publish-dialog__visibility">
          <legend><Trans>Visibility</Trans></legend>
          <label><input type="radio" name="visibility" value="private" checked={visibility === 'private'} onChange={() => setVisibility('private')} /> <Trans>Private</Trans></label>
          <label><input type="radio" name="visibility" value="public" checked={visibility === 'public'} onChange={() => setVisibility('public')} /> <Trans>Public</Trans></label>
        </fieldset>
        {refusal ? <div className="tt-dialog__status tt-dialog__status--error" role="alert">{shownWords(refusal)}</div> : null}
        <div className="tt-dialog__actions">
          <Button variant="secondary" onClick={onCancel}><Trans>Cancel</Trans></Button>
          <Button variant="primary" type="submit"><Trans>Publish</Trans></Button>
        </div>
      </form>
    </section>
  </div>
}
