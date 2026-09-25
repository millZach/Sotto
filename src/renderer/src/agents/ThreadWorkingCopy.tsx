import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Folder, FolderGit2, FolderMinus, FolderOpen, GitBranch, RefreshCw, Undo2 } from 'lucide-react'
import { RECLAIM_WORKTREE_NEEDS_CONFIRMATION, RESTORE_BRANCH_NEEDS_CONFIRMATION, type AgentProject, type AgentThread } from '../../../shared/agents'
import { useOptionalApp } from '../state/AppContext'
import { resolveThreadWorkingDirectory } from '../../../shared/threadWorkingDirectory'
import type { AgentConnection } from './AgentContext'
import { Button } from '../components/Button'
import { ConfirmationDialog } from '../components/ConfirmationDialog'
import { folderKey } from './NewThreadDialog'
import './workingCopy.css'

/** Older threads carry no working-copy metadata and keep the folder they already use. */
export type WorkingCopyThread = Pick<AgentThread, 'id' | 'nativeSessionStarted' | 'workingDirectory' | 'worktree'> & Partial<Pick<AgentThread, 'projectId' | 'remoteHost'>>
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
  /** The folder was reclaimed; the branch stays and the next send puts the folder back. */
  readonly reclaimed?: boolean | undefined
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
  const common = { mode: worktree.mode, branch: worktree.branch, repositoryRoot: worktree.repositoryRoot, dirty: worktree.dirty, reclaimed: Boolean(worktree.reclaimedAt) }
  if (worktree.status === 'pending') return { ...common, status: 'pending', directory: undefined, label: worktree.mode === 'shared' ? 'Project folder' : 'New worktree' }
  if (worktree.status === 'error') return { ...common, status: 'error', directory: undefined, label: 'Worktree not ready', error: worktree.error }
  const directory = resolve()
  const label = worktree.branch ?? (worktree.repositoryRoot ? 'Detached HEAD' : directory ? folderLabel(directory, project) : 'Working folder')
  return { ...common, status: 'ready', directory, label }
}

