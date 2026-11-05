import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, CircleCheck, CircleDashed, CircleX, GitPullRequest, GitPullRequestDraft, RotateCw, Search, type LucideIcon } from 'lucide-react'
import { plural } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import { isPullRequestListLimited, type GitPullRequestList, type GitPullRequestListItem } from '../../../shared/gitPullRequests'
import { agoWords } from '../watcher/machineWords'
import { shownCount, shownLineCount } from '../state/interfaceNumbers'
import { PullRequestLineCounts } from './PullRequestDetails'
import { limitedWords, listChecksWord, listMatches, listReviewWord, stateLabel } from './pullRequestSurface.logic'

const openExternal = (url: string): void => { void window.sotto?.openExternalLink?.(url) }
type ListRead = { readonly status: 'idle' } | { readonly status: 'loading'; readonly list: GitPullRequestList | null } | { readonly status: 'ready'; readonly list: GitPullRequestList } | { readonly status: 'none' } | { readonly status: 'failed'; readonly words: string; readonly list: GitPullRequestList | null }
const LIST_CHECK_ICONS: Readonly<Record<GitPullRequestListItem['checks'], LucideIcon | null>> = { passed: CircleCheck, failing: CircleX, running: CircleDashed, none: null }

/**
 * The repository's open pull requests, read from GitHub only once this is opened and on its own Refresh, the most
 * recently updated first; nothing here polls and nothing is kept on a record. A press shows that pull request in this
 * surface. Reading one this thread does not know changes nothing: acting on it still asks to link it first (ADR-0027).
 */
export function OpenPullRequests({ threadId, shownUrl, open, onToggle, onShow }: {
  readonly threadId: string; readonly shownUrl: string | null; readonly open: boolean; readonly onToggle: () => void; readonly onShow: (url: string) => void
}): ReactNode {
  const { t } = useLingui()
  const [read, setRead] = useState<ListRead>({ status: 'idle' })
  const [query, setQuery] = useState('')
  const generation = useRef(0)
  const panel = useId()
  const load = async (): Promise<void> => {
    const turn = ++generation.current
    const ask = window.sotto?.agents?.gitPullRequestList
    const last = read.status === 'ready' || read.status === 'failed' || read.status === 'loading' ? read.list : null
    if (!ask) { setRead({ status: 'failed', words: t`Pull requests are not available in this window.`, list: null }); return }
    setRead({ status: 'loading', list: last })
    try {
      const next = await ask({ threadId })
      if (turn !== generation.current) return
      if (next === null) setRead({ status: 'none' })
      else if (isPullRequestListLimited(next)) setRead({ status: 'failed', words: limitedWords(next.limited.retryAt), list: last })
      else setRead({ status: 'ready', list: next })
    } catch {
      if (turn === generation.current) setRead({ status: 'failed', words: t`Could not read the open pull requests from GitHub. Check your gh sign-in and connection, then refresh.`, list: last })
    }
  }
  useEffect(() => { if (open && read.status === 'idle') void load() })
  useEffect(() => () => { generation.current++ }, [])
  const list = read.status === 'ready' || read.status === 'loading' || read.status === 'failed' ? read.list : null
  const rows = list ? list.pullRequests.filter(item => listMatches(item, query)) : []
  const heading = t({ message: 'Open pull requests', comment: 'The fold listing every open pull request of the repository.' })
  const Chevron = open ? ChevronDown : ChevronRight
  const total = list ? shownCount(list.total) : null
  const repository = list?.repository
  return <div className="pr-surface__fold">
    <button type="button" className="pr-surface__fold-head tt-focusable" aria-expanded={open} aria-controls={open ? panel : undefined} onClick={onToggle}>
      <Chevron size={15} aria-hidden="true" />{heading}{total !== null ? <>{' '}<span className="pr-surface__quiet">{total}</span></> : null}
    </button>
    {open ? <div id={panel} className="pr-surface__fold-body" data-wide="">
      {list ? <div className="pr-surface__list-tools">
        <label className="pr-surface__search"><Search size={14} aria-hidden="true" />
          <input type="search" value={query} placeholder={t`Search pull requests`} aria-label={t`Search open pull requests by title, number, author or branch`} autoComplete="off" spellCheck={false}
            onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); setQuery('') } }} />
        </label>
        <button type="button" className="files-icon tt-focusable" aria-label={t`Refresh open pull requests`} title={t`Refresh open pull requests`} data-busy={read.status === 'loading' || undefined} onClick={() => void load()}><RotateCw size={15} aria-hidden="true" /></button>
      </div> : null}
      {read.status === 'loading' && !list ? <p className="files-preview__loading" role="status">{t`Reading the open pull requests…`}</p> : null}
      {read.status === 'none' ? <p className="pr-surface__quiet tt-paragraph">{t`This project has no GitHub remote, so it has no pull requests to list.`}</p> : null}
      {read.status === 'failed' ? <div className="pr-surface__list-failed" role="alert"><span>{read.words}</span>{list ? null : <button type="button" className="files-link tt-focusable" onClick={() => void load()}>{t`Try again`}</button>}</div> : null}
      {list && rows.length ? <ul className="pr-surface__open-list" aria-label={heading}>{rows.map(item => <ListRow key={item.url} item={item} current={item.url === shownUrl} onShow={onShow} />)}</ul> : null}
      {list && !list.pullRequests.length && repository ? <p className="pr-surface__quiet tt-paragraph">{t({ message: `${repository} has no open pull requests.`, comment: '{repository} is a GitHub repository, as in owner/name.' })}</p> : null}
      {list && list.pullRequests.length > 0 && !rows.length ? <p className="pr-surface__quiet tt-paragraph">{t`No open pull request matches that search.`}</p> : null}
      {list && list.total > list.pullRequests.length ? <p className="pr-surface__quiet tt-paragraph">{plural(list.pullRequests.length, { other: `The # most recently updated of ${total}.` })}{' '}
        <button type="button" className="pr-surface__textlink tt-focusable" onClick={() => openExternal(`https://github.com/${list.repository}/pulls`)}>{t`See them all on GitHub`}</button></p> : null}
    </div> : null}
  </div>
}

