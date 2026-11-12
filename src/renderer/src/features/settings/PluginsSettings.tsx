import React, { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { ChevronRight, Code } from 'lucide-react'
import {
  PLUGIN_ACCOUNT_NAME_MAX, PLUGIN_SECRET_MAX, PLUGIN_USE_SHOWN, PLUGINS, type GitHubSignIn, type PluginAccount, type PluginAccountProblem, type PluginAccountResult,
  type PluginEntry, type PluginGroupId, type PluginProject, type PluginReadKind, type PluginsBridge, type ShownPluginUse,
} from '../../../../shared/plugins'
import { localeFormatter } from '../../agents/localeFormat'
import { useTransientFlag, writeClipboard } from '../../agents/richActions'
import { Button } from '../../components/Button'
import { Field } from '../../components/Field'
import { Toggle } from '../../components/Toggle'
import { PluginMark } from './PluginMark'
import { SettingsGroup } from './SettingsGroup'
import './plugins.css'

const GH_SIGN_IN_COMMAND = 'gh auth login'
/** Where Vercel makes tokens. Shown as words to type or copy: the page opens nothing on its own. */
const VERCEL_TOKENS_PAGE = 'vercel.com/account/tokens'

/** What the page knows of gh's sign-in: main's answer, still asking, or a read that failed. */
type SignInView = GitHubSignIn | { readonly state: 'checking' }

/** When a use happened, as the day and the time of day. */
const whenUsed = localeFormatter({ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
/** The day a secret was saved. */
const daySaved = localeFormatter({ month: 'long', day: 'numeric' })

/**
 * Settings › Plugins (ADR-0205), an Owl feature: every plugin is a row in its group, and a row opens in place. Zach's
 * pick A of docs/prototypes/plugins-settings-prototype.html. A plugin's row is here from the slice that makes it work.
 */
export function PluginsSettings({ bridge = window.sotto?.plugins }: { readonly bridge?: PluginsBridge | undefined }): ReactNode {
  const { t } = useLingui()
  const [signIn, setSignIn] = useState<SignInView>({ state: 'checking' })
  // Only the newest read's answer is shown: Check again pressed twice must not let the older answer land last.
  const asked = useRef(0)
  const check = useCallback((): void => {
    const mine = ++asked.current
    setSignIn({ state: 'checking' })
    if (!bridge) { setSignIn({ state: 'unknown' }); return }
    void bridge.gitHubSignIn().then(value => { if (asked.current === mine) setSignIn(value) }).catch(() => { if (asked.current === mine) setSignIn({ state: 'unknown' }) })
  }, [bridge])
  useEffect(() => { check(); return () => { asked.current += 1 } }, [check])
  // The newest uses, read when the page opens and with each Check again. Null while unread, or when the read failed.
  const [uses, setUses] = useState<readonly ShownPluginUse[] | null>(null)
  const usesAsked = useRef(0)
  const readUses = useCallback((): void => {
    if (!bridge) return
    const mine = ++usesAsked.current
    void bridge.recentUse().then(value => { if (usesAsked.current === mine) setUses(value) }).catch(() => { if (usesAsked.current === mine) setUses(null) })
  }, [bridge])
  useEffect(() => { readUses(); return () => { usesAsked.current += 1 } }, [readUses])
  // The accounts the user added. Null while unread, or when they could not be read.
  const [accounts, setAccounts] = useState<readonly PluginAccount[] | null>(null)
  useEffect(() => {
    if (!bridge) return
    let alive = true
    void bridge.accounts().then(value => { if (alive) setAccounts(value) }).catch(() => { if (alive) setAccounts(null) })
    return () => { alive = false }
  }, [bridge])
  // This computer's projects, for keeping an account to some of them. None while unread: an account kept to projects still says so.
  const [projects, setProjects] = useState<readonly PluginProject[]>([])
  useEffect(() => {
    if (!bridge) return
    let alive = true
    void bridge.projects().then(value => { if (alive) setProjects(value) }).catch(() => undefined)
    return () => { alive = false }
  }, [bridge])
  const groupTitle: Record<PluginGroupId, string> = { code: t`Code and deploys` }
  return <div className="plugins-settings">
    <p className="tt-paragraph plugins-lead"><Trans>A thread’s agent uses a plugin through Sotto’s tools and never holds its secret. Reading never asks you. A change, such as posting a comment, asks you first in its thread, each time.</Trans></p>
    <SettingsGroup title={groupTitle.code} icon={Code} rows={false}>
      <div className="plugins-list">
        {PLUGINS.filter(plugin => plugin.group === 'code').map(plugin => plugin.id === 'github'
          ? <GitHubRow key={plugin.id} plugin={plugin} signIn={signIn} uses={uses} onCheck={() => { check(); readUses() }} />
          : <VercelRow key={plugin.id} plugin={plugin} bridge={bridge} accounts={accounts} projects={projects} uses={uses} onAccounts={setAccounts} />)}
      </div>
    </SettingsGroup>
  </div>
}

/** A plugin's row: its mark, its name and where it stands, and a body that opens in place. Escape closes it from anywhere inside. */
function PluginRow({ plugin, state, summary, children }: { readonly plugin: PluginEntry; readonly state: string; readonly summary: string; readonly children: ReactNode }): ReactNode {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const head = useRef<HTMLButtonElement>(null)
  // Escape closes the open row and gives focus back to its header, as a provider's row does. A form inside takes its own first.
  const closeOnEscape = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || !open || event.defaultPrevented) return
    event.preventDefault()
    event.stopPropagation()
    setOpen(false)
    head.current?.focus()
  }
  return <div className="plugin-row" data-setting={`plugin-${plugin.id}`} data-state={state} onKeyDown={closeOnEscape}>
    <button ref={head} type="button" className="plugin-row__head tt-focusable" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(value => !value)}>
      <PluginMark plugin={plugin.id} />
      <span className="plugin-row__name">{plugin.name}</span>
      {/* A space between the two, so the row's name reads "GitHub Signed in…" and not one run-together word. */}
      {' '}
      <span className="plugin-row__state"><span className="plugin-row__dot" aria-hidden="true" />{summary}</span>
      <ChevronRight className="plugin-row__chevron" size={16} strokeWidth={1.7} aria-hidden="true" />
    </button>
    {open ? <div className="plugin-row__body" id={bodyId}>{children}</div> : null}
  </div>
}

