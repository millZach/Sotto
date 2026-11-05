import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import { useLingui } from '@lingui/react/macro'
import { Button } from '../components/Button'
import { teamMergeOrder, TEAM_DESK_REFRESH_MS, type TeamChecks, type TeamDesk, type TeamLinkView, type TeamMergeOrderRow, type TeamsBridge, type TeamsState } from '../../../shared/teams'
import { whenOf } from './teamsState'

/** How often the user's own desk catches up while it is open. It reads this computer's records and sends nothing. */
const OWN_DESK_REFRESH_MS = 15_000

function useDeskWords() {
  const { t } = useLingui()
  const stands: Readonly<Record<TeamDesk['threads'][number]['stands'], string>> = { working: t`Working`, 'waiting-on-its-owner': t`Waiting on its owner`, failed: t`Last turn failed`, idle: t`Idle` }
  const checks: Readonly<Record<TeamChecks, string>> = { passed: t`checks passed`, pending: t`checks running`, failed: t`checks failed`, unknown: t`checks not read` }
  return { stands, standing: (item: { readonly draft: boolean; readonly checks: TeamChecks }) => item.draft ? t`draft` : checks[item.checks] }
}

/** One owner's threads, by project in the order they came, most active first. */
function DeskThreads({ desk }: { readonly desk: TeamDesk }): ReactNode {
  const { t } = useLingui()
  const words = useDeskWords(), more = desk.more
  const projects: { readonly title: string; readonly threads: TeamDesk['threads'][number][] }[] = []
  for (const thread of desk.threads) {
    const held = projects.find(project => project.title === thread.project)
    if (held) held.threads.push(thread)
    else projects.push({ title: thread.project, threads: [thread] })
  }
  return <>
    {projects.map(project => <section key={project.title} aria-label={project.title}>
      {project.title ? <h4 className="teams-desk__project">{project.title}</h4> : null}
      {project.threads.map((thread, index) => <div key={index} className="teams-desk__thread">
        <span className="teams-desk__title">{thread.title}</span>
        <span className="teams-desk__stands teams-muted" data-stands={thread.stands}><i aria-hidden="true" />{words.stands[thread.stands]}</span>
        {thread.pullRequests.map(item => <span key={item.number} className="teams-desk__pull">#{item.number} {item.title} <span className="teams-muted">· {words.standing(item)}</span></span>)}
      </div>)}
    </section>)}
    {more > 0 ? <p className="teams-muted">{t`${more} more threads did not fit.`}</p> : null}
  </>
}

/** The merge order across the top (ADR-0189, decision 8). Advice: it offers no press at all. */
function MergeOrder({ rows, name, read }: { readonly rows: readonly TeamMergeOrderRow[]; readonly name: string; readonly read: boolean }): ReactNode {
  const { t } = useLingui()
  const words = useDeskWords(), whose = (row: TeamMergeOrderRow) => row.whose === 'yours' ? t`yours` : row.whose === 'both' ? t`both of you` : name
  const projects = new Set(rows.map(row => row.project)).size
  const own = rows.map(row => `#${row.number}`).join(', ')
  return <section className="teams-order" aria-label={t`Merge order`}>
    <div className="teams-order__top"><h3 className="teams-section__title">{t`Merge order`}</h3>
      <span className="teams-muted">{read ? t`Advice from both desks: checks passed first, then oldest. Nothing merges from this, and it cannot see which files pull requests share.`
        : rows.length ? t`Needs ${name}'s desk first. Your own, for now: ${own}.` : t`Needs ${name}'s desk first.`}</span></div>
    {read && rows.length ? <ol className="teams-order__list">{rows.map((row, index) => <li key={index} data-checks={row.draft ? 'draft' : row.checks}>
      <b>{index + 1}</b><span className="teams-order__what">{projects > 1 && row.project ? `${row.project} ` : ''}#{row.number} {row.title} <span className="teams-muted">· {whose(row)}</span></span>
      <span className="teams-order__checks">{words.standing(row)}</span></li>)}</ol>
      : read ? <p className="teams-muted">{t`Neither of you has an open pull request here.`}</p> : null}
  </section>
}

/**
 * Two desks: yours beside a teammate's (ADR-0189), in Watcher's column with no ground of their own (Zach's pick, November 5,
 * 2026). While they are on screen, the teammate's desk is read on opening when the last read is older than two minutes, then
 * every two minutes, and never while the window is hidden (ADR-0193). Leaving stops it.
 */
export function TeamDesks({ link, state, bridge, onClose }: { readonly link: TeamLinkView; readonly state: TeamsState; readonly bridge: TeamsBridge; readonly onClose: () => void }): ReactNode {
  const { t } = useLingui()
  const [own, setOwn] = useState<TeamDesk | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), back = useRef<HTMLButtonElement>(null)
  const name = link.name, held = state.desks[link.id], when = held ? whenOf(held.at, Date.now()) : '', leftOut = state.projects.some(project => project.leftOut)
  // When the desk was last read, or last tried: a computer that does not answer is tried again in two minutes, not sooner.
  const heldAt = useRef(held?.at), tried = useRef(0), reading = useRef(false)
  heldAt.current = held?.at
  useEffect(() => { back.current?.focus() }, [])
  useEffect(() => {
    let live = true
    const read = (): void => { void bridge.ownDesk().then(desk => { if (live) setOwn(desk) }).catch(() => undefined) }
    read()
    const timer = setInterval(read, OWN_DESK_REFRESH_MS)
    return () => { live = false; clearInterval(timer) }
  }, [bridge])
  const get = (pressed: boolean): void => {
    if (reading.current) return
    reading.current = true; tried.current = Date.now(); setBusy(true)
    if (pressed) setError(null)
    void bridge.command({ type: 'read-desk', linkId: link.id }).then(result => { setError(result.status === 'refused' ? result.message : null) })
      .catch(() => setError(t`Sotto could not do that. Nothing changed. Try again.`)).finally(() => { reading.current = false; setBusy(false) })
  }
  useEffect(() => {
    const stale = (): boolean => Date.now() - Math.max(tried.current, heldAt.current === undefined ? 0 : Date.parse(heldAt.current)) >= TEAM_DESK_REFRESH_MS
    const shown = (): boolean => document.visibilityState === 'visible'
    if (shown() && stale()) get(false)
    const timer = setInterval(() => { if (shown() && stale()) get(false) }, TEAM_DESK_REFRESH_MS / 4)
    const visible = (): void => { if (shown() && stale()) get(false) }
    document.addEventListener('visibilitychange', visible)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', visible) }
  }, [link.id, bridge])
  const noDesk: TeamDesk = { threads: [], more: 0 }
  const rows = teamMergeOrder(own ?? noDesk, held?.desk ?? noDesk)
  return <div className="teams-desks" role="group" aria-label={t`Two desks with ${name}`} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() } }}>
    <div className="teams-desks__head">
      <Button ref={back} variant="ghost" aria-label={t`Back to Teams`} onClick={onClose}>← {t`Teams`}</Button>
      <h2 className="teams-desks__title">{t`You and ${name}`}</h2>
      <span className="teams-desks__grow" />
      <span className="teams-muted teams-desks__when" role="status">{busy ? t`Getting ${name}'s desk…` : held ? t`As of ${when}, again every 2 minutes while open` : ''}</span>
      {/* Not disabled while it reads: that would drop keyboard focus, and Escape with it. */}
      <Button variant="secondary" aria-busy={busy} onClick={() => get(true)}>{held ? t`Update now` : t`Get ${name}'s desk`}</Button>
    </div>
    {error ? <p className="agent-error teams-desk__error" role="alert">{error}</p> : null}
    <MergeOrder rows={rows} name={name} read={held !== undefined} />
    <div className="teams-desks__columns">
      <section className="teams-desk" aria-label={t`Your desk`}>
        <h3 className="teams-desk__head">{t`Yours`} <span className="teams-muted">{t`Now`}</span></h3>
        {own === null ? <p className="teams-muted" role="status">{t`Reading your threads…`}</p> : own.threads.length ? <DeskThreads desk={own} /> : <p className="teams-desk__empty teams-muted">{t`No threads to show right now.`}</p>}
        {leftOut ? <p className="teams-muted">{t`The projects you left out are not here, as they are not on ${name}'s desks.`}</p> : null}
      </section>
      <section className="teams-desk" aria-label={t`${name}'s desk`}>
        <h3 className="teams-desk__head">{t`${name}'s`} {held ? <span className="teams-muted">{t`As of ${when}`}</span> : null}</h3>
        {held ? held.desk.threads.length ? <DeskThreads desk={held.desk} /> : <p className="teams-desk__empty teams-muted">{t`${name} has no threads to show.`}</p>
          : <p className="teams-desk__empty teams-muted">{busy ? t`Getting ${name}'s desk…` : t`Nothing from ${name} yet.`}</p>}
      </section>
    </div>
    <p className="teams-muted teams-desks__fine">{t`Asks still go through Watcher. ${name}'s Teams tab lists the reads, and their left-out projects never come. Leave and come back: the desks stay open.`}</p>
  </div>
}
