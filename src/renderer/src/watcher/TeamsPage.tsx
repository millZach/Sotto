import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useLingui } from '@lingui/react/macro'
import { Button } from '../components/Button'
import { TEAM_ANSWERS_PER_DAY, TEAM_NAME_MAX, TEAM_RENEW_WINDOW_MS, type TeamDeskRead, type TeamLinkView, type TeammateMessage, type TeamsBridge, type TeamsCommand, type TeamsState } from '../../../shared/teams'
import { TeamDesks } from './TeamDesks'
import { useTeamWords } from './TeammateMessages'
import { dateOf, timeOf, useTeamsBridge, useTeamsState, whenOf } from './teamsState'
import './teams.css'

const OWLS = ['   ,_,                 ,_,   ', '  (o,o) . . . . . . . (o,o)  ', '  /)_)     tailnet     (_(\\  ', ' ~~~~~~~~~~~~~~~~~~~~~~~~~~~ '].join('\n')
const LATEST_ROWS = 8

const desksButtonId = (linkId: string): string => `teams-open-desks-${linkId}`

/** One teammate: how long the link lasts, Link again, and what it has cost today. */
function TeamLinkCard({ link, command, busy, openDesks }: { readonly link: TeamLinkView; readonly command: (value: TeamsCommand) => void; readonly busy: boolean; readonly openDesks: () => void }): ReactNode {
  const { t } = useLingui()
  const [removing, setRemoving] = useState(false), keep = useRef<HTMLButtonElement>(null), removeButton = useRef<HTMLButtonElement>(null), reopened = useRef(false), name = link.name, until = dateOf(link.expiresAt), answers = link.answersToday, cap = TEAM_ANSWERS_PER_DAY, refused = link.refusedToday
  const soon = Date.parse(link.expiresAt) - Date.now() <= TEAM_RENEW_WINDOW_MS
  // Opening the question moves focus to its safe answer, and closing it brings focus back to the press that opened it.
  useEffect(() => {
    if (removing) keep.current?.focus()
    else if (reopened.current) { reopened.current = false; removeButton.current?.focus() }
  }, [removing])
  const closeQuestion = (): void => { reopened.current = true; setRemoving(false) }
  const again = link.expired || soon || link.theyWantAgain || link.wantedAgain
  return <section className="teams-card" aria-label={t`Link with ${name}`}>
    <div className="teams-card__head">
      <span className="teams-card__avatar" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
      <div className="teams-card__who"><strong>{name}</strong>
        <span className="teams-muted">{link.machine}{link.lastUsedAt ? ` · ${t`last used ${whenOf(link.lastUsedAt, Date.now())}`}` : ''}</span></div>
      {removing ? null : <Button ref={removeButton} variant="ghost" disabled={busy} onClick={() => setRemoving(true)}>{t`Remove link`}</Button>}
    </div>
    {removing ? <div className="teams-card__confirm" role="group" aria-label={t`Remove the link with ${name}`} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeQuestion() } }}>
      <p className="teams-muted">{t`Remove the link with ${name}? Nothing is sent to them. Their next ask will say the link is gone.`}</p>
      <Button variant="danger" disabled={busy} onClick={() => command({ type: 'remove-link', linkId: link.id })}>{t`Remove link`}</Button>
      <Button ref={keep} variant="ghost" onClick={closeQuestion}>{t`Keep it`}</Button>
    </div> : null}
    <dl className="teams-facts">
      <dt>{t`Link`}</dt>
      <dd>{link.expired ? t`Ran out on ${until}. ${name} cannot ask until you both press Link again.` : t`Lasts until ${until}.`}
        {link.wantedAgain ? ` ${t`Waiting for ${name} to press Link again.`}` : link.theyWantAgain ? ` ${t`${name} pressed Link again. Press it too to keep the link.`}` : ''}</dd>
      <dt>{t`Answers`}</dt>
      <dd>{t`${answers} of ${cap} today, on your own provider account.`}{refused > 0 ? ` ${t`${refused} turned down.`}` : ''}</dd>
    </dl>
    <div className="teams-actions">
      <Button id={desksButtonId(link.id)} onClick={openDesks}>{t`Open two desks`}</Button>
      {again && !link.wantedAgain ? <Button disabled={busy} onClick={() => command({ type: 'link-again', linkId: link.id })}>{t`Link again`}</Button> : null}
    </div>
  </section>
}

