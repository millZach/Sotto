import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Folder, FolderGit2, FolderMinus, FolderOpen, GitBranch, RefreshCw, Undo2 } from 'lucide-react'
import { i18n } from '@lingui/core'
import { msg, ph, plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { RECLAIM_WORKTREE_NEEDS_CONFIRMATION, RESTORE_BRANCH_NEEDS_CONFIRMATION, type AgentProject, type AgentThread, type WorktreeReclaimPreview } from '../../../shared/agents'
import { useOptionalApp } from '../state/AppContext'
import { resolveThreadWorkingDirectory } from '../../../shared/threadWorkingDirectory'
import type { AgentConnection } from './AgentContext'
import { Button } from '../components/Button'
import { ConfirmationDialog } from '../components/ConfirmationDialog'
import { folderKey } from './NewThreadDialog'
import { worktreeErrorWords } from './movedWorktreeWords'
import { leftToRight, shownWords, type LaterWords } from './interfaceWords'
import { shownCount, shownLocalCount } from '../state/interfaceNumbers'
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
  if (project && folderKey(project.path) === folderKey(path)) return i18n._(msg`Project folder`)
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || path
}

/** Where a thread's files live. Pending or failed setup never borrows the project folder as its answer. */
export function describeWorkingCopy(thread: WorkingCopyThread, project: Pick<AgentProject, 'path'> | undefined): WorkingCopyFacts {
  const worktree = thread.worktree
  // The same resolver main uses: the actual folder (a project subfolder inside a checkout), never the checkout root by accident.
  const resolve = (): string | undefined => { try { return resolveThreadWorkingDirectory(thread, project) } catch { return undefined } }
  if (!worktree) {
    const directory = resolve()
    return { status: 'legacy', mode: undefined, directory, label: directory ? folderLabel(directory, project) : i18n._(msg`Working folder`) }
  }
  const common = { mode: worktree.mode, branch: worktree.branch, repositoryRoot: worktree.repositoryRoot, dirty: worktree.dirty, reclaimed: Boolean(worktree.reclaimedAt) }
  if (worktree.status === 'pending') return { ...common, status: 'pending', directory: undefined, label: worktree.mode === 'shared' ? i18n._(msg`Project folder`) : i18n._(msg`New worktree`) }
  if (worktree.status === 'error') return { ...common, status: 'error', directory: undefined, label: i18n._(msg`Worktree not ready`), error: worktreeErrorWords(worktree.error) }
  const directory = resolve()
  const label = worktree.branch ?? (worktree.repositoryRoot ? i18n._(msg({ message: 'Detached HEAD', comment: 'Git\'s name for a checkout on no branch.' })) : directory ? folderLabel(directory, project) : i18n._(msg`Working folder`))
  return { ...common, status: 'ready', directory, label }
}

type Action = 'retry-thread-worktree' | 'refresh-thread-worktree' | 'open-thread-folder' | 'restore-thread-branch' | 'reclaim-thread-worktree'
function useWorkingCopyAction(threadId: string, command: AgentConnection['command']) {
  // Busy buttons use aria-disabled, not disabled: a disabled button would drop keyboard focus to the page.
  const [running, setRunning] = useState<Action | null>(null)
  // Main's own words come as written; Sotto's are kept as a message and read in the interface language when shown.
  const [failure, setFailure] = useState<LaterWords | null>(null)
  const lastError = useRef<LaterWords | null>(null)
  const inFlight = useRef(false)
  const run = async (type: Action, withUncommittedChanges?: boolean, confirmedIgnored?: string[], confirmedRepositories?: WorktreeReclaimPreview['repositories'], confirmedItems?: { path: string; fileCount: number }[]): Promise<boolean> => {
    if (inFlight.current) return false
    inFlight.current = true
    setRunning(type); setFailure(null); lastError.current = null
    const fail = (message: LaterWords): false => { lastError.current = message; setFailure(message); return false }
    try {
      const result = await command(type === 'restore-thread-branch' || type === 'reclaim-thread-worktree' ? { type, threadId, withUncommittedChanges, ...(type === 'reclaim-thread-worktree' && confirmedIgnored ? { confirmedIgnored, confirmedRepositories, confirmedItems } : {}) } : { type, threadId })
      if (!result || result.error) return fail(result?.error ?? msg`Could not confirm this action. Try again.`)
      return true
    } catch { return fail(msg`Could not confirm this action. Try again.`) }
    finally { inFlight.current = false; setRunning(null) }
  }
  const error = shownWords(failure)
  return { running, error, lastError, run }
}

