import React, { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Folder, FolderGit2, FolderOpen, GitBranch, RefreshCw, Undo2 } from 'lucide-react'
import { RESTORE_BRANCH_NEEDS_CONFIRMATION, type AgentProject, type AgentThread } from '../../../shared/agents'
import { resolveThreadWorkingDirectory } from '../../../shared/threadWorkingDirectory'
import type { AgentConnection } from './AgentContext'
import { Button } from '../components/Button'
import { ConfirmationDialog } from '../components/ConfirmationDialog'
import { folderKey } from './NewThreadDialog'
import './workingCopy.css'

/** Older threads carry no working-copy metadata and keep the folder they already use. */
export type WorkingCopyThread = Pick<AgentThread, 'id' | 'nativeSessionStarted' | 'workingDirectory' | 'worktree'>
export interface ThreadWorkingCopyProps {
  readonly thread: WorkingCopyThread
  /** The thread's original Sotto project, never a provider's project alias. */
  readonly project: Pick<AgentProject, 'path'> | undefined
  readonly command: AgentConnection['command']
}
export interface WorkingCopyFacts {
  readonly status: 'legacy' | 'pending' | 'ready' | 'error'
  readonly mode: 'independent' | 'shared' | undefined
  /** The folder the thread actually works in. Unknown while setup is pending or failed. */
  readonly directory: string | undefined
  readonly label: string
  readonly branch?: string | undefined
  readonly repositoryRoot?: string | undefined
  readonly dirty?: boolean | undefined
  readonly error?: string | undefined
}

/** The project already names itself beside this label, so its own folder is called what it is. */
function folderLabel(path: string, project: Pick<AgentProject, 'path'> | undefined): string {
  if (project && folderKey(project.path) === folderKey(path)) return 'Project folder'
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || path
}

/** Where a thread's files live. Pending or failed setup never borrows the project folder as its answer. */
export function describeWorkingCopy(thread: WorkingCopyThread, project: Pick<AgentProject, 'path'> | undefined): WorkingCopyFacts {
  const worktree = thread.worktree
  // The same resolver main uses: the actual folder (a project subfolder inside a checkout), never the checkout root by accident.
  const resolve = (): string | undefined => { try { return resolveThreadWorkingDirectory(thread, project) } catch { return undefined } }
  if (!worktree) {
    const directory = resolve()
    return { status: 'legacy', mode: undefined, directory, label: directory ? folderLabel(directory, project) : 'Working folder' }
  }
  const common = { mode: worktree.mode, branch: worktree.branch, repositoryRoot: worktree.repositoryRoot, dirty: worktree.dirty }
  if (worktree.status === 'pending') return { ...common, status: 'pending', directory: undefined, label: 'Preparing worktree...' }
  if (worktree.status === 'error') return { ...common, status: 'error', directory: undefined, label: 'Worktree not ready', error: worktree.error }
  const directory = resolve()
  const label = worktree.mode === 'independent' && worktree.branch ? worktree.branch : directory ? folderLabel(directory, project) : 'Working folder'
  return { ...common, status: 'ready', directory, label }
}

type Action = 'retry-thread-worktree' | 'refresh-thread-worktree' | 'open-thread-folder' | 'restore-thread-branch'
function useWorkingCopyAction(threadId: string, command: AgentConnection['command']) {
  // Busy buttons use aria-disabled, not disabled: a disabled button would drop keyboard focus to the page.
  const [running, setRunning] = useState<Action | null>(null)
  const [error, setError] = useState<string | null>(null)
  const lastError = useRef<string | null>(null)
  const inFlight = useRef(false)
  const run = async (type: Action, withUncommittedChanges?: boolean): Promise<boolean> => {
    if (inFlight.current) return false
    inFlight.current = true
    setRunning(type); setError(null); lastError.current = null
    const fail = (message: string): false => { lastError.current = message; setError(message); return false }
    try {
      const result = await command(type === 'restore-thread-branch' ? { type, threadId, withUncommittedChanges } : { type, threadId })
      if (!result || result.error) return fail(result?.error ?? 'Could not confirm this action. Try again.')
      return true
    } catch { return fail('Could not confirm this action. Try again.') }
    finally { inFlight.current = false; setRunning(null) }
  }
  return { running, error, lastError, run }
}