function ListRow({ item, current, onShow }: { readonly item: GitPullRequestListItem; readonly current: boolean; readonly onShow: (url: string) => void }): ReactNode {
  const { t } = useLingui()
  const Icon = item.draft ? GitPullRequestDraft : GitPullRequest
  const CheckIcon = LIST_CHECK_ICONS[item.checks]
  const checks = listChecksWord(item.checks)
  const when = item.updatedAt ? agoWords(Date.now() - Date.parse(item.updatedAt)) : null
  const { number, title } = item
  const by = item.author
  const added = shownLineCount(item.additions), removed = shownLineCount(item.deletions)
  const review = listReviewWord(item.reviewDecision)
  const label = item.draft
    ? t({ message: `Show draft #${number}: ${title}. ${checks}. ${added} added, ${removed} removed`, comment: '{checks} says how its checks stand, as in Checks passed.' })
    : t({ message: `Show #${number}: ${title}. ${checks}. ${added} added, ${removed} removed`, comment: '{checks} says how its checks stand, as in Checks passed.' })
  return <li>
    <button type="button" className="pr-surface__open-row tt-focusable" aria-current={current || undefined} aria-label={review ? `${label}. ${review}` : label} onClick={() => onShow(item.url)}>
      <Icon size={15} aria-hidden="true" data-state={item.draft ? 'draft' : 'open'} />
      <span className="pr-surface__open-title"><span className="pr-surface__link-number">#{item.number}</span> {item.title}</span>
      {CheckIcon ? <CheckIcon size={14} aria-hidden="true" className="pr-surface__open-checks" data-checks={item.checks} /> : <span className="pr-surface__open-checks" />}
      <span className="pr-surface__open-meta">
        {by ? <span>{by}</span> : null}{when ? <span>{when}</span> : null}<PullRequestLineCounts additions={item.additions} deletions={item.deletions} />
        {item.draft ? <span>{stateLabel({ state: 'open', draft: true })}</span> : review ? <span data-review={item.reviewDecision}>{review}</span> : null}
      </span>
    </button>
  </li>
}
