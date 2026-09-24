import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { parsePullRequestReference, type GitPullRequestDetail, type GitPullRequestRequest } from '../../../shared/gitPullRequests'
import type { AgentCommand, AgentState } from '../../../shared/agents'
import { Button } from '../components/Button'
import { useDialogFocus } from '../components/useDialogFocus'
import { stateLabel } from './pullRequestSurface.logic'

type Command = (command: AgentCommand) => Promise<AgentState | null>
const RESOLVE_DELAY_MS = 450

/** The bridge call a dialog resolves a reference through; absent in a window without the preload. */
export function pullRequestBridge(): ((request: GitPullRequestRequest) => Promise<GitPullRequestDetail | null>) | undefined {
  return window.sotto?.agents?.gitPullRequest
}

/** T3's validation words for a reference field. */
function referenceProblem(reference: string): string | null {
  if (!reference.trim()) return 'Paste a pull request URL or enter 123 / #123.'
  return parsePullRequestReference(reference) ? null : 'Use a pull request URL, 123, or #123.'
}

/** Sends one pull request command and answers with the refusal in the host's words, or the host's notice when it went through. */
export async function sendCommand(command: Command, request: AgentCommand, fallback: string): Promise<{ error: string | null; notice: string | null }> {
  try {
    const result = await command(request)
    if (!result) return { error: fallback, notice: null }
    return { error: result.error ?? null, notice: result.notice ?? null }
  } catch { return { error: fallback, notice: null } }
}

/**
 * T3's Link pull request: a GitHub URL or `#42`, attached to the thread. The host reads it through gh before it
 * links it, so a reference that names no pull request is refused in GitHub's words.
 */
export function LinkPullRequestDialog({ threadId, command, onClose, onLinked }: {
  readonly threadId: string
  readonly command: Command
  readonly onClose: () => void
  readonly onLinked: (notice: string) => void
}): ReactNode {
  const [reference, setReference] = useState('')
  const [dirty, setDirty] = useState(false)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const field = useRef<HTMLInputElement>(null)
  const dialog = useDialogFocus({ onEscape: () => { if (!pending) onClose() }, initialFocus: field })
  const titleId = useId(), fieldId = useId(), descriptionId = useId()
  const problem = dirty ? referenceProblem(reference) : null
  const submit = async (): Promise<void> => {
    setDirty(true)
    if (pending || referenceProblem(reference)) return
    setPending(true); setFailure(null)
    const result = await sendCommand(command, { type: 'git-link-pull-request', threadId, reference: reference.trim() }, 'Could not link the pull request.')
    setPending(false)
    if (result.error) { setFailure(result.error); return }
    onLinked(result.notice ?? 'Pull request linked.')
  }
  return <div className="tt-dialog-backdrop" role="presentation">
    <section ref={dialog} className="tt-dialog pull-request-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={pending || undefined}>
      <h2 id={titleId}>Link pull request</h2>
      <div id={descriptionId} className="tt-dialog__description">Attach a pull request to this thread. A full GitHub URL can point at any repository your gh sign-in can read.</div>
      <form onSubmit={event => { event.preventDefault(); void submit() }}>
        <label htmlFor={fieldId}>Pull request</label>
        <input ref={field} id={fieldId} className="tt-focusable" value={reference} placeholder="Pull request URL or #42" maxLength={2_048} autoComplete="off" spellCheck={false}
          aria-invalid={problem ? true : undefined} onChange={event => { setDirty(true); setReference(event.target.value); setFailure(null) }} />
        {problem ?? failure ? <div className="tt-dialog__status tt-dialog__status--error" role="alert">{problem ?? failure}</div> : null}
        <div className="tt-dialog__actions">
          <Button variant="secondary" disabled={pending} onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={pending || (dirty && problem !== null)}>{pending ? 'Linking...' : 'Link'}</Button>
        </div>
      </form>
    </section>
  </div>
}

/**
 * T3's Checkout pull request, opened from the branch picker: the reference is resolved through gh as it is
 * typed, and the pull request is checked out Local, in the thread's folder (the project's own checkout for a
 * draft), or into a Worktree of its own, which only a thread that has not started can take.
 */