/** Pane header chip: the actual branch or folder, with its details and folder actions. */
export function ThreadWorkingCopy({ thread, project, command }: ThreadWorkingCopyProps): ReactNode {
  const facts = describeWorkingCopy(thread, project)
  const [open, setOpen] = useState(false)
  const [alignEnd, setAlignEnd] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const { running, error, run } = useWorkingCopyAction(thread.id, command)
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent): void => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  useEffect(() => { setOpen(false) }, [thread.id])
  // A chip in a right-hand pane opens its details toward the pane instead of past the window edge.
  useLayoutEffect(() => {
    if (!open || !root.current || !panel.current) return
    setAlignEnd(root.current.getBoundingClientRect().left + panel.current.offsetWidth > document.documentElement.clientWidth - 16)
  }, [open])
  const Icon = facts.status === 'pending' || facts.status === 'error' ? FolderGit2 : facts.mode === 'independent' && facts.branch ? GitBranch : Folder
  return <span className="working-copy" ref={root} data-status={facts.status}
    onKeyDown={event => { if (event.key === 'Escape' && open) { event.stopPropagation(); setOpen(false); trigger.current?.focus() } }}>
    <button ref={trigger} type="button" className="working-copy__trigger tt-focusable" aria-expanded={open} aria-controls={open ? panelId : undefined}
      aria-label={`Working copy: ${facts.label}`} title={facts.directory ?? facts.label} onClick={() => setOpen(value => !value)}>
      <Icon size={14} aria-hidden="true" /><span>{facts.label}</span>
    </button>
    {open ? <div ref={panel} id={panelId} className="working-copy__panel" data-align={alignEnd ? 'end' : undefined} role="group" aria-label="Working copy details">
      <dl>
        {facts.directory ? <div><dt>Folder</dt><dd className="working-copy__path">{facts.directory}</dd></div> : null}
        {facts.branch ? <div><dt>Branch</dt><dd className="working-copy__path">{facts.branch}</dd></div> : null}
        {facts.repositoryRoot && facts.status === 'ready' && facts.mode === 'independent' ? <div><dt>Repository</dt><dd className="working-copy__path">{facts.repositoryRoot}</dd></div> : null}
        {facts.status === 'ready' && facts.dirty !== undefined ? <div><dt>Changes</dt><dd>{facts.dirty ? 'Uncommitted changes' : 'No uncommitted changes'}</dd></div> : null}
        {facts.status === 'pending' ? <div><dt>Status</dt><dd>Creating this thread’s branch and folder.</dd></div> : null}
        {facts.status === 'error' ? <div><dt>Status</dt><dd>{facts.error ?? 'Setup did not finish.'}</dd></div> : null}
      </dl>
      <div className="working-copy__actions">
        {facts.directory ? <Button variant="secondary" aria-disabled={running !== null} onClick={() => void run('open-thread-folder')}><FolderOpen size={15} aria-hidden="true" />Open folder</Button> : null}
        {thread.worktree ? <Button variant="ghost" aria-disabled={running !== null} onClick={() => void run('refresh-thread-worktree')}><RefreshCw size={15} aria-hidden="true" />{running === 'refresh-thread-worktree' ? 'Checking...' : 'Refresh'}</Button> : null}
      </div>
      {error ? <p className="agent-error" role="alert">{error}</p> : null}
    </div> : null}
  </span>
}