type Action = 'retry-thread-worktree' | 'refresh-thread-worktree' | 'open-thread-folder' | 'restore-thread-branch' | 'reclaim-thread-worktree'
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
      const result = await command(type === 'restore-thread-branch' || type === 'reclaim-thread-worktree' ? { type, threadId, withUncommittedChanges } : { type, threadId })
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
  const [position, setPosition] = useState<{ left: number; width: number; maxHeight: number } | null>(null)
  const root = useRef<HTMLSpanElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const { running, error, lastError, run } = useWorkingCopyAction(thread.id, command)
  /** The open confirmation, and whether it names uncommitted work: the record's word, or main's when it knows better. */
  const [reclaiming, setReclaiming] = useState<false | 'clean' | 'dirty'>(false)
  useEffect(() => {
    if (!open || reclaiming) return
    const outside = (event: PointerEvent): void => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open, reclaiming])
  useEffect(() => { setOpen(false); setReclaiming(false) }, [thread.id])
  // The worktree Sotto made for this thread alone can be given back; a shared or reused folder is never offered.
  const reclaimable = isReclaimable(thread)
  const confirmReclaim = async (): Promise<boolean> => {
    const done = await run('reclaim-thread-worktree', reclaiming === 'dirty')
    if (done) { setOpen(false); return true }
    // The record can lag the folder: when main finds work it did not know about, the question is asked again, naming it.
    if (reclaiming === 'clean' && lastError.current === RECLAIM_WORKTREE_NEEDS_CONFIRMATION) setReclaiming('dirty')
    return false
  }
  // Panes clip their children. Keep the whole editor inside its pane, including when the chip is near either edge.
  useLayoutEffect(() => {
    if (!open || !root.current || !panel.current) return
    const element = root.current
    const pane = element.closest('.thread-pane')
    const update = (): void => {
      const anchor = element.getBoundingClientRect()
      const bounds = pane?.getBoundingClientRect()
      const leftEdge = Math.max(0, bounds?.left ?? 0) + 8
      const rightEdge = Math.min(document.documentElement.clientWidth, bounds?.right ?? document.documentElement.clientWidth) - 8
      const width = Math.min(420, Math.max(0, rightEdge - leftEdge))
      const left = Math.max(leftEdge, Math.min(anchor.left, rightEdge - width)) - anchor.left
      const bottom = Math.min(window.innerHeight, bounds?.bottom ?? window.innerHeight)
      const maxHeight = Math.max(0, bottom - anchor.bottom - 14)
      setPosition(previous => previous?.left === left && previous.width === width && previous.maxHeight === maxHeight ? previous : { left, width, maxHeight })
    }
    update()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(element)
    if (pane) observer?.observe(pane)
    window.addEventListener('resize', update)
    return () => { observer?.disconnect(); window.removeEventListener('resize', update) }
  }, [open])
  const Icon = facts.status === 'pending' || facts.status === 'error' ? FolderGit2 : facts.branch || facts.repositoryRoot ? GitBranch : Folder
  return <span className="working-copy" ref={root} data-status={facts.status}
    onKeyDown={event => { if (event.key === 'Escape' && open && !reclaiming) { event.stopPropagation(); setOpen(false); trigger.current?.focus() } }}>
    <button ref={trigger} type="button" className="working-copy__trigger tt-focusable" aria-expanded={open} aria-controls={open ? panelId : undefined}
      aria-label={`Working copy: ${facts.label}`} title={facts.directory ?? facts.label} onClick={() => setOpen(value => !value)}>
      <Icon size={14} aria-hidden="true" /><span>{facts.label}</span>
    </button>
    {open ? <div ref={panel} id={panelId} className="working-copy__panel" style={position ?? undefined} role="group" aria-label="Working copy details">
      <dl>
        {facts.directory ? <div><dt>Folder</dt><dd className="working-copy__path">{facts.directory}</dd></div> : null}
        {facts.branch ? <div><dt>Branch</dt><dd className="working-copy__path">{facts.branch}</dd></div> : null}
        {facts.repositoryRoot && facts.status === 'ready' && facts.mode === 'independent' ? <div><dt>Repository</dt><dd className="working-copy__path">{facts.repositoryRoot}</dd></div> : null}
        {facts.status === 'ready' && facts.reclaimed ? <div><dt>Status</dt><dd>Folder removed. Sending to this thread puts it back on {facts.branch ?? 'its branch'}.</dd></div> : null}
        {facts.status === 'ready' && !facts.reclaimed && facts.dirty !== undefined ? <div><dt>Changes</dt><dd>{facts.dirty ? 'Uncommitted changes' : 'No uncommitted changes'}</dd></div> : null}
        {/* A draft's worktree is not being prepared: it is made on first send, and the composer's toolbar chooses it (ADR-0027). */}
        {facts.status === 'pending' ? <div><dt>Status</dt><dd>{thread.nativeSessionStarted === false ? 'Created on first send. Choose the workspace and branch under the composer.' : 'Preparing the working copy.'}</dd></div> : null}
        {facts.status === 'error' ? <div><dt>Status</dt><dd>{facts.error ?? 'Setup did not finish.'}</dd></div> : null}
      </dl>
      {thread.remoteHost ? <p>This folder is on the host machine. Open it there.</p> : null}
      <div className="working-copy__actions">
        {facts.directory && !facts.reclaimed ? <Button variant="secondary" aria-disabled={running !== null || thread.remoteHost === true} onClick={() => { if (!thread.remoteHost) void run('open-thread-folder') }}><FolderOpen size={15} aria-hidden="true" />Open folder</Button> : null}
        {thread.worktree ? <Button variant="ghost" aria-disabled={running !== null} onClick={() => void run('refresh-thread-worktree')}><RefreshCw size={15} aria-hidden="true" />{running === 'refresh-thread-worktree' ? 'Checking...' : 'Refresh'}</Button> : null}
        {reclaimable ? <Button variant="ghost" aria-disabled={running !== null} aria-label="Remove worktree folder, keeping its branch" onClick={() => setReclaiming(facts.dirty ? 'dirty' : 'clean')}><FolderMinus size={15} aria-hidden="true" />{running === 'reclaim-thread-worktree' ? 'Removing…' : 'Remove worktree'}</Button> : null}
      </div>
      {error && !reclaiming ? <p className="agent-error" role="alert">{error}</p> : null}
    </div> : null}
    {reclaiming ? <ReclaimWorktreeDialog facts={facts} dirty={reclaiming === 'dirty'} fallbackFocusRef={trigger} onCancel={() => setReclaiming(false)} onConfirm={confirmReclaim} /> : null}
  </span>
}

/** The worktree Sotto made for this thread alone can be given back; a shared, reused or already reclaimed folder is never offered. */
export function isReclaimable(thread: Pick<AgentThread, 'worktree'>): boolean {
  const worktree = thread.worktree
  return worktree?.mode === 'independent' && worktree.status === 'ready' && Boolean(worktree.path) && !worktree.reused && !worktree.reclaimedAt
}