/** Pane header chip: the actual branch or folder, with its details and folder actions. */
export function ThreadWorkingCopy({ thread, project, command }: ThreadWorkingCopyProps): ReactNode {
  const { t } = useLingui()
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
  const confirmReclaim = async (preview: WorktreeReclaimPreview): Promise<boolean> => {
    const done = await run('reclaim-thread-worktree', reclaiming === 'dirty' || preview.dirty, preview.ignored, preview.repositories, preview.items.map(({ path, fileCount }) => ({ path, fileCount })))
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
  const label = facts.label, branch = facts.branch
  return <span className="working-copy" ref={root} data-status={facts.status}
    onKeyDown={event => { if (event.key === 'Escape' && open && !reclaiming) { event.stopPropagation(); setOpen(false); trigger.current?.focus() } }}>
    <button ref={trigger} type="button" className="working-copy__trigger tt-focusable" aria-expanded={open} aria-controls={open ? panelId : undefined}
      aria-label={t`Working copy: ${label}`} title={facts.directory ?? facts.label} onClick={() => setOpen(value => !value)}>
      <Icon size={14} aria-hidden="true" /><span>{facts.label}</span>
    </button>
    {open ? <div ref={panel} id={panelId} className="working-copy__panel" style={position ?? undefined} role="group" aria-label={t`Working copy details`}>
      <dl>
        {facts.directory ? <div><dt><Trans>Folder</Trans></dt><dd className="working-copy__path">{facts.directory}</dd></div> : null}
        {facts.branch ? <div><dt><Trans>Branch</Trans></dt><dd className="working-copy__path">{facts.branch}</dd></div> : null}
        {facts.repositoryRoot && facts.status === 'ready' && facts.mode === 'independent' ? <div><dt><Trans>Repository</Trans></dt><dd className="working-copy__path">{facts.repositoryRoot}</dd></div> : null}
        {facts.status === 'ready' && facts.reclaimed ? <div><dt><Trans>Status</Trans></dt><dd>{branch === undefined ? t`Folder removed. Sending to this thread puts it back on its branch.` : t({ message: `Folder removed. Sending to this thread puts it back on ${ph({ branch: leftToRight(branch) })}.`, comment: '{branch} is a Git branch name.' })}</dd></div> : null}
        {facts.status === 'ready' && !facts.reclaimed && facts.dirty !== undefined ? <div><dt><Trans>Changes</Trans></dt><dd>{facts.dirty ? t`Uncommitted changes` : t`No uncommitted changes`}</dd></div> : null}
        {/* A draft's worktree is not being prepared: it is made on first send, and the composer's toolbar chooses it (ADR-0027). */}
        {facts.status === 'pending' ? <div><dt><Trans>Status</Trans></dt><dd>{thread.nativeSessionStarted === false ? t`Created on first send. Choose the workspace and branch under the composer.` : t`Preparing the working copy.`}</dd></div> : null}
        {facts.status === 'error' ? <div><dt><Trans>Status</Trans></dt><dd>{facts.error ?? t`Setup did not finish.`}</dd></div> : null}
      </dl>
      {thread.remoteHost ? <p className="tt-paragraph"><Trans>This folder is on the host machine. Open it there.</Trans></p> : null}
      <div className="working-copy__actions">
        {facts.directory && !facts.reclaimed ? <Button variant="secondary" aria-disabled={running !== null || thread.remoteHost === true} onClick={() => { if (!thread.remoteHost) void run('open-thread-folder') }}><FolderOpen size={15} aria-hidden="true" />{t`Open folder`}</Button> : null}
        {thread.worktree ? <Button variant="ghost" aria-disabled={running !== null} onClick={() => void run('refresh-thread-worktree')}><RefreshCw size={15} aria-hidden="true" />{running === 'refresh-thread-worktree' ? t`Checking...` : t`Refresh`}</Button> : null}
        {reclaimable ? <Button variant="ghost" aria-disabled={running !== null} aria-label={t`Remove worktree folder, keeping its branch`} onClick={() => setReclaiming(facts.dirty ? 'dirty' : 'clean')}><FolderMinus size={15} aria-hidden="true" />{running === 'reclaim-thread-worktree' ? t`Removing…` : t`Remove worktree`}</Button> : null}
      </div>
      {error && !reclaiming ? <p className="agent-error tt-paragraph" role="alert">{error}</p> : null}
    </div> : null}
    {reclaiming ? <ReclaimWorktreeDialog facts={facts} dirty={reclaiming === 'dirty'} threadId={thread.id} command={command} fallbackFocusRef={trigger} removalError={error} onCancel={() => setReclaiming(false)} onConfirm={confirmReclaim} /> : null}
  </span>
}

/** The worktree Sotto made for this thread alone can be given back; a shared, reused or already reclaimed folder is never offered. */
export function isReclaimable(thread: Pick<AgentThread, 'worktree'>): boolean {
  const worktree = thread.worktree
  return worktree?.mode === 'independent' && worktree.status === 'ready' && Boolean(worktree.path) && !worktree.reused && !worktree.reclaimedAt
}

/** What a worktree folder holds that Git ignores, and its nested repositories and worktrees, each once. */
export function worktreeListedPaths(preview: Pick<WorktreeReclaimPreview, 'ignored' | 'repositories'>): string[] {
  return [...new Set([...preview.ignored, ...preview.repositories.map(repository => repository.path)])]
}

/**
 * ADR-0041's List and tick: the ignored items and nested work a worktree folder holds, and the tick that agrees to delete
 * them with it. Remove worktree and Delete thread… (ADR-0140) both ask it. Nothing is drawn for a folder with none.
 */
export function WorktreeFilesToTick({ preview, tickable, acknowledged, onAcknowledge }: {
  readonly preview: WorktreeReclaimPreview
  /** False while the folder cannot be removed at all: the list still shows, with nothing to tick. */
  readonly tickable: boolean
  readonly acknowledged: boolean
  readonly onAcknowledge: (acknowledged: boolean) => void
}): ReactNode {
  const { t } = useLingui()
  const listedPaths = worktreeListedPaths(preview)
  if (!listedPaths.length) return null
  const nestedKinds = [...new Set(preview.repositories.map(item => item.kind))]
  /** The acknowledgement: how many ignored items go, and whose uncommitted work goes with them when a nested checkout is listed. */
  const items = listedPaths.length
  const nested = !preview.repositories.length ? 'none' : nestedKinds.length !== 1 ? 'mixed'
    : preview.repositories.length === 1 ? nestedKinds[0]! : nestedKinds[0] === 'repository' ? 'repositories' : 'worktrees'
  const acknowledgement = nested === 'none' ? plural(items, { one: `Delete this ${{ itemCount: shownCount(items) }} ignored item with the folder`, other: `Delete these ${{ itemCount: shownCount(items) }} ignored items with the folder` })
    : nested === 'repository' ? plural(items, { one: `Delete this ${{ itemCount: shownCount(items) }} ignored item with the folder, including the nested repository’s uncommitted work`, other: `Delete these ${{ itemCount: shownCount(items) }} ignored items with the folder, including the nested repository’s uncommitted work` })
      : nested === 'worktree' ? plural(items, { one: `Delete this ${{ itemCount: shownCount(items) }} ignored item with the folder, including the nested worktree’s uncommitted work`, other: `Delete these ${{ itemCount: shownCount(items) }} ignored items with the folder, including the nested worktree’s uncommitted work` })
        : nested === 'repositories' ? plural(items, { one: `Delete this ${{ itemCount: shownCount(items) }} ignored item with the folder, including the nested repositories’ uncommitted work`, other: `Delete these ${{ itemCount: shownCount(items) }} ignored items with the folder, including the nested repositories’ uncommitted work` })
          : nested === 'worktrees' ? plural(items, { one: `Delete this ${{ itemCount: shownCount(items) }} ignored item with the folder, including the nested worktrees’ uncommitted work`, other: `Delete these ${{ itemCount: shownCount(items) }} ignored items with the folder, including the nested worktrees’ uncommitted work` })
            : plural(items, { one: `Delete this ${{ itemCount: shownCount(items) }} ignored item with the folder, including the nested repositories and worktrees’ uncommitted work`, other: `Delete these ${{ itemCount: shownCount(items) }} ignored items with the folder, including the nested repositories and worktrees’ uncommitted work` })
  return <>
    <div className="working-copy__callout"><Trans>These files are ignored by Git and are deleted with the folder:</Trans></div>
    <ul className="working-copy__ignored">{listedPaths.map(path => {
      const repository = preview.repositories.find(item => item.path === path)
      const item = preview.items.find(item => item.path === path)
      const kilobytes = item ? shownLocalCount(Math.max(1, Math.ceil(item.bytes / 1024))) : ''
      const files = item?.fileCount ?? 0
      const size = !item ? t({ message: 'Ignored', comment: 'A file Git ignores.' })
        : path.endsWith('/') ? plural(files, { one: `${kilobytes} KB, ${{ fileCount: shownCount(files) }} file, ignored`, other: `${kilobytes} KB, ${{ fileCount: shownCount(files) }} files, ignored` })
          : t`${kilobytes} KB, ignored`
      const changes = repository?.changeCount ?? 0, unpushed = repository?.unpushedCommitCount ?? 0
      const note = !repository ? size
        : repository.kind === 'repository'
          ? t`Nested repository · ${plural(changes, { one: `${{ changeCount: shownCount(changes) }} uncommitted change`, other: `${{ changeCount: shownCount(changes) }} uncommitted changes` })} · ${plural(unpushed, { one: `${{ commitCount: shownCount(unpushed) }} commit not on any remote`, other: `${{ commitCount: shownCount(unpushed) }} commits not on any remote` })}`
          : t`Nested worktree · ${plural(changes, { one: `${{ changeCount: shownCount(changes) }} uncommitted change`, other: `${{ changeCount: shownCount(changes) }} uncommitted changes` })}`
      return <li key={path}><span className="working-copy__path">{path}</span><span className={repository ? 'working-copy__nested-note' : 'working-copy__file-note'}>{note}</span></li>
    })}</ul>
    {tickable ? <label className="working-copy__acknowledge"><input type="checkbox" checked={acknowledged} onChange={event => onAcknowledge(event.target.checked)} />{acknowledgement}</label> : null}
  </>
}

const FOLDER_UNCHECKED = msg`The folder could not be checked. Nothing was removed. Close this question and try again.`

/** The one question before a worktree folder goes: what is in it, and that the branch stays (ADR-0041). */
export function ReclaimWorktreeDialog({ facts, dirty, title, threadId, command, onConfirm, onCancel, fallbackFocusRef, removalError }: {
  readonly facts: Pick<WorkingCopyFacts, 'branch'>
  readonly dirty: boolean
  readonly title?: string | undefined
  readonly threadId: string
  readonly command: AgentConnection['command']
  readonly removalError?: string | null
  readonly onConfirm: (preview: WorktreeReclaimPreview) => Promise<boolean>
  readonly onCancel: () => void
  readonly fallbackFocusRef?: React.RefObject<HTMLElement | null> | undefined
}): ReactNode {
  const { t } = useLingui()
  const [preview, setPreview] = useState<WorktreeReclaimPreview | null>(null)
  const [failure, setFailure] = useState<LaterWords | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  useEffect(() => {
    let active = true
    void command({ type: 'preview-reclaim-thread-worktree', threadId }).then(result => {
      if (!active) return
      const facts = result?.worktreeReclaimPreview
      if (result?.error || !facts) setFailure(result?.error ?? FOLDER_UNCHECKED)
      else setPreview(facts)
    }).catch(() => { if (active) setFailure(FOLDER_UNCHECKED) })
    return () => { active = false }
  }, [command, threadId])
  const hasChanges = dirty || preview?.dirty === true
  const blocked = Boolean(preview?.outsideLink || (preview && !preview.branch))
  const listedPaths = preview ? worktreeListedPaths(preview) : []
  const branch = facts.branch
  const outsideLink = preview?.outsideLink
  return <ConfirmationDialog title={title ?? t`Remove this worktree?`} danger
    confirmDisabled={!preview || blocked || (preview.ignored.length > 0 && !acknowledged)}
    description={<>
      <p className="tt-paragraph">{branch
        ? <Trans comment="{branch} is a Git branch name.">This thread’s worktree folder and everything installed in it is removed. The branch {ph({ branch: leftToRight(branch) })} keeps its commits, and sending to this thread puts the folder back.</Trans>
        : <Trans>This thread’s worktree folder and everything installed in it is removed. Its commits are kept, and sending to this thread puts the folder back.</Trans>}</p>
      {!preview && !failure ? <p className="tt-paragraph" role="status"><Trans>Checking the folder…</Trans></p> : null}
      {failure ? <p className="tt-paragraph" role="alert">{shownWords(failure)}</p> : null}
      {hasChanges ? <p className="tt-paragraph"><Trans><strong>This folder has uncommitted changes.</strong> They are lost with it.</Trans></p> : null}
      {preview ? <WorktreeFilesToTick preview={preview} tickable={!blocked} acknowledged={acknowledged} onAcknowledge={setAcknowledged} /> : null}
      {preview && !preview.branch ? <p className="tt-paragraph" role="alert"><Trans>This folder has no branch checked out. Switch it to a branch before removing it. Nothing was changed.</Trans></p> : null}
      {outsideLink ? <p className="tt-paragraph" role="alert"><Trans comment="{outsideLink} is the folder a link points to.">Remove the link to another folder ({outsideLink}) before removing this folder. Nothing was changed.</Trans></p> : null}
    </>}
    confirmLabel={listedPaths.length ? t`Remove with these files` : hasChanges ? t`Remove and lose changes` : t`Remove worktree`} cancelLabel={t`Keep folder`} {...(fallbackFocusRef ? { fallbackFocusRef } : {})}
    failureMessage={removalError ?? t`Nothing was removed. Close this question and choose Remove worktree again to review the folder.`} onConfirm={async () => preview && !blocked && (!preview.ignored.length || acknowledged) ? onConfirm(preview) : false} onCancel={onCancel} />
}

/**
 * Settle a thread, then ask whether its own worktree should go with it (ADR-0041). The Settle press
 * settles at once, as it always has; the question is a separate one, answered by Keep folder or Escape.
 * With the on-settle rule turned on, a clean folder goes without the question and a dirty one still asks.
 */
export function useSettleThread(command: AgentConnection['command'], fallbackFocusRef?: React.RefObject<HTMLElement | null>) {
  const app = useOptionalApp()
  const { t } = useLingui()
  const [removalError, setRemovalError] = useState<string | null>(null)
  const onSettleRule = app?.settings?.worktreeCleanup.onSettle === true
  const [questions, setQuestions] = useState<readonly { thread: WorkingCopyThread; project: Pick<AgentProject, 'path'> | undefined; dirty: boolean }[]>([])
  const asking = questions[0]
  const nextQuestion = (): void => { setRemovalError(null); setQuestions(current => current.slice(1)) }
  const settle = useCallback(async (thread: WorkingCopyThread, project: Pick<AgentProject, 'path'> | undefined): Promise<boolean> => {
    const result = await command({ type: 'settle-thread', threadId: thread.id })
    if (!result || result.error) return false
    if (!isReclaimable(thread)) return true
    const dirty = thread.worktree?.dirty === true
    if (onSettleRule && !dirty) { void command({ type: 'reclaim-thread-worktree', threadId: thread.id }); return true }
    setQuestions(current => current.some(question => question.thread.id === thread.id) ? current : [...current, { thread, project, dirty }])
    return true
  }, [command, onSettleRule])
  const dialog = asking ? <ReclaimWorktreeDialog key={asking.thread.id} facts={describeWorkingCopy(asking.thread, asking.project)} dirty={asking.dirty} title={t`Remove its worktree too?`} removalError={removalError} threadId={asking.thread.id} command={command} fallbackFocusRef={fallbackFocusRef}
    onCancel={nextQuestion}
    onConfirm={async preview => {
      setRemovalError(null)
      const result = await command({ type: 'reclaim-thread-worktree', threadId: asking.thread.id, withUncommittedChanges: asking.dirty || preview.dirty, confirmedIgnored: preview.ignored, confirmedItems: preview.items.map(({ path, fileCount }) => ({ path, fileCount })), confirmedRepositories: preview.repositories })
      if (result && !result.error) return true
      setRemovalError(result?.error ?? null)
      if (!asking.dirty && result?.error === RECLAIM_WORKTREE_NEEDS_CONFIRMATION) setQuestions(current => current.map(question => question.thread.id === asking.thread.id ? { ...question, dirty: true } : question))
      return false
    }} /> : null
  return { settle, dialog }
}

/**
 * Above the pane composer: a failed setup and the one action that can recover it, or the local branch notice for a
 * worktree that started from the local branch because origin had nothing to fetch. The draft stays untouched.
 */
export function ThreadWorkingCopyNotice({ thread, project, command, onRecovered }: ThreadWorkingCopyProps & { readonly onRecovered?: (() => void) | undefined }): ReactNode {
  const { t } = useLingui()
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
    const base = thread.worktree?.baseBranch ?? t({ message: 'the branch', comment: 'Stands for a branch\'s name when the record has none.' })
    return <div className="working-copy-notice" data-tone="status" role="status">
      <p className="tt-paragraph">{originBase === 'not-on-origin'
        ? <Trans comment="{base} is a Git branch name."><strong>origin/{ph({ base: leftToRight(base) })} was not found</strong>, so the worktree started from the local branch {ph({ base: leftToRight(base) })}.</Trans>
        : <Trans comment="{base} is a Git branch name."><strong>This project has no origin</strong>, so the worktree started from the local branch {ph({ base: leftToRight(base) })}.</Trans>}</p>
      <Button variant="secondary" aria-label={t`Dismiss the local branch notice`} onClick={() => { dismissLocalBranchNotice(thread.id); rerender(value => value + 1) }}><Trans>Dismiss</Trans></Button>
    </div>
  }
  if (facts.status !== 'error') return null
  // Setup can only be retried before native work starts; afterwards Sotto only re-checks the bound folder.
  const retry = thread.nativeSessionStarted === false
  const action: Action = retry ? 'retry-thread-worktree' : 'refresh-thread-worktree'
  return <div className="working-copy-notice" role="alert">
    <p className="tt-paragraph"><strong>{retry ? t`Worktree not ready.` : t`Working folder unavailable.`}</strong> {facts.error ?? t`Setup did not finish.`}</p>
    <Button variant="secondary" aria-disabled={running !== null} onClick={() => { if (running) return; recovering.current = true; void run(action).then(done => { if (!done) recovering.current = false }) }}>
      <RefreshCw size={15} aria-hidden="true" />{running ? (retry ? t`Retrying...` : t`Checking...`) : retry ? t`Retry setup` : t`Check again`}
    </Button>
    {error && error !== facts.error ? <p className="working-copy-notice__result tt-paragraph">{error}</p> : null}
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
  const { t } = useLingui()
  const facts = describeWorkingCopy(thread, project)
  const sent = thread.worktree?.sentBranch ?? ''
  const [, rerender] = useState(0)
  const [confirming, setConfirming] = useState(false)
  const { running, error, lastError, run } = useWorkingCopyAction(thread.id, command)
  const trigger = useRef<HTMLButtonElement>(null)
  const changed = facts.status === 'ready' && facts.mode === 'shared' && Boolean(sent) && Boolean(facts.branch) && sent !== facts.branch
  // A later switch is a new thing to say, so dismissal is remembered for this pair of branches alone.
  const change = [thread.id, sent ?? '', facts.branch ?? ''].join('\n')
  const dismiss = (): void => { dismissedBranchNotices.add(change); rerender(value => value + 1) }
  const branch = facts.branch
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
    <p className="tt-paragraph">{branch
      ? <Trans comment="{sent} is the branch the last send went to; {branch} is the one the folder is on now."><strong>Branch changed, was {ph({ sent: leftToRight(sent) })}.</strong> Sending will continue on {ph({ branch: leftToRight(branch) })}.</Trans>
      : <Trans comment="{sent} is the branch the last send went to."><strong>Branch changed, was {ph({ sent: leftToRight(sent) })}.</strong> This folder has no branch checked out; sending will continue there.</Trans>}</p>
    <Button ref={trigger} variant="secondary" aria-disabled={running !== null} aria-label={t({ message: `Restore branch ${ph({ sent: leftToRight(sent) })}`, comment: '{sent} is a Git branch name.' })}
      onClick={() => { if (facts.dirty) setConfirming(true); else restore() }}>
      <Undo2 size={15} aria-hidden="true" />{running === 'restore-thread-branch' ? t`Switching…` : t`Restore branch`}
    </Button>
    <Button variant="ghost" aria-label={t`Dismiss the branch notice`} onClick={() => dismiss()}><Trans>Dismiss</Trans></Button>
    {error && !confirming ? <p className="branch-notice__result tt-paragraph" role="alert">{error}</p> : null}
    {confirming ? <ConfirmationDialog title={t({ message: `Switch back to ${ph({ sent: leftToRight(sent) })}?`, comment: '{sent} is a Git branch name.' })} danger={false}
      description={<Trans comment="{sent} is a Git branch name.">This folder has uncommitted changes. They move with the switch to {ph({ sent: leftToRight(sent) })}, and Git refuses the switch if they would conflict.</Trans>}
      confirmLabel={t`Switch branch`} cancelLabel={t`Keep this branch`} fallbackFocusRef={trigger}
      failureMessage={t`The branch could not be switched. Nothing was changed.`}
      onConfirm={async () => run('restore-thread-branch', true)}
      onCancel={() => setConfirming(false)} /> : null}
  </div>
}