/** What a summary covers: every project, unless the user leaves one out (Zach's pick, November 3, 2026). */
function WhatYouShare({ state, command, busy }: { readonly state: TeamsState; readonly command: (value: TeamsCommand) => void; readonly busy: boolean }): ReactNode {
  const { t } = useLingui()
  return <section className="teams-card" aria-labelledby="teams-share">
    <h3 id="teams-share" className="teams-card__title">{t`What you share`}</h3>
    <p className="teams-muted">{t`When a teammate asks or reads your desk, your computer tells them each thread's title, project and where it stands, and its open pull requests and how their checks stand. Never its messages, code or file names. Thread titles come from your words, so untick any project they should not see.`}</p>
    {state.projects.length ? <ul className="teams-projects">{state.projects.map(project => <li key={project.key}>
      <label className="teams-projects__row"><input type="checkbox" checked={!project.leftOut} disabled={busy} onChange={event => command({ type: 'leave-out', project: project.key, leftOut: !event.currentTarget.checked })} />
        <span>{project.title}</span><span className="teams-muted">{project.machine ?? t`This computer`}</span></label>
    </li>)}</ul> : <p className="teams-muted">{t`No projects yet.`}</p>}
  </section>
}

const isAsk = (row: TeammateMessage | TeamDeskRead): row is TeammateMessage => 'direction' in row

function Latest({ state }: { readonly state: TeamsState }): ReactNode {
  const { t } = useLingui()
  const words = useTeamWords(), now = Date.now()
  // A read of this computer's desk sits among the asks, by when it came. It has no words, and it never shows in Watcher's conversation (ADR-0189).
  const rows = [...state.messages.slice(-LATEST_ROWS), ...state.deskReads.slice(-LATEST_ROWS)].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, LATEST_ROWS)
  const reads = state.deskReads.length
  if (!rows.length) return null
  return <section className="teams-card" aria-labelledby="teams-latest">
    <h3 id="teams-latest" className="teams-card__title">{t`Latest`}</h3>
    <dl className="teams-facts">{rows.map(row => {
      const name = row.teammate
      if (!isAsk(row)) return <div key={row.id} className="teams-facts__row"><dt>{whenOf(row.at, now)}</dt><dd>{t`${name} read your desk.`}</dd></div>
      const said = row.state === 'answered' ? row.answer ?? '' : row.state === 'refused' ? words.refusal(name, row.refusal) : row.state === 'failed' ? t`No answer came.` : t`Waiting for the answer.`
      return <div key={row.id} className="teams-facts__row"><dt>{whenOf(row.at, now)}</dt>
        <dd>{row.direction === 'we-asked' ? words.weAsked(name, row.ask) : words.theyAsked(name, row.ask)} <span className="teams-muted">{said}</span></dd></div>
    })}</dl>
    {reads ? <details className="teams-reads">
      <summary className="teams-muted">{t`Every read of your desk (${reads})`}</summary>
      <ul className="teams-reads__list teams-muted">{[...state.deskReads].reverse().map(read => { const who = read.teammate, when = whenOf(read.at, now); return <li key={read.id}>{t`${who}, ${when}`}</li> })}</ul>
    </details> : null}
  </section>
}

function LinkForms({ state, command, busy }: { readonly state: TeamsState; readonly command: (value: TeamsCommand) => void; readonly busy: boolean }): ReactNode {
  const { t } = useLingui()
  const [name, setName] = useState(''), [pasted, setPasted] = useState(''), [copied, setCopied] = useState(false), nameId = useId(), codeId = useId()
  useEffect(() => { setName(current => current || state.ownName) }, [state.ownName])
  const shown = name.trim(), code = state.code
  const expires = code ? timeOf(code.expiresAt) : ''
  return <section className="teams-card" aria-labelledby="teams-link">
    <h3 id="teams-link" className="teams-card__title">{t`Link with a teammate`}</h3>
    <p className="teams-muted">{t`Their computer must be able to reach yours on a tailnet, and yours theirs. On separate tailnets, share your computers with each other in Tailscale first.`}</p>
    <label className="teams-field" htmlFor={nameId}>{t`Your name, as your teammate sees it`}</label>
    <input id={nameId} className="tt-input" value={name} maxLength={TEAM_NAME_MAX} spellCheck={false} onChange={event => setName(event.currentTarget.value)} />
    {code ? <div className="teams-code">
      <code className="teams-code__text">{code.text}</code>
      <p className="teams-muted">{t`Send this to your teammate. It works once, until ${expires}.`}</p>
      <div className="teams-actions">
        <Button onClick={() => { void navigator.clipboard.writeText(code.text).then(() => setCopied(true)) }}>{copied ? t`Copied` : t`Copy code`}</Button>
        <Button variant="ghost" disabled={busy} onClick={() => { setCopied(false); command({ type: 'cancel-code' }) }}>{t`Cancel code`}</Button>
      </div>
    </div> : <div className="teams-actions"><Button variant="primary" disabled={busy || !shown} onClick={() => { setCopied(false); command({ type: 'make-code', name: shown }) }}>{t`Make a code`}</Button></div>}
    <label className="teams-field" htmlFor={codeId}>{t`Got a code from your teammate?`}</label>
    <input id={codeId} className="tt-input" value={pasted} spellCheck={false} placeholder={t`Paste their code`} onChange={event => setPasted(event.currentTarget.value)} />
    <div className="teams-actions"><Button disabled={busy || !shown || !pasted.trim()} onClick={() => { command({ type: 'link', code: pasted, name: shown }); setPasted('') }}>{t`Link`}</Button></div>
  </section>
}

