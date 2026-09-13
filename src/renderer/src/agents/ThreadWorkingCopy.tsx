import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Folder, FolderGit2, FolderOpen, GitBranch, RefreshCw } from 'lucide-react'
import type { AgentProject, AgentThread } from '../../../shared/agents'
import type { AgentConnection } from './AgentContext'
import { Button } from '../components/Button'
import './workingCopy.css'

/** The working-copy metadata a thread may carry; older threads have none and keep their folder. */
interface WorkingCopyMetadata {
  readonly mode: 'independent' | 'shared'
  readonly status: 'pending' | 'ready' | 'error'
  readonly path?: string | undefined
  readonly repositoryRoot?: string | undefined
  readonly branch?: string | undefined
  readonly dirty?: boolean | undefined
  readonly error?: string | undefined
}
export type WorkingCopyThread = Pick<AgentThread, 'id' | 'nativeSessionStarted'> & {
  readonly workingDirectory?: string | undefined
  readonly worktree?: WorkingCopyMetadata | undefined
}
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

function folderName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || path
}

/** Where a thread's files live. Pending or failed setup never borrows the project folder as its answer. */
export function describeWorkingCopy(thread: WorkingCopyThread, project: Pick<AgentProject, 'path'> | undefined): WorkingCopyFacts {
  const worktree = thread.worktree
  if (!worktree) {
    const directory = thread.workingDirectory ?? project?.path
    return { status: 'legacy', mode: undefined, directory, label: directory ? folderName(directory) : 'Working folder' }
  }
  const common = { mode: worktree.mode, branch: worktree.branch, repositoryRoot: worktree.repositoryRoot, dirty: worktree.dirty }
  if (worktree.status === 'pending') return { ...common, status: 'pending', directory: undefined, label: 'Preparing worktree...' }
  if (worktree.status === 'error') return { ...common, status: 'error', directory: undefined, label: 'Worktree not ready', error: worktree.error }
  const directory = thread.workingDirectory ?? worktree.path
  const label = worktree.mode === 'independent' && worktree.branch ? worktree.branch : directory ? folderName(directory) : 'Working folder'
  return { ...common, status: 'ready', directory, label }
}

type Action = 'retry-thread-worktree' | 'refresh-thread-worktree' | 'open-thread-folder'
function useWorkingCopyAction(threadId: string, command: AgentConnection['command']) {
  const [running, setRunning] = useState<Action | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  const run = async (type: Action): Promise<boolean> => {
    if (inFlight.current) return false
    inFlight.current = true
    setRunning(type); setError(null)
    try {
      const result = await command({ type, threadId })
      if (!result || result.error) { setError(result?.error ?? 'Could not confirm this action. Try again.'); return false }
      return true
    } catch { setError('Could not confirm this action. Try again.'); return false }
    finally { inFlight.current = false; setRunning(null) }
  }
  return { running, error, run }
}

/** Pane header chip: the actual branch or folder, with its details and folder actions. */
export function ThreadWorkingCopy({ thread, project, command }: ThreadWorkingCopyProps): ReactNode {
  const facts = describeWorkingCopy(thread, project)
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
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
  const Icon = facts.status === 'pending' || facts.status === 'error' ? FolderGit2 : facts.mode === 'independent' && facts.branch ? GitBranch : Folder
  return <span className="working-copy" ref={root} data-status={facts.status}
    onKeyDown={event => { if (event.key === 'Escape' && open) { event.stopPropagation(); setOpen(false); trigger.current?.focus() } }}>
    <button ref={trigger} type="button" className="working-copy__trigger tt-focusable" aria-expanded={open} aria-controls={open ? panelId : undefined}
      aria-label={`Working copy: ${facts.label}`} title={facts.directory ?? facts.label} onClick={() => setOpen(value => !value)}>
      <Icon size={14} aria-hidden="true" /><span>{facts.label}</span>
    </button>
    {open ? <div id={panelId} className="working-copy__panel" role="group" aria-label="Working copy details">
      <dl>
        {facts.directory ? <div><dt>Folder</dt><dd className="working-copy__path">{facts.directory}</dd></div> : null}
        {facts.branch ? <div><dt>Branch</dt><dd className="working-copy__path">{facts.branch}</dd></div> : null}
        {facts.repositoryRoot && facts.status === 'ready' && facts.mode === 'independent' ? <div><dt>Repository</dt><dd className="working-copy__path">{facts.repositoryRoot}</dd></div> : null}
        {facts.status === 'ready' && facts.dirty !== undefined ? <div><dt>Changes</dt><dd>{facts.dirty ? 'Uncommitted changes' : 'No uncommitted changes'}</dd></div> : null}
        {facts.status === 'pending' ? <div><dt>Status</dt><dd>Creating this thread’s branch and folder.</dd></div> : null}
        {facts.status === 'error' ? <div><dt>Status</dt><dd>{facts.error ?? 'Setup did not finish.'}</dd></div> : null}
      </dl>
      <div className="working-copy__actions">
        {facts.directory ? <Button variant="secondary" disabled={running !== null} onClick={() => void run('open-thread-folder')}><FolderOpen size={15} aria-hidden="true" />Open folder</Button> : null}
        {thread.worktree ? <Button variant="ghost" disabled={running !== null} onClick={() => void run('refresh-thread-worktree')}><RefreshCw size={15} aria-hidden="true" />{running === 'refresh-thread-worktree' ? 'Checking...' : 'Refresh'}</Button> : null}
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
    <Button variant="secondary" disabled={running !== null} onClick={() => { recovering.current = true; void run(action).then(done => { if (!done) recovering.current = false }) }}>
      <RefreshCw size={15} aria-hidden="true" />{running ? (retry ? 'Retrying...' : 'Checking...') : retry ? 'Retry setup' : 'Check again'}
    </Button>
    {error && error !== facts.error ? <p className="working-copy-notice__result">{error}</p> : null}
  </div>
}
