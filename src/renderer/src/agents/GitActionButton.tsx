import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDownToLine, ArrowUpFromLine, ChevronDown, FolderGit2, GitBranch, GitCommitHorizontal, GitPullRequestArrow, RefreshCw, Upload, X } from 'lucide-react'
import type { AgentState, AgentThread } from '../../../shared/agents'
import type { GitStackedAction } from '../../../shared/gitActions'
import type { GitChangedFile, GitChangedFiles } from '../../../shared/gitChangedFiles'
import type { GitStatus } from '../../../shared/gitStatus'
import { Button } from '../components/Button'
import type { AgentConnection } from './AgentContext'
import { PaneMenu, type PaneMenuItem } from './PaneMenu'
import { commitLabel, commits, defaultBranchQuestion, fileCount, lineCounts, menuEntries, needsDefaultBranchConfirmation, noticeFor, quickAction, stackedFor, STATUS_LETTER, type GitNotice, type GitQuickKind } from './gitActionButton.logic'
import './gitActionButton.css'

type Command = AgentConnection['command']

/** The bridge call the dialog reads the changed files through; absent in a window without the preload. */
function changedFilesBridge(): ((request: { threadId: string }) => Promise<GitChangedFiles>) | undefined {
  return window.sotto?.agents?.gitChangedFiles
}

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
  const status = thread.worktree?.git
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [local, setLocal] = useState<GitNotice | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [inFlight, setInFlight] = useState(false)
  const flight = useRef(false)
  useEffect(() => { setDialog(null); setLocal(null); setDismissed(null) }, [thread.id])
  const explained = useRef(onExplainedError)
  explained.current = onExplainedError
  const progress = thread.gitAction
  const shown: GitNotice | null = local ?? (progress && progress.actionId !== dismissed ? noticeFor(progress) : null)
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
      if (!result) setLocal({ tone: 'error', title: 'Action failed', detail: 'Sotto could not confirm this Git command.' })
      else if (result.error) { if (!onRefused?.(result)) setLocal({ tone: 'error', title: 'Action failed', detail: result.error }) }
      else onDone(result)
    } catch { setLocal({ tone: 'error', title: 'Action failed', detail: 'Sotto could not confirm this Git command.' }) }
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
      case 'pull': void send({ type: 'git-pull', threadId: thread.id }, result => setLocal({ tone: 'success', title: result.notice ?? 'Pulled' })); return
      case 'init': void send({ type: 'git-init', threadId: thread.id }, result => setLocal({ tone: 'success', title: result.notice ?? 'Git initialized.' })); return
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
  const menu: PaneMenuItem[] = menuEntries(status).map(entry => ({ id: entry.id, label: entry.label, disabled: running || entry.hint !== undefined, ...(entry.hint ? { hint: entry.hint } : {}),
    icon: entry.id === 'commit' ? <GitCommitHorizontal size={15} aria-hidden="true" /> : entry.id === 'push' ? <ArrowUpFromLine size={15} aria-hidden="true" /> : entry.id === 'publish' ? <Upload size={15} aria-hidden="true" /> : <GitPullRequestArrow size={15} aria-hidden="true" />,
    run: () => press(entry.id) }))

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
      {menu.length > 0 ? <PaneMenu groups={[menu]} label="More Git actions" className="git-action__more" icon={<ChevronDown size={14} aria-hidden="true" />} /> : null}
    </div> : null}
    {noticeSlot && notice ? createPortal(notice, noticeSlot) : notice}
    {dialog?.kind === 'commit' && status ? <CommitDialog threadId={thread.id} status={status} action={dialog.action} onCancel={() => setDialog(null)}
      onCommit={(request) => { setDialog(null); runAction(request) }} /> : null}
    {dialog?.kind === 'confirm' && status ? <DefaultBranchDialog status={status} request={dialog.request} onCancel={() => setDialog(null)}
      onPush={() => { const request = dialog.request; setDialog(null); runAction({ ...request, allowDefaultBranch: true }) }}
      onFeatureBranch={() => { const request = dialog.request; setDialog(null); runAction({ ...request, featureBranch: true }) }} /> : null}
    {dialog?.kind === 'publish' ? <PublishDialog onCancel={() => setDialog(null)}
      onPublish={(repository, visibility) => { setDialog(null); void send({ type: 'git-publish', threadId: thread.id, repository, visibility }, result => setLocal({ tone: 'success', title: result.notice ?? 'Repository published.' })) }} /> : null}
  </>
}