/** The one question before a worktree folder goes: what is in it, and that the branch stays (ADR-0019). */
export function ReclaimWorktreeDialog({ facts, dirty, title, onConfirm, onCancel, fallbackFocusRef }: {
  readonly facts: Pick<WorkingCopyFacts, 'branch'>
  readonly dirty: boolean
  readonly title?: string | undefined
  readonly onConfirm: () => Promise<boolean>
  readonly onCancel: () => void
  readonly fallbackFocusRef?: React.RefObject<HTMLElement | null> | undefined
}): ReactNode {
  return <ConfirmationDialog title={title ?? 'Remove this worktree?'} danger={dirty}
    description={<>
      <p>This thread’s worktree folder and everything installed in it is removed. {facts.branch ? <>The branch {facts.branch} keeps its commits</> : <>Its commits are kept</>}, and sending to this thread puts the folder back.</p>
      {dirty ? <p><strong>This folder has uncommitted changes.</strong> They are lost with it.</p> : null}
    </>}
    confirmLabel={dirty ? 'Remove and lose changes' : 'Remove worktree'} cancelLabel="Keep folder" {...(fallbackFocusRef ? { fallbackFocusRef } : {})}
    failureMessage="The folder could not be removed. Nothing was changed." onConfirm={onConfirm} onCancel={onCancel} />
}

/**
 * Settle a thread, then ask whether its own worktree should go with it (ADR-0019). The Settle press
 * settles at once, as it always has; the question is a separate one, answered by Keep folder or Escape.
 * With the on-settle rule turned on, a clean folder goes without the question and a dirty one still asks.
 */
export function useSettleThread(command: AgentConnection['command']) {
  const app = useOptionalApp()
  const onSettleRule = app?.settings?.worktreeCleanup.onSettle === true
  const [asking, setAsking] = useState<{ thread: WorkingCopyThread; project: Pick<AgentProject, 'path'> | undefined; dirty: boolean } | null>(null)
  const settle = useCallback(async (thread: WorkingCopyThread, project: Pick<AgentProject, 'path'> | undefined): Promise<void> => {
    const result = await command({ type: 'settle-thread', threadId: thread.id })
    if (!result || result.error || !isReclaimable(thread)) return
    const dirty = thread.worktree?.dirty === true
    if (onSettleRule && !dirty) { await command({ type: 'reclaim-thread-worktree', threadId: thread.id }); return }
    setAsking({ thread, project, dirty })
  }, [command, onSettleRule])
  const dialog = asking ? <ReclaimWorktreeDialog facts={describeWorkingCopy(asking.thread, asking.project)} dirty={asking.dirty} title="Remove its worktree too?"
    onCancel={() => setAsking(null)}
    onConfirm={async () => {
      const result = await command({ type: 'reclaim-thread-worktree', threadId: asking.thread.id, withUncommittedChanges: asking.dirty })
      if (result && !result.error) return true
      if (!asking.dirty && result?.error === RECLAIM_WORKTREE_NEEDS_CONFIRMATION) setAsking({ ...asking, dirty: true })
      return false
    }} /> : null
  return { settle, dialog }
}

/**
 * Above the pane composer: a failed setup and the one action that can recover it, or the local branch notice for a
 * worktree that started from the local branch because origin had nothing to fetch. The draft stays untouched.
 */
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
  const [, rerender] = useState(0)
  const originBase = thread.worktree?.originBase
  if (facts.status === 'ready' && (originBase === 'not-on-origin' || originBase === 'no-origin') && !localBranchNoticeDismissed(thread.id)) {
    // The local branch notice (CONTEXT.md): Start from origin found nothing to fetch and the worktree took the local
    // branch instead (ADR-0014). Said once, in the status tone: nothing stopped, and the pane header names the branch.
    const base = thread.worktree?.baseBranch ?? 'the branch'
    return <div className="working-copy-notice" data-tone="status" role="status">
      <p>{originBase === 'not-on-origin'
        ? <><strong>origin/{base} was not found</strong>, so the worktree started from the local branch {base}.</>
        : <><strong>This project has no origin</strong>, so the worktree started from the local branch {base}.</>}</p>
      <Button variant="secondary" aria-label="Dismiss the local branch notice" onClick={() => { dismissLocalBranchNotice(thread.id); rerender(value => value + 1) }}>Dismiss</Button>
    </div>
  }
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
 * Above the pane composer: the shared checkout is on a different named branch from the one its last send went
 * to. It is information, not a refusal: the next send goes to the branch the folder is on either way, so
 * the notice waits until there is something to send and can be dismissed. Restore branch switches back,
 * and asks first when the folder has uncommitted work to carry along.
 */