export function CheckoutPullRequestDialog({ threadId, initialReference, command, worktreeAllowed, localMovesToCheckout, onClose, onDone }: {
  readonly threadId: string
  readonly initialReference: string
  readonly command: Command
  /** False once the thread has a folder of its own; Worktree then says why it is unavailable. */
  readonly worktreeAllowed: boolean
  /** True for a draft set to a worktree: Local works in the project checkout instead, and the dialog says so first. */
  readonly localMovesToCheckout: boolean
  readonly onClose: () => void
  readonly onDone: (notice: string) => void
}): ReactNode {
  const [reference, setReference] = useState(initialReference)
  const [resolved, setResolved] = useState<{ readonly reference: string; readonly detail: GitPullRequestDetail } | null>(null)
  const [resolveFailure, setResolveFailure] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)
  const [preparing, setPreparing] = useState<'local' | 'worktree' | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const field = useRef<HTMLInputElement>(null)
  const dialog = useDialogFocus({ onEscape: () => { if (!preparing) onClose() }, initialFocus: field })
  const titleId = useId(), fieldId = useId(), descriptionId = useId()
  const parsed = parsePullRequestReference(reference)
  useEffect(() => { field.current?.select() }, [])
  useEffect(() => {
    setResolveFailure(null)
    if (!parsed) { setResolving(false); return }
    const read = pullRequestBridge()
    if (!read) { setResolveFailure('Pull requests are not available in this window.'); return }
    let live = true
    setResolving(true)
    const timer = window.setTimeout(() => {
      read({ threadId, reference: parsed })
        .then(detail => { if (!live) return; if (detail) setResolved({ reference: parsed, detail }); else setResolveFailure('No pull request answers to that reference.') },
          () => { if (live) setResolveFailure('Could not read that pull request. Check the reference and your gh sign-in.') })
        .finally(() => { if (live) setResolving(false) })
    }, RESOLVE_DELAY_MS)
    return () => { live = false; window.clearTimeout(timer) }
  }, [parsed, threadId])
  const detail = resolved && resolved.reference === parsed ? resolved.detail : null
  const problem = referenceProblem(reference)
  const confirm = async (mode: 'local' | 'worktree'): Promise<void> => {
    if (!detail || preparing) return
    setPreparing(mode); setFailure(null)
    const result = await sendCommand(command, { type: 'git-checkout-pull-request', threadId, reference: detail.url, mode }, 'Could not check out the pull request.')
    setPreparing(null)
    if (result.error) { setFailure(result.error); return }
    onDone(result.notice ?? `Checked out PR #${detail.number}.`)
  }
  const ready = detail !== null && !resolving && preparing === null
  return <div className="tt-dialog-backdrop" role="presentation">
    <section ref={dialog} className="tt-dialog pull-request-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={preparing !== null || undefined}>
      <h2 id={titleId}>Checkout pull request</h2>
      <div id={descriptionId} className="tt-dialog__description">Resolve a GitHub pull request, then check it out in this thread's folder, or in a worktree of its own for a thread that has not started.{localMovesToCheckout ? <p className="pull-request-dialog__note">Local: this thread will work in the project checkout.</p> : null}</div>
      <label htmlFor={fieldId}>Pull request</label>
      <input ref={field} id={fieldId} className="tt-focusable" value={reference} placeholder="PR URL, checkout command, or #42" maxLength={2_048} autoComplete="off" spellCheck={false}
        aria-invalid={problem ? true : undefined}
        onChange={event => { setReference(event.target.value); setFailure(null) }}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); if (ready) void confirm('local') } }} />
      {detail ? <div className="pull-request-dialog__resolved">
        <p><strong>{detail.title}</strong></p>
        <p className="pull-request-dialog__meta">#{detail.number} · <bdi>{detail.headBranch}</bdi> to <bdi>{detail.baseBranch}</bdi> <span data-state={detail.draft && detail.state === 'open' ? 'draft' : detail.state}>{stateLabel(detail)}</span></p>
      </div> : null}
      {resolving && !detail ? <div className="tt-dialog__status" role="status">Resolving pull request...</div> : null}
      {problem && reference.trim() !== initialReference.trim() ? <div className="tt-dialog__status tt-dialog__status--error" role="alert">{problem}</div>
        : failure ?? resolveFailure ? <div className="tt-dialog__status tt-dialog__status--error" role="alert">{failure ?? resolveFailure}</div> : null}
      <div className="tt-dialog__actions">
        <Button variant="secondary" disabled={preparing !== null} onClick={onClose}>Cancel</Button>
        <Button variant="secondary" disabled={!ready} onClick={() => void confirm('local')}>{preparing === 'local' ? 'Preparing local...' : 'Local'}</Button>
        <Button variant="primary" disabled={!ready || !worktreeAllowed} title={worktreeAllowed ? undefined : 'Only a thread that has not started can take a worktree of its own. Use Local, or start a new thread.'}
          aria-description={worktreeAllowed ? undefined : 'Only a thread that has not started can take a worktree of its own.'} onClick={() => void confirm('worktree')}>{preparing === 'worktree' ? 'Preparing worktree...' : 'Worktree'}</Button>
      </div>
    </section>
  </div>
}