/** The notice above the composer: the stage as it runs, then T3's toast with its next step, or the failure in the host's words. */
function GitActionNotice({ notice, running, onDismiss, onRun }: { readonly notice: GitNotice; readonly running: boolean; readonly onDismiss: () => void; readonly onRun: (action: GitStackedAction) => void }): ReactNode {
  const cta = notice.cta
  return <div className="git-action-notice" data-tone={notice.tone} role={notice.tone === 'error' ? 'alert' : 'status'}
    onKeyDown={event => { if (event.key === 'Escape' && notice.tone !== 'progress') { event.stopPropagation(); onDismiss() } }}>
    {notice.tone === 'progress' ? <span className="git-action-notice__spinner" aria-hidden="true" /> : null}
    <p><strong>{notice.title}</strong>{notice.detail ? <> {notice.detail}</> : null}</p>
    {cta?.kind === 'open_pr' ? <Button variant="secondary" onClick={() => void window.sotto?.openExternalLink?.(cta.url)}>{cta.label}</Button> : null}
    {cta?.kind === 'run_action' ? <Button variant="secondary" disabled={running} onClick={() => onRun(cta.action)}>{cta.label}</Button> : null}
    {notice.tone !== 'progress' ? <button type="button" className="git-action-notice__dismiss tt-focusable" aria-label="Dismiss the Git notice" onClick={onDismiss}><X size={14} aria-hidden="true" /></button> : null}
  </div>
}

/** Focus the first control on open, keep Tab inside, answer Escape, and give focus back on close: what every dialog here does. */
function useDialogFocus(onCancel: () => void, initial: React.RefObject<HTMLElement | null>): React.RefObject<HTMLElement | null> {
  const dialog = useRef<HTMLElement>(null)
  const cancel = useRef(onCancel)
  cancel.current = onCancel
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    initial.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel.current(); return }
      if (event.key !== 'Tab') return
      const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? [])]
      if (focusable.length === 0) return
      const first = focusable[0]!, last = focusable.at(-1)!
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      // Focus goes back to where it was, unless the next dialog has already taken it (the commit dialog hands over to the question).
      queueMicrotask(() => {
        const active = document.activeElement
        if (active && active !== document.body && active.isConnected) return
        if (previous?.isConnected) previous.focus()
      })
    }
  }, [initial])
  return dialog
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
  const [files, setFiles] = useState<GitChangedFiles | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set())
  const [editing, setEditing] = useState(false)
  const [message, setMessage] = useState('')
  const [refusal, setRefusal] = useState<string | null>(null)
  const messageField = useRef<HTMLTextAreaElement>(null)
  const dialog = useDialogFocus(onCancel, messageField)
  const titleId = useId(), messageId = useId()
  useEffect(() => {
    let live = true
    const read = changedFilesBridge()
    if (!read) { setFailure('Changed files are not available in this window.'); return }
    read({ threadId }).then(listed => { if (live) setFiles(listed) }, () => { if (live) setFailure('The changed files could not be read.') })
    return () => { live = false }
  }, [threadId])
  const listed = files?.files ?? []
  const included = listed.filter(file => !excluded.has(file.path))
  const submit = (featureBranch: boolean): void => {
    if (files && listed.length > 0 && included.length === 0) { setRefusal('Choose at least one file to commit.'); return }
    const trimmed = message.trim()
    onCommit({ action, ...(trimmed ? { commitMessage: trimmed } : {}), ...(excluded.size > 0 ? { filePaths: included.map(file => file.path) } : {}), ...(featureBranch ? { featureBranch: true } : {}) })
  }
  const toggle = (file: GitChangedFile): void => setExcluded(current => { const next = new Set(current); if (next.has(file.path)) next.delete(file.path); else next.add(file.path); return next })
  const nothing = files !== null && listed.length === 0
  return <div className="tt-dialog-backdrop" role="presentation" onPointerDown={event => { if (event.target === event.currentTarget) onCancel() }}>
    <section ref={dialog} className="tt-dialog commit-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <h2 id={titleId}>Commit changes</h2>
      <p className="commit-dialog__branch"><GitBranch size={14} aria-hidden="true" /><span>{status.branch ?? 'Detached HEAD'}</span>{status.isDefaultBranch ? <span className="commit-dialog__tag">Default branch</span> : null}</p>
      <div className="commit-dialog__files">
        <div className="commit-dialog__files-head">
          <span>{files ? `${fileCount(included.length)}${excluded.size > 0 ? ` of ${listed.length}` : ''}${files.truncated ? ' (more than Sotto lists)' : ''}` : failure ? 'Changed files' : 'Reading changes…'}</span>
          {listed.length > 0 ? <button type="button" className="commit-dialog__edit tt-focusable" aria-pressed={editing} onClick={() => setEditing(value => !value)}>{editing ? 'Done' : 'Edit'}</button> : null}
        </div>
        {failure ? <p className="commit-dialog__note" role="alert">{failure}</p> : null}
        {nothing ? <p className="commit-dialog__note">No changes to commit.</p> : null}
        {listed.length > 0 ? <ul className="commit-dialog__list" aria-label="Changed files">{listed.map(file => {
          const counts = lineCounts(file)
          const { letter, label } = STATUS_LETTER[file.status]
          const out = excluded.has(file.path)
          return <li key={file.path} data-excluded={out || undefined}>
            {editing ? <input type="checkbox" className="tt-focusable" checked={!out} aria-label={`Include ${file.path}`} onChange={() => toggle(file)} /> : null}
            <span className="commit-dialog__badge" data-status={file.status} title={label}>{letter}</span>
            <span className="commit-dialog__path" dir="auto">{file.path}</span>
            {counts ? <span className="commit-dialog__counts" aria-label={`${file.insertions} added, ${file.deletions} removed`}>{counts}</span> : null}
          </li>
        })}</ul> : null}
      </div>
      <label className="commit-dialog__message" htmlFor={messageId}>Commit message (optional)</label>
      <textarea ref={messageField} id={messageId} className="tt-focusable" rows={3} value={message} maxLength={10_000} placeholder="Leave empty to auto-generate"
        onChange={event => setMessage(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); submit(false) } }} />
      {refusal ? <div className="tt-dialog__status tt-dialog__status--error" role="alert">{refusal}</div> : null}
      <div className="tt-dialog__actions commit-dialog__actions">
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button variant="secondary" disabled={nothing || failure !== null} onClick={() => submit(true)}>Commit on new branch</Button>
        <Button variant="primary" disabled={nothing || failure !== null} onClick={() => submit(false)}>{commitLabel(action)}</Button>
      </div>
    </section>
  </div>
}

