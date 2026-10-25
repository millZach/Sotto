import React, { useEffect, useState, type ReactNode } from 'react'
import { Trash2 } from 'lucide-react'
import type { AgentClientHost, AgentState, AgentThread, ThreadDeletePreview } from '../../../shared/agents'
import { threadClearKeptWords } from '../../../shared/threadClear'
import { ConfirmationDialog } from '../components/ConfirmationDialog'
import { useOwlFeature } from '../state/owlFeature'
import type { AgentConnection } from './AgentContext'
import { threadHostName } from './HostBadge'
import type { PaneMenuItem } from './PaneMenu'
import { focusedComposerField } from './promptSelection'
import type { ThreadRow } from './threadFacts'
import { WorktreeFilesToTick, worktreeListedPaths } from './ThreadWorkingCopy'
import './threadClear.css'

type Command = AgentConnection['command']

const CHECK_FAILED = 'Sotto could not check this thread. Nothing was deleted. Close this and try again.'
const DELETE_UNCONFIRMED = 'Sotto could not confirm the delete. If the thread is still listed, nothing was deleted.'

/**
 * Whether this thread's host deletes threads when asked (ADR-0140 decision 7): this computer, or a paired host that lists
 * `thread-delete`, which the desktop marks on the host's `clientHosts` entry. A window shown no host list is this computer's own.
 */
export function offersThreadDelete(clientHosts: readonly Pick<AgentClientHost, 'hostId' | 'threadDelete'>[] | undefined,
  thread: Pick<AgentThread, 'hostId' | 'remoteHost'>): boolean {
  const host = clientHosts?.find(item => item.hostId === thread.hostId)
  return host ? host.threadDelete === true : thread.remoteHost !== true
}

/**
 * Delete thread… for a pane's More menu (ADR-0140; Owl only): offered on a thread settled on its own or with its project,
 * never on Watcher's own, last and in the error colour. On a paired host that cannot delete yet it is listed off, saying
 * to update the host. Returns the menu's group, empty when it is not offered, and the dialog while it is open.
 */
export function useDeleteThread(row: ThreadRow, state: AgentState, command: Command, options: { readonly ownPane?: boolean } = {}): { readonly items: PaneMenuItem[]; readonly dialog: ReactNode } {
  const enabled = useOwlFeature('clear-threads')
  const [open, setOpen] = useState(false)
  const thread = row.thread
  useEffect(() => { setOpen(false) }, [thread.id])
  const offered = enabled && options.ownPane !== true && (row.settledBy === 'thread' || row.settledBy === 'project')
    && thread.kind !== 'watcher' && thread.kind !== 'watcher-history'
  if (!offered) return { items: [], dialog: null }
  const refusal = offersThreadDelete(state.host.clientHosts, thread) ? null : `Update ${threadHostName(state, thread)} to delete its threads`
  const items: PaneMenuItem[] = [{ id: 'delete', label: 'Delete thread…', icon: <Trash2 size={15} aria-hidden="true" />, tone: 'danger',
    disabled: refusal !== null, ...(refusal !== null ? { hint: refusal } : {}), run: () => setOpen(true) }]
  const dialog = open ? <DeleteThreadDialog threadId={thread.id} title={thread.title} provider={row.provider} command={command} onClose={() => setOpen(false)} /> : null
  return { items, dialog }
}

/** Once the deleted thread's pane has gone: the cursor in the pane that now has focus, or else the empty page's heading. */
function focusAfterDelete(): void {
  window.setTimeout(() => {
    const active = document.activeElement
    if (active && active !== document.body && active.isConnected) return
    const target = focusedComposerField()
      ?? document.querySelector<HTMLElement>('.thread-pane .thread-workspace__compose .prompt-editor[contenteditable="true"]')
      ?? document.querySelector<HTMLElement>('.thread-workspace__empty--page h2')
    target?.focus()
  }, 0)
}

