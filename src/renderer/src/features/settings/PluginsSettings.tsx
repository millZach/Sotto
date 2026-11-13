import React, { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { ChevronRight, Code, MonitorSmartphone } from 'lucide-react'
import {
  PLUGIN_ACCOUNT_NAME_MAX, PLUGIN_SECRET_MAX, PLUGIN_USE_SHOWN, PLUGINS, type GitHubSignIn, type PluginAccount, type PluginAccountProblem, type PluginAccountResult,
  type PluginAccountCopyState, type PluginCopiesView, type PluginEntry, type PluginGroupId, type PluginProject, type PluginReadKind, type PluginsBridge, type ShownPluginUse,
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

/** This computer's projects as the page knows them: read, not read yet, or a read that failed. */
type ProjectsView = readonly PluginProject[] | null | 'failed'
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
  // This computer's projects, for keeping an account to some of them. Null while unread, and `failed` when they
  // could not be read: neither is the same as there being none, which would make every kept project look gone.
  const [projects, setProjects] = useState<ProjectsView>(null)
  useEffect(() => {
    if (!bridge) return
    let alive = true
    void bridge.projects().then(value => { if (alive) setProjects(value) }).catch(() => { if (alive) setProjects('failed') })
    return () => { alive = false }
  }, [bridge])
  // The user's other computers and each account's copy on each. Null while unread, or when it could not be read.
  // Main says when something changed, a copy arriving or a computer connecting, and the page reads it again.
  const [copies, setCopies] = useState<PluginCopiesView | null>(null)
  const copiesAsked = useRef(0)
  const readCopies = useCallback((): void => {
    if (!bridge) return
    const mine = ++copiesAsked.current
    void bridge.copies().then(value => { if (copiesAsked.current === mine) setCopies(value) }).catch(() => { if (copiesAsked.current === mine) setCopies(null) })
  }, [bridge])
  useEffect(() => {
    readCopies()
    const off = bridge?.onCopiesChanged(readCopies)
    return () => { copiesAsked.current += 1; off?.() }
  }, [bridge, readCopies])
  // An answer to a choice is the newest word on the copies, so an older read still on its way must not land after it.
  const tookCopies = (view: PluginCopiesView): void => { copiesAsked.current += 1; setCopies(view) }
  const changedAccounts = (next: readonly PluginAccount[]): void => { setAccounts(next); readCopies() }
  const groupTitle: Record<PluginGroupId, string> = { code: t`Code and deploys` }
  return <div className="plugins-settings">
    <p className="tt-paragraph plugins-lead"><Trans>A thread’s agent uses a plugin through Sotto’s tools and never holds its secret. Reading never asks you. A change, such as posting a comment, asks you first in its thread, each time.</Trans></p>
    <SettingsGroup title={groupTitle.code} icon={Code} rows={false}>
      <div className="plugins-list">
        {PLUGINS.filter(plugin => plugin.group === 'code').map(plugin => plugin.id === 'github'
          ? <GitHubRow key={plugin.id} plugin={plugin} signIn={signIn} uses={uses} onCheck={() => { check(); readUses() }} />
          : <VercelRow key={plugin.id} plugin={plugin} bridge={bridge} accounts={accounts} projects={projects} copies={copies} uses={uses} onAccounts={changedAccounts} onCopies={tookCopies} />)}
      </div>
    </SettingsGroup>
    <OtherComputers bridge={bridge} copies={copies} accounts={accounts} onCopies={tookCopies} />
  </div>
}

/**
 * The user's other computers (ADR-0205, amending ADR-0025): whether a new account starts with a copy on them, and
 * for each computer whether it is connected and how many accounts it holds. A copy lets a computer's threads use an
 * account while this one is off. Each account says for itself where it is kept.
 */
function OtherComputers({ bridge, copies, accounts, onCopies }: {
  readonly bridge: PluginsBridge | undefined; readonly copies: PluginCopiesView | null; readonly accounts: readonly PluginAccount[] | null
  readonly onCopies: (view: PluginCopiesView) => void
}): ReactNode {
  const { t } = useLingui()
  const [failed, setFailed] = useState(false)
  if (!copies) return null
  const count = accounts?.length ?? 0
  const setCopyNew = (copyNew: boolean): void => {
    if (!bridge) return
    setFailed(false)
    void bridge.setCopyNew(copyNew).then(onCopies, () => setFailed(true))
  }
  return <SettingsGroup title={t`Other computers`} icon={MonitorSmartphone} rows={false}>
    <div className="plugins-computers">
      <Toggle label={t`Copy new accounts to every computer I pair`} checked={copies.copyNew} disabled={!bridge} onCheckedChange={setCopyNew}
        description={t`Each account’s secret is sent to the computers you paired as hosts, on the connection Sotto already holds to each, and kept in each one’s own encrypted store, so their threads work while this computer is off. You can stop the copy for any account. An account kept to chosen projects is never copied.`} />
      {failed ? <p className="tt-field__error tt-paragraph" role="alert"><Trans>That could not be saved. Nothing was changed. Try again.</Trans></p> : null}
      {copies.computers.length === 0 ? <p className="tt-paragraph plugin-row__note"><Trans>No other computer is paired. Pair one in Settings › Hosts &amp; phones, and its threads can use these accounts too.</Trans></p>
        : <ul className="plugins-computers__list" aria-label={t`Other computers`}>
          {copies.computers.map(computer => {
            const kept = copies.copies.filter(copy => copy.computerId === computer.id && copy.state === 'kept').length
            const name = computer.name
            return <li key={computer.id}>
              <span className="plugin-row__dot" data-state={computer.connected ? 'signed-in' : 'none'} aria-hidden="true" />
              <b>{name}</b>
              <span>{computer.connected ? t`Connected. Copies kept there: ${kept} of ${count}.` : t`Not connected. Copies wait until it is.`}</span>
            </li>
          })}
        </ul>}
    </div>
  </SettingsGroup>
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

function VercelRow({ plugin, bridge, accounts, projects, copies, uses, onAccounts, onCopies }: {
  readonly plugin: PluginEntry; readonly bridge: PluginsBridge | undefined; readonly accounts: readonly PluginAccount[] | null; readonly projects: ProjectsView
  readonly copies: PluginCopiesView | null; readonly onCopies: (view: PluginCopiesView) => void
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
    {mine.map(account => <AccountCard key={account.id} account={account} bridge={bridge} projects={projects} copies={copies} onCopies={onCopies} onAccounts={onAccounts} onRemoved={() => { setAdding(false); requestAnimationFrame(() => addButton.current?.focus()) }}
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
function AccountCard({ account, bridge, projects, copies, uses, onAccounts, onCopies, onRemoved }: {
  readonly account: PluginAccount; readonly bridge: PluginsBridge | undefined; readonly projects: ProjectsView; readonly uses: readonly ShownPluginUse[] | null
  readonly copies: PluginCopiesView | null; readonly onCopies: (view: PluginCopiesView) => void
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
    <AccountCopies account={account} bridge={bridge} copies={copies} onCopies={onCopies} />
    <RecentUse name={name} uses={uses} />
  </section>
}

/**
 * Where an account's secret is kept (ADR-0205, amending ADR-0025): always on this computer, and on each of the user's
 * other computers that holds a copy, each with its own switch. The line under a switch says where that copy stands in
 * plain words: kept, waiting for the computer, or why the computer could not keep it. Nothing here shows a secret.
 */
function AccountCopies({ account, bridge, copies, onCopies }: {
  readonly account: PluginAccount; readonly bridge: PluginsBridge | undefined; readonly copies: PluginCopiesView | null; readonly onCopies: (view: PluginCopiesView) => void
}): ReactNode {
  const { t } = useLingui()
  const headingId = useId()
  const [failed, setFailed] = useState(false)
  // With no other computer paired there is one place it is kept, and nothing to choose.
  if (!copies || copies.computers.length === 0) return null
  const name = account.name
  const set = (computerId: string, on: boolean): void => {
    if (!bridge) return
    setFailed(false)
    void bridge.setCopy({ accountId: account.id, computerId, on }).then(onCopies, () => setFailed(true))
  }
  const words = (state: PluginAccountCopyState, computer: string, connected: boolean): string => {
    switch (state) {
      case 'kept': return t`A copy is kept on ${computer}.`
      case 'waiting': return connected ? t`Sending the copy to ${computer}…` : t`${computer} is not connected. Sotto sends the copy, or checks the one there, when it is.`
      case 'off': return t`No copy. ${computer}’s threads cannot use this account.`
      case 'here-only': return t`No copy. ${name} is kept to projects on this computer, so its secret stays here. Choose Every project to copy it.`
      case 'too-old': return t`${computer}’s Sotto cannot keep account copies. Update Sotto on ${computer}, and the copy is sent.`
      case 'no-key': return t`${computer} was started without a key file, so it cannot keep a token. Nothing was kept there. On ${computer}, set SOTTO_HOST_KEY_FILE to a file holding a secret of your own, start its host again, and the copy is sent.`
      case 'full': return t`${computer} already holds as many accounts as a plugin takes. Nothing was kept there.`
      case 'name-taken': return t`Another of your computers already sent ${computer} an account called ${name}. Rename one of the two. Nothing was kept there.`
      case 'held': return t`Another of your computers already sent ${computer} this account. Nothing was changed there.`
      case 'locked': return t`This computer’s credential store is locked, so the token could not be read to send. Unlock it, and Sotto tries again.`
      case 'failed': return t`The copy could not be sent to ${computer}. Sotto tries again.`
    }
  }
  return <section className="plugin-account__copies" aria-labelledby={headingId}>
    <h4 id={headingId}><Trans>Where its secret is kept</Trans></h4>
    <p className="plugin-account__here tt-paragraph"><b><Trans>This computer</Trans></b> <span><Trans>Always, in Sotto’s encrypted store.</Trans></span></p>
    {copies.computers.map(computer => {
      const state = copies.copies.find(copy => copy.accountId === account.id && copy.computerId === computer.id)?.state ?? 'waiting'
      const computerName = computer.name
      return <Toggle key={computer.id} label={t`Keep a copy of ${name} on ${computerName}`} checked={state !== 'off' && state !== 'here-only'} disabled={!bridge || state === 'here-only'}
        description={words(state, computerName, computer.connected)} onCheckedChange={on => set(computer.id, on)} />
    })}
    <p className="tt-paragraph plugin-row__note"><Trans>A copy lets that computer’s threads use this account while this computer is off. It travels on the connection Sotto already holds to that computer and is kept in that computer’s own encrypted store.</Trans></p>
    {failed ? <p className="tt-field__error tt-paragraph" role="alert"><Trans>That could not be saved. Nothing was changed. Try again.</Trans></p> : null}
  </section>
}

/**
 * Which threads may use an account (ADR-0205, decision 9): its switch, and the projects it is kept to. Every project
 * is the default; pressing a project keeps the account to the ones pressed, and letting the last one go gives it back
 * to every project. A change is saved as it is made, and one that could not be saved says so and shows what is kept.
 */
function AccountThreads({ account, bridge, projects: read, onAccounts }: {
  readonly account: PluginAccount; readonly bridge: PluginsBridge | undefined; readonly projects: ProjectsView
  readonly onAccounts: (accounts: readonly PluginAccount[]) => void
}): ReactNode {
  const { t } = useLingui()
  const [failed, setFailed] = useState(false)
  const name = account.name
  const kept = account.projects
  // What the user has asked for and main has not yet answered. A press made while a save is still on its way is
  // worked out from this, not from what the page last heard: otherwise two quick presses would each start from
  // the same stale list, and letting one project go could give the account to every project.
  const wanted = useRef<{ readonly on: boolean; readonly projects: readonly string[] | null } | null>(null)
  const asked = useRef(0)
  const standing = (): { readonly on: boolean; readonly projects: readonly string[] | null } => wanted.current ?? { on: account.on, projects: kept }
  const change = (next: { readonly on: boolean; readonly projects: readonly string[] | null }, request: { readonly on?: boolean; readonly projects?: string[] | null }): void => {
    if (!bridge) return
    setFailed(false)
    wanted.current = next
    const mine = ++asked.current
    // Every change main kept is shown as it is answered. Only the newest one's answer says whether the page is
    // showing what the user asked for: an older change that failed is made good by a newer one built on it, and a
    // newer one that failed leaves the page on what main last kept.
    const answered = (ok: boolean): void => { if (asked.current === mine) { wanted.current = null; setFailed(!ok) } }
    void bridge.updateAccount({ id: account.id, ...request }).then(result => { if (result.ok) onAccounts(result.accounts); answered(result.ok) }, () => answered(false))
  }
  const turn = (): void => { const now = standing(); change({ ...now, on: !now.on }, { on: !now.on }) }
  const keepTo = (projects: string[] | null): void => { change({ ...standing(), projects }, { projects }) }
  const press = (id: string): void => {
    const now = standing().projects
    const next = now?.includes(id) ? now.filter(other => other !== id) : [...now ?? [], id]
    keepTo(next.length === 0 ? null : next)
  }
  // The projects, once they are read. Until then nothing is said to be gone and nothing can be let go: a list not
  // read yet is not an empty one, and letting the last project go gives the account to every project.
  const projects = read === null || read === 'failed' ? null : read
  if (projects === null) {
    return <div className="plugin-account__threads">
      <Toggle label={t`Threads may use ${name}`} checked={account.on} disabled={!bridge} onCheckedChange={turn}
        {...(account.on ? {} : { description: t`Off. No thread can see or use this account until you turn it back on. Its token stays saved.` })} />
      {account.on ? <p className="tt-paragraph plugin-row__note">{kept === null ? <Trans>Threads in every project may use it, and so may Watcher.</Trans> : <Trans>It is kept to chosen projects.</Trans>}</p> : null}
      {account.on && read === 'failed' ? <p className="tt-field__error tt-paragraph" role="alert"><Trans>Your projects could not be read, so the projects this account is kept to cannot be changed here. Nothing was changed. Reopen Settings and try again.</Trans></p> : null}
      {failed ? <p className="tt-field__error tt-paragraph" role="alert"><Trans>That could not be saved. What is shown is what is kept. Try again.</Trans></p> : null}
    </div>
  }
  // A settled project is offered only while the account is kept to it; one that is gone keeps a chip, so it can be let go.
  const offered = projects.filter(project => !project.settled || kept?.includes(project.id))
  const gone = (kept ?? []).filter(id => !projects.some(project => project.id === id))
  const titles = (kept ?? []).flatMap(id => { const project = projects.find(entry => entry.id === id); return project ? [project.title] : [] }).join(', ')
  return <div className="plugin-account__threads">
    <Toggle label={t`Threads may use ${name}`} checked={account.on} disabled={!bridge} onCheckedChange={turn}
      {...(account.on ? {} : { description: t`Off. No thread can see or use this account until you turn it back on. Its token stays saved.` })} />
    {account.on ? <>
      <div className="plugin-account__projects" role="group" aria-label={t`Projects whose threads may use ${name}`}>
        <button type="button" className="plugin-chip tt-focusable" aria-pressed={kept === null} disabled={!bridge} onClick={() => { if (standing().projects !== null) keepTo(null) }}><Trans>Every project</Trans></button>
        {offered.map(project => <button key={project.id} type="button" className="plugin-chip tt-focusable" aria-pressed={kept?.includes(project.id) ?? false} disabled={!bridge}
          onClick={() => press(project.id)}>{project.title}</button>)}
        {gone.map(id => <button key={id} type="button" className="plugin-chip tt-focusable" aria-pressed disabled={!bridge} onClick={() => press(id)}><Trans>A project that is gone</Trans></button>)}
      </div>
      <p className="tt-paragraph plugin-row__note">{kept === null ? <Trans>Threads in every project may use it, and so may Watcher.</Trans>
        : titles ? <Trans>Only threads in {titles} may use it. Watcher belongs to no project, so it cannot.</Trans>
          : <Trans>It is kept to a project that is gone, so no thread can use it. Press Every project, or choose one.</Trans>}</p>
    </> : null}
    {failed ? <p className="tt-field__error tt-paragraph" role="alert"><Trans>That could not be saved. What is shown is what is kept. Try again.</Trans></p> : null}
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
