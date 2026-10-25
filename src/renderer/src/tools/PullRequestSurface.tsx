import React, { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import {
  AlarmClock, AlarmClockOff, Check, ChevronDown, ChevronRight, Circle, CircleAlert, CircleCheck, CircleDashed, CircleHelp, CircleX, Copy, ExternalLink, GitMerge,
  GitPullRequest, GitPullRequestDraft, Link2, RotateCw, Unlink, type LucideIcon,
} from 'lucide-react'
import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import type { AgentCommand, AgentState, AgentThread } from '../../../shared/agents'
import { branchPullRequestUrl, isPullRequestLimited, type GitPullRequestAction, type GitPullRequestDetail, type GitPullRequestMergeMethod } from '../../../shared/gitPullRequests'
import { PR_ICONS } from '../agents/BranchToolbar'
import { writeClipboard } from '../agents/richActions'
import { menuEntries } from '../agents/gitActionButton.logic'
import { Button } from '../components/Button'
import { ConfirmationDialog } from '../components/ConfirmationDialog'
import { PaneMenu, type PaneMenuItem } from '../agents/PaneMenu'
import { babysitEndedOf, babysitLine, babysittingOf, type BabysitLine } from '../agents/babysitting'
import { useBabysitEndingsDismissed } from './babysitEndingsDismissed'
import { LinkPullRequestDialog, pullRequestBridge, sendCommand } from './PullRequestDialogs'
import {
  canAutoMerge, checklist, checklistCount, checklistHeading, confirmationFor, holdsBack, limitedWords, linesLeft, LINK_SOURCE, MERGE_METHOD_SHORT, mergedWhen, mergeEffect, mergeLabel, mergeReady,
  resolveMergeMethod, stateLabel, type ChecklistLine, type ConfirmedAction, type LineFix, type LineTone,
} from './pullRequestSurface.logic'
import { usePullRequestMergeMethod } from './usePullRequestMergeMethod'
import './pullRequestSurface.css'

type Command = (command: AgentCommand) => Promise<AgentState | null>
/** `at: 'babysit'`: a refused Stop, said in the babysitting line beside the Stop it answers rather than above the checklist. */
type Notice = { readonly text: string; readonly tone: 'status' | 'error'; readonly at?: 'babysit' }
type Busy = GitPullRequestAction | 'unlink' | 'create-pr' | 'babysit'
const LINE_ICONS: Record<LineTone, LucideIcon> = { done: CircleCheck, failed: CircleX, running: CircleDashed, todo: Circle, unknown: CircleHelp, open: CircleAlert }
/** Said before a line's words, since its colour and icon are not read. */
const LINE_STATE: Record<LineTone, MessageDescriptor> = {
  done: msg({ message: 'Done', comment: 'A merge checklist line\'s state, said before its words.' }),
  failed: msg({ message: 'Failing', comment: 'A merge checklist line\'s state, said before its words.' }),
  running: msg({ message: 'Waiting', comment: 'A merge checklist line\'s state, said before its words.' }),
  todo: msg({ message: 'To do', comment: 'A merge checklist line\'s state, said before its words.' }),
  unknown: msg({ message: 'Unknown', comment: 'A merge checklist line\'s state, said before its words.' }),
  open: msg({ message: 'Does not block', comment: 'A merge checklist line\'s state, said before its words.' }),
}
const BUSY_LABEL: Partial<Record<Busy, MessageDescriptor>> = {
  merge: msg`Merging...`, ready: msg`Marking ready...`, 'update-branch': msg`Updating...`, reopen: msg`Reopening...`,
  'disable-auto-merge': msg`Turning off...`, 'create-pr': msg`Creating PR...`, babysit: msg`Stopping...`,
}
const stateIcon = (detail: Pick<GitPullRequestDetail, 'state' | 'draft'>): LucideIcon => detail.draft && detail.state === 'open' ? GitPullRequestDraft : PR_ICONS[detail.state]
const stateKey = (detail: Pick<GitPullRequestDetail, 'state' | 'draft'>): string => detail.draft && detail.state === 'open' ? 'draft' : detail.state
const onGitHub = (url: string): boolean => /^https:\/\/github\.com\//iu.test(url)

/**
 * The Pull request surface in Tools (ADR-0027): the merge checklist. The branch's pull request, or one linked to
 * the thread, read from GitHub through the host's gh when it opens and on Refresh, as five lines (checks, review,
 * up to date with the base, no conflicts, ready for review), each done or carrying the one press that fixes it.
 * One large Merge, in the method chosen beside it, is enabled only when no line holds it back; Merge when ready
 * arms GitHub's auto-merge instead. The description and the linked pull requests fold below, and the rest is in
 * the ··· menu. Nothing happens from viewing: every change is a press, and the merge, turning on auto-merge,
 * closing and Update with rebase ask first. ToolsPanel keys it by the thread, so another thread starts it afresh:
 * nothing of one thread's pull request, choice or notice carries over.
 *
 * Babysitting (ADR-0061, variant C): while the thread babysits the pull request shown, a line docked above Merge says
 * since when, who started it and what Sotto does, with Stop; Babysit pull request is in the ··· menu when nothing
 * babysits it, where the thread's host can (`babysit`). Once babysitting ended on its own, the line says so and why.
 */
export function PullRequestSurface({ thread, command, onStatus, babysit }: {
  readonly thread: AgentThread; readonly command: Command | undefined; readonly onStatus: (message: string) => void
  /** The thread's host babysits pull requests, and the name its agent goes by. Absent where it cannot. */
  readonly babysit?: { readonly agent: string } | undefined
}): ReactNode {
  const { t, i18n } = useLingui()
  /** The pull request chosen from Linked pull requests; null for the thread's own (its branch's, else the one linked last). */
  const [chosen, setChosen] = useState<string | null>(null)
  const [detail, setDetail] = useState<GitPullRequestDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState<Busy | null>(null)
  const [confirming, setConfirming] = useState<ConfirmedAction | null>(null)
  const [linking, setLinking] = useState(false)
  const [descriptionOpen, setDescriptionOpen] = useState(false)
  const [linksOpen, setLinksOpen] = useState(false)
  const [preferred, choosePreferred] = usePullRequestMergeMethod()
  // Worked out for every ending the thread holds, before a read of GitHub says which one shows.
  const endings = useBabysitEndingsDismissed()
  const generation = useRef(0)
  const surface = useRef<HTMLDivElement>(null)
  const top = useRef<HTMLHeadingElement>(null)
  const hintId = useId()
  const branchUrl = branchPullRequestUrl(thread) ?? null
  const links = thread.pullRequests ?? []
  // Which pull requests are linked, not what they last said: a read that brings a link's title up to date must not read again.
  const linkKey = links.map(link => link.url).join('|')

  const load = useCallback(async (): Promise<void> => {
    const turn = ++generation.current
    const read = pullRequestBridge()
    if (!read) { setLoading(false); setFailure(t`Pull requests are not available in this window.`); return }
    setLoading(true); setFailure(null)
    try {
      const next = await read({ threadId: thread.id, ...(chosen ? { reference: chosen } : {}) })
      if (turn !== generation.current) return
      // GitHub's rate limit held the read back: the last reading stays, under the words that say when to ask again.
      if (next && isPullRequestLimited(next)) { setFailure(limitedWords(next.limited.retryAt)); return }
      setDetail(next)
    } catch {
      if (turn === generation.current) setFailure(t`Could not read the pull request from GitHub. Check your gh sign-in and connection, then refresh.`)
    } finally { if (turn === generation.current) setLoading(false) }
  }, [thread.id, chosen, t])
  // Read again when another pull request is chosen, and when the record says GitHub moved (a new branch pull request, a link).
  useEffect(() => { void load() }, [load, branchUrl, linkKey])
  useEffect(() => () => { generation.current++ }, [])

  /** One command at a time. `then` runs before the press counts as over, so its controls stay off until it has finished too. */
  /**
   * `briefly`: what the surface already shows once the press succeeds, said in the panel's passing status instead of a
   * notice that would hold the checklist down. A refusal still stays in the surface, saying why.
   */
  const send = async (request: AgentCommand, pending: Busy, fallback: string, then?: () => Promise<void>, briefly?: string): Promise<boolean> => {
    if (!command || busy) return false
    setBusy(pending); setNotice(null)
    try {
      const result = await sendCommand(command, request, fallback)
      if (!result.error && briefly) onStatus(briefly)
      else setNotice(result.error ? { text: result.error, tone: 'error' } : { text: result.notice ?? t({ message: 'Done.', comment: 'A pull request command went through.' }), tone: 'status' })
      await then?.()
      return result.error === null
    } finally { setBusy(null) }
  }
  const act = async (action: GitPullRequestAction, withMethod?: GitPullRequestMergeMethod): Promise<void> => {
    if (!detail) return
    // The press is over only once GitHub has been read again: until then the checklist shows the pull request as it was
    // before the press, and a control enabled over it could merge twice or update a branch that was just updated.
    await send({ type: 'git-pull-request-action', threadId: thread.id, url: detail.url, action, ...(withMethod ? { method: withMethod } : {}) }, action,
      t`Sotto could not confirm this. Refresh to see what GitHub has.`, load)
    // A press that settled its line takes its own button away; focus comes back to the pull request rather than the page.
    requestAnimationFrame(() => { if (!surface.current?.contains(document.activeElement)) top.current?.focus() })
  }
  const unlink = async (url: string): Promise<void> => {
    if (await send({ type: 'git-unlink-pull-request', threadId: thread.id, url }, 'unlink', t`Could not unlink the pull request.`) && chosen === url) setChosen(null)
  }
  /**
   * Babysit pull request and Stop babysitting: the host answers with what it did, or why it did nothing. The docked line
   * coming or going says what it did, so success passes in the panel's status rather than above the checklist. A refused
   * Stop leaves the line and its Stop, which keeps focus, and says why in the line, where the reader is.
   */
  const babysitting = async (url: string, number: number, start: boolean): Promise<void> => {
    const done = await send({ type: start ? 'babysit-pull-request' : 'stop-babysitting', threadId: thread.id, url }, 'babysit',
      start ? t`Sotto could not confirm babysitting started. Check the pull request before trying again.` : t`Sotto could not confirm babysitting stopped. Check the pull request before trying again.`,
      undefined, start ? t({ message: `Babysitting #${number}`, comment: '{number} is a pull request\'s number.' }) : t({ message: `Stopped babysitting #${number}`, comment: '{number} is a pull request\'s number.' }))
    if (start) return
    if (!done) { setNotice(current => current?.tone === 'error' ? { ...current, at: 'babysit' } : current); return }
    // Stop takes its own line away, once the thread's state says so; Babysit pull request is in the ··· menu again, so focus waits there.
    leaveLine(true)
  }
  /**
   * Focus after a press that takes the babysitting line away: on ··· (`menu`), where Babysit pull request is, else on the
   * pull request. Only while focus is still in the line, or went with it; a reader who moved on while the host answered,
   * to the composer or anywhere else, stays where they went.
   */
  const leaveLine = (menu: boolean): void => { requestAnimationFrame(() => {
    const active = document.activeElement
    const lost = !active || active === document.body || !active.isConnected
    if (!lost && !active.closest('.pr-surface__babysit')) return
    ((menu ? surface.current?.querySelector<HTMLElement>('.pr-surface__menu > button') : null) ?? top.current)?.focus()
  }) }
  const copyLink = async (url: string): Promise<void> => {
    try { await writeClipboard(url); onStatus(t`Link copied`) } catch { onStatus(t`Could not copy the link. Open on GitHub and copy the address from your browser.`) }
  }
  const openExternal = (url: string): void => { void window.sotto?.openExternalLink?.(url) }
  /** A linked pull request opens here; the view starts again at its top line. */
  const show = (url: string): void => { setChosen(url); setDescriptionOpen(false); requestAnimationFrame(() => top.current?.focus()) }
  const linkDialog = linking && command ? <LinkPullRequestDialog threadId={thread.id} command={command} onClose={() => setLinking(false)}
    onLinked={text => { setLinking(false); setNotice({ text, tone: 'status' }) }} /> : null
  /** `docked`: the notice is a refused Stop that the babysitting line shows instead. */
  const noticeLine = (docked = false): ReactNode => <>
    {notice && !docked ? <p className="pr-surface__notice" data-tone={notice.tone} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</p> : null}
    {/* A read that failed under a checklist already shown: the checklist is the last one GitHub gave, and says so. */}
    {failure && detail ? <p className="pr-surface__notice tt-paragraph" data-tone="error" role="alert">{t({ message: `${failure} What shows below is from the last read.`, comment: '{failure} says why the latest read of the pull request failed, in a sentence.' })}</p> : null}
  </>
  const linked = <LinkedFold thread={thread} open={linksOpen} onToggle={() => setLinksOpen(value => !value)} onShow={show} onLink={command ? () => setLinking(true) : null} />
  const refresh = <button type="button" className="files-icon tt-focusable" aria-label={t`Refresh pull request`} title={t`Refresh pull request`} data-busy={loading || undefined} onClick={() => { setNotice(null); void load() }}><RotateCw size={15} aria-hidden="true" /></button>

  if (!detail) {
    return <div ref={surface} className="pr-surface" aria-busy={loading || busy !== null}>
      <div className="tools-chrome pr-surface__top">
        <span className="pr-surface__lead"><GitPullRequest size={16} aria-hidden="true" data-state="none" /><h2 ref={top} tabIndex={-1} className="pr-surface__name">{loading ? t`Pull request` : t`No pull request`}</h2></span>
        <div className="tools-chrome__actions">{refresh}</div>
      </div>
      {noticeLine()}
      <div className="pr-surface__body">
        {loading ? <p className="files-preview__loading" role="status">{t`Reading the pull request…`}</p>
          : failure ? <div className="files-problem" role="status"><strong>{failure}</strong><button type="button" className="files-link tt-focusable" onClick={() => void load()}>{t`Try again`}</button></div>
            : <NoPullRequest thread={thread} busy={busy} command={command} onLink={() => setLinking(true)}
              onCreate={actionId => void send({ type: 'git-action', threadId: thread.id, actionId, action: 'create_pr' }, 'create-pr', t`Sotto could not confirm this Git command.`).then(() => setNotice(current => current?.tone === 'status' ? null : current))} />}
        {!loading && !failure && (links.length > 0 || thread.worktree?.git?.pullRequest) ? linked : null}
      </div>
      {linkDialog}
    </div>
  }

  const lines = checklist(detail)
  const ready = mergeReady(detail, lines)
  const allowed = detail.mergeMethods
  const selected = resolveMergeMethod(allowed, preferred)
  // A read in flight, a Refresh or the one after a press, also holds every press: what is on screen may already be out of date.
  const running = busy !== null || loading
  const open = detail.state === 'open'
  const autoMerge = canAutoMerge(detail)
  const behind = (detail.behindBy ?? 0) > 0
  const clear = !lines.some(holdsBack)
  const StateIcon = stateIcon(detail)
  const confirmation = confirming ? confirmationFor(confirming, detail.number, selected, detail.baseBranch) : null
  // Babysitting is offered on an open pull request this thread knows, where its host can and nothing babysits it yet.
  const babysat = babysittingOf(thread, detail.url) !== undefined
  const offerBabysit = Boolean(babysit && command && open && (detail.linked || detail.branch) && !babysat)
  // An ending the user dismissed here stays on the record, and away from this surface, until a later one replaces it.
  const ending = babysitEndedOf(thread, detail.url)
  const endingShown = ending ? { threadId: thread.id, url: ending.url, endedAt: ending.endedAt } : null
  const line = endingShown && endings.dismissed(endingShown) ? null
    : babysitLine({ thread, pullRequest: detail, agent: babysit?.agent ?? t({ message: 'the agent', comment: 'Stands in for the provider\'s name, as in "Started by the agent".' }), offered: offerBabysit })
  /** Dismiss takes its own line away; focus waits on ··· beside an open pull request, where Babysit pull request is, else on the pull request. */
  const dismissEnding = (): void => {
    if (!endingShown) return
    endings.dismiss(endingShown)
    leaveLine(open)
  }
  // A refused Stop is said in the line it answers, while that line is still there to say it.
  const stopRefused = notice?.at === 'babysit' && line?.kind === 'babysitting' ? notice.text : null
  const dock = <BabysitDock line={line} busy={busy === 'babysit'} disabled={running || !command} refused={stopRefused}
    onStop={() => void babysitting(detail.url, detail.number, false)} onDismiss={dismissEnding} />
  const menu: PaneMenuItem[][] = [[
    ...(open ? [detail.draft ? { id: 'ready', label: t`Ready for review`, disabled: running, run: () => void act('ready') }
      : { id: 'draft', label: t`Convert to draft`, disabled: running, run: () => void act('draft') }] : []),
    ...(open && behind && detail.canUpdateBranch ? [{ id: 'rebase', label: t`Update with rebase`, disabled: running, run: () => setConfirming('update-with-rebase') }] : []),
    ...(autoMerge ? [{ id: 'auto', label: t`Merge when ready (auto-merge)`, disabled: running, run: () => setConfirming('enable-auto-merge') }] : []),
    ...(detail.autoMerge ? [{ id: 'no-auto', label: t`Disable auto-merge`, disabled: running, run: () => void act('disable-auto-merge') }] : []),
    ...(offerBabysit ? [{ id: 'babysit', label: t`Babysit pull request`, icon: <AlarmClock size={15} aria-hidden="true" />, disabled: running, run: () => void babysitting(detail.url, detail.number, true) }] : []),
    { id: 'copy', label: t`Copy link`, icon: <Copy size={15} aria-hidden="true" />, run: () => void copyLink(detail.url) },
    ...(command ? [{ id: 'link', label: t`Link pull request`, icon: <Link2 size={15} aria-hidden="true" />, run: () => setLinking(true) }] : []),
    ...(detail.linked ? [{ id: 'unlink', label: t`Unlink from thread`, icon: <Unlink size={15} aria-hidden="true" />, disabled: running, run: () => void unlink(detail.url) }] : []),
  ], [
    ...(open ? [{ id: 'close', label: t`Close pull request`, tone: 'danger' as const, disabled: running, run: () => setConfirming('close') }] : []),
    ...(detail.state === 'closed' ? [{ id: 'reopen', label: t`Reopen pull request`, disabled: running, run: () => void act('reopen') }] : []),
  ]]
  const busyLabel = (pending: Busy): string => i18n._(BUSY_LABEL[pending]!)
  const fix = (line: ChecklistLine, press: LineFix): ReactNode => {
    switch (press.kind) {
      case 'open-check': {
        const check = press.name
        return <Button variant="secondary" aria-label={onGitHub(press.url) ? t({ message: `Open ${check} on GitHub`, comment: '{check} is the name of a check, as in "build".' }) : t({ message: `Open ${check} in the browser`, comment: '{check} is the name of a check, as in "build".' })} onClick={() => openExternal(press.url)}>
          <ExternalLink size={14} aria-hidden="true" />{t`Open check`}</Button>
      }
      case 'open-review': {
        const author = press.author
        return <Button variant="secondary" aria-label={author ? t({ message: `Open ${author}'s review on GitHub`, comment: '{author} is a GitHub user name.' }) : t`Open the review on GitHub`} onClick={() => openExternal(press.url)}>
          <ExternalLink size={14} aria-hidden="true" />{t`Open review`}</Button>
      }
      case 'update-branch': return <Button variant="secondary" disabled={running} onClick={() => void act('update-branch')}>{busy === 'update-branch' ? busyLabel('update-branch') : t`Update branch`}</Button>
      case 'ready': return <Button variant="secondary" disabled={running} onClick={() => void act('ready')}>{busy === 'ready' ? busyLabel('ready') : line.label}</Button>
    }
  }
  const baseBranch = detail.baseBranch, number = detail.number
  const autoMethod = detail.autoMerge?.method ? mergeLabel(detail.autoMerge.method).toLowerCase() : null
  const when = mergedWhen(detail.mergedAt)

  return <div ref={surface} className="pr-surface" aria-busy={running}>
    <div className="tools-chrome pr-surface__top">
      <span className="pr-surface__lead">
        <StateIcon size={16} aria-hidden="true" data-state={stateKey(detail)} />
        <h2 ref={top} tabIndex={-1} className="pr-surface__name"><span className="pr-surface__number">#{detail.number}</span> {detail.title}</h2>
        <span className="pr-surface__tag">{stateLabel(detail)}</span>
      </span>
      <div className="tools-chrome__actions">
        <button type="button" className="files-icon tt-focusable" aria-label={t`Open on GitHub`} title={t`Open on GitHub`} onClick={() => openExternal(detail.url)}><ExternalLink size={15} aria-hidden="true" /></button>
        {refresh}
        <PaneMenu groups={menu} label={t`More pull request actions`} className="pr-surface__menu" />
      </div>
    </div>
    {noticeLine(stopRefused !== null)}
    <div className="pr-surface__body">
      <h3 className="pr-surface__heading">{checklistHeading(detail, clear)}{' '}<small data-tone={clear ? 'done' : undefined}>{checklistCount(lines)}</small></h3>
      <ol className="pr-surface__lines" aria-label={t`Merge checklist`}>{lines.map(line => {
        const Icon = LINE_ICONS[line.tone]
        return <li key={line.id} className="pr-surface__line" data-tone={line.tone}>
          <Icon size={18} aria-hidden="true" />
          <div className="pr-surface__line-text"><strong><span className="tt-visually-hidden">{i18n._(LINE_STATE[line.tone])}: </span>{line.label}</strong><span className="pr-surface__why">{line.why}</span></div>
          {line.fix ? <span className="pr-surface__fix">{fix(line, line.fix)}</span> : null}
        </li>
      })}</ol>
      <div className="pr-surface__dock">
        {open ? dock : null}
        {detail.state === 'merged' ? <div className="pr-surface__finished" data-state="merged"><CircleCheck size={20} aria-hidden="true" />
          <div><strong><Trans comment="{baseBranch} is a Git branch name, as in main.">Merged into <bdi>{baseBranch}</bdi></Trans></strong>{when ? <span>{when}</span> : null}</div></div>
          : detail.state === 'closed' ? <div className="pr-surface__finished" data-state="closed"><Circle size={20} aria-hidden="true" />
            <div><strong>{t`Closed without merging`}</strong></div>
            <Button variant="secondary" disabled={running} onClick={() => void act('reopen')}>{busy === 'reopen' ? busyLabel('reopen') : t({ message: 'Reopen', context: 'pull request', comment: 'Reopens a closed pull request.' })}</Button></div>
            : detail.autoMerge ? <div className="pr-surface__finished" data-state="auto"><CircleDashed size={20} aria-hidden="true" />
              <div><strong>{t`Auto-merge is on`}</strong><span>{autoMethod ? t({ message: `GitHub merges this with ${autoMethod} when every line is done.`, comment: '{autoMethod} is the merge method, as in "squash and merge".' }) : t`GitHub merges this when every line is done.`}</span></div>
              <Button variant="secondary" aria-label={t`Turn off auto-merge`} disabled={running} onClick={() => void act('disable-auto-merge')}>{busy === 'disable-auto-merge' ? busyLabel('disable-auto-merge') : t({ message: 'Turn off', comment: 'Turns off auto-merge.' })}</Button></div>
              : <>
                <div className="pr-surface__merge">
                  <Button variant="primary" className="pr-surface__merge-go" aria-disabled={!ready || running || undefined} aria-describedby={hintId}
                    onClick={() => { if (ready && !running) setConfirming('merge') }}>
                    <GitMerge size={17} aria-hidden="true" />{busy === 'merge' ? busyLabel('merge') : t({ message: `Merge #${number}`, comment: '{number} is the pull request\'s number.' })}</Button>
                  {allowed.length > 1 ? <MergeMethodMenu allowed={allowed} selected={selected} base={detail.baseBranch} disabled={running} onChoose={choosePreferred} /> : null}
                </div>
                <p id={hintId} className="pr-surface__hint tt-paragraph">{ready ? `${mergeEffect(selected, detail.baseBranch)}.` : allowed.length === 0 ? t`This repository allows no merge method. Change that on GitHub.` : <>{linesLeft(lines)}{autoMerge
                  ? <> <button type="button" className="pr-surface__textlink tt-focusable" disabled={running} onClick={() => setConfirming('enable-auto-merge')}>{t`Merge when ready`}</button></> : null}</>}</p>
              </>}
        {/* Under a merged or closed pull request goes what ended babysitting it, or, until the next pass sees the
            merge, that it is still babysat, which Stop can end now. */}
        {!open ? dock : null}
      </div>
      <Fold label={t({ message: 'Description', comment: 'A pull request\'s description, which folds away.' })} open={descriptionOpen} onToggle={() => setDescriptionOpen(value => !value)}>
        {detail.body.trim() ? <div className="pr-surface__description">{detail.body}</div> : <p className="pr-surface__quiet tt-paragraph">{t`No description.`}</p>}
      </Fold>
      {linked}
    </div>
    {linkDialog}
    {confirmation && confirming ? <ConfirmationDialog title={confirmation.title} description={confirmation.description} confirmLabel={confirmation.confirm} cancelLabel={t`Cancel`} danger={confirmation.danger}
      fallbackFocusRef={top} onCancel={() => setConfirming(null)}
      onConfirm={async () => {
        const action = confirming
        setConfirming(null)
        if (action === 'update-with-rebase') void act('update-branch', 'rebase')
        else void act(action, action === 'close' ? undefined : selected)
      }} /> : null}
  </div>
}

/**
 * The line docked above Merge (variant C): babysitting since when, who started it and what Sotto does, with Stop; or
 * that it ended, and why, with Dismiss once it has been read. Each is named for its pull request, so a reader hears
 * what a press does. Stop is held
 * with aria-disabled rather than disabled, so a press keeps focus on it: a refused Stop says why under it (`refused`),
 * and a Stop that worked takes the line away and focus moves on.
 */
function BabysitDock({ line, busy, disabled, refused, onStop, onDismiss }: {
  readonly line: BabysitLine; readonly busy: boolean; readonly disabled: boolean; readonly refused: string | null
  readonly onStop: () => void; readonly onDismiss: () => void
}): ReactNode {
  const { t, i18n } = useLingui()
  if (line === null) return null
  const Icon = line.kind === 'babysitting' ? AlarmClock : AlarmClockOff
  return <div className="pr-surface__babysit" data-state={line.kind} role="group" aria-label={line.title}>
    <Icon size={18} aria-hidden="true" />
    <div className="pr-surface__babysit-text"><strong>{line.title}</strong><span>{line.detail}</span></div>
    {line.kind === 'babysitting' ? <Button variant="secondary" aria-label={line.stop} title={line.stop} aria-disabled={disabled || undefined}
      onClick={() => { if (!disabled) onStop() }}>{busy ? i18n._(BUSY_LABEL.babysit!) : t({ message: 'Stop', comment: 'Stops babysitting a pull request.' })}</Button>
      : <Button variant="secondary" aria-label={line.dismiss} title={line.dismiss} onClick={onDismiss}>{t`Dismiss`}</Button>}
    {refused ? <p className="pr-surface__babysit-refused" role="alert">{refused}</p> : null}
  </div>
}

/**
 * No pull request yet: what the checklist would list once there is one, Create PR as the Git action runs it (the
 * same press, disabled with the same reason), and Link pull request.
 */
function NoPullRequest({ thread, busy, command, onCreate, onLink }: {
  readonly thread: AgentThread; readonly busy: Busy | null; readonly command: Command | undefined
  readonly onCreate: (actionId: string) => void; readonly onLink: () => void
}): ReactNode {
  const { t, i18n } = useLingui()
  const status = thread.worktree?.git
  const create = menuEntries(status).find(entry => entry.id === 'create_pr')
  const gitRunning = thread.gitAction?.status === 'running' || busy !== null
  const hintId = useId()
  const branch = status?.branch
  const base = status?.defaultBranch
  return <div className="pr-surface__none">
    <h3 className="pr-surface__heading">{t`Nothing to merge yet`}</h3>
    {branch && status?.isDefaultBranch
      ? <p className="tt-paragraph"><Trans comment="{branch} is a Git branch name."><bdi className="pr-surface__branch">{branch}</bdi> is the default branch.</Trans>{' '}{base
        ? <Trans comment="{base} is the default Git branch, as in main.">Once this thread is on a branch with a pull request, this lists what stands between it and <bdi className="pr-surface__branch">{base}</bdi>.</Trans>
        : t`Once this thread is on a branch with a pull request, this lists what stands between it and its base.`}</p>
      : <p className="tt-paragraph">{branch ? <Trans comment="{branch} is a Git branch name."><bdi className="pr-surface__branch">{branch}</bdi> has no pull request.</Trans> : t`This thread has no pull request.`}{' '}{base
        ? <Trans comment="{base} is the default Git branch, as in main.">Once it has one, this lists what stands between it and <bdi className="pr-surface__branch">{base}</bdi>.</Trans>
        : t`Once it has one, this lists what stands between it and its base.`}</p>}
    {command ? <div className="pr-surface__none-actions">
      {create ? <Button variant="primary" aria-disabled={create.hint !== undefined || gitRunning || undefined} aria-describedby={create.hint ? hintId : undefined} title={create.hint}
        onClick={() => { if (!create.hint && !gitRunning) onCreate(crypto.randomUUID()) }}>
        <GitPullRequest size={15} aria-hidden="true" />{busy === 'create-pr' ? i18n._(BUSY_LABEL['create-pr']!) : t`Create PR`}</Button> : null}
      <Button variant="secondary" onClick={onLink}><Link2 size={15} aria-hidden="true" />{t`Link pull request`}</Button>
      {create?.hint ? <span id={hintId} className="tt-visually-hidden">{create.hint}</span> : null}
    </div> : null}
  </div>
}

/** A part of the surface that folds away: the description, the linked pull requests. */
function Fold({ label, count, open, onToggle, children }: { readonly label: string; readonly count?: number; readonly open: boolean; readonly onToggle: () => void; readonly children: ReactNode }): ReactNode {
  const id = useId()
  const Chevron = open ? ChevronDown : ChevronRight
  return <div className="pr-surface__fold">
    <button type="button" className="pr-surface__fold-head tt-focusable" aria-expanded={open} aria-controls={open ? id : undefined} onClick={onToggle}>
      <Chevron size={15} aria-hidden="true" />{label}{count !== undefined ? <>{' '}<span className="pr-surface__quiet">{count}</span></> : null}
    </button>
    {open ? <div id={id} className="pr-surface__fold-body">{children}</div> : null}
  </div>
}

/**
 * Linked pull requests: the thread's links, and its branch's pull request when that is not linked, each opening in the
 * surface, and each the thread babysits marked Babysitting (ADR-0061, variant C).
 */
function LinkedFold({ thread, open, onToggle, onShow, onLink }: {
  readonly thread: AgentThread; readonly open: boolean; readonly onToggle: () => void
  readonly onShow: (url: string) => void; readonly onLink: (() => void) | null
}): ReactNode {
  const { t } = useLingui()
  const links = [...(thread.pullRequests ?? [])].reverse()
  const branch = thread.worktree?.git?.pullRequest
  const branchLinked = branch ? links.some(link => link.url.toLowerCase() === branch.url.toLowerCase()) : false
  const rows = [
    ...(branch && !branchLinked ? [{ number: branch.number, url: branch.url, title: branch.title, state: branch.state, draft: branch.draft, source: t({ message: 'This branch', comment: 'Where a pull request in the list came from: the thread\'s own branch.' }) }] : []),
    ...links.map(link => ({ number: link.number, url: link.url, title: link.title, state: link.state, draft: link.draft, source: LINK_SOURCE[link.source] })),
  ]
  const linkedLabel = t`Linked pull requests`
  const babysittingWord = t({ message: 'Babysitting', comment: 'Marks a pull request this thread is babysitting.' })
  return <Fold label={linkedLabel} count={rows.length} open={open} onToggle={onToggle}>
    {rows.length ? <ul className="pr-surface__links" aria-label={linkedLabel}>{rows.map(row => {
      const Icon = stateIcon(row)
      const babysat = babysittingOf(thread, row.url) !== undefined
      const { number, title, source } = row
      const state = stateLabel(row)
      return <li key={row.url} className="pr-surface__link">
        <button type="button" className="pr-surface__link-open tt-focusable" onClick={() => onShow(row.url)} aria-label={babysat
          ? t({ message: `PR #${number}, ${state}: ${title}. ${source}. Babysitting`, comment: '{state} is the pull request\'s state, as in Open; {source} says where it came from, as in "Linked by you".' })
          : t({ message: `PR #${number}, ${state}: ${title}. ${source}`, comment: '{state} is the pull request\'s state, as in Open; {source} says where it came from, as in "Linked by you".' })}>
          <Icon size={15} aria-hidden="true" data-state={stateKey(row)} />
          <span className="pr-surface__link-number">#{row.number}</span>
          <span className="pr-surface__link-title">{row.title}</span>
          <span className="pr-surface__link-source">{row.source}{babysat ? <>{' · '}<span className="pr-surface__link-babysat">{babysittingWord}</span></> : null}</span>
        </button>
      </li>
    })}</ul> : <p className="pr-surface__quiet tt-paragraph">{t`None yet. A pull request the Git action creates is linked here, and so is one you link or check out from the branch picker.`}</p>}
    {onLink ? <Button variant="ghost" className="pr-surface__link-add" onClick={onLink}><Link2 size={14} aria-hidden="true" />{t`Link pull request`}</Button> : null}
  </Fold>
}

/** The method beside Merge: its short name on the button, and a menu of the methods this repository allows, each saying what it leaves. */
function MergeMethodMenu({ allowed, selected, base, disabled, onChoose }: {
  readonly allowed: readonly GitPullRequestMergeMethod[]; readonly selected: GitPullRequestMergeMethod; readonly base: string
  readonly disabled: boolean; readonly onChoose: (method: GitPullRequestMergeMethod) => void
}): ReactNode {
  const { t } = useLingui()
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const method = mergeLabel(selected)
  useEffect(() => {
    if (!open) return
    list.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus()
    const dismiss = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!list.current?.contains(target) && !button.current?.contains(target)) setOpen(false)
    }
    const away = (): void => setOpen(false)
    document.addEventListener('pointerdown', dismiss, true)
    window.addEventListener('blur', away)
    return () => { document.removeEventListener('pointerdown', dismiss, true); window.removeEventListener('blur', away) }
  }, [open])
  const close = (): void => { setOpen(false); button.current?.focus() }
  return <div className="pr-surface__method">
    <Button ref={button} variant="secondary" className="pr-surface__method-button" aria-label={t({ message: `Merge method: ${method}`, comment: '{method} is the merge method, as in "Squash and merge".' })} title={t`Merge method`}
      aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen(value => !value)}
      onKeyDown={event => {
        if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false) }
        if (!open && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) { event.preventDefault(); setOpen(true) }
      }}>
      {MERGE_METHOD_SHORT[selected]}<ChevronDown size={14} aria-hidden="true" />
    </Button>
    {open ? <div ref={list} className="pr-surface__method-list" role="menu" aria-label={t`Merge method`}
      onKeyDown={event => {
        if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); close(); return }
        const entries = [...(list.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])]
        const index = entries.indexOf(document.activeElement as HTMLElement)
        const next = event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowUp' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : null
        if (next === null) return
        event.preventDefault()
        entries[(next + entries.length) % entries.length]?.focus()
      }}>
      {allowed.map(method => <button key={method} type="button" role="menuitemradio" aria-checked={method === selected} tabIndex={-1} className="pr-surface__method-item"
        aria-label={mergeLabel(method)} aria-description={mergeEffect(method, base)} onClick={() => { onChoose(method); close() }}>
        <span><span>{mergeLabel(method)}</span><small>{mergeEffect(method, base)}</small></span>
        {method === selected ? <Check size={14} aria-hidden="true" /> : null}
      </button>)}
    </div> : null}
  </div>
}
