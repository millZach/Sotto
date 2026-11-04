import React, { memo, useMemo, type ReactNode } from 'react'
import { CircleAlert, ExternalLink } from 'lucide-react'
import { useLingui } from '@lingui/react/macro'
import type { GitPullRequestDetail, GitPullRequestFile } from '../../../shared/gitPullRequests'
import { MessageContent } from '../agents/MessageContent'
import { Button } from '../components/Button'
import { shownCount } from '../state/interfaceNumbers'
import { fileOnGitHub, filesByWeight, filesOnGitHub, pathParts } from './pullRequestSurface.logic'

const openExternal = (url: string): void => { void window.sotto?.openExternalLink?.(url) }

/** One count of lines, "+2,114" or "−2,097", in the interface language's digits. */
function LineCounts({ additions, deletions }: { readonly additions: number; readonly deletions: number }): ReactNode {
  const { t, i18n } = useLingui()
  // Grouped, since these run to thousands and are read at a glance.
  const added = additions.toLocaleString(i18n.locale || 'en'), removed = deletions.toLocaleString(i18n.locale || 'en')
  return <span className="pr-surface__counts">
    <span className="tt-visually-hidden">{t({ message: `${added} added, ${removed} removed`, comment: '{added} and {removed} are counts of lines in a pull request.' })}</span>
    {/* A side with no lines says nothing, so what a file did reads at a glance: only added, only removed, or both. */}
    <span data-side="added" aria-hidden="true">{additions > 0 || deletions === 0 ? `+${added}` : ''}</span> <span data-side="removed" aria-hidden="true">{deletions > 0 ? `−${removed}` : ''}</span>
  </span>
}
export { LineCounts as PullRequestLineCounts }

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
 * The files a pull request changes, the most changed first, each with its counts and a press that opens it on GitHub. A
 * pull request of this thread's own branch also offers its whole diff in Changes, where it can be read here.
 */
export function PullRequestFiles({ detail, onReview }: { readonly detail: Pick<GitPullRequestDetail, 'url' | 'files' | 'changedFiles'>; readonly onReview: (() => void) | undefined }): ReactNode {
  const { t } = useLingui()
  const listLabel = t({ message: 'Changed files', comment: 'The list of files a pull request changes.' })
  const files = useMemo(() => filesByWeight(detail.files ?? []), [detail.files])
  const shown = shownCount(files.length), all = shownCount(detail.changedFiles ?? files.length)
  const open = (file: GitPullRequestFile): void => { void fileOnGitHub(detail.url, file.path).then(openExternal) }
  return <>
    {files.length ? <ul className="pr-surface__files" aria-label={listLabel}>{files.map(file => {
      const { folder, name } = pathParts(file.path)
      const path = file.path, added = shownCount(file.additions), removed = shownCount(file.deletions)
      return <li key={file.path}>
        <button type="button" className="pr-surface__file tt-focusable" title={file.path} onClick={() => open(file)}
          aria-label={t({ message: `Open ${path} on GitHub. ${added} added, ${removed} removed`, comment: '{path} is a file\'s path; {added} and {removed} are counts of lines.' })}>
          <span className="pr-surface__file-path"><bdi className="pr-surface__file-folder">{folder}</bdi><bdi className="pr-surface__file-name">{name}</bdi></span>
          <LineCounts additions={file.additions} deletions={file.deletions} />
        </button>
      </li>
    })}</ul> : <p className="pr-surface__quiet tt-paragraph">{t`GitHub did not list the files.`}</p>}
    {(detail.changedFiles ?? 0) > files.length && files.length ? <p className="pr-surface__quiet tt-paragraph">{t({ message: `Showing the ${shown} first of ${all} files.`, comment: '{shown} and {all} are counts of files.' })}</p> : null}
    <div className="pr-surface__fold-actions">
      {onReview ? <Button variant="secondary" onClick={onReview}>{t`Review in Changes`}</Button> : null}
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
