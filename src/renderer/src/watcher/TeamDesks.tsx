import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import { useLingui } from '@lingui/react/macro'
import { Button } from '../components/Button'
import { teamMergeOrder, type TeamChecks, type TeamDesk, type TeamLinkView, type TeamMergeOrderRow, type TeamsBridge, type TeamsState } from '../../../shared/teams'
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
    <div className="teams-order__top"><strong>{t`Merge order`}</strong>
      <span className="teams-muted">{read ? t`Advice, worked out here: checks passed first, then oldest. Nothing merges from this, and it cannot see which files pull requests share.`
        : rows.length ? t`Needs ${name}'s desk first. Your own, for now: ${own}.` : t`Needs ${name}'s desk first.`}</span></div>
    {read && rows.length ? <ol className="teams-order__list">{rows.map((row, index) => <li key={index} title={row.title}>
      <b>{index + 1}</b> {projects > 1 && row.project ? `${row.project} ` : ''}#{row.number} <span className="teams-muted">{whose(row)} · {words.standing(row)}</span></li>)}</ol>
      : read ? <p className="teams-muted">{t`Neither of you has an open pull request here.`}</p> : null}
  </section>
}

/** Two desks: yours beside a teammate's (ADR-0189). Opening them sends nothing; only Get reads, once, on a press. */
export function TeamDesks({ link, state, bridge, onClose }: { readonly link: TeamLinkView; readonly state: TeamsState; readonly bridge: TeamsBridge; readonly onClose: () => void }): ReactNode {
  const { t } = useLingui()
  const [own, setOwn] = useState<TeamDesk | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), back = useRef<HTMLButtonElement>(null)
  const name = link.name, held = state.desks[link.id], when = held ? whenOf(held.at, Date.now()) : '', leftOut = state.projects.some(project => project.leftOut)
  useEffect(() => { back.current?.focus() }, [])
  useEffect(() => {
    let live = true
    const read = (): void => { void bridge.ownDesk().then(desk => { if (live) setOwn(desk) }).catch(() => undefined) }
    read()
    const timer = setInterval(read, OWN_DESK_REFRESH_MS)
    return () => { live = false; clearInterval(timer) }
  }, [bridge])
  const get = (): void => {
    if (busy) return
    setBusy(true); setError(null)
    void bridge.command({ type: 'read-desk', linkId: link.id }).then(result => { if (result.status === 'refused') setError(result.message) })
      .catch(() => setError(t`Sotto could not do that. Nothing changed. Try again.`)).finally(() => setBusy(false))
  }
  const noDesk: TeamDesk = { threads: [], more: 0 }
  const rows = teamMergeOrder(own ?? noDesk, held?.desk ?? noDesk)
  return <div className="teams-desks" role="group" aria-label={t`Two desks with ${name}`} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() } }}>
    <div className="teams-desks__head">
      <Button ref={back} variant="ghost" aria-label={t`Back to Teams`} onClick={onClose}>← {t`Teams`}</Button>
      <h2 className="teams-desks__title">{t`You and ${name}`}</h2>
      <span className="teams-desks__grow" />
      {held ? <span className="teams-muted">{t`As of ${when}`}</span> : null}
      {/* Not disabled while it reads: that would drop keyboard focus, and Escape with it. */}
      <Button variant="primary" aria-busy={busy} onClick={get}>{busy ? t`Getting…` : held ? t`Get it again` : t`Get ${name}'s desk`}</Button>
    </div>
    <MergeOrder rows={rows} name={name} read={held !== undefined} />
    <div className="teams-desks__columns">
      <section className="teams-desk" aria-label={t`Your desk`}>
        <h3 className="teams-desk__head">{t`Yours`} <span className="teams-muted">{t`Now`}</span></h3>
        {own === null ? <p className="teams-muted" role="status">{t`Reading your threads…`}</p> : own.threads.length ? <DeskThreads desk={own} /> : <p className="teams-desk__empty teams-muted">{t`No threads to show right now.`}</p>}
        {leftOut ? <p className="teams-muted">{t`The projects you left out are not here, as they are not on ${name}'s desks.`}</p> : null}
      </section>
      <section className="teams-desk" aria-label={t`${name}'s desk`}>
        <h3 className="teams-desk__head">{t`${name}'s`} {held ? <span className="teams-muted">{t`As of ${when}`}</span> : null}</h3>
        {error ? <p className="agent-error teams-desk__error" role="alert">{error}</p> : null}
        {held ? held.desk.threads.length ? <DeskThreads desk={held.desk} /> : <p className="teams-desk__empty teams-muted">{t`${name} has no threads to show.`}</p>
          : error ? null : <p className="teams-desk__empty teams-muted">{t`Nothing from ${name} yet. Get ${name}'s desk asks their computer once.`}</p>}
      </section>
    </div>
    <p className="teams-muted">{t`Asks still go through Watcher. ${name}'s Teams tab lists each time you read their desk, and their left-out projects never come.`}</p>
  </div>
}
