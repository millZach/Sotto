import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useLingui } from '@lingui/react/macro'
import { Button } from '../components/Button'
import { foldTeamDeskReads, TEAM_ANSWERS_PER_DAY, TEAM_NAME_MAX, TEAM_RENEW_WINDOW_MS, type TeamDeskReadsLine, type TeamLinkView, type TeammateMessage, type TeamsBridge, type TeamsCommand, type TeamsState } from '../../../shared/teams'
import { TeamDesks } from './TeamDesks'
import { useTeamWords } from './TeammateMessages'
import { dateOf, setOpenDesks, timeOf, useOpenDesks, useTeamsBridge, useTeamsState, whenOf } from './teamsState'
import './teams.css'

const LATEST_ROWS = 8

const desksButtonId = (linkId: string): string => `teams-open-desks-${linkId}`
type Command = (value: TeamsCommand) => void

/**
 * Whether the last check found both ways open, and what to do when it did not (ADR-0193). One shape for every result, so
 * Check again keeps keyboard focus when the words round it change; it stays pressable while it checks and ignores a second press.
 */
function LinkReach({ link, machine, command, busy }: { readonly link: TeamLinkView; readonly machine: string; readonly command: Command; readonly busy: boolean }): ReactNode {
  const { t } = useLingui()
  const name = link.name, reach = link.reach, when = reach ? whenOf(reach.at, Date.now()) : ''
  const state = reach === null ? 'unchecked' : reach.tooOld ? 'too-old' : !reach.toThem ? 'none' : reach.fromThem === true ? 'both' : reach.fromThem === false ? 'one-way' : 'unchecked'
  const words = state === 'both' ? <><i className="teams-dot" aria-hidden="true" />{t`Works both ways. Checked ${when}.`}</>
    : state === 'too-old' ? t`${name}'s Sotto is too old to check a link. Asks and desks still work. Ask ${name} to update it, then check again.`
    : state === 'one-way' ? <><strong>{t`${name}'s computer can't reach this one.`}</strong> {t`You can read ${name}'s desk, but ${name} can't read yours or ask your Watcher.`}{' '}
      {link.otherTailnet ? t`Share this computer with ${name} in Tailscale: on Machines, press ••• beside ${machine}, then Share, and send ${name} the link. Then check again.`
        : t`Check that this computer is on and that your tailnet's access rules let ${name} reach it. Then check again.`}</>
    : state === 'none' ? <><strong>{t`This computer couldn't reach ${name}'s.`}</strong> {link.otherTailnet ? t`${name}'s computer may be off, or not shared with you. ${name} shares it from Tailscale's Machines page. Then check again.` : t`${name}'s computer may be off. Check again when it is on.`}</>
    : t`Not checked yet. A check reaches each computer once and carries nothing.`
  return <div className="teams-reach" data-reach={state} role={state === 'one-way' || state === 'none' ? 'status' : undefined}>
    <p className={state === 'unchecked' ? 'teams-muted' : undefined}>{words}</p>
    <div className="teams-actions">
      {state === 'one-way' && link.otherTailnet ? <Button key="share" variant="secondary" onClick={() => command({ type: 'open-share-page' })}>{t`Open Tailscale's Machines`}</Button> : null}
      <Button key="check" variant="secondary" aria-busy={busy} onClick={() => { if (!busy) command({ type: 'check-link', linkId: link.id }) }}>{reach ? t`Check again` : t`Check both ways`}</Button>
    </div>
  </div>
}

/** A fold that closes on Escape, with focus back on its summary, as anything that opens does. */
function Fold({ className, summary, onToggle, children }: { readonly className: string; readonly summary: string; readonly onToggle?: (open: boolean) => void; readonly children: ReactNode }): ReactNode {
  const fold = useRef<HTMLDetailsElement>(null)
  return <details ref={fold} className={className} onToggle={event => onToggle?.(event.currentTarget.open)} onKeyDown={event => {
    if (event.key !== 'Escape' || !fold.current?.open) return
    event.preventDefault(); event.stopPropagation()
    fold.current.open = false
    fold.current.querySelector<HTMLElement>(':scope > summary')?.focus()
  }}><summary>{summary}</summary>{children}</details>
}

