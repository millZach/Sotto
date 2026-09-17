import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import type { GitChangesBridge } from '../../../shared/gitChanges'
import type { PrReview } from '../../../shared/gitPullRequests'
import { threadLinkRouter } from './webLinks'

export function GitPullRequest({ threadId, workspaceId, bridge, onBack }: { threadId: string; workspaceId: string; bridge: GitChangesBridge; onBack?: () => void }): ReactNode {
  const [review, setReview] = useState<PrReview | null>(null)
  const [base, setBase] = useState(''), [title, setTitle] = useState(''), [body, setBody] = useState('')
  const [busy, setBusy] = useState(false), [status, setStatus] = useState(''), [drafting, setDrafting] = useState(false)
  const content = useRef<HTMLDivElement>(null)
  const generation = useRef(0), locked = useRef(false)
  /**
   * Sotto's own draft of the form. It is never an error: a request that writes
   * nothing leaves the fields exactly as the review left them, so a user with
   * no OpenRouter key sees the form they have always seen.
   */
  const draft = async (value: PrReview): Promise<void> => {
    if (!bridge.draftPullRequestText || value.pullRequest) return
    const token = generation.current
    setDrafting(true)
    try {
      const result = await bridge.draftPullRequestText({ threadId, workspaceId, ...(value.remote ? { remote: value.remote } : {}), ...(value.base ? { base: value.base } : {}) })
      if (token !== generation.current) return
      if (result.ok && result.value.title !== null) { setTitle(result.value.title); setBody(result.value.body ?? '') }
    } catch { /* Text the user did not ask for never becomes an error they must clear. */ }
    finally { if (token === generation.current) setDrafting(false) }
  }
  const load = async (remote?: string, reset = false): Promise<void> => {
    if (!bridge.reviewPullRequest || locked.current) return
    const token = generation.current
    locked.current = true; setBusy(true); setStatus('')
    try {
      const result = await bridge.reviewPullRequest({ threadId, workspaceId, ...(remote ? { remote } : {}) })
      if (token !== generation.current) return
      if (!result.ok) { setReview(null); setStatus(result.error.message); return }
      setReview(result.value)
      if (reset || review?.branch !== result.value.branch || review?.remote !== result.value.remote) {
        setBase(result.value.base); setTitle(result.value.title); setBody(result.value.body)
        // Sotto writes over the commit's own words; nothing is created either way.
        void draft(result.value)
      }
    } catch { if (token === generation.current) { setReview(null); setStatus('Could not refresh the pull request. Check your connection and try again.') } }
    finally { if (token === generation.current) { locked.current = false; setBusy(false) } }
  }
  useEffect(() => {
    generation.current++; locked.current = false; setReview(null)
    void load(undefined, true)
    return () => { generation.current++; locked.current = false }
  }, [threadId, workspaceId]) // The owning working copy controls this surface.
  const act = async (action: 'push' | 'create'): Promise<void> => {
    if (!review?.remote || !bridge.actPullRequest || locked.current) return
    const token = generation.current
    locked.current = true; setBusy(true); setStatus('')
    try {
      const result = await bridge.actPullRequest({ threadId, workspaceId, remote: review.remote, revision: review.revision, action, ...(action === 'create' ? { base, title, body } : {}) })
      if (token !== generation.current) return
      if (!result.ok) { setStatus(result.error.message); return }
      if (result.value.pullRequest) { setReview({ ...review, pullRequest: result.value.pullRequest }); if (content.current) content.current.scrollTop = 0 }
      setStatus(result.value.message)
    } catch { if (token === generation.current) setStatus('The action was not confirmed. Refresh before trying again.') }
    finally { if (token === generation.current) { locked.current = false; setBusy(false) } }
  }
  const open = async (url: string): Promise<void> => {
    const result = await threadLinkRouter(threadId, 'this thread', window.sotto?.browser).open(url)
    if (!result.ok) setStatus(result.message ?? 'Could not open this link.'); else if (result.message) setStatus(result.message)
  }
  const pr = review?.pullRequest
  return <section className="git-pr" aria-label="Pull request review" aria-busy={busy}>
    <div className="git-pr__toolbar">{onBack ? <button type="button" className="files-link tt-focusable" onClick={onBack}>Back to changes</button> : null}<button type="button" className="files-link tt-focusable" disabled={busy} onClick={() => void load(review?.remote ?? undefined)}>Refresh pull request</button></div>
    <div className="git-pr__content" ref={content}>
      {review ? <>
        <p className="git-pr__branch"><strong>{review.branch ?? 'Detached HEAD'}</strong> <span>{review.head.slice(0, 8)}</span></p>
        <label>Remote<select className="tt-focusable" aria-label="Remote" value={review.remote ?? ''} disabled={busy} onChange={event => void load(event.target.value, true)}>{review.remotes.map(remote => <option key={remote} value={remote}>{remote}</option>)}</select></label>
        {review.remoteUrl ? <p className="git-pr__destination">{review.remoteUrl}</p> : null}
        {review.error ? <p role="status">{review.error}</p> : null}
        {pr ? <section className="git-pr__result" aria-label="Pull request status">
          <button type="button" className="files-link tt-focusable" onClick={() => void open(pr.url)}>#{pr.number} &middot; {pr.title}</button>
          <p>{pr.draft ? 'Draft' : pr.state} &middot; {pr.head} &rarr; {pr.base}</p>
          <p>Review: {pr.review.replaceAll('_', ' ').toLowerCase()}</p>
          {pr.checks.length ? <ul aria-label="Checks">{pr.checks.map((check, index) => <li key={`${check.name}-${index}`}>{check.url ? <button type="button" className="files-link tt-focusable" onClick={() => void open(check.url!)}>{check.name}</button> : <span>{check.name}</span>}<span>{check.status.replaceAll('_', ' ').toLowerCase()}</span></li>)}</ul> : <p>No checks reported.</p>}
        </section> : <>
          <label>Base branch<input className="tt-focusable" aria-label="Base branch" value={base} disabled={busy} maxLength={240} onChange={event => setBase(event.target.value)} placeholder="main" /></label>
          <label>PR title<input className="tt-focusable" aria-label="PR title" value={title} disabled={busy} maxLength={500} onChange={event => setTitle(event.target.value)} /></label>
          <label>PR body<textarea className="tt-focusable" aria-label="PR body" value={body} disabled={busy} rows={5} maxLength={60000} onChange={event => setBody(event.target.value)} /></label>
          {bridge.draftPullRequestText ? <button type="button" className="files-link tt-focusable" disabled={busy || drafting} onClick={() => void draft(review)}>Regenerate</button> : null}
        </>}
      </> : !busy && !status ? <p>Refresh to review this branch.</p> : null}
    </div>
    <footer className="git-pr__footer">
      {busy || drafting || status ? <p role="status">{busy ? 'Working...' : drafting ? 'Writing...' : status}</p> : null}
      <div className="git-pr__actions"><button type="button" className="files-link tt-focusable" disabled={busy || !review?.branch || !review.remote} onClick={() => void act('push')}>Push branch</button>
        {!pr ? <button type="button" className="files-link tt-focusable" disabled={busy || drafting || !review?.repository || !!review.error || !base.trim() || !title.trim()} onClick={() => void act('create')}>Create pull request</button> : null}</div>
    </footer>
  </section>
}