/** Why one thread is kept, in a sentence's middle; the worktree's own trouble named when the folder's facts say it. */
function keptWords(preview: ThreadDeletePreview): string {
  const worktree = preview.worktree
  if (preview.kept === 'worktree-error') {
    if (worktree?.outsideLink) return `its worktree folder links to another folder (${worktree.outsideLink}); remove the link first`
    if (worktree && !worktree.branch) return 'its worktree folder has no branch checked out; switch it to a branch first'
    return 'its worktree folder could not be checked'
  }
  return threadClearKeptWords(preview.kept!)
}

/**
 * Delete “title”? (ADR-0140): asks main what deleting this one thread would do, then says why it is kept, or lists what goes
 * and what stays, with ADR-0041's List and tick for a worktree holding ignored files or nested work. Nothing can be taken back.
 */
export function DeleteThreadDialog({ threadId, title, provider, command, onClose }: {
  readonly threadId: string
  readonly title: string
  /** The provider's name, which keeps its own copy of the session. */
  readonly provider: string
  readonly command: Command
  readonly onClose: () => void
}): ReactNode {
  const [preview, setPreview] = useState<ThreadDeletePreview | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  useEffect(() => {
    let active = true
    void command({ type: 'preview-delete-thread', threadId }).then(result => {
      if (!active) return
      if (result?.error || !result?.threadDeletePreview) setFailure(result?.error ?? CHECK_FAILED)
      else setPreview(result.threadDeletePreview)
    }).catch(() => { if (active) setFailure(CHECK_FAILED) })
    return () => { active = false }
  }, [command, threadId])
  const kept = preview?.kept ?? null
  const worktree = preview?.worktree ?? null
  const listed = worktree ? worktreeListedPaths(worktree) : []
  const closeOnly = failure !== null || kept !== null
  const remove = async (): Promise<boolean> => {
    if (!preview || preview.kept !== null) return false
    setDeleteError(null)
    const confirmations = worktree ? { confirmedIgnored: worktree.ignored, confirmedItems: worktree.items.map(({ path, fileCount }) => ({ path, fileCount })),
      confirmedRepositories: worktree.repositories.map(({ path, changeCount, unpushedCommitCount, kind }) => ({ path, changeCount, kind, ...(unpushedCommitCount !== undefined ? { unpushedCommitCount } : {}) })) } : {}
    const result = await command({ type: 'delete-thread', threadId, ...confirmations }).catch(() => null)
    if (result && !result.error) { focusAfterDelete(); return true }
    setDeleteError(result?.error ?? DELETE_UNCONFIRMED)
    return false
  }
  return <ConfirmationDialog title={`Delete “${title}”?`} danger withoutConfirm={closeOnly}
    confirmLabel="Delete" cancelLabel={closeOnly ? 'Close' : 'Cancel'}
    confirmDisabled={!preview || (listed.length > 0 && !acknowledged)}
    failureMessage={deleteError ?? DELETE_UNCONFIRMED} pendingStatus="Deleting…"
    description={<div className="thread-clear">
      {!preview && !failure ? <p role="status">Checking the thread…</p> : null}
      {failure ? <p role="alert">{failure}</p> : null}
      {preview && kept !== null ? <p>This thread can’t be deleted: {keptWords(preview)}. Nothing was deleted.</p> : null}
      {preview && kept === null ? <>
        <ul className="thread-clear__facts">
          <li>Its messages and activity leave Sotto and can’t be brought back.</li>
          {worktree ? <li>Removes the worktree folder it made. Its branch and commits stay.</li> : null}
          <li>Usage keeps its numbers. {provider} keeps its own copy of the session.</li>
        </ul>
        {worktree ? <WorktreeFilesToTick preview={worktree} tickable acknowledged={acknowledged} onAcknowledge={setAcknowledged} /> : null}
      </> : null}
    </div>}
    onConfirm={remove} onCancel={onClose} />
}
