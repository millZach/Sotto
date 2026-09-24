import React, { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, Check, CircleDashed, CircleX, Copy, ExternalLink, GitPullRequest, GitPullRequestDraft, Link2, List, LoaderCircle, RotateCw, Unlink, type LucideIcon } from 'lucide-react'
import type { AgentCommand, AgentState, AgentThread } from '../../../shared/agents'
import { branchPullRequestUrl, type GitPullRequestAction, type GitPullRequestCheck, type GitPullRequestDetail, type GitPullRequestMergeMethod } from '../../../shared/gitPullRequests'
import { PR_ICONS } from '../agents/BranchToolbar'
import { Button } from '../components/Button'
import { ConfirmationDialog } from '../components/ConfirmationDialog'
import { PaneMenu, type PaneMenuItem } from '../agents/PaneMenu'
import { LinkPullRequestDialog, pullRequestBridge, sendCommand } from './PullRequestDialogs'
import { ToolsChrome } from './ToolsChrome'
import {
  CHECK_STATUS, confirmationFor, isStale, LINK_SOURCE, mergeLabel, primaryControl, rememberedMergeMethod, rememberMergeMethod,
  resolveMergeMethod, reviewLabel, stateLabel, summarizeChecks, type ConfirmedAction,
} from './pullRequestSurface.logic'
import './pullRequestSurface.css'

type Command = (command: AgentCommand) => Promise<AgentState | null>
type Notice = { readonly text: string; readonly tone: 'status' | 'error' }
const CHECK_ICONS: Record<GitPullRequestCheck['status'], LucideIcon> = {
  success: Check, failure: CircleX, cancelled: CircleX, pending: LoaderCircle, 'action-required': CircleDashed, skipped: CircleDashed, neutral: CircleDashed,
}
const stateIcon = (detail: Pick<GitPullRequestDetail, 'state' | 'draft'>): LucideIcon => detail.draft && detail.state === 'open' ? GitPullRequestDraft : PR_ICONS[detail.state]
const stateKey = (detail: Pick<GitPullRequestDetail, 'state' | 'draft'>): string => detail.draft && detail.state === 'open' ? 'draft' : detail.state

/**
 * The Pull request surface in Tools (ADR-0027): the branch's pull request, or one linked to the thread, read
 * from GitHub through the host's gh when it opens and on Refresh. It leads with T3's one primary control
 * (the merge in the remembered method, Ready for review, Auto-merge, or the state it has reached), offers
 * Update branch while the branch is behind its base, lists each check and the description, and keeps the
 * rest in its menu. Nothing happens from viewing: every change is a press, and the merge, turning on
 * auto-merge and closing ask first. Linked pull requests is the same surface's list of the thread's links.
 */