function GitHubRow({ plugin, signIn, uses, onCheck }: { readonly plugin: PluginEntry; readonly signIn: SignInView; readonly uses: readonly ShownPluginUse[] | null; readonly onCheck: () => void }): ReactNode {
  const { t } = useLingui()
  const [copied, showCopied] = useTransientFlag<'copied'>()
  const [copyFailed, setCopyFailed] = useState(false)
  const login = signIn.state === 'signed-in' ? signIn.login : ''
  const summary = signIn.state === 'signed-in' ? t`Signed in as ${login} through gh`
    : signIn.state === 'signed-out' ? t`Not signed in`
      : signIn.state === 'not-installed' ? t`gh isn’t installed`
        : signIn.state === 'checking' ? t`Checking…` : t`Couldn’t check`
  const copy = async (): Promise<void> => {
    setCopyFailed(false)
    try { await writeClipboard(GH_SIGN_IN_COMMAND); showCopied('copied') } catch { setCopyFailed(true) }
  }
  return <PluginRow plugin={plugin} state={signIn.state} summary={summary}>
    <div aria-live="polite">
      {signIn.state === 'signed-in' ? <p className="tt-paragraph"><Trans>Signed in as <b>{login}</b> through gh on this computer.</Trans></p> : null}
      {signIn.state === 'signed-out' ? <>
        <p className="tt-paragraph"><Trans>gh is not signed in to GitHub on this computer. Run this in a terminal, then press Check again.</Trans></p>
        <div className="plugin-command"><code>{GH_SIGN_IN_COMMAND}</code><Button variant="ghost" aria-label={t`Copy the gh sign-in command`} onClick={() => void copy()}>{copied ? t`Copied` : t`Copy`}</Button></div>
        {copyFailed ? <p className="tt-field__error tt-paragraph" role="alert"><Trans>The command could not be copied. Select {GH_SIGN_IN_COMMAND} and copy it yourself.</Trans></p> : null}
      </> : null}
      {signIn.state === 'not-installed' ? <p className="tt-paragraph"><Trans>gh, GitHub’s command line program, isn’t installed on this computer. Install it from cli.github.com, sign in with <code>{GH_SIGN_IN_COMMAND}</code>, then press Check again. If this still shows, quit Sotto and open it again so it can find gh.</Trans></p> : null}
      {signIn.state === 'unknown' ? <p className="tt-paragraph"><Trans>Sotto couldn’t ask gh who is signed in. Nothing was changed. Press Check again.</Trans></p> : null}
      {signIn.state === 'checking' ? <p className="tt-paragraph"><Trans>Asking gh who is signed in…</Trans></p> : null}
    </div>
    <p className="tt-paragraph plugin-row__note"><Trans>GitHub uses the gh command’s own sign-in. Sotto stores nothing for it.</Trans></p>
    <RecentUse name={plugin.name} uses={uses === null ? null : uses.filter(use => use.plugin === plugin.id)} />
    <div className="plugin-row__actions"><Button variant="secondary" aria-disabled={signIn.state === 'checking'} aria-label={t`Check GitHub’s sign-in again`} onClick={() => { if (signIn.state !== 'checking') onCheck() }}><Trans>Check again</Trans></Button></div>
  </PluginRow>
}