const dismissedBranchNotices = new Set<string>()
/**
 * Threads whose local branch notice was dismissed. The worktree record keeps `originBase` for the thread's life, so
 * a dismissal that lived only in memory would bring the notice back at every launch; it is remembered on this
 * computer instead. Thread ids only, nothing the user wrote.
 */
const LOCAL_BRANCH_NOTICE_KEY = 'sotto.localBranchNotice.dismissed'
const LOCAL_BRANCH_NOTICE_LIMIT = 200
function localBranchNoticeDismissed(threadId: string): boolean { return readDismissedLocalBranchNotices().includes(threadId) }
function dismissLocalBranchNotice(threadId: string): void {
  const kept = [...readDismissedLocalBranchNotices().filter(id => id !== threadId), threadId].slice(-LOCAL_BRANCH_NOTICE_LIMIT)
  try { globalThis.localStorage?.setItem(LOCAL_BRANCH_NOTICE_KEY, JSON.stringify(kept)) } catch { /* Storage refused: the notice comes back next launch, which loses nothing. */ }
}
function readDismissedLocalBranchNotices(): string[] {
  try {
    const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(LOCAL_BRANCH_NOTICE_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch { return [] }
}
/** Test seam: a new client session has no dismissed notices. */
export function resetBranchNoticeDismissals(): void {
  dismissedBranchNotices.clear()
  try { globalThis.localStorage?.removeItem(LOCAL_BRANCH_NOTICE_KEY) } catch { /* nothing to clear */ }
}

export function ThreadBranchNotice({ thread, project, command, composing }: ThreadWorkingCopyProps & { readonly composing: boolean }): ReactNode {
  const facts = describeWorkingCopy(thread, project)
  const sent = thread.worktree?.sentBranch
  const [, rerender] = useState(0)
  const [confirming, setConfirming] = useState(false)
  const { running, error, lastError, run } = useWorkingCopyAction(thread.id, command)
  const trigger = useRef<HTMLButtonElement>(null)
  const changed = facts.status === 'ready' && facts.mode === 'shared' && Boolean(sent) && Boolean(facts.branch) && sent !== facts.branch
  // A later switch is a new thing to say, so dismissal is remembered for this pair of branches alone.
  const change = [thread.id, sent ?? '', facts.branch ?? ''].join('\n')
  const dismiss = (): void => { dismissedBranchNotices.add(change); rerender(value => value + 1) }
  if (!changed || !composing || dismissedBranchNotices.has(change)) return null
  const restore = (withUncommittedChanges?: boolean): void => {
    if (running) return
    void run('restore-thread-branch', withUncommittedChanges).then(done => {
      // The record here can lag the folder: when main finds work it did not know about, it asks the same question.
      if (!done && !withUncommittedChanges && lastError.current === RESTORE_BRANCH_NEEDS_CONFIRMATION) setConfirming(true)
    })
  }
  return <div className="branch-notice" role="status"
    onKeyDown={event => { if (event.key === 'Escape' && !confirming) { event.stopPropagation(); dismiss() } }}>
    <p><strong>Branch changed, was {sent}.</strong> {facts.branch
      ? <>Sending will continue on {facts.branch}.</>
      : <>This folder has no branch checked out; sending will continue there.</>}</p>
    <Button ref={trigger} variant="secondary" aria-disabled={running !== null} aria-label={`Restore branch ${sent}`}
      onClick={() => { if (facts.dirty) setConfirming(true); else restore() }}>
      <Undo2 size={15} aria-hidden="true" />{running === 'restore-thread-branch' ? 'Switching…' : 'Restore branch'}
    </Button>
    <Button variant="ghost" aria-label="Dismiss the branch notice" onClick={() => dismiss()}>Dismiss</Button>
    {error && !confirming ? <p className="branch-notice__result" role="alert">{error}</p> : null}
    {confirming ? <ConfirmationDialog title={`Switch back to ${sent}?`} danger={false}
      description={<>This folder has uncommitted changes. They move with the switch to {sent}, and Git refuses the switch if they would conflict.</>}
      confirmLabel="Switch branch" cancelLabel="Keep this branch" fallbackFocusRef={trigger}
      failureMessage="The branch could not be switched. Nothing was changed."
      onConfirm={async () => run('restore-thread-branch', true)}
      onCancel={() => setConfirming(false)} /> : null}
  </div>
}