/** T3's "Push to default ref?": Abort, push there, or cut a feature branch and continue on it. */
function DefaultBranchDialog({ status, request, onCancel, onPush, onFeatureBranch }: {
  readonly status: GitStatus; readonly request: ActionRequest; readonly onCancel: () => void; readonly onPush: () => void; readonly onFeatureBranch: () => void
}): ReactNode {
  const abort = useRef<HTMLButtonElement>(null)
  const dialog = useDialogFocus(onCancel, abort)
  const titleId = useId(), descriptionId = useId()
  const words = defaultBranchQuestion(request.action, status.branch ?? status.defaultBranch ?? 'the default branch')
  return <div className="tt-dialog-backdrop" role="presentation">
    <section ref={dialog} className="tt-dialog default-branch-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}>
      <h2 id={titleId}>{words.title}</h2>
      <div id={descriptionId} className="tt-dialog__description">{words.description}</div>
      <div className="tt-dialog__actions default-branch-dialog__actions">
        <Button ref={abort} variant="secondary" onClick={onCancel}>Abort</Button>
        <Button variant="secondary" onClick={onFeatureBranch}>Check out feature branch & continue</Button>
        <Button variant="primary" onClick={onPush}>{words.confirm}</Button>
      </div>
    </section>
  </div>
}

/** Publish repository: the GitHub name and its visibility, nothing else (ADR-0027). */
function PublishDialog({ onCancel, onPublish }: { readonly onCancel: () => void; readonly onPublish: (repository: string, visibility: 'private' | 'public') => void }): ReactNode {
  const [repository, setRepository] = useState('')
  const [visibility, setVisibility] = useState<'private' | 'public'>('private')
  const [refusal, setRefusal] = useState<string | null>(null)
  const field = useRef<HTMLInputElement>(null)
  const dialog = useDialogFocus(onCancel, field)
  const titleId = useId(), fieldId = useId()
  const submit = (): void => {
    const name = repository.trim()
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/u.test(name)) { setRefusal('Name the repository as owner/name.'); return }
    onPublish(name, visibility)
  }
  return <div className="tt-dialog-backdrop" role="presentation">
    <section ref={dialog} className="tt-dialog publish-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <h2 id={titleId}>Publish repository</h2>
      <div className="tt-dialog__description">Creates the repository on GitHub through the gh command and your own sign-in, adds it as origin, and pushes the current branch.</div>
      <form onSubmit={event => { event.preventDefault(); submit() }}>
        <label htmlFor={fieldId}>Repository</label>
        <input ref={field} id={fieldId} className="tt-focusable" value={repository} placeholder="owner/name" maxLength={200} autoComplete="off" spellCheck={false} onChange={event => { setRepository(event.target.value); setRefusal(null) }} />
        <fieldset className="publish-dialog__visibility">
          <legend>Visibility</legend>
          <label><input type="radio" name="visibility" value="private" checked={visibility === 'private'} onChange={() => setVisibility('private')} /> Private</label>
          <label><input type="radio" name="visibility" value="public" checked={visibility === 'public'} onChange={() => setVisibility('public')} /> Public</label>
        </fieldset>
        {refusal ? <div className="tt-dialog__status tt-dialog__status--error" role="alert">{refusal}</div> : null}
        <div className="tt-dialog__actions">
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" type="submit">Publish</Button>
        </div>
      </form>
    </section>
  </div>
}