/** What went wrong with an account, in words that say whether anything was saved and what to do next. */
function useProblemWords(): (problem: PluginAccountProblem, replacing: boolean) => string {
  const { t } = useLingui()
  return (problem, replacing) => {
    const kept = replacing ? t`The token already saved was kept.` : t`Nothing was saved.`
    switch (problem) {
      case 'refused': return t`Vercel did not accept this token. ${kept} Make a new token at ${VERCEL_TOKENS_PAGE} and paste it here.`
      case 'unreachable': return t`Vercel could not be reached to check the token. ${kept} Check your connection, then try again.`
      case 'busy': return t`Vercel is turning requests away for now, so the token could not be checked. ${kept} Wait a minute, then try again.`
      case 'name-taken': return t`There is already a Vercel account with that name. Nothing was saved. Give this one another name.`
      case 'limit': return t`Vercel already has as many accounts as Sotto keeps for one plugin. Nothing was saved. Remove one first.`
      case 'gone': return t`That account is no longer here. Nothing was changed.`
      default: return t`Sotto could not keep the token. ${kept} Check that this computer’s credential store is unlocked, then try again.`
    }
  }
}

function VercelRow({ plugin, bridge, accounts, projects, uses, onAccounts }: {
  readonly plugin: PluginEntry; readonly bridge: PluginsBridge | undefined; readonly accounts: readonly PluginAccount[] | null; readonly projects: readonly PluginProject[]
  readonly uses: readonly ShownPluginUse[] | null; readonly onAccounts: (accounts: readonly PluginAccount[]) => void
}): ReactNode {
  const { t } = useLingui()
  const mine = (accounts ?? []).filter(account => account.plugin === 'vercel')
  // An account switched off says so beside its name, so the folded row does not read as one threads can use.
  const names = mine.map(account => { const name = account.name; return account.on ? name : t`${name} (off)` }).join(', ')
  const count = mine.length
  const summary = accounts === null ? t`Couldn’t read the accounts` : count === 0 ? t`Not added` : count === 1 ? names : t`${count} accounts: ${names}`
  const [adding, setAdding] = useState(false)
  const addButton = useRef<HTMLButtonElement>(null)
  const closeAdd = (): void => { setAdding(false); requestAnimationFrame(() => addButton.current?.focus()) }
  // The row's dot is lit only while some account is one a thread could use.
  return <PluginRow plugin={plugin} state={accounts === null ? 'unknown' : mine.some(account => account.on) ? 'signed-in' : 'none'} summary={summary}>
    <p className="tt-paragraph"><Trans>Deployments, build logs, projects and domains, read with a token you paste. Sotto keeps the token in its encrypted store and makes each read itself, so no agent ever sees it.</Trans></p>
    {accounts === null ? <p className="tt-field__error tt-paragraph" role="alert"><Trans>The accounts could not be read. Nothing was changed. Reopen Settings and try again.</Trans></p> : null}
    {mine.map(account => <AccountCard key={account.id} account={account} bridge={bridge} projects={projects} onAccounts={onAccounts} onRemoved={() => { setAdding(false); requestAnimationFrame(() => addButton.current?.focus()) }}
      uses={uses === null ? null : uses.filter(use => use.accountId === account.id)} />)}
    {adding ? <AddAccount bridge={bridge} onAccounts={onAccounts} onDone={closeAdd} />
      : <div className="plugin-row__actions"><Button ref={addButton} variant="secondary" disabled={accounts === null || !bridge} onClick={() => setAdding(true)}>
        {count === 0 ? <Trans>Add a Vercel account</Trans> : <Trans>Add another Vercel account</Trans>}</Button></div>}
  </PluginRow>
}