export function PullRequestSurface({ thread, command, onStatus }: { readonly thread: AgentThread; readonly command: Command | undefined; readonly onStatus: (message: string) => void }): ReactNode {
  const [view, setView] = useState<'detail' | 'linked'>('detail')
  /** The pull request chosen from the list; null for the thread's own (its branch's, else the one linked last). */
  const [chosen, setChosen] = useState<string | null>(null)
  const [detail, setDetail] = useState<GitPullRequestDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState<GitPullRequestAction | 'unlink' | null>(null)
  const [method, setMethod] = useState<GitPullRequestMergeMethod | null>(null)
  const [confirming, setConfirming] = useState<ConfirmedAction | null>(null)
  const [linking, setLinking] = useState(false)
  const generation = useRef(0)
  const primary = useRef<HTMLButtonElement>(null)
  /** Coming back from the list, focus lands on the control that opened it. */
  const linkedButton = useRef<HTMLButtonElement>(null)
  const returning = useRef(false)
  useEffect(() => { if (view === 'detail' && returning.current) { returning.current = false; linkedButton.current?.focus() } }, [view])
  const showDetail = (url: string | null | undefined): void => { if (url !== undefined) setChosen(url); returning.current = true; setView('detail') }
  const branchUrl = branchPullRequestUrl(thread) ?? null
  const links = thread.pullRequests ?? []
  // Which pull requests are linked, not what they last said: a read that brings a link's title up to date must not read again.
  const linkKey = links.map(link => link.url).join('|')

  const load = useCallback(async (): Promise<void> => {
    const turn = ++generation.current
    const read = pullRequestBridge()
    if (!read) { setLoading(false); setFailure('Pull requests are not available in this window.'); return }
    setLoading(true); setFailure(null)
    try {
      const next = await read({ threadId: thread.id, ...(chosen ? { reference: chosen } : {}) })
      if (turn !== generation.current) return
      setDetail(next)
    } catch {
      if (turn === generation.current) setFailure('Could not read the pull request from GitHub. Check your gh sign-in and connection, then refresh.')
    } finally { if (turn === generation.current) setLoading(false) }
  }, [thread.id, chosen])
  // Read again when another pull request is chosen, and when the record says GitHub moved (a new branch pull request, a link).
  useEffect(() => { void load() }, [load, branchUrl, linkKey])
  useEffect(() => () => { generation.current++ }, [])
  useEffect(() => { setView('detail'); setChosen(null); setNotice(null); setMethod(null) }, [thread.id])

  const send = async (request: AgentCommand, pending: GitPullRequestAction | 'unlink', fallback: string): Promise<boolean> => {
    if (!command || busy) return false
    setBusy(pending); setNotice(null)
    const result = await sendCommand(command, request, fallback)
    setBusy(null)
    setNotice(result.error ? { text: result.error, tone: 'error' } : { text: result.notice ?? 'Done.', tone: 'status' })
    return result.error === null
  }
  const act = async (action: GitPullRequestAction, withMethod?: GitPullRequestMergeMethod): Promise<void> => {
    if (!detail) return
    await send({ type: 'git-pull-request-action', threadId: thread.id, url: detail.url, action, ...(withMethod ? { method: withMethod } : {}) }, action, 'Sotto could not confirm this. Refresh to see what GitHub has.')
    await load()
  }
  const unlink = async (url: string): Promise<void> => {
    if (await send({ type: 'git-unlink-pull-request', threadId: thread.id, url }, 'unlink', 'Could not unlink the pull request.') && chosen === url) setChosen(null)
  }
  const copyLink = async (url: string): Promise<void> => {
    try { await navigator.clipboard.writeText(url); onStatus('Link copied') } catch { onStatus('Could not copy the link') }
  }
  const openOnGitHub = (url: string): void => { void window.sotto?.openExternalLink?.(url) }

  if (view === 'linked') return <LinkedPullRequests thread={thread} busy={busy !== null} notice={notice}
    onOpen={url => showDetail(url)} onBack={() => showDetail(undefined)} onUnlink={url => void unlink(url)}
    onLink={() => setLinking(true)} linking={linking && command ? <LinkPullRequestDialog threadId={thread.id} command={command} onClose={() => setLinking(false)}
      onLinked={text => { setLinking(false); setNotice({ text, tone: 'status' }) }} /> : null} />

  const allowed = detail?.mergeMethods ?? []
  const selected = resolveMergeMethod(allowed, method, rememberedMergeMethod())
  const control = detail ? primaryControl(detail) : null
  const running = busy !== null
  const chooseMethod = (next: GitPullRequestMergeMethod): void => { setMethod(next); rememberMergeMethod(next) }
  const menu: PaneMenuItem[] = detail ? [
    { id: 'open', label: 'Open on GitHub', icon: <ExternalLink size={15} aria-hidden="true" />, run: () => openOnGitHub(detail.url) },
    { id: 'copy', label: 'Copy link', icon: <Copy size={15} aria-hidden="true" />, run: () => void copyLink(detail.url) },
    ...(detail.state === 'open' ? [detail.draft
      ? { id: 'ready', label: 'Ready for review', disabled: running, run: () => void act('ready') }
      : { id: 'draft', label: 'Convert to draft', disabled: running, run: () => void act('draft') }] : []),
    ...(control === 'enable-auto-merge' ? [{ id: 'merge-now', label: 'Merge now', disabled: running, run: () => setConfirming('merge') }] : []),
    ...(detail.state === 'open' && !detail.draft && !detail.autoMerge && detail.autoMergeAllowed && control !== 'enable-auto-merge' && allowed.length > 0
      ? [{ id: 'auto', label: 'Enable auto-merge', disabled: running, run: () => setConfirming('enable-auto-merge') }] : []),
    ...(detail.autoMerge ? [{ id: 'no-auto', label: 'Disable auto-merge', disabled: running, run: () => void act('disable-auto-merge') }] : []),
    ...(detail.state === 'open' ? [{ id: 'close', label: 'Close pull request', disabled: running, run: () => setConfirming('close') }] : []),
    ...(detail.state === 'closed' ? [{ id: 'reopen', label: 'Reopen pull request', disabled: running, run: () => void act('reopen') }] : []),
    ...(detail.linked ? [{ id: 'unlink', label: 'Unlink from thread', icon: <Unlink size={15} aria-hidden="true" />, disabled: running, run: () => void unlink(detail.url) }] : []),
  ] : []
  const StateIcon = detail ? stateIcon(detail) : GitPullRequest
  const confirmation = confirming && detail ? confirmationFor(confirming, detail.number, selected, detail.baseBranch) : null

  return <div className="pr-surface" aria-busy={loading || running}>
    <ToolsChrome title={detail ? `PR #${detail.number}` : 'Pull request'} detail={detail ? stateLabel(detail) : null}>
      <button ref={linkedButton} type="button" className="tools-chrome__button pr-surface__linked tt-focusable" title={links.length ? `Linked pull requests: ${links.length}` : 'Linked pull requests'}
        aria-description={links.length ? `${links.length} linked` : undefined} onClick={() => setView('linked')}>
        <List size={16} aria-hidden="true" /><span className="tools-chrome__button-label">Linked pull requests</span>{links.length ? <span className="pr-surface__count" aria-hidden="true">{links.length}</span> : null}
      </button>
      <button type="button" className="files-icon tt-focusable" aria-label="Refresh pull request" title="Refresh pull request" data-busy={loading || undefined} onClick={() => void load()}><RotateCw size={15} aria-hidden="true" /></button>
      {menu.length ? <PaneMenu groups={[menu]} label="More pull request actions" className="pr-surface__menu" /> : null}
    </ToolsChrome>
    {notice ? <p className="pr-surface__notice" data-tone={notice.tone} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</p> : null}
    <div className="pr-surface__body">
      {detail ? <>
        <header className="pr-surface__head">
          <h3 className="pr-surface__title"><StateIcon size={16} aria-hidden="true" data-state={stateKey(detail)} /><span>{detail.title}</span></h3>
          <p className="pr-surface__meta"><bdi>{detail.headBranch}</bdi><span aria-hidden="true"> → </span><span className="tt-visually-hidden"> into </span><bdi>{detail.baseBranch}</bdi>
            <span className="pr-surface__sep" aria-hidden="true">·</span><span>{reviewLabel(detail.reviewDecision)}</span>
            {detail.branch ? <><span className="pr-surface__sep" aria-hidden="true">·</span><span>This branch</span></> : detail.linked ? <><span className="pr-surface__sep" aria-hidden="true">·</span><span>{LINK_SOURCE[detail.linked]}</span></> : null}</p>
        </header>
        <section className="pr-surface__merge" aria-label="Merge">
          {control === 'merged' ? <p>Merged.</p> : null}
          {control === 'closed' ? <><p>Closed without merging.</p><Button variant="secondary" disabled={running} onClick={() => void act('reopen')}>{busy === 'reopen' ? 'Reopening...' : 'Reopen pull request'}</Button></> : null}
          {control === 'resolve' ? <p>This branch has conflicts with <bdi>{detail.baseBranch}</bdi>. Resolve them in the working copy and push, then refresh.</p> : null}
          {control === 'ready' ? <Button ref={primary} variant="primary" disabled={running} onClick={() => void act('ready')}>{busy === 'ready' ? 'Marking ready...' : 'Ready for review'}</Button> : null}
          {control === 'auto-merge-armed' ? <><p>Auto-merge is on{detail.autoMerge?.method ? ` (${mergeLabel(detail.autoMerge.method).toLowerCase()})` : ''}. GitHub merges this when it is ready.</p>
            <Button variant="secondary" disabled={running} onClick={() => void act('disable-auto-merge')}>{busy === 'disable-auto-merge' ? 'Turning off...' : 'Disable auto-merge'}</Button></> : null}
          {control === 'enable-auto-merge' ? <Button ref={primary} variant="primary" disabled={running} onClick={() => setConfirming('enable-auto-merge')}>{busy === 'enable-auto-merge' ? 'Enabling...' : `Auto-merge (${mergeLabel(selected).toLowerCase()})`}</Button> : null}
          {control === 'merge' ? <Button ref={primary} variant="primary" disabled={running} onClick={() => setConfirming('merge')}>{busy === 'merge' ? 'Merging...' : mergeLabel(selected)}</Button> : null}
          {(control === 'merge' || control === 'enable-auto-merge') && allowed.length > 1 ? <label className="pr-surface__method">Merge method
            <select className="tt-focusable" value={selected} disabled={running} onChange={event => chooseMethod(event.target.value as GitPullRequestMergeMethod)}>
              {allowed.map(option => <option key={option} value={option}>{mergeLabel(option)}</option>)}
            </select></label> : null}
        </section>
        {isStale(detail) ? <section className="pr-surface__stale" aria-label="Base branch">
          <p>This branch is {detail.behindBy} {detail.behindBy === 1 ? 'commit' : 'commits'} behind <bdi>{detail.baseBranch}</bdi>.</p>
          {detail.canUpdateBranch ? <div className="pr-surface__row">
            <Button variant="secondary" disabled={running} onClick={() => void act('update-branch')}>{busy === 'update-branch' ? 'Updating...' : 'Update branch'}</Button>
            <Button variant="secondary" disabled={running} onClick={() => setConfirming('update-with-rebase')}>Update with rebase</Button>
          </div> : <p className="pr-surface__quiet">GitHub does not let this account update the branch.</p>}
        </section> : null}
        <section className="pr-surface__checks" aria-labelledby={`pr-checks-${detail.number}`}>
          <h4 id={`pr-checks-${detail.number}`}>Checks <span className="pr-surface__quiet">{summarizeChecks(detail.checks)}</span></h4>
          {detail.checks.length ? <ul aria-label="Checks">{detail.checks.map((check, index) => {
            const Icon = CHECK_ICONS[check.status]
            return <li key={`${check.name}-${index}`} data-status={check.status}>
              <Icon size={14} aria-hidden="true" /><span className="tt-visually-hidden">{CHECK_STATUS[check.status]}: </span>
              {check.url ? <button type="button" className="pr-surface__check-name tt-focusable" title={`Open ${check.name} in the browser`} onClick={() => openOnGitHub(check.url!)}>{check.name}</button>
                : <span className="pr-surface__check-name">{check.name}</span>}
              <span className="pr-surface__check-status" aria-hidden="true">{CHECK_STATUS[check.status]}</span>
              {check.description ? <span className="pr-surface__check-description">{check.description}</span> : null}
            </li>
          })}</ul> : null}
        </section>
        <section className="pr-surface__description" aria-labelledby={`pr-description-${detail.number}`}>
          <h4 id={`pr-description-${detail.number}`}>Description</h4>
          {detail.body.trim() ? <div className="pr-surface__body-text">{detail.body}</div> : <p className="pr-surface__quiet">No description.</p>}
        </section>
      </> : loading ? <p className="files-preview__loading" role="status">Reading the pull request…</p>
        : failure ? <div className="files-problem" role="status"><strong>{failure}</strong><button type="button" className="files-link tt-focusable" onClick={() => void load()}>Try again</button></div>
          : <div className="files-problem pr-surface__empty" role="status"><strong>This branch has no pull request.</strong>
            <p>Create one with the Git action in the pane header, or link one to this thread.</p>
            {command ? <button type="button" className="files-link tt-focusable" onClick={() => setLinking(true)}><Link2 size={14} aria-hidden="true" /> Link pull request</button> : null}</div>}
    </div>
    {linking && command ? <LinkPullRequestDialog threadId={thread.id} command={command} onClose={() => setLinking(false)} onLinked={text => { setLinking(false); setNotice({ text, tone: 'status' }) }} /> : null}
    {confirmation && confirming ? <ConfirmationDialog title={confirmation.title} description={confirmation.description} confirmLabel={confirmation.confirm} cancelLabel="Cancel" danger={confirmation.danger}
      fallbackFocusRef={primary} onCancel={() => setConfirming(null)}
      onConfirm={async () => {
        const action = confirming
        setConfirming(null)
        if (action === 'update-with-rebase') void act('update-branch', 'rebase')
        else void act(action, action === 'close' ? undefined : selected)
      }} /> : null}
  </div>
}

