import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { i18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { isPullRequestLimited, parsePullRequestReference, type GitPullRequestDetail, type GitPullRequestRead, type GitPullRequestRequest } from '../../../shared/gitPullRequests'
import { limitedWords } from './pullRequestSurface.logic'
import type { AgentCommand, AgentState } from '../../../shared/agents'
import { Button } from '../components/Button'
import { useDialogFocus } from '../components/useDialogFocus'
import { Isolated } from '../components/isolated'
import { holdingThread, openHolderWords } from '../agents/checkoutHold'
import { shownWords } from '../agents/interfaceWords'
import { stateLabel } from './pullRequestSurface.logic'

type Command = (command: AgentCommand) => Promise<AgentState | null>
const RESOLVE_DELAY_MS = 450
const NO_THREADS: readonly { readonly id: string; readonly title: string }[] = []

/** The bridge call a dialog resolves a reference through; absent in a window without the preload. */
export function pullRequestBridge(): ((request: GitPullRequestRequest) => Promise<GitPullRequestRead>) | undefined {
  return window.sotto?.agents?.gitPullRequest
}

/** T3's validation words for a reference field. */
function referenceProblem(reference: string): string | null {
  if (!reference.trim()) return i18n._(msg`Paste a pull request URL or enter 123 / #123.`)
  return parsePullRequestReference(reference) ? null : i18n._(msg`Use a pull request URL, 123, or #123.`)
}

/**
 * Sends one pull request command and answers with the refusal in the host's words, or the host's notice when it went
 * through, and the thread holding the folder when the refusal is a hold another thread caused (#1823).
 */
export async function sendCommand(command: Command, request: AgentCommand, fallback: string): Promise<{ error: string | null; notice: string | null; holder?: string }> {
  try {
    const result = await command(request)
    if (!result) return { error: fallback, notice: null }
    const holder = result.error ? result.checkoutHold?.threadId : undefined
    return { error: result.error ?? null, notice: result.notice ?? null, ...(holder !== undefined ? { holder } : {}) }
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
  const { t } = useLingui()
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
    const result = await sendCommand(command, { type: 'git-link-pull-request', threadId, reference: reference.trim() }, t`Could not link the pull request.`)
    setPending(false)
    if (result.error) { setFailure(result.error); return }
    onLinked(result.notice ?? t`Pull request linked.`)
  }
  return <div className="tt-dialog-backdrop" role="presentation">
    <section ref={dialog} className="tt-dialog pull-request-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={pending || undefined}>
      <h2 id={titleId}>{t`Link pull request`}</h2>
      <div id={descriptionId} className="tt-dialog__description tt-paragraph">{t`Attach a pull request to this thread. A full GitHub URL can point at any repository your gh sign-in can read.`}</div>
      <form onSubmit={event => { event.preventDefault(); void submit() }}>
        <label htmlFor={fieldId}>{t`Pull request`}</label>
        <input ref={field} id={fieldId} className="tt-focusable" value={reference} placeholder={t`Pull request URL or #42`} maxLength={2_048} autoComplete="off" spellCheck={false}
          aria-invalid={problem ? true : undefined} onChange={event => { setDirty(true); setReference(event.target.value); setFailure(null) }} />
        {problem ?? failure ? <div className="tt-dialog__status tt-dialog__status--error" role="alert">{problem ?? failure}</div> : null}
        <div className="tt-dialog__actions">
          <Button variant="secondary" disabled={pending} onClick={onClose}>{t`Cancel`}</Button>
          <Button variant="primary" type="submit" disabled={pending || (dirty && problem !== null)}>{pending ? t`Linking...` : t({ message: 'Link', comment: 'Links a pull request to this thread.' })}</Button>
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
export function CheckoutPullRequestDialog({ threadId, threads = NO_THREADS, initialReference, command, worktreeAllowed, localMovesToCheckout, onClose, onDone }: {
  readonly threadId: string
  /** The window's threads, for opening the one holding the folder when a checkout is refused for it (#1823). */
  readonly threads?: readonly { readonly id: string; readonly title: string }[]
  readonly initialReference: string
  readonly command: Command
  /** False once the thread has a folder of its own; Worktree then says why it is unavailable. */
  readonly worktreeAllowed: boolean
  /** True for a draft set to a worktree: Local works in the project checkout instead, and the dialog says so first. */
  readonly localMovesToCheckout: boolean
  readonly onClose: () => void
  readonly onDone: (notice: string) => void
}): ReactNode {
  const { t } = useLingui()
  const [reference, setReference] = useState(initialReference)
  const [resolved, setResolved] = useState<{ readonly reference: string; readonly detail: GitPullRequestDetail } | null>(null)
  const [resolveFailure, setResolveFailure] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)
  const [preparing, setPreparing] = useState<'local' | 'worktree' | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [holderId, setHolderId] = useState<string | undefined>(undefined)
  const field = useRef<HTMLInputElement>(null)
  const dialog = useDialogFocus({ onEscape: () => { if (!preparing) onClose() }, initialFocus: field })
  const titleId = useId(), fieldId = useId(), descriptionId = useId()
  const parsed = parsePullRequestReference(reference)
  useEffect(() => { field.current?.select() }, [])
  useEffect(() => {
    setResolveFailure(null)
    if (!parsed) { setResolving(false); return }
    const read = pullRequestBridge()
    if (!read) { setResolveFailure(t`Pull requests are not available in this window.`); return }
    let live = true
    setResolving(true)
    const timer = window.setTimeout(() => {
      read({ threadId, reference: parsed })
        .then(detail => { if (!live) return; if (detail && isPullRequestLimited(detail)) setResolveFailure(limitedWords(detail.limited.retryAt, 'try-again')); else if (detail) setResolved({ reference: parsed, detail }); else setResolveFailure(t`No pull request answers to that reference.`) },
          () => { if (live) setResolveFailure(t`Could not read that pull request. Check the reference and your gh sign-in.`) })
        .finally(() => { if (live) setResolving(false) })
    }, RESOLVE_DELAY_MS)
    return () => { live = false; window.clearTimeout(timer) }
  }, [parsed, threadId, t])
  const detail = resolved && resolved.reference === parsed ? resolved.detail : null
  const problem = referenceProblem(reference)
  const confirm = async (mode: 'local' | 'worktree'): Promise<void> => {
    if (!detail || preparing) return
    setPreparing(mode); setFailure(null); setHolderId(undefined)
    const result = await sendCommand(command, { type: 'git-checkout-pull-request', threadId, reference: detail.url, mode }, t`Could not check out the pull request.`)
    setPreparing(null)
    if (result.error) { setFailure(result.error); setHolderId(result.holder); return }
    const number = detail.number
    onDone(result.notice ?? t({ message: `Checked out PR #${number}.`, comment: '{number} is the pull request\'s number.' }))
  }
  const ready = detail !== null && !resolving && preparing === null
  const holder = holdingThread(threads, holderId, threadId)
  return <div className="tt-dialog-backdrop" role="presentation">
    <section ref={dialog} className="tt-dialog pull-request-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={preparing !== null || undefined}>
      <h2 id={titleId}>{t`Checkout pull request`}</h2>
      <div id={descriptionId} className="tt-dialog__description tt-paragraph">{t`Resolve a GitHub pull request, then check it out in this thread's folder, or in a worktree of its own for a thread that has not started.`}{localMovesToCheckout ? <p className="pull-request-dialog__note tt-paragraph">{t`Local: this thread will work in the project checkout.`}</p> : null}</div>
      <label htmlFor={fieldId}>{t`Pull request`}</label>
      <input ref={field} id={fieldId} className="tt-focusable" value={reference} placeholder={t`PR URL, checkout command, or #42`} maxLength={2_048} autoComplete="off" spellCheck={false}
        aria-invalid={problem ? true : undefined}
        onChange={event => { setReference(event.target.value); setFailure(null); setHolderId(undefined) }}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); if (ready) void confirm('local') } }} />
      {detail ? <div className="pull-request-dialog__resolved">
        <p><strong>{detail.title}</strong></p>
        <PullRequestMeta detail={detail} />
      </div> : null}
      {resolving && !detail ? <div className="tt-dialog__status" role="status">{t`Resolving pull request...`}</div> : null}
      {problem && reference.trim() !== initialReference.trim() ? <div className="tt-dialog__status tt-dialog__status--error" role="alert">{problem}</div>
        : failure ?? resolveFailure ? <div className="tt-dialog__status tt-dialog__status--error" role="alert">{failure ?? resolveFailure}
          {failure && holder ? <> <button type="button" className="pull-request-dialog__open tt-focusable" onClick={() => { onClose(); void command({ type: 'select-thread', threadId: holder.id }) }}>
            <Isolated text={shownWords(openHolderWords(holder.title))} /></button></> : null}</div> : null}
      <div className="tt-dialog__actions">
        <Button variant="secondary" disabled={preparing !== null} onClick={onClose}>{t`Cancel`}</Button>
        <Button variant="secondary" disabled={!ready} onClick={() => void confirm('local')}>{preparing === 'local' ? t`Preparing local...` : t({ message: 'Local', comment: 'Checks a pull request out in the thread\'s own folder.' })}</Button>
        <Button variant="primary" disabled={!ready || !worktreeAllowed} title={worktreeAllowed ? undefined : t`Only a thread that has not started can take a worktree of its own. Use Local, or start a new thread.`}
          aria-description={worktreeAllowed ? undefined : t`Only a thread that has not started can take a worktree of its own.`} onClick={() => void confirm('worktree')}>{preparing === 'worktree' ? t`Preparing worktree...` : t({ message: 'Worktree', context: 'pull request checkout', comment: 'Checks a pull request out into a worktree of its own.' })}</Button>
      </div>
    </section>
  </div>
}

/** A resolved pull request's number, its branches and its state, under its title. */
function PullRequestMeta({ detail }: { readonly detail: GitPullRequestDetail }): ReactNode {
  const { number, headBranch, baseBranch } = detail
  const state = stateLabel(detail)
  return <p className="pull-request-dialog__meta"><Trans comment="{headBranch} and {baseBranch} are Git branch names; {state} is the pull request's state, as in Open.">#{number} · <bdi>{headBranch}</bdi> to <bdi>{baseBranch}</bdi> <span data-state={detail.draft && detail.state === 'open' ? 'draft' : detail.state}>{state}</span></Trans></p>
}