/** The form that adds an account: a name and the token, checked with Vercel before anything is kept. Escape cancels it. */
function AddAccount({ bridge, onAccounts, onDone }: { readonly bridge: PluginsBridge | undefined; readonly onAccounts: (accounts: readonly PluginAccount[]) => void; readonly onDone: () => void }): ReactNode {
  const { t } = useLingui()
  const words = useProblemWords()
  const [name, setName] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  useEffect(() => { nameInput.current?.focus() }, [])
  const ready = name.trim() !== '' && token.trim() !== '' && !busy && bridge !== undefined
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!ready) return
    setBusy(true); setProblem(null)
    let result: PluginAccountResult
    try { result = await bridge.addAccount({ plugin: 'vercel', name: name.trim(), secret: token.trim() }) } catch { result = { ok: false, problem: 'store' } }
    setBusy(false)
    // The token is not kept in the page a moment longer than the request that carried it, whether it was kept or not.
    setToken('')
    if (!result.ok) { setProblem(words(result.problem, false)); return }
    onAccounts(result.accounts)
    onDone()
  }
  const cancelOnEscape = (event: KeyboardEvent<HTMLFormElement>): void => {
    if (event.key !== 'Escape') return
    event.preventDefault(); event.stopPropagation()
    // A token already sent to be checked is saved or refused whatever the form does, so the form stays until it knows.
    if (busy) return
    setToken(''); onDone()
  }
  return <form className="plugin-account plugin-account--form" aria-label={t`Add a Vercel account`} onSubmit={event => void submit(event)} onKeyDown={cancelOnEscape}>
    <Field label={t`Name`} description={t`What you and your threads’ agents call this account, such as Work or Personal.`}>
      <input ref={nameInput} className="tt-input" autoComplete="off" spellCheck={false} maxLength={PLUGIN_ACCOUNT_NAME_MAX} value={name} onChange={event => setName(event.target.value)} />
    </Field>
    <Field label={t`Token`} description={t`Make one at ${VERCEL_TOKENS_PAGE}. Sotto checks it with Vercel before saving it, and never shows it again.`}>
      <input className="tt-input" type="password" autoComplete="off" spellCheck={false} maxLength={PLUGIN_SECRET_MAX} value={token} placeholder={t`Paste the token`} onChange={event => setToken(event.target.value)} />
    </Field>
    {problem ? <p className="tt-field__error tt-paragraph" role="alert">{problem}</p> : null}
    <div className="plugin-row__actions">
      <Button type="submit" variant="primary" aria-disabled={!ready}>{busy ? t`Checking…` : t`Add account`}</Button>
      <Button variant="ghost" aria-disabled={busy} onClick={() => { if (!busy) { setToken(''); onDone() } }}><Trans>Cancel</Trans></Button>
    </div>
  </form>
}