/** Linked pull requests: the thread's links, and its branch's pull request when that is not linked, each opening in the surface. */
function LinkedPullRequests({ thread, busy, notice, onOpen, onBack, onUnlink, onLink, linking }: {
  readonly thread: AgentThread; readonly busy: boolean; readonly notice: Notice | null
  readonly onOpen: (url: string) => void; readonly onBack: () => void; readonly onUnlink: (url: string) => void; readonly onLink: () => void
  readonly linking: ReactNode
}): ReactNode {
  const links = [...(thread.pullRequests ?? [])].reverse()
  const branch = thread.worktree?.git?.pullRequest
  const branchLinked = branch ? links.some(link => link.url.toLowerCase() === branch.url.toLowerCase()) : false
  const back = useRef<HTMLButtonElement>(null)
  useEffect(() => { back.current?.focus() }, [])
  return <div className="pr-surface">
    <ToolsChrome title="Linked pull requests" detail={links.length ? String(links.length) : null}>
      <button ref={back} type="button" className="tools-chrome__button tt-focusable" title="Back to the pull request" onClick={onBack}><ArrowLeft size={16} aria-hidden="true" /><span className="tools-chrome__button-label">Back</span></button>
      <button type="button" className="tools-chrome__button tt-focusable" title="Link pull request" onClick={onLink}><Link2 size={16} aria-hidden="true" /><span className="tools-chrome__button-label">Link pull request</span></button>
    </ToolsChrome>
    {notice ? <p className="pr-surface__notice" data-tone={notice.tone} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</p> : null}
    <div className="pr-surface__body">
      {branch && !branchLinked ? <ul className="pr-surface__links" aria-label="This branch">
        <LinkRow number={branch.number} title={branch.title} state={branch.state} draft={branch.draft} source="This branch" onOpen={() => onOpen(branch.url)} />
      </ul> : null}
      {links.length ? <ul className="pr-surface__links" aria-label="Linked pull requests">{links.map(link =>
        <LinkRow key={link.url} number={link.number} title={link.title} state={link.state} draft={link.draft} source={LINK_SOURCE[link.source]} onOpen={() => onOpen(link.url)}
          unlink={<button type="button" className="files-icon tt-focusable" aria-label={`Unlink PR #${link.number} from this thread`} title="Unlink from thread" disabled={busy} onClick={() => onUnlink(link.url)}><Unlink size={14} aria-hidden="true" /></button>} />)}
      </ul> : <div className="files-problem pr-surface__empty" role="status"><strong>No pull requests are linked to this thread.</strong>
        <p>A pull request the Git action creates is linked here, and so is one you link or check out from the branch picker.</p></div>}
    </div>
    {linking}
  </div>
}

function LinkRow({ number, title, state, draft, source, onOpen, unlink }: {
  readonly number: number; readonly title: string; readonly state: GitPullRequestDetail['state']; readonly draft: boolean; readonly source: string
  readonly onOpen: () => void; readonly unlink?: ReactNode
}): ReactNode {
  const Icon = stateIcon({ state, draft })
  return <li className="pr-surface__link">
    <button type="button" className="pr-surface__link-open tt-focusable" onClick={onOpen} aria-label={`PR #${number}, ${stateLabel({ state, draft })}: ${title}. ${source}`}>
      <Icon size={15} aria-hidden="true" data-state={stateKey({ state, draft })} />
      <span className="pr-surface__link-number">#{number}</span>
      <span className="pr-surface__link-title">{title}</span>
      <span className="pr-surface__link-source">{source}</span>
    </button>
    {unlink}
  </li>
}