/** One teammate: whether the link works both ways, how long it lasts, and what it has cost today. */
function TeamLinkCard({ link, machine, command, busy, openDesks }: { readonly link: TeamLinkView; readonly machine: string; readonly command: Command; readonly busy: boolean; readonly openDesks: () => void }): ReactNode {
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
      <Button id={desksButtonId(link.id)} onClick={openDesks}>{t`Open two desks`}</Button>
      {removing ? null : <Button ref={removeButton} variant="ghost" disabled={busy} onClick={() => setRemoving(true)}>{t`Remove link`}</Button>}
    </div>
    {removing ? <div className="teams-card__confirm" role="group" aria-label={t`Remove the link with ${name}`} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeQuestion() } }}>
      <p className="teams-muted">{t`Remove the link with ${name}? Nothing is sent to them. Their next ask will say the link is gone.`}</p>
      <Button variant="danger" disabled={busy} onClick={() => command({ type: 'remove-link', linkId: link.id })}>{t`Remove link`}</Button>
      <Button ref={keep} variant="ghost" onClick={closeQuestion}>{t`Keep it`}</Button>
    </div> : null}
    <LinkReach link={link} machine={machine} command={command} busy={busy} />
    <dl className="teams-facts">
      <dt>{t`Link`}</dt>
      <dd>{link.expired ? t`Ran out on ${until}. ${name} cannot ask until you both press Link again.` : t`Lasts until ${until}.`}
        {link.wantedAgain ? ` ${t`Waiting for ${name} to press Link again.`}` : link.theyWantAgain ? ` ${t`${name} pressed Link again. Press it too to keep the link.`}` : ''}</dd>
      <dt>{t`Answers`}</dt>
      <dd>{t`${answers} of ${cap} today, on your own provider account.`}{refused > 0 ? ` ${t`${refused} turned down.`}` : ''}</dd>
    </dl>
    {again && !link.wantedAgain ? <div className="teams-actions"><Button variant="secondary" disabled={busy} onClick={() => command({ type: 'link-again', linkId: link.id })}>{t`Link again`}</Button></div> : null}
  </section>
}

/** What a summary covers: every project, unless the user leaves one out (Zach's pick, November 3, 2026). */
function WhatYouShare({ state, command, busy }: { readonly state: TeamsState; readonly command: Command; readonly busy: boolean }): ReactNode {
  const { t } = useLingui()
  return <section className="teams-section" aria-labelledby="teams-share">
    <h3 id="teams-share" className="teams-section__title">{t`What you share`}</h3>
    <p className="teams-muted">{t`When a teammate asks or reads your desk, your computer tells them each thread's title, project and where it stands, and its open pull requests and how their checks stand. Never its messages, code or file names. Thread titles come from your words, so untick any project they should not see.`}</p>
    {state.projects.length ? <ul className="teams-projects">{state.projects.map(project => <li key={project.key}>
      <label className="teams-projects__row"><input type="checkbox" checked={!project.leftOut} disabled={busy} onChange={event => command({ type: 'leave-out', project: project.key, leftOut: !event.currentTarget.checked })} />
        <span>{project.title}</span><span className="teams-muted">{project.machine ?? t`This computer`}</span></label>
    </li>)}</ul> : <p className="teams-muted">{t`No projects yet.`}</p>}
  </section>
}

const isAsk = (row: TeammateMessage | TeamDeskReadsLine): row is TeammateMessage => 'direction' in row