/** One account: its name, when its token was saved, Replace and Remove, and its recent use. */
function AccountCard({ account, bridge, projects, uses, onAccounts, onRemoved }: {
  readonly account: PluginAccount; readonly bridge: PluginsBridge | undefined; readonly projects: readonly PluginProject[]; readonly uses: readonly ShownPluginUse[] | null
  readonly onAccounts: (accounts: readonly PluginAccount[]) => void
  /** The account is gone, and its buttons with it: focus needs somewhere to go. */
  readonly onRemoved: () => void
}): ReactNode {
  const { t } = useLingui()
  const words = useProblemWords()
  const [mode, setMode] = useState<'rest' | 'replacing' | 'removing'>('rest')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const replaceButton = useRef<HTMLButtonElement>(null)
  const removeButton = useRef<HTMLButtonElement>(null)
  const name = account.name
  const saved = daySaved(new Date(account.savedAt))
  const signedInAs = account.signedInAs
  const rest = (focus: 'replace' | 'remove'): void => {
    setMode('rest'); setToken(''); setProblem(null)
    requestAnimationFrame(() => (focus === 'replace' ? replaceButton : removeButton).current?.focus())
  }
  const run = async (request: () => Promise<PluginAccountResult>, replacing: boolean): Promise<void> => {
    if (busy || !bridge) return
    setBusy(true); setProblem(null)
    let result: PluginAccountResult
    try { result = await request() } catch { result = { ok: false, problem: 'store' } }
    setBusy(false); setToken('')
    if (!result.ok) { setProblem(replacing ? words(result.problem, true) : t`The account could not be removed. Nothing was changed. Try again.`); return }
    onAccounts(result.accounts)
    if (replacing) rest('replace')
    else onRemoved()
  }
  const cancelOnEscape = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape' || mode === 'rest') return
    event.preventDefault(); event.stopPropagation()
    if (busy) return
    rest(mode === 'replacing' ? 'replace' : 'remove')
  }
  return <section className="plugin-account" aria-label={t`Vercel account ${name}`} onKeyDown={cancelOnEscape}>
    <div className="plugin-account__top">
      <div className="plugin-account__who">
        <b>{name}</b>
        <span>{signedInAs ? <Trans>Signed in to Vercel as {signedInAs}. Token saved {saved}.</Trans> : <Trans>Token saved {saved}.</Trans>}</span>
      </div>
      {mode === 'rest' ? <div className="plugin-row__actions">
        <Button ref={replaceButton} variant="secondary" disabled={!bridge} aria-label={t`Replace the token for ${name}`} onClick={() => setMode('replacing')}><Trans>Replace</Trans></Button>
        <Button ref={removeButton} variant="ghost" disabled={!bridge} aria-label={t`Remove the Vercel account ${name}`} onClick={() => setMode('removing')}><Trans>Remove</Trans></Button>
      </div> : null}
    </div>
    {mode === 'replacing' ? <form className="plugin-account__change" aria-label={t`Replace the token for ${name}`}
      onSubmit={event => { event.preventDefault(); if (token.trim()) void run(() => bridge!.replaceSecret({ id: account.id, secret: token.trim() }), true) }}>
      <Field label={t`New token`} description={t`Sotto checks it with Vercel first. The token saved now stays in use until the new one is accepted.`}>
        <input className="tt-input" type="password" autoComplete="off" spellCheck={false} maxLength={PLUGIN_SECRET_MAX} value={token} placeholder={t`Paste the token`} autoFocus onChange={event => setToken(event.target.value)} />
      </Field>
      <div className="plugin-row__actions">
        <Button type="submit" variant="primary" aria-disabled={busy || token.trim() === ''}>{busy ? t`Checking…` : t`Save token`}</Button>
        <Button variant="ghost" aria-disabled={busy} onClick={() => { if (!busy) rest('replace') }}><Trans>Cancel</Trans></Button>
      </div>
    </form> : null}
    {mode === 'removing' ? <div className="plugin-account__change" role="group" aria-label={t`Remove the Vercel account ${name}`}>
      <p className="tt-paragraph"><Trans>Remove <b>{name}</b>? Its token is deleted from this computer, and threads lose the account at once. Nothing changes at Vercel.</Trans></p>
      <div className="plugin-row__actions">
        <Button variant="danger" autoFocus aria-disabled={busy} onClick={() => void run(() => bridge!.removeAccount({ id: account.id }), false)}><Trans>Remove account</Trans></Button>
        <Button variant="ghost" aria-disabled={busy} onClick={() => { if (!busy) rest('remove') }}><Trans>Keep it</Trans></Button>
      </div>
    </div> : null}
    {problem ? <p className="tt-field__error tt-paragraph" role="alert">{problem}</p> : null}
    <AccountThreads account={account} bridge={bridge} projects={projects} onAccounts={onAccounts} />
    <RecentUse name={name} uses={uses} />
  </section>
}

