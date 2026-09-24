import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { History } from 'lucide-react'
import type { z } from 'zod'
import type { Checkpoint, checkpointInspectionSchema, checkpointListingSchema } from '../../../shared/checkpoints'
import type { GitChangesBridge } from '../../../shared/gitChanges'
import type { ToolsResult } from '../../../shared/tools'
import type { ChangesStore, ThreadChanges } from './changesStore'

/**
 * The Checkpoints drawer. It opens under the Changes line of chrome, and its toggle is drawn into that line
 * (`toggleSlot`), so no bar of its own sits between the line and the work. Commit, branch and push are the Git
 * action's in the pane header, and staging left the UI with it (ADR-0027); the commit dialog's file list is the choice.
 */
export function GitActions({ threadId, changes, bridge, store, toggleSlot }: {
  threadId: string; changes: ThreadChanges; bridge: GitChangesBridge | undefined; store: ChangesStore
  toggleSlot: HTMLElement | null
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false), [status, setStatus] = useState('')
  const [checkpoints, setCheckpoints] = useState<z.infer<typeof checkpointListingSchema> | null>(null)
  const [inspection, setInspection] = useState<z.infer<typeof checkpointInspectionSchema> | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const generation = useRef(0)
  useEffect(() => { generation.current++; setOpen(false); setStatus(''); setCheckpoints(null); setInspection(null); setBusy(false) }, [threadId, changes.workspace?.workspaceId])
  if (!changes.workspace || changes.list.status !== 'ready' || !bridge) return null
  const target = { threadId, workspaceId: changes.workspace.workspaceId }
  const run = async <T,>(operation: () => Promise<ToolsResult<T>>, success: (value: T) => void | Promise<void>): Promise<void> => {
    if (busy) return
    const token = generation.current
    setBusy(true); setStatus('')
    try {
      const result = await operation()
      if (token !== generation.current) return
      if (result.ok) await success(result.value); else setStatus(result.error.message)
    } catch { if (token === generation.current) setStatus('Sotto did not confirm this action. Refresh before trying again.') }
    finally { if (token === generation.current) setBusy(false) }
  }
  const select = (checkpoint: Checkpoint): void => {
    if (!bridge.inspectCheckpoint) return
    setInspection(null); setConfirmed(false)
    void run(() => bridge.inspectCheckpoint!({ ...target, checkpointId: checkpoint.id }), setInspection)
  }
  const toggle = (): void => {
    setOpen(!open); setStatus('')
    if (!open && bridge.checkpoints) void run(() => bridge.checkpoints!(target), setCheckpoints)
  }
  const revert = (recover: boolean): void => {
    if (!inspection || (!recover && !confirmed)) return
    if (recover ? !bridge.recoverCheckpoint : !bridge.revertCheckpoint) return
    const request = { ...target, checkpointId: inspection.checkpoint.id }
    void run(() => recover ? bridge.recoverCheckpoint!(request) : bridge.revertCheckpoint!({ ...request, confirmed: true }), value => {
      setInspection({ ...inspection, checkpoint: value }); setConfirmed(false)
      setStatus(value.status === 'reverted' ? 'Files and native conversation reverted.' : value.reason ?? 'Revert needs recovery.')
      void store.refresh(bridge, threadId)
      if (bridge.checkpoints) void bridge.checkpoints(target).then(result => { if (result.ok) setCheckpoints(result.value) })
    })
  }
  const toggles = bridge.checkpoints ? <button type="button" className="tools-chrome__button tt-focusable" title="Checkpoints" aria-expanded={open} onClick={toggle}>
    <History size={16} aria-hidden="true" /><span className="tools-chrome__button-label">Checkpoints</span></button> : null
  const drawer = open || busy || status !== ''
  return <>
    {toggleSlot && toggles ? createPortal(toggles, toggleSlot) : null}
    {drawer ? <section className="git-actions" aria-label="Checkpoints">
    {open ? <div className="git-actions__drawer">
      {!checkpoints ? <p role="status">Reading checkpoints…</p> : <>
        {!checkpoints.supported ? <p>{checkpoints.reason}</p> : null}
        {checkpoints.checkpoints.length === 0 ? <p>No completed checkpoints yet.</p> : <ul className="checkpoint-list">{checkpoints.checkpoints.map((checkpoint, index) => <li key={checkpoint.id}>
          <button type="button" className="files-link tt-focusable" disabled={busy} onClick={() => select(checkpoint)}>Checkpoint {checkpoints.checkpoints.length - index} · {checkpoint.files.length} {checkpoint.files.length === 1 ? 'file' : 'files'} · {checkpoint.status}</button>
        </li>)}</ul>}
      </>}
      {inspection ? <section aria-label="Checkpoint review">
        {inspection.patches.map(patch => <details key={patch.path} className="checkpoint-file"><summary className="tt-focusable">{patch.path}</summary>{patch.binary ? <p>Binary or large file. File contents will be restored from its saved checkpoint.</p> : <div className="checkpoint-versions"><div><strong>Restore to</strong><pre>{patch.before ?? '(file did not exist)'}</pre></div><div><strong>After turn</strong><pre>{patch.after ?? '(file deleted)'}</pre></div></div>}</details>)}
        {inspection.checkpoint.reason ? <p>{inspection.checkpoint.reason}</p> : null}
        {inspection.checkpoint.supported && inspection.checkpoint.status === 'ready' ? <>
          <label className="checkpoint-confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />Restore {inspection.checkpoint.files.length === 1 ? 'this file' : `these ${inspection.checkpoint.files.length} files`} and remove this completed turn from the native conversation.</label>
          <button type="button" className="files-link tt-focusable" disabled={busy || !confirmed} onClick={() => revert(false)}>Revert files and conversation</button>
        </> : null}
        {['uncertain', 'reverting'].includes(inspection.checkpoint.status) ? <button type="button" className="files-link tt-focusable" disabled={busy} onClick={() => revert(true)}>Check recovery</button> : null}
      </section> : null}
    </div> : null}
    {busy || status ? <p className="git-actions__status" role="status">{busy ? 'Working…' : status}</p> : null}
    </section> : null}
  </>
}
