import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import type { z } from 'zod'
import type { Checkpoint, checkpointInspectionSchema, checkpointListingSchema } from '../../../shared/checkpoints'
import type { GitChangesBridge, gitActionSchema } from '../../../shared/gitChanges'
import type { ToolsResult } from '../../../shared/tools'
import type { ChangesStore, ThreadChanges } from './changesStore'

export function GitActions({ threadId, changes, bridge, store }: { threadId: string; changes: ThreadChanges; bridge: GitChangesBridge | undefined; store: ChangesStore }): ReactNode {
  const [open, setOpen] = useState<'git' | 'checkpoints' | null>(null)
  const [message, setMessage] = useState(''), [branch, setBranch] = useState('')
  const [branches, setBranches] = useState<string[]>([]), [busy, setBusy] = useState(false), [status, setStatus] = useState('')
  const [checkpoints, setCheckpoints] = useState<z.infer<typeof checkpointListingSchema> | null>(null)
  const [inspection, setInspection] = useState<z.infer<typeof checkpointInspectionSchema> | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [drafting, setDrafting] = useState(false), [draftNote, setDraftNote] = useState('')
  const generation = useRef(0)
  useEffect(() => { generation.current++; setOpen(null); setStatus(''); setMessage(''); setBranch(''); setBranches([]); setCheckpoints(null); setInspection(null); setBusy(false); setDrafting(false); setDraftNote('') }, [threadId, changes.workspace?.workspaceId])
  if (!changes.workspace || changes.list.status !== 'ready' || !bridge) return null
  const target = { threadId, workspaceId: changes.workspace.workspaceId }, listing = changes.list
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
  const action = (action: z.infer<typeof gitActionSchema>['action'], path?: string): void => {
    if (!bridge.act) return
    void run(() => bridge.act!({ ...target, revision: listing.revision, action, ...(path ? { path } : {}), ...(action === 'commit' ? { message } : {}), ...(['checkout', 'create-branch'].includes(action) ? { branch } : {}) }), async () => {
      if (action === 'commit') setMessage('')
      await store.refresh(bridge, threadId)
      setStatus(action === 'commit' ? 'Commit created.' : action === 'stage' ? 'Change staged.' : action === 'unstage' ? 'Change unstaged.' : 'Branch changed.')
    })
  }
  const select = (checkpoint: Checkpoint): void => {
    if (!bridge.inspectCheckpoint) return
    setInspection(null); setConfirmed(false)
    void run(() => bridge.inspectCheckpoint!({ ...target, checkpointId: checkpoint.id }), setInspection)
  }
  const staged = listing.files.filter(file => file.staged).length
  /**
   * Sotto writes the first draft from the staged diff; the field stays the user's.
   * A draft that arrives after the user has typed is dropped rather than pasted
   * over their words, and a draft is never committed on its own.
   */
  const draft = (replace: boolean): void => {
    if (!bridge.draftCommitMessage || drafting || staged === 0) return
    const token = generation.current, from = message
    if (!replace && from.trim().length > 0) return
    setDrafting(true); setDraftNote('')
    void bridge.draftCommitMessage({ ...target, revision: listing.revision })
      .then(result => {
        if (token !== generation.current || !result.ok) return
        const written = result.value.message
        if (written) setMessage(current => (replace || current === from ? written : current))
        if (written && result.value.truncated) setDraftNote('The staged diff was too large to send whole, so this draft covers only its first part.')
      })
      .catch(() => undefined)
      .finally(() => { if (token === generation.current) setDrafting(false) })
  }
  const selected = listing.files.find(file => file.path === changes.selectedPath)
  const toggle = (next: 'git' | 'checkpoints'): void => {
    setOpen(open === next ? null : next); setStatus('')
    if (open === next) return
    if (next === 'git') draft(false)
    if (next === 'git' && bridge.branches) void run(() => bridge.branches!(target), value => setBranches(value.branches))
    if (next === 'checkpoints' && bridge.checkpoints) void run(() => bridge.checkpoints!(target), setCheckpoints)
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
  return <section className="git-actions" aria-label="Local Git actions">
    <div className="git-actions__bar">
      {bridge.act ? <button type="button" className="files-link tt-focusable" aria-expanded={open === 'git'} onClick={() => toggle('git')}>Git actions</button> : null}
      {bridge.checkpoints ? <button type="button" className="files-link tt-focusable" aria-expanded={open === 'checkpoints'} onClick={() => toggle('checkpoints')}>Checkpoints</button> : null}
      {selected && bridge.act ? <span className="git-actions__stage">
        {selected.unstaged ? <button className="files-link tt-focusable" type="button" disabled={busy} onClick={() => action('stage', selected.path)}>Stage file</button> : null}
        {selected.staged ? <button className="files-link tt-focusable" type="button" disabled={busy} onClick={() => action('unstage', selected.path)}>Unstage file</button> : null}
      </span> : null}
    </div>
    {open === 'git' ? <div className="git-actions__drawer">
      <form onSubmit={event => { event.preventDefault(); action('commit') }}>
        <label htmlFor={`commit-${threadId}`}>Commit message</label>
        <textarea id={`commit-${threadId}`} className="tt-focusable" rows={4} value={message} onChange={event => setMessage(event.target.value)} placeholder="Describe the staged changes" maxLength={10000} />
        {drafting ? <p className="git-actions__status" role="status">Writing…</p> : null}
        {draftNote ? <p className="git-actions__status">{draftNote}</p> : null}
        <div className="git-actions__bar">
          <button className="files-link tt-focusable" type="submit" disabled={busy || drafting || !message.trim() || staged === 0}>Commit staged changes ({staged})</button>
          {bridge.draftCommitMessage ? <button type="button" className="files-link tt-focusable" disabled={busy || drafting || staged === 0} onClick={() => draft(true)}>Regenerate</button> : null}
        </div>
      </form>
      <div className="git-actions__branch">
        <label htmlFor={`branch-${threadId}`}>Local branch</label>
        <input id={`branch-${threadId}`} className="tt-focusable" list={`branches-${threadId}`} value={branch} onChange={event => setBranch(event.target.value)} placeholder={listing.branch ?? 'Detached HEAD'} maxLength={240} />
        <datalist id={`branches-${threadId}`}>{branches.map(name => <option key={name} value={name} />)}</datalist>
        <div className="git-actions__bar"><button type="button" className="files-link tt-focusable" disabled={busy || !branch.trim()} onClick={() => action('checkout')}>Switch branch</button>
          <button type="button" className="files-link tt-focusable" disabled={busy || !branch.trim()} onClick={() => action('create-branch')}>Create branch</button></div>
      </div>
    </div> : null}
    {open === 'checkpoints' ? <div className="git-actions__drawer">
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
  </section>
}