/**
 * Which threads may use an account (ADR-0205, decision 9): its switch, and the projects it is kept to. Every project
 * is the default; pressing a project keeps the account to the ones pressed, and letting the last one go gives it back
 * to every project. A change is saved as it is made, and one that could not be saved says so and shows what is kept.
 */
function AccountThreads({ account, bridge, projects, onAccounts }: {
  readonly account: PluginAccount; readonly bridge: PluginsBridge | undefined; readonly projects: readonly PluginProject[]
  readonly onAccounts: (accounts: readonly PluginAccount[]) => void
}): ReactNode {
  const { t } = useLingui()
  const [failed, setFailed] = useState(false)
  const name = account.name
  const kept = account.projects
  const change = (request: { readonly on?: boolean; readonly projects?: string[] | null }): void => {
    if (!bridge) return
    setFailed(false)
    void bridge.updateAccount({ id: account.id, ...request }).then(result => { if (result.ok) onAccounts(result.accounts); else setFailed(true) }, () => setFailed(true))
  }
  const press = (id: string): void => {
    const next = kept?.includes(id) ? kept.filter(other => other !== id) : [...kept ?? [], id]
    change({ projects: next.length === 0 ? null : next })
  }
  // A settled project is offered only while the account is kept to it; one that is gone keeps a chip, so it can be let go.
  const offered = projects.filter(project => !project.settled || kept?.includes(project.id))
  const gone = (kept ?? []).filter(id => !projects.some(project => project.id === id))
  const titles = (kept ?? []).flatMap(id => { const project = projects.find(entry => entry.id === id); return project ? [project.title] : [] }).join(', ')
  return <div className="plugin-account__threads">
    <Toggle label={t`Threads may use ${name}`} checked={account.on} disabled={!bridge} onCheckedChange={on => change({ on })}
      {...(account.on ? {} : { description: t`Off. No thread can see or use this account until you turn it back on. Its token stays saved.` })} />
    {account.on ? <>
      <div className="plugin-account__projects" role="group" aria-label={t`Projects whose threads may use ${name}`}>
        <button type="button" className="plugin-chip tt-focusable" aria-pressed={kept === null} disabled={!bridge} onClick={() => { if (kept !== null) change({ projects: null }) }}><Trans>Every project</Trans></button>
        {offered.map(project => <button key={project.id} type="button" className="plugin-chip tt-focusable" aria-pressed={kept?.includes(project.id) ?? false} disabled={!bridge}
          onClick={() => press(project.id)}>{project.title}</button>)}
        {gone.map(id => <button key={id} type="button" className="plugin-chip tt-focusable" aria-pressed disabled={!bridge} onClick={() => press(id)}><Trans>A project that is gone</Trans></button>)}
      </div>
      <p className="tt-paragraph plugin-row__note">{kept === null ? <Trans>Threads in every project may use it, and so may Watcher.</Trans>
        : titles ? <Trans>Only threads in {titles} may use it. Watcher belongs to no project, so it cannot.</Trans>
          : <Trans>It is kept to a project that is gone, so no thread can use it. Press Every project, or choose one.</Trans>}</p>
    </> : null}
    {failed ? <p className="tt-field__error tt-paragraph" role="alert"><Trans>That could not be saved. Nothing was changed. Try again.</Trans></p> : null}
  </div>
}