/** Above the pane composer: a failed setup and the one action that can recover it. The draft stays untouched. */
export function ThreadWorkingCopyNotice({ thread, project, command, onRecovered }: ThreadWorkingCopyProps & { readonly onRecovered?: (() => void) | undefined }): ReactNode {
  const facts = describeWorkingCopy(thread, project)
  const { running, error, run } = useWorkingCopyAction(thread.id, command)
  const recovering = useRef(false)
  const latestRecovered = useRef(onRecovered)
  latestRecovered.current = onRecovered
  // An accepted retry is not a recovered folder: wait for the thread itself to report ready.
  useEffect(() => {
    if (facts.status === 'error' || facts.status === 'pending' || !recovering.current) return
    recovering.current = false
    latestRecovered.current?.()
  }, [facts.status])
  useEffect(() => { recovering.current = false }, [thread.id])
  if (facts.status !== 'error') return null
  // Setup can only be retried before native work starts; afterwards Sotto only re-checks the bound folder.
  const retry = thread.nativeSessionStarted === false
  const action: Action = retry ? 'retry-thread-worktree' : 'refresh-thread-worktree'
  return <div className="working-copy-notice" role="alert">
    <p><strong>{retry ? 'Worktree not ready.' : 'Working folder unavailable.'}</strong> {facts.error ?? 'Setup did not finish.'}</p>
    <Button variant="secondary" aria-disabled={running !== null} onClick={() => { if (running) return; recovering.current = true; void run(action).then(done => { if (!done) recovering.current = false }) }}>
      <RefreshCw size={15} aria-hidden="true" />{running ? (retry ? 'Retrying...' : 'Checking...') : retry ? 'Retry setup' : 'Check again'}
    </Button>
    {error && error !== facts.error ? <p className="working-copy-notice__result">{error}</p> : null}
  </div>
}

/**
 * Above the pane composer: the thread's worktree is on a different branch from the one its last send went
 * to. It is information, not a refusal: the next send goes to the branch the folder is on either way, so
 * the notice waits until there is something to send and can be dismissed. Restore branch switches back,
 * and asks first when the folder has uncommitted work to carry along.
 */
export function ThreadBranchNotice({ thread, project, command, composing }: ThreadWorkingCopyProps & { readonly composing: boolean }): ReactNode {
  const facts = describeWorkingCopy(thread, project)
  const sent = thread.worktree?.sentBranch
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const { running, error, lastError, run } = useWorkingCopyAction(thread.id, command)
  const trigger = useRef<HTMLButtonElement>(null)
  const changed = facts.status === 'ready' && facts.mode === 'independent' && sent !== undefined && sent !== facts.branch
  // A later switch is a new thing to say, so dismissal is remembered for this pair of branches alone.
  const change = [thread.id, sent ?? '', facts.branch ?? ''].join('\n')
  if (!changed || !composing || dismissed === change) return null
  const restore = (withUncommittedChanges?: boolean): void => {
    if (running) return
    void run('restore-thread-branch', withUncommittedChanges).then(done => {
      // The record here can lag the folder: when main finds work it did not know about, it asks the same question.
      if (!done && !withUncommittedChanges && lastError.current === RESTORE_BRANCH_NEEDS_CONFIRMATION) setConfirming(true)
    })
  }
  return <div className="branch-notice" role="status"
    onKeyDown={event => { if (event.key === 'Escape' && !confirming) { event.stopPropagation(); setDismissed(change) } }}>
    <p><strong>Branch changed, was {sent}.</strong> {facts.branch
      ? <>Sending will continue on {facts.branch}.</>
      : <>This folder has no branch checked out; sending will continue there.</>}</p>
    <Button ref={trigger} variant="secondary" aria-disabled={running !== null} aria-label={`Restore branch ${sent}`}
      onClick={() => { if (facts.dirty) setConfirming(true); else restore() }}>
      <Undo2 size={15} aria-hidden="true" />{running === 'restore-thread-branch' ? 'Switching…' : 'Restore branch'}
    </Button>
    <Button variant="ghost" aria-label="Dismiss the branch notice" onClick={() => setDismissed(change)}>Dismiss</Button>
    {error && !confirming ? <p className="branch-notice__result" role="alert">{error}</p> : null}
    {confirming ? <ConfirmationDialog title={`Switch back to ${sent}?`} danger={false}
      description={<>This folder has uncommitted changes. They move with the switch to {sent}, and Git refuses the switch if they would conflict.</>}
      confirmLabel="Switch branch" cancelLabel="Keep this branch" fallbackFocusRef={trigger}
      failureMessage="The branch could not be switched. Nothing was changed."
      onConfirm={async () => run('restore-thread-branch', true)}
      onCancel={() => setConfirming(false)} /> : null}
  </div>
}