/** Settings > Hosts & phones says when each team link was last used (plan, decision 10). It changes nothing; the Teams tab does. */
export function TeamLinksOnHosts(): ReactNode {
  const { t } = useLingui()
  const state = useTeamsState(useTeamsBridge()), now = Date.now()
  if (!state?.links.length) return null
  return <section className="hosts-settings" aria-labelledby="teams-on-hosts">
    <h3 id="teams-on-hosts">{t`Team links`}</h3>
    <dl className="teams-facts">{state.links.map(link => {
      const name = link.name, until = dateOf(link.expiresAt), used = link.lastUsedAt ? whenOf(link.lastUsedAt, now) : ''
      return <div key={link.id} className="teams-facts__row"><dt>{name}</dt><dd>{link.expired ? t`Ran out on ${until}.` : t`Lasts until ${until}.`}{used ? ` ${t`Last used ${used}.`}` : ''}</dd></div>
    })}</dl>
    <p className="teams-muted">{t`Change these on the Teams tab in Watcher's room.`}</p>
  </section>
}

/** The Teams tab (ADR-0186): links, what they share and the latest asks. It sends nothing until a press. */
export function TeamsPage({ bridge, state }: { readonly bridge: TeamsBridge; readonly state: TeamsState | null }): ReactNode {
  const { t } = useLingui()
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const command = (value: TeamsCommand): void => {
    setBusy(true); setError(null)
    void bridge.command(value).then(result => { if (result.status === 'refused') setError(result.message) })
      .catch(() => setError(t`Sotto could not do that. Nothing changed. Try again.`)).finally(() => setBusy(false))
  }
  const linkNames = state?.links.map(link => link.name) ?? []
  const [desksOf, setDesksOf] = useState<string | null>(null), desksLink = state?.links.find(link => link.id === desksOf), closedDesks = useRef<string | null>(null)
  // Closing the desks brings focus back to the press that opened them.
  useEffect(() => {
    if (desksOf !== null || closedDesks.current === null) return
    document.getElementById(desksButtonId(closedDesks.current))?.focus()
    closedDesks.current = null
  }, [desksOf])
  const closeDesks = (): void => { closedDesks.current = desksOf; setDesksOf(null) }
  if (state && desksLink) return <div className="teams-page tt-paragraph" role="tabpanel" aria-labelledby="watcher-tab-teams"><TeamDesks link={desksLink} state={state} bridge={bridge} onClose={closeDesks} /></div>
  return <div className="teams-page tt-paragraph" role="tabpanel" aria-labelledby="watcher-tab-teams">
    <div className="teams-page__column">
      <pre className="teams-page__art" aria-hidden="true">{OWLS}</pre>
      <h2 className="teams-page__title">{t`Teams`}</h2>
      <p className="teams-page__sub teams-muted">{linkNames.length ? t`You and ${linkNames.join(', ')}, direct over your tailnet` : t`Let your Watcher and a teammate's talk, direct over your tailnet`}</p>
      {error ? <p className="agent-error teams-page__error" role="alert">{error}</p> : null}
      {state?.serveEnableUrl ? <div className="teams-actions"><Button onClick={() => command({ type: 'open-serve-setting' })}>{t`Turn on Serve`}</Button></div> : null}
      {state === null ? <p className="teams-muted" role="status">{t`Opening Teams…`}</p> : <>
        {state.links.map(link => <TeamLinkCard key={link.id} link={link} command={command} busy={busy} openDesks={() => setDesksOf(link.id)} />)}
        {state.links.length ? <WhatYouShare state={state} command={command} busy={busy} /> : null}
        <Latest state={state} />
        <LinkForms state={state} command={command} busy={busy} />
        {state.links.length ? <p className="teams-page__fine teams-muted">{t`Sotto says nothing to a teammate's computer until one of you asks or reads a desk, so this page never says who is online.`}</p> : null}
      </>}
    </div>
  </div>
}