/** The newest uses by threads' agents of a plugin or of one account: what was done and by which thread, never what was read. */
function RecentUse({ name, uses }: { readonly name: string; readonly uses: readonly ShownPluginUse[] | null }): ReactNode {
  const { t } = useLingui()
  const headingId = useId()
  if (uses === null) return null
  const shown = uses.slice(0, PLUGIN_USE_SHOWN)
  const what: Record<PluginReadKind, string> = {
    issues: t`Read issues`, 'pull-requests': t`Read pull requests`, repository: t`Read a repository`, commits: t`Read commits`, checks: t`Read checks`,
    releases: t`Read releases`, search: t`Searched ${name}`, account: t`Read account details`, deployments: t`Read deployments`, projects: t`Read projects`,
    domains: t`Read domains`, logs: t`Read a build log`, other: t`Read from ${name}`,
    comment: t`Posted a comment`, 'deployment-cancel': t`Cancelled a deployment’s build`,
    'issue-open': t`Opened an issue`, 'issue-close': t`Closed an issue`, 'issue-reopen': t`Reopened an issue`,
    'deployment-promote': t`Promoted a deployment to production`, 'deployment-rollback': t`Rolled production back`,
  }
  // A change that was not made: what the agent asked to do, since nothing was done.
  const asked: Partial<Record<PluginReadKind, string>> = {
    comment: t`Asked to post a comment`, 'deployment-cancel': t`Asked to cancel a deployment’s build`,
    'issue-open': t`Asked to open an issue`, 'issue-close': t`Asked to close an issue`, 'issue-reopen': t`Asked to reopen an issue`,
    'deployment-promote': t`Asked to promote a deployment to production`, 'deployment-rollback': t`Asked to roll production back`,
  }
  const changed = (use: ShownPluginUse): boolean => use.tool !== 'plugin_read'
  return <section className="plugin-use" aria-labelledby={headingId}>
    <h4 id={headingId}><Trans>Recent use</Trans></h4>
    {shown.length === 0 ? <p className="tt-paragraph plugin-row__note"><Trans>No thread has used {name} yet.</Trans></p> : <ul>
      {shown.map(use => <li key={use.id}>
        <time dateTime={use.at}>{whenUsed(new Date(use.at))}</time>
        <span>
          {use.outcome === 'done' || !changed(use) ? what[use.kind] : asked[use.kind] ?? what[use.kind]}{' '}
          <span className="plugin-use__thread">{use.threadTitle === null ? t`in a thread that is gone` : t`in “${use.threadTitle}”`}</span>
          {use.outcome === 'refused' ? <>{' '}<Trans>Sotto refused it.</Trans></>
            : use.outcome === 'failed' ? <>{' '}{changed(use) ? <Trans>You allowed it, and it failed.</Trans> : <Trans>It failed.</Trans>}</>
              : use.outcome === 'denied' ? <>{' '}<Trans>You said no.</Trans></>
                : use.outcome === 'lapsed' ? <>{' '}<Trans>Nobody answered in time.</Trans></>
                  : changed(use) ? <>{' '}<Trans>You allowed it.</Trans></> : null}
        </span>
      </li>)}
    </ul>}
    <p className="tt-paragraph plugin-row__note"><Trans>Sotto records what was done and by which thread, never what was read or sent.</Trans></p>
  </section>
}
