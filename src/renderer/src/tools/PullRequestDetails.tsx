import React, { memo, useId, useMemo, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Circle, CircleAlert, CircleCheck, CircleDashed, CircleMinus, CircleX, ExternalLink, type LucideIcon } from 'lucide-react'
import { useLingui } from '@lingui/react/macro'
import type { GitPullRequestCheck, GitPullRequestDetail, GitPullRequestFile } from '../../../shared/gitPullRequests'
import { MessageContent } from '../agents/MessageContent'
import { Button } from '../components/Button'
import { shownCount, shownLineCount } from '../state/interfaceNumbers'
import { checkNameParts, checksInOrder, checksOnGitHub, checksSummary, checksToPreview, checkTime, checkWord, fileOnGitHub, filesByFolder, filesByWeight, filesOnGitHub, pathParts } from './pullRequestSurface.logic'

const CHECK_ICONS: Readonly<Record<GitPullRequestCheck['status'], LucideIcon>> = {
  success: CircleCheck, failure: CircleX, cancelled: CircleX, pending: CircleDashed, 'action-required': Circle, skipped: CircleMinus, neutral: CircleMinus,
}
const onGitHub = (url: string): boolean => /^https:\/\/github\.com\//iu.test(url)
const openExternal = (url: string): void => { void window.sotto?.openExternalLink?.(url) }

/** One count of lines, "+2,114" or "−2,097", in the interface language's digits. */
function LineCounts({ additions, deletions, quiet }: { readonly additions: number; readonly deletions: number; readonly quiet?: boolean }): ReactNode {
  const { t } = useLingui()
  const added = shownLineCount(additions), removed = shownLineCount(deletions)
  // Quiet: a folder's sum over its files, in the muted text rather than the two status colours.
  return <span className="pr-surface__counts" data-quiet={quiet || undefined}>
    <span className="tt-visually-hidden">{t({ message: `${added} added, ${removed} removed`, comment: '{added} and {removed} are counts of lines in a pull request.' })}</span>
    {/* A side with no lines says nothing, so what a file did reads at a glance: only added, only removed, or both. */}
    <span data-side="added" aria-hidden="true">{additions > 0 || deletions === 0 ? `+${added}` : ''}</span> <span data-side="removed" aria-hidden="true">{deletions > 0 ? `−${removed}` : ''}</span>
  </span>
}
export { LineCounts as PullRequestLineCounts }

/** How the checks stand, on the head of their closed fold, so nothing has to be opened to learn that one failed. */
export function PullRequestChecksSummary({ checks }: { readonly checks: readonly GitPullRequestCheck[] }): ReactNode {
  return <span className="pr-surface__checks-summary">{checksSummary(checks).map(part => <React.Fragment key={part.words}><span data-tone={part.tone}>{part.words}</span>{' '}</React.Fragment>)}</span>
}

/** How many rows a closed fold's peek shows: enough to name what matters, few enough to stay a glance. */
export const PEEK_ROWS = 3
/** How many files a peek shows in a panel with room for more after every other peek. */
export const PEEK_MORE_FILES = 8

/**
 * The checks that still stand (failed, waiting on an approval, running), the first few, under the head of their closed
 * fold where the panel has room: for the eye only, since the head's press opens the whole list, where each opens. The
 * one the checklist's line already names is left out, so the preview adds the rest rather than saying it again.
 */
export function PullRequestChecksPeek({ checks }: { readonly checks: readonly GitPullRequestCheck[] }): ReactNode {
  return <span className="pr-surface__peek" data-of="checks" aria-hidden="true">{checksToPreview(checks).slice(0, PEEK_ROWS).map((check, index) => {
    const Icon = CHECK_ICONS[check.status]
    const { group, own } = checkNameParts(check.name)
    return <span key={`${check.name}\n${index}`} className="pr-surface__peek-row" data-status={check.status}>
      <Icon size={13} data-status={check.status} />
      <span className="pr-surface__peek-name">{group ? <span className="pr-surface__peek-folder" data-group="">{group} /</span> : null}<bdi>{own}</bdi></span>
      <span className="pr-surface__peek-word">{checkWord(check)}</span>
      <span className="pr-surface__peek-time">{checkTime(check)}</span>
    </span>
  })}</span>
}
/** The most changed files, the first few (`rows`), under the head of their closed fold where the panel has room; for the eye only. */
export function PullRequestFilesPeek({ files, rows = PEEK_ROWS }: { readonly files: readonly GitPullRequestFile[]; readonly rows?: number | undefined }): ReactNode {
  const most = useMemo(() => filesByWeight(files).slice(0, rows), [files, rows])
  return <span className="pr-surface__peek" data-of="files" aria-hidden="true">{most.map(file => {
    const { folder, name } = pathParts(file.path)
    return <span key={file.path} className="pr-surface__peek-row">
      <span className="pr-surface__peek-name"><bdi className="pr-surface__peek-folder">{folder}</bdi><bdi className="pr-surface__peek-file">{name}</bdi></span>
      <LineCounts additions={file.additions} deletions={file.deletions} />
    </span>
  })}</span>
}