function Latest({ state }: { readonly state: TeamsState }): ReactNode {
  const { t } = useLingui()
  const words = useTeamWords(), now = Date.now()
  // Reads of this computer's desk sit among the asks, by when they came, and a teammate's reads close together are one line
  // (ADR-0193). They have no words, and never show in Watcher's conversation (ADR-0189).
  const rows = [...state.messages.slice(-LATEST_ROWS), ...foldTeamDeskReads(state.deskReads).slice(0, LATEST_ROWS)].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, LATEST_ROWS)
  const reads = state.deskReads.length
  if (!rows.length) return null
  return <section className="teams-section" aria-labelledby="teams-latest">
    <h3 id="teams-latest" className="teams-section__title">{t`Latest`}</h3>
    <dl className="teams-facts teams-facts--latest">{rows.map(row => {
      const name = row.teammate
      if (!isAsk(row)) {
        const count = row.count, from = timeOf(row.first)
        return <div key={row.id} className="teams-facts__row"><dt>{whenOf(row.at, now)}</dt><dd>{count > 1 ? t`${name} read your desk ${count} times, from ${from}, while their desks were open.` : t`${name} read your desk.`}</dd></div>
      }
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

/** One step of setup. `state` says whether it is done, needs something, or is still to come. */
function Step({ n, state, title, children }: { readonly n: number; readonly state: 'done' | 'needs' | 'todo'; readonly title: string; readonly children?: ReactNode }): ReactNode {
  const { t } = useLingui()
  const mark = state === 'done' ? '✓' : state === 'needs' ? '!' : String(n)
  const said = state === 'done' ? t`Done` : state === 'needs' ? t`Needs you` : t`To do`
  return <li className="teams-step" data-state={state}>
    <span className="teams-step__mark" aria-hidden="true">{mark}</span>
    <h4 className="teams-step__title">{title} <span className="tt-visually-hidden">({said})</span></h4>
    <div className="teams-step__body">{children}</div>
  </li>
}

/**
 * Linking, as six steps in the order they are done (ADR-0193): Tailscale on, Serve allowed, the teammate's computer seen,
 * this one shared back, the code, and the check. Steps 1 to 3 read this computer's own Tailscale and send nothing.
 */
function TeamSetup({ state, command, busy }: { readonly state: TeamsState; readonly command: Command; readonly busy: boolean }): ReactNode {
  const { t } = useLingui()
  const setup = state.setup, machine = setup?.machine ?? t`this computer`, problem = state.problem
  const [name, setName] = useState(''), [pasted, setPasted] = useState(''), [copied, setCopied] = useState(false), nameId = useId(), codeId = useId()
  useEffect(() => { setName(current => current || state.ownName) }, [state.ownName])
  // Reading this computer's own Tailscale sends nothing, so the steps read it as they show.
  useEffect(() => { command({ type: 'read-setup' }) }, [])
  const shown = name.trim(), code = state.code, expires = code ? timeOf(code.expiresAt) : ''
  const checkAgain = <Button variant="secondary" disabled={busy} onClick={() => command({ type: 'read-setup' })}>{t`Check again`}</Button>
  const others = setup?.others ?? []
  const othersText = others.map(other => other.otherTailnet ? t`${other.name}, shared from another tailnet` : other.name).join('; ')
  const serveNeeds = problem === 'serve-off' || problem === 'serve-denied' || problem === 'ports-taken'
  return <ol className="teams-steps">
    <Step n={1} state={setup === null ? 'todo' : setup.tailscale === 'running' ? 'done' : 'needs'} title={t`Tailscale is on`}>
      {setup === null ? <p className="teams-muted" role="status">{t`Looking at this computer's Tailscale…`}</p>
        : setup.tailscale === 'running' ? <p>{t`This computer is ${machine} on your tailnet.`}</p>
        : <><p>{setup.tailscale === 'missing' ? t`Tailscale isn't installed on this computer. Install it from tailscale.com and sign in, then check again.` : t`Tailscale isn't running on this computer. Start it and sign in, then check again.`}</p><div className="teams-actions">{checkAgain}</div></>}
    </Step>
    <Step n={2} state={serveNeeds ? 'needs' : state.listening ? 'done' : 'todo'} title={t`Tailscale Serve is allowed`}>
      {problem === 'serve-off' ? <><p>{t`Your tailnet hasn't turned on Serve, which carries your teammate's asks to Sotto on your tailnet only.`}</p>
        {state.serveEnableUrl ? <div className="teams-actions"><Button variant="secondary" onClick={() => command({ type: 'open-serve-setting' })}>{t`Turn on Serve in Tailscale`}</Button></div> : null}</>
        : problem === 'serve-denied' ? <p>{t`Tailscale won't let this account change Serve. Run tailscale set --operator=$USER on this computer, then make or paste the code again.`}</p>
        : problem === 'ports-taken' ? <p>{t`Other apps hold the tailnet ports a team link uses (8445 to 8447). Free one, then make or paste the code again.`}</p>
        : state.listening ? <p>{t`Sotto answers your teammate on your tailnet only, never the internet.`}</p>
        : <p className="teams-muted">{t`Sotto turns it on when you make or paste a code, on your tailnet only, never the internet. If your tailnet has Serve off, this step says so.`}</p>}
    </Step>
    <Step n={3} state={others.length ? 'done' : 'todo'} title={t`Your teammate's computer is on your tailnet`}>
      {others.length ? <p>{t`Tailscale sees ${othersText}.`}</p> : <p>{t`Tailscale doesn't show anyone else's computer yet. If your teammate has their own tailnet, they share their computer with you, and you accept.`}</p>}
      <Fold className="teams-how" summary={t`How your teammate shares theirs`}>
        <ol><li>{t`They open Tailscale's admin console and go to Machines.`}</li><li>{t`They press ••• beside their computer, then Share, and send you the link.`}</li><li>{t`You open the link and accept. Then check again here.`}</li></ol>
      </Fold>
      {others.length ? null : <div className="teams-actions">{checkAgain}</div>}
    </Step>
    {/* Which listed computer is the teammate's is not known here, so this step is never marked done on a guess. */}
    <Step n={4} state="todo" title={t`Share this computer with your teammate`}>
      <p>{t`Sharing goes one way. Seeing your teammate's computer doesn't let them reach yours, so share yours back. If your teammate is on your own tailnet, there's nothing to share.`}</p>
      <ol><li>{t`Press Open Tailscale's Machines.`}</li><li>{t`Press ••• beside ${machine}, then Share.`}</li><li>{t`Send your teammate the link. They open it and accept.`}</li></ol>
      <div className="teams-actions"><Button variant="secondary" onClick={() => command({ type: 'open-share-page' })}>{t`Open Tailscale's Machines`}</Button></div>
    </Step>
    <Step n={5} state={code ? 'needs' : 'todo'} title={t`Link with a code`}>
      <p>{t`One of you makes a code and sends it however you like, and the other pastes it. One code links both ways. It works once, for 30 minutes.`}</p>
      <label className="teams-field" htmlFor={nameId}>{t`Your name, as your teammate sees it`}</label>
      <input id={nameId} className="tt-input" value={name} maxLength={TEAM_NAME_MAX} spellCheck={false} onChange={event => setName(event.currentTarget.value)} />
      {code ? <div className="teams-code">
        <code className="teams-code__text">{code.text}</code>
        <p className="teams-muted">{t`Send this to your teammate. It works once, until ${expires}.`}</p>
        <div className="teams-actions">
          <Button variant="secondary" onClick={() => { void navigator.clipboard.writeText(code.text).then(() => setCopied(true)) }}>{copied ? t`Copied` : t`Copy code`}</Button>
          <Button variant="ghost" disabled={busy} onClick={() => { setCopied(false); command({ type: 'cancel-code' }) }}>{t`Cancel code`}</Button>
        </div>
      </div> : <div className="teams-actions"><Button variant="secondary" disabled={busy || !shown} onClick={() => { setCopied(false); command({ type: 'make-code', name: shown }) }}>{t`Make a code`}</Button></div>}
      <label className="teams-field" htmlFor={codeId}>{t`Got a code from your teammate?`}</label>
      <input id={codeId} className="tt-input" value={pasted} spellCheck={false} placeholder={t`Paste their code`} onChange={event => setPasted(event.currentTarget.value)} />
      <div className="teams-actions"><Button disabled={busy || !shown || !pasted.trim()} onClick={() => { command({ type: 'link', code: pasted, name: shown }); setPasted('') }}>{t`Link`}</Button></div>
    </Step>
    <Step n={6} state="todo" title={t`Check it works both ways`}>
      <p className="teams-muted">{t`Right after linking, each computer reaches the other once, carrying nothing. Your teammate's card then says whether it works both ways, and what to share if it doesn't.`}</p>
    </Step>
  </ol>
}

/**
 * Why this computer can't take a teammate's ask or read right now (#2151), in standing words rather than a press's. The
 * teammate only sees that it did not answer, so the owner, who can fix it, is told here.
 */
function ListenProblem({ state, command }: { readonly state: TeamsState; readonly command: Command }): ReactNode {
  const { t } = useLingui()
  const names = state.links.map(link => link.name).join(', ')
  switch (state.problem) {
    case null: case 'credentials-locked': return null
    case 'tailscale-off': return <p className="teams-problem" role="status">{t`Tailscale isn't running on this computer, so ${names} can't reach it. Start Tailscale; Sotto looks again every 30 seconds.`}</p>
    case 'serve-off': return <div className="teams-problem" role="status"><p>{t`Your tailnet has Serve turned off, so ${names} can't reach this computer.`}</p>
      {state.serveEnableUrl ? <div className="teams-actions"><Button variant="secondary" onClick={() => command({ type: 'open-serve-setting' })}>{t`Turn on Serve in Tailscale`}</Button></div> : null}</div>
    case 'serve-denied': return <p className="teams-problem" role="status">{t`Tailscale won't let this account change Serve, so ${names} can't reach this computer. Run tailscale set --operator=$USER on it.`}</p>
    case 'ports-taken': return <p className="teams-problem" role="status">{t`Other apps hold the tailnet ports a team link uses (8445 to 8447), so ${names} can't reach this computer. Free one; Sotto looks again every 30 seconds.`}</p>
    case 'serve-failed': return <p className="teams-problem" role="status">{t`Tailscale couldn't set up this computer's address, so ${names} can't reach it. Sotto looks again every 30 seconds.`}</p>
  }
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

/**
 * The Teams tab (ADR-0186, ADR-0193): set up in steps, then each link, what it shares and the latest asks. It lies on the room
 * in Watcher's column with no ground of its own, as Watcher's conversation does (Zach's pick B, November 5, 2026).
 */
export function TeamsPage({ bridge, state }: { readonly bridge: TeamsBridge; readonly state: TeamsState | null }): ReactNode {
  const { t } = useLingui()
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [more, setMore] = useState(false)
  const command = (value: TeamsCommand): void => {
    // Reading this computer's own Tailscale for the steps is no press: it holds nothing up and has nothing to say if it fails.
    const quiet = value.type === 'read-setup'
    if (!quiet) { setBusy(true); setError(null) }
    void bridge.command(value).then(result => { if (!quiet && result.status === 'refused') setError(result.message) })
      .catch(() => { if (!quiet) setError(t`Sotto could not finish that change. It may have partly taken effect. Check Teams before trying again.`) }).finally(() => { if (!quiet) setBusy(false) })
  }
  const desksOf = useOpenDesks(), desksLink = state?.links.find(link => link.id === desksOf), closedDesks = useRef<string | null>(null)
  // Closing the desks brings focus back to the press that opened them.
  useEffect(() => {
    if (desksOf !== null || closedDesks.current === null) return
    document.getElementById(desksButtonId(closedDesks.current))?.focus()
    closedDesks.current = null
  }, [desksOf])
  // A link that has gone takes its open desks with it.
  useEffect(() => { if (state && desksOf !== null && !desksLink) setOpenDesks(null) }, [state, desksOf, desksLink])
  const linked = (state?.links.length ?? 0) > 0
  // The linked page needs this computer's tailnet name for what to share, and reading it sends nothing.
  useEffect(() => { if (linked && state?.setup === null) command({ type: 'read-setup' }) }, [linked])
  const closeDesks = (): void => { closedDesks.current = desksOf; setOpenDesks(null) }
  const unsaved = state?.unsaved ? <p className="agent-error teams-page__error" role="status">{t`Teams has unsaved changes. They are active here, but may be lost when Sotto closes.`}</p> : null
  if (state && desksLink) return <div className="teams-page tt-paragraph" role="tabpanel" aria-labelledby="watcher-tab-teams">
    {unsaved}
    <ListenProblem state={state} command={command} />
    <TeamDesks link={desksLink} state={state} bridge={bridge} onClose={closeDesks} />
  </div>
  const machine = state?.setup?.machine ?? t`this computer`
  return <div className="teams-page tt-paragraph" role="tabpanel" aria-labelledby="watcher-tab-teams">
    <div className="teams-page__column">
      {unsaved}
      {error ? <p className="agent-error teams-page__error" role="alert">{error}</p> : null}
      {state === null ? <p className="teams-muted" role="status">{t`Opening Teams…`}</p> : !linked ? <>
        <header className="teams-page__intro">
          <h2 className="teams-page__title">{t`Link with a teammate`}</h2>
          <p className="teams-page__sub">{t`Your Watcher and a teammate's can ask each other what you're working on, and you can open your desks side by side. Both of you need Sotto Owl and Tailscale, and each of you does these steps.`}</p>
        </header>
        <TeamSetup state={state} command={command} busy={busy} />
      </> : <>
        <section className="teams-section" aria-labelledby="teams-teammates">
          <h3 id="teams-teammates" className="teams-section__title">{t`Teammates`}</h3>
          <ListenProblem state={state} command={command} />
          {state.links.map(link => <TeamLinkCard key={link.id} link={link} machine={machine} command={command} busy={busy} openDesks={() => setOpenDesks(link.id)} />)}
          <Fold className="teams-more" summary={t`Link another teammate`} onToggle={setMore}>
            {more ? <TeamSetup state={state} command={command} busy={busy} /> : null}
          </Fold>
        </section>
        <WhatYouShare state={state} command={command} busy={busy} />
        <Latest state={state} />
        <p className="teams-page__fine teams-muted">{t`Sotto says nothing to a teammate's computer until one of you asks, checks or reads a desk, so this page never says who is online.`}</p>
      </>}
    </div>
  </div>
}