/**
 * Every check, inside its fold below Merge, each named, with its state and how long it took, and a press that opens it
 * where GitHub says it lives. What stands comes first; what settled folds away behind one press while anything still
 * stands, and is simply listed once nothing does. GitHub's own full list is one press away at its foot.
 */
export const PullRequestChecks = memo(function PullRequestChecks({ url, checks }: { readonly url: string; readonly checks: readonly GitPullRequestCheck[] }): ReactNode {
  const { t } = useLingui()
  const { standing, settled } = checksInOrder(checks)
  const [settledOpen, setSettledOpen] = useState(false)
  const folds = standing.length > 0 && settled.length > 0
  const count = shownCount(settled.length)
  const onlyPassed = settled.every(check => check.status === 'success')
  const listLabel = t({ message: 'Checks', comment: 'The list of a pull request\'s checks.' })
  return <div className="pr-surface__checks">
    <ul className="pr-surface__check-list" aria-label={listLabel}>
      {standing.map((check, index) => <CheckRow key={`${check.name}\n${index}`} check={check} />)}
      {!folds || settledOpen ? settled.map((check, index) => <CheckRow key={`${check.name}\n${index}`} check={check} />) : null}
    </ul>
    {folds ? <button type="button" className="pr-surface__check-more tt-focusable" aria-expanded={settledOpen} onClick={() => setSettledOpen(value => !value)}>
      {settledOpen ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
      {settledOpen
        ? onlyPassed ? t({ message: 'Hide the ones that passed', comment: 'Folds away the checks that passed.' }) : t({ message: 'Hide the ones that finished', comment: 'Folds away the checks that passed or were skipped.' })
        : onlyPassed ? t({ message: `Show ${count} passed`, comment: '{count} is how many checks passed.' }) : t({ message: `Show ${count} finished`, comment: '{count} is how many checks passed or were skipped.' })}
    </button> : null}
    <div className="pr-surface__fold-actions">
      <Button variant="ghost" onClick={() => openExternal(checksOnGitHub(url))}><ExternalLink size={14} aria-hidden="true" />{t`Open all checks on GitHub`}</Button>
    </div>
  </div>
})

function CheckRow({ check }: { readonly check: GitPullRequestCheck }): ReactNode {
  const { t } = useLingui()
  const Icon = CHECK_ICONS[check.status]
  const { group, own } = checkNameParts(check.name)
  const word = checkWord(check)
  const took = checkTime(check)
  const name = check.name
  const content = <>
    <Icon size={15} aria-hidden="true" data-status={check.status} />
    <span className="pr-surface__check-name">{group ? <span className="pr-surface__check-group">{group} / </span> : null}<span>{own}</span>
      {check.description ? <small className="pr-surface__check-why">{check.description}</small> : null}</span>
    <span className="pr-surface__check-word">{word}</span>
    <span className="pr-surface__check-time">{took}</span>
  </>
  const url = check.url
  return <li className="pr-surface__check" data-status={check.status}>
    {url
      ? <button type="button" className="pr-surface__check-row tt-focusable" title={onGitHub(url) ? t`Open on GitHub` : t`Open in the browser`} onClick={() => openExternal(url)}
        aria-label={onGitHub(url)
          ? took ? t({ message: `Open ${name} on GitHub. ${word}, ${took}`, comment: '{name} is a check\'s name; {word} is its state, as in Failed; {took} how long it took.' }) : t({ message: `Open ${name} on GitHub. ${word}`, comment: '{name} is a check\'s name; {word} is its state, as in Failed.' })
          : took ? t({ message: `Open ${name} in the browser. ${word}, ${took}`, comment: '{name} is a check\'s name; {word} is its state, as in Failed; {took} how long it took.' }) : t({ message: `Open ${name} in the browser. ${word}`, comment: '{name} is a check\'s name; {word} is its state, as in Failed.' })}>
        {content}<ExternalLink size={13} aria-hidden="true" className="pr-surface__check-go" />
      </button>
      : <div className="pr-surface__check-row" data-still="">{content}<span className="pr-surface__check-go" /></div>}
  </li>
}

/** The pull request's description, drawn by the transcript's own Markdown reader, which leaves pictures unloaded until asked. */
export const PullRequestDescription = memo(function PullRequestDescription({ detail }: { readonly detail: Pick<GitPullRequestDetail, 'body' | 'author'> }): ReactNode {
  const { t } = useLingui()
  const { author } = detail
  return <>
    {author ? <p className="pr-surface__from tt-paragraph">{t({ message: `Opened by ${author}.`, comment: '{author} is a GitHub user name.' })}</p> : null}
    {detail.body.trim() ? <div className="pr-surface__description"><MessageContent text={detail.body} /></div> : <p className="pr-surface__quiet tt-paragraph">{t`No description.`}</p>}
  </>
})

/**
 * The files a pull request changes under their folders, as the Changes tree groups them, the folder that changed most
 * first, each folder's files the most changed first, with its counts and a press that opens it on GitHub. A pull request
 * of this thread's own branch also offers its whole diff in Changes, where it can be read here.
 */
export function PullRequestFiles({ detail, onReview }: { readonly detail: Pick<GitPullRequestDetail, 'url' | 'files' | 'changedFiles'>; readonly onReview: (() => void) | undefined }): ReactNode {
  const { t } = useLingui()
  const listLabel = t({ message: 'Changed files', comment: 'The list of files a pull request changes.' })
  const folders = useMemo(() => filesByFolder(detail.files ?? []), [detail.files])
  const listed = detail.files?.length ?? 0
  const shown = shownCount(listed), all = shownCount(detail.changedFiles ?? listed)
  const folderId = useId()
  const open = (file: GitPullRequestFile): void => { void fileOnGitHub(detail.url, file.path).then(openExternal) }
  return <>
    {/* First, since a long list would otherwise push the way to read the diff out of sight. */}
    {onReview ? <div className="pr-surface__fold-actions"><Button variant="secondary" onClick={onReview}>{t`Review in Changes`}</Button></div> : null}
    {listed ? <ul className="pr-surface__files" aria-label={listLabel}>{folders.map((group, at) => {
      const id = `${folderId}-${at}`
      return <li key={group.folder} className="pr-surface__files-group">
        {/* The folder heads its files with what they change between them, quieter than each file's own counts. */}
        {group.folder ? <span className="pr-surface__files-folder"><span><bdi id={id}>{group.folder}</bdi></span><LineCounts additions={group.additions} deletions={group.deletions} quiet /><span className="pr-surface__file-go" /></span> : null}
        <ul aria-labelledby={group.folder ? id : undefined}>{group.files.map(file => {
          const { name } = pathParts(file.path)
          const path = file.path, added = shownLineCount(file.additions), removed = shownLineCount(file.deletions)
          return <li key={file.path}>
            <button type="button" className="pr-surface__file tt-focusable" title={file.path} onClick={() => open(file)}
              aria-label={t({ message: `Open ${path} on GitHub. ${added} added, ${removed} removed`, comment: '{path} is a file\'s path; {added} and {removed} are counts of lines.' })}>
              <bdi className="pr-surface__file-name">{name}</bdi>
              <LineCounts additions={file.additions} deletions={file.deletions} />
              <ExternalLink size={13} aria-hidden="true" className="pr-surface__file-go" />
            </button>
          </li>
        })}</ul>
      </li>
    })}</ul> : <p className="pr-surface__quiet tt-paragraph">{t`GitHub did not list the files.`}</p>}
    {(detail.changedFiles ?? 0) > listed && listed ? <p className="pr-surface__quiet tt-paragraph">{t({ message: `Showing the ${shown} first of ${all} files.`, comment: '{shown} and {all} are counts of files.' })}</p> : null}
    <div className="pr-surface__fold-actions">
      <Button variant="ghost" onClick={() => openExternal(filesOnGitHub(detail.url))}><ExternalLink size={14} aria-hidden="true" />{t`Open files on GitHub`}</Button>
    </div>
  </>
}

/** Words for a line of the surface when a pull request is read but not this thread's: why its presses are not offered. */
export function UnlinkedDock({ number, disabled, onLink }: { readonly number: number; readonly disabled: boolean; readonly onLink: () => void }): ReactNode {
  const { t } = useLingui()
  return <div className="pr-surface__finished" data-state="unlinked"><CircleAlert size={20} aria-hidden="true" />
    <div><strong>{t({ message: `#${number} is not linked to this thread`, comment: '{number} is a pull request\'s number.' })}</strong><span>{t`Reading it changes nothing. Link it to merge it or change it from here.`}</span></div>
    <Button variant="secondary" disabled={disabled} onClick={onLink}>{t`Link to this thread`}</Button></div>
}
