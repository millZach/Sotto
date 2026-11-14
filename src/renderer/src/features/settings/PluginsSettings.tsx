import React, { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { ChevronRight, Code, Mail, MonitorSmartphone } from 'lucide-react'
import {
  isMailPlugin, PLUGIN_ACCOUNT_NAME_MAX, PLUGIN_MAIL_ADDRESS_MAX, PLUGIN_SECRET_MAX, PLUGIN_USE_SHOWN, pluginMailAddressSchema, PLUGINS, type AccountPluginId, type GitHubSignIn, type PluginAccount, type PluginAccountProblem, type PluginAccountResult,
  type PluginAccountCopyLeaving, type PluginAccountCopyState, type PluginCopiesView, type PluginHostSignIn, type PluginEntry, type PluginGroupId, type PluginProject, type PluginReadKind, type PluginsBridge, type ShownPluginUse,
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
/** Where Google makes app passwords, from its own help page (support.google.com/accounts/answer/185833, November 13, 2026). Words to type or copy, as Vercel's is. */
const GOOGLE_APP_PASSWORDS_PAGE = 'myaccount.google.com/apppasswords'

/** This computer's projects as the page knows them: read, not read yet, or a read that failed. */
type ProjectsView = readonly PluginProject[] | null | 'failed'
/** What the page knows of gh's sign-in: main's answer, still asking, or a read that failed. */
type SignInView = GitHubSignIn | { readonly state: 'checking' }
/** gh's sign-in on another computer as the page shows it: what the computer said, or that it has just connected and is being asked. */
type ShownHostSignIn = PluginHostSignIn | { readonly computerId: string; readonly name: string; readonly state: 'asking'; readonly login?: undefined }

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
  // gh's sign-in on each of the user's other computers, whose threads act as that account. Null while unread, or
  // when it could not be read. Each read starts gh on every connected computer, so it is asked for when the page
  // knows its computers, when one connects or leaves, and on Check again, and not each time a copy changes.
  const [elsewhereSignIns, setElsewhereSignIns] = useState<readonly PluginHostSignIn[] | null>(null)
  const elsewhereAsked = useRef(0)
  const checkElsewhere = useCallback((): void => {
    if (!bridge) return
    const mine = ++elsewhereAsked.current
    void bridge.gitHubSignInElsewhere().then(value => { if (elsewhereAsked.current === mine) setElsewhereSignIns(value) }).catch(() => { if (elsewhereAsked.current === mine) setElsewhereSignIns(null) })
  }, [bridge])
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
  // A choice takes its place in line when it is asked, as a read does, so whichever was asked last is what shows:
  // an older read still on its way does not land after a choice's answer, and a choice's answer that comes back
  // late does not undo a newer read.
  const tookCopies: CopiesChoice = ask => {
    const mine = ++copiesAsked.current
    return ask().then(view => { if (copiesAsked.current === mine) setCopies(view) })
  }
  const changedAccounts = (next: readonly PluginAccount[]): void => { setAccounts(next); readCopies() }
  // With another computer paired, its threads use plugins too: its own gh, and the copies it holds.
  // Which computers are paired and which of them are connected, as one value that changes only when that does.
  const computersNow = copies === null ? null : copies.computers.map(computer => `${computer.id} ${computer.connected ? 'connected' : 'away'}`).join('\n')
  useEffect(() => {
    if (computersNow === null) return
    checkElsewhere()
    return () => { elsewhereAsked.current += 1 }
  }, [computersNow, checkElsewhere])
  // What each computer last said is shown as the computers stand now, since a read can take as long as its slowest
  // computer: one that has left is not connected whatever it said a moment ago, one that has just connected is
  // being asked, and one that is no longer paired is not listed.
  const shownElsewhere: readonly ShownHostSignIn[] | null = elsewhereSignIns === null ? null : elsewhereSignIns.flatMap((computer): ShownHostSignIn[] => {
    if (copies === null) return [computer]
    const now = copies.computers.find(saved => saved.id === computer.computerId)
    if (!now) return []
    if (!now.connected) return [computer.state === 'no-plugins' || computer.state === 'away' ? computer : { computerId: computer.computerId, name: computer.name, state: 'away' }]
    return [computer.state === 'away' ? { computerId: computer.computerId, name: computer.name, state: 'asking' } : computer]
  })
  // Only a computer whose Sotto runs plugin tools counts, once each has said; until then, any paired computer.
  const elsewhere = shownElsewhere !== null ? shownElsewhere.some(computer => computer.state !== 'no-plugins') : copies !== null && copies.computers.length > 0
  const groupTitle: Record<PluginGroupId, string> = { code: t`Code and deploys`, mail: t`Mail` }
  return <div className="plugins-settings">
    <p className="tt-paragraph plugins-lead"><Trans>A thread’s agent uses a plugin through Sotto’s tools and never holds its secret. Reading never asks you, except that each thread asks once before it reads a mail account. A change, such as posting a comment, asks you first in its thread, each time.</Trans></p>
    <SettingsGroup title={groupTitle.code} icon={Code} rows={false}>
      <div className="plugins-list">
        {PLUGINS.filter(plugin => plugin.group === 'code').map(plugin => plugin.id === 'github'
          ? <GitHubRow key={plugin.id} plugin={plugin} signIn={signIn} uses={uses} elsewhere={elsewhere} elsewhereSignIns={shownElsewhere} onCheck={() => { check(); checkElsewhere(); readUses() }} />
          : <AccountsRow key={plugin.id} plugin={plugin} bridge={bridge} accounts={accounts} projects={projects} copies={copies} uses={uses} elsewhere={elsewhere} onAccounts={changedAccounts} onCopies={tookCopies} />)}
      </div>
    </SettingsGroup>
    <SettingsGroup title={groupTitle.mail} icon={Mail} rows={false}>
      <div className="plugins-list">
        {PLUGINS.filter(plugin => plugin.group === 'mail').map(plugin =>
          <AccountsRow key={plugin.id} plugin={plugin} bridge={bridge} accounts={accounts} projects={projects} copies={copies} uses={uses} elsewhere={elsewhere} onAccounts={changedAccounts} onCopies={tookCopies} />)}
      </div>
    </SettingsGroup>
    <OtherComputers bridge={bridge} copies={copies} onCopies={tookCopies} />
  </div>
}

/** A choice about copies, asked of main: its answer is the copies as the choice left them. */
type CopiesChoice = (ask: () => Promise<PluginCopiesView>) => Promise<void>

/**
 * The user's other computers (ADR-0205, amending ADR-0025): whether a new account starts with a copy on them, and
 * for each computer whether it is connected and how many copies it has said it holds. A copy lets a computer's threads use an
 * account while this one is off. Each account says for itself where it is kept.
 */
function OtherComputers({ bridge, copies, onCopies }: {
  readonly bridge: PluginsBridge | undefined; readonly copies: PluginCopiesView | null; readonly onCopies: CopiesChoice
}): ReactNode {
  const { t } = useLingui()
  const [failed, setFailed] = useState(false)
  if (!copies) return null
  const setCopyNew = (copyNew: boolean): void => {
    if (!bridge) return
    setFailed(false)
    void onCopies(() => bridge.setCopyNew(copyNew)).catch(() => setFailed(true))
  }
  return <SettingsGroup title={t`Other computers`} icon={MonitorSmartphone} rows={false}>
    <div className="plugins-computers">
      <Toggle label={t`Copy new accounts to every computer I pair`} checked={copies.copyNew} disabled={!bridge || !copies.readable} onCheckedChange={setCopyNew}
        description={t`Each account’s secret is sent to the computers you paired as hosts, on the connection Sotto already holds to each, and kept in each one’s own encrypted store, so their threads work while this computer is off. You can stop the copy for any account. An account kept to chosen projects is never copied.`} />
      {failed ? <p className="tt-field__error tt-paragraph" role="alert"><Trans>That could not be saved. Nothing was changed. Try again.</Trans></p> : null}
      {copies.readable ? null : <p className="tt-field__error tt-paragraph" role="alert"><Trans>Sotto cannot read its record of which computers keep a copy, so it sends no copy and no choice can be changed. It still takes back the copy of an account you remove or keep to chosen projects. If a newer Sotto wrote the record, update Sotto on this computer.</Trans></p>}
      {copies.computers.length === 0 ? <p className="tt-paragraph plugin-row__note"><Trans>No other computer is paired. Pair one in Settings › Hosts &amp; phones, and its threads can use these accounts too.</Trans></p>
        : <ul className="plugins-computers__list" aria-label={t`Other computers`}>
          {copies.computers.map(computer => {
            // A copy the computer is known to hold and is being told to let go is counted until it has gone. One whose
            // presence is not known is not: the count is of copies the computer has said it holds.
            const kept = copies.copies.filter(copy => copy.computerId === computer.id && (copy.state === 'kept' || copy.leaving === 'now')).length
            const name = computer.name
            return <li key={computer.id}>
              <span className="plugin-row__dot" data-state={computer.connected ? 'signed-in' : 'none'} aria-hidden="true" />
              <b>{name}</b>
              <span>{computer.connected ? t`Connected. Copies kept there: ${kept}.` : t`Not connected. Copies wait until it is.`}</span>
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

function GitHubRow({ plugin, signIn, uses, elsewhere, elsewhereSignIns, onCheck }: {
  readonly plugin: PluginEntry; readonly signIn: SignInView; readonly uses: readonly ShownPluginUse[] | null
  /** Whether another computer is paired whose threads use plugins, with that computer's own gh. */
  readonly elsewhere: boolean
  /** gh's sign-in on each of the user's other computers, or null while unread. */
  readonly elsewhereSignIns: readonly ShownHostSignIn[] | null; readonly onCheck: () => void
}): ReactNode {
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
    {elsewhereSignIns !== null && elsewhereSignIns.length > 0 ? <ul className="plugin-row__elsewhere" aria-label={t`GitHub’s sign-in on your other computers`}>
      {elsewhereSignIns.map(computer => {
        const name = computer.name, account = computer.login ?? ''
        const says = computer.state === 'signed-in' ? t`Signed in as ${account} through gh on that computer.`
          : computer.state === 'signed-out' ? t`gh is not signed in there, so its threads cannot use GitHub. On ${name}, run ${GH_SIGN_IN_COMMAND}.`
            : computer.state === 'not-installed' ? t`gh isn’t installed there, so its threads cannot use GitHub.`
              : computer.state === 'away' ? t`Not connected, so its gh cannot be asked.`
                : computer.state === 'asking' ? t`Asking its gh who is signed in…`
                : computer.state === 'too-old' ? t`Its Sotto is too old to say who gh is signed in as there. Its threads use that computer’s gh all the same. Update Sotto on ${name} to see the account.`
                  : computer.state === 'no-plugins' ? t`Its Sotto runs no plugin tools, so its threads do not use GitHub through Sotto.`
                  : t`Sotto couldn’t ask its gh who is signed in.`
        return <li key={computer.computerId}>
          <span className="plugin-row__dot" data-state={computer.state === 'signed-in' ? 'signed-in' : computer.state === 'signed-out' || computer.state === 'not-installed' ? 'signed-out' : 'none'} aria-hidden="true" />
          <b>{name}</b>
          <span>{says}</span>
        </li>
      })}
    </ul> : null}
    <p className="tt-paragraph plugin-row__note"><Trans>GitHub uses the gh command’s own sign-in. Sotto stores nothing for it.</Trans>
      {elsewhere ? <> <Trans>A thread on another of your computers uses the gh sign-in on that computer, which may be a different account.</Trans></> : null}</p>
    <RecentUse name={plugin.name} uses={uses === null ? null : uses.filter(use => use.plugin === plugin.id)} elsewhere={elsewhere} />
    <div className="plugin-row__actions"><Button variant="secondary" aria-disabled={signIn.state === 'checking'} aria-label={t`Check GitHub’s sign-in again`} onClick={() => { if (signIn.state !== 'checking') onCheck() }}><Trans>Check again</Trans></Button></div>
  </PluginRow>
}

/** What went wrong with an account, in words that say whether anything was saved and what to do next. */
/**
 * What the page calls a plugin's accounts. Vercel's secret is a token it issues; a mail account's is an app password
 * that signs in beside an address. Each plugin's sentences are written out whole, so each can be put into another
 * language as a sentence.
 */
interface AccountWords {
  /** What the plugin is for, under its row. */
  readonly about: string
  readonly add: string
  readonly addAnother: string
  readonly secretLabel: string
  readonly secretDescription: string
  readonly secretPlaceholder: string
  readonly newSecretLabel: string
  readonly newSecretDescription: string
  readonly saveSecret: string
  readonly account: (name: string) => string
  /** Who the account is and when its secret was saved. */
  readonly saved: (account: PluginAccount, day: string) => string
  readonly replace: (name: string) => string
  readonly remove: (name: string) => string
  readonly removeAsk: (name: string) => ReactNode
  /** Said of an account that is switched off. */
  readonly off: string
  readonly noKey: (computer: string) => string
  readonly locked: string
  readonly tooOld: (computer: string) => string
  readonly problem: (problem: PluginAccountProblem, replacing: boolean) => string
}

function useAccountWords(plugin: AccountPluginId): AccountWords {
  const { t } = useLingui()
  if (isMailPlugin(plugin)) {
    return {
      about: t`Search and read mail with an app password. Each thread asks you once, in the thread, before it reads an account’s mail, and what it reads goes to that thread’s provider. A thread asks you before each email it sends, and shows you the whole email first. It cannot move or delete mail, and a message it reads stays unread for you. To make a thread ask again, open its ··· menu and press Ask before this thread reads the account.`,
      add: t`Add a Gmail account`, addAnother: t`Add another Gmail account`,
      secretLabel: t`App password`,
      secretDescription: t`Sixteen characters, made at ${GOOGLE_APP_PASSWORDS_PAGE}. It needs 2-Step Verification on the Google account. Sotto checks it with Gmail before saving it, and never shows it again.`,
      secretPlaceholder: t`Paste the app password`,
      newSecretLabel: t`New app password`,
      newSecretDescription: t`Sotto checks it with Gmail first. The app password saved now stays in use until the new one is accepted.`,
      saveSecret: t`Save app password`,
      account: name => t`Gmail account ${name}`,
      saved: (account, day) => { const address = account.address ?? ''; return t`${address}. App password saved ${day}.` },
      replace: name => t`Replace the app password for ${name}`,
      remove: name => t`Remove the Gmail account ${name}`,
      removeAsk: name => <Trans>Remove <b>{name}</b>? Its app password is deleted from this computer, and threads lose the account at once. Nothing changes at Gmail.</Trans>,
      off: t`Off. No thread can see or use this account until you turn it back on. Its app password stays saved.`,
      noKey: computer => t`${computer} was started without a key file, so it cannot keep an app password. Nothing was kept there. On ${computer}, set SOTTO_HOST_KEY_FILE to a file holding a secret of your own, start its host again, and the copy is sent.`,
      locked: t`This computer’s credential store is locked, so the app password could not be read to send. Unlock it, and Sotto tries again.`,
      tooOld: computer => t`${computer}’s Sotto cannot keep a mail account’s copy. Update Sotto on ${computer}, and the copy is sent.`,
      problem: (problem, replacing) => {
        const kept = replacing ? t`The app password already saved was kept.` : t`Nothing was saved.`
        switch (problem) {
          case 'refused': return t`Gmail did not accept this address and app password. ${kept} Check the address, and make a new app password at ${GOOGLE_APP_PASSWORDS_PAGE}.`
          case 'unreachable': return t`Gmail could not be reached to check the app password. ${kept} Check your connection, then try again.`
          case 'busy': return t`Gmail is turning sign-ins away for now, so the app password could not be checked. ${kept} Wait a few minutes, then try again.`
          case 'name-taken': return t`There is already a Gmail account with that name. Nothing was saved. Give this one another name.`
          case 'limit': return t`Gmail already has as many accounts as Sotto keeps for one plugin. Nothing was saved. Remove one first.`
          case 'gone': return t`That account is no longer here. Nothing was changed.`
          default: return t`Sotto could not keep the app password. ${kept} Check that this computer’s credential store is unlocked, then try again.`
        }
      },
    }
  }
  return {
    about: t`Deployments, build logs, projects and domains, read with a token you paste. Sotto keeps the token in its encrypted store and makes each read itself, so no agent ever sees it.`,
    add: t`Add a Vercel account`, addAnother: t`Add another Vercel account`,
    secretLabel: t`Token`,
    secretDescription: t`Make one at ${VERCEL_TOKENS_PAGE}. Sotto checks it with Vercel before saving it, and never shows it again.`,
    secretPlaceholder: t`Paste the token`,
    newSecretLabel: t`New token`,
    newSecretDescription: t`Sotto checks it with Vercel first. The token saved now stays in use until the new one is accepted.`,
    saveSecret: t`Save token`,
    account: name => t`Vercel account ${name}`,
    saved: (account, day) => { const signedInAs = account.signedInAs; return signedInAs ? t`Signed in to Vercel as ${signedInAs}. Token saved ${day}.` : t`Token saved ${day}.` },
    replace: name => t`Replace the token for ${name}`,
    remove: name => t`Remove the Vercel account ${name}`,
    removeAsk: name => <Trans>Remove <b>{name}</b>? Its token is deleted from this computer, and threads lose the account at once. Nothing changes at Vercel.</Trans>,
    off: t`Off. No thread can see or use this account until you turn it back on. Its token stays saved.`,
    noKey: computer => t`${computer} was started without a key file, so it cannot keep a token. Nothing was kept there. On ${computer}, set SOTTO_HOST_KEY_FILE to a file holding a secret of your own, start its host again, and the copy is sent.`,
    locked: t`This computer’s credential store is locked, so the token could not be read to send. Unlock it, and Sotto tries again.`,
    tooOld: computer => t`${computer}’s Sotto cannot keep account copies. Update Sotto on ${computer}, and the copy is sent.`,
    problem: (problem, replacing) => {
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
    },
  }
}

/** The row of a plugin whose accounts the user adds: Vercel's, and a mail plugin's. Its accounts, each with its settings, and the way to add one. */
function AccountsRow({ plugin, bridge, accounts, projects, copies, uses, elsewhere, onAccounts, onCopies }: {
  readonly plugin: PluginEntry; readonly bridge: PluginsBridge | undefined; readonly accounts: readonly PluginAccount[] | null; readonly projects: ProjectsView
  readonly copies: PluginCopiesView | null; readonly onCopies: CopiesChoice
  readonly uses: readonly ShownPluginUse[] | null; readonly onAccounts: (accounts: readonly PluginAccount[]) => void
  /** Whether another computer is paired whose threads use plugins: their uses are not listed here. */
  readonly elsewhere: boolean
}): ReactNode {
  const { t } = useLingui()
  // GitHub's row is its own: its account is gh's sign-in, and nothing is added here.
  const id: AccountPluginId = plugin.id === 'gmail' ? 'gmail' : 'vercel'
  const words = useAccountWords(id)
  const mine = (accounts ?? []).filter(account => account.plugin === id)
  // An account switched off says so beside its name, so the folded row does not read as one threads can use.
  const names = mine.map(account => { const name = account.name; return account.on ? name : t`${name} (off)` }).join(', ')
  const count = mine.length
  const summary = accounts === null ? t`Couldn’t read the accounts` : count === 0 ? t`Not added` : count === 1 ? names : t`${count} accounts: ${names}`
  const [adding, setAdding] = useState(false)
  const addButton = useRef<HTMLButtonElement>(null)
  const closeAdd = (): void => { setAdding(false); requestAnimationFrame(() => addButton.current?.focus()) }
  // The row's dot is lit only while some account is one a thread could use.
  return <PluginRow plugin={plugin} state={accounts === null ? 'unknown' : mine.some(account => account.on) ? 'signed-in' : 'none'} summary={summary}>
    <p className="tt-paragraph">{words.about}</p>
    {accounts === null ? <p className="tt-field__error tt-paragraph" role="alert"><Trans>The accounts could not be read. Nothing was changed. Reopen Settings and try again.</Trans></p> : null}
    {mine.map(account => <AccountCard key={account.id} account={account} bridge={bridge} projects={projects} copies={copies} elsewhere={elsewhere} onCopies={onCopies} onAccounts={onAccounts} onRemoved={() => { setAdding(false); requestAnimationFrame(() => addButton.current?.focus()) }}
      uses={uses === null ? null : uses.filter(use => use.accountId === account.id)} />)}
    {adding ? <AddAccount plugin={id} bridge={bridge} onAccounts={onAccounts} onDone={closeAdd} />
      : <div className="plugin-row__actions"><Button ref={addButton} variant="secondary" disabled={accounts === null || !bridge} onClick={() => setAdding(true)}>
        {count === 0 ? words.add : words.addAnother}</Button></div>}
  </PluginRow>
}

/**
 * The form that adds an account: a name and the secret, and for a mail account the address the secret signs in.
 * They are checked with the service before anything is kept. Escape cancels it.
 */
function AddAccount({ plugin, bridge, onAccounts, onDone }: { readonly plugin: AccountPluginId; readonly bridge: PluginsBridge | undefined; readonly onAccounts: (accounts: readonly PluginAccount[]) => void; readonly onDone: () => void }): ReactNode {
  const { t } = useLingui()
  const words = useAccountWords(plugin)
  const mail = isMailPlugin(plugin)
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  useEffect(() => { nameInput.current?.focus() }, [])
  const ready = name.trim() !== '' && token.trim() !== '' && (!mail || pluginMailAddressSchema.safeParse(address).success) && !busy && bridge !== undefined
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!ready) return
    setBusy(true); setProblem(null)
    let result: PluginAccountResult
    try { result = await bridge.addAccount({ plugin, name: name.trim(), secret: token.trim(), ...(mail ? { address: address.trim() } : {}) }) } catch { result = { ok: false, problem: 'store' } }
    setBusy(false)
    // The token is not kept in the page a moment longer than the request that carried it, whether it was kept or not.
    setToken('')
    if (!result.ok) { setProblem(words.problem(result.problem, false)); return }
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
  return <form className="plugin-account plugin-account--form" aria-label={words.add} onSubmit={event => void submit(event)} onKeyDown={cancelOnEscape}>
    <Field label={t`Name`} description={t`What you and your threads’ agents call this account, such as Work or Personal.`}>
      <input ref={nameInput} className="tt-input" autoComplete="off" spellCheck={false} maxLength={PLUGIN_ACCOUNT_NAME_MAX} value={name} onChange={event => setName(event.target.value)} />
    </Field>
    {mail ? <Field label={t`Gmail address`} description={t`The address the app password belongs to. Sotto shows it here and never tells it to an agent.`}>
      <input className="tt-input" type="email" autoComplete="off" spellCheck={false} maxLength={PLUGIN_MAIL_ADDRESS_MAX} value={address} onChange={event => setAddress(event.target.value)} />
    </Field> : null}
    <Field label={words.secretLabel} description={words.secretDescription}>
      <input className="tt-input" type="password" autoComplete="off" spellCheck={false} maxLength={PLUGIN_SECRET_MAX} value={token} placeholder={words.secretPlaceholder} onChange={event => setToken(event.target.value)} />
    </Field>
    {problem ? <p className="tt-field__error tt-paragraph" role="alert">{problem}</p> : null}
    <div className="plugin-row__actions">
      <Button type="submit" variant="primary" aria-disabled={!ready}>{busy ? t`Checking…` : t`Add account`}</Button>
      <Button variant="ghost" aria-disabled={busy} onClick={() => { if (!busy) { setToken(''); onDone() } }}><Trans>Cancel</Trans></Button>
    </div>
  </form>
}

/** One account: its name, when its secret was saved, Replace and Remove, and its recent use. */
function AccountCard({ account, bridge, projects, copies, uses, elsewhere, onAccounts, onCopies, onRemoved }: {
  readonly account: PluginAccount; readonly bridge: PluginsBridge | undefined; readonly projects: ProjectsView; readonly uses: readonly ShownPluginUse[] | null
  readonly copies: PluginCopiesView | null; readonly onCopies: CopiesChoice; readonly elsewhere: boolean
  readonly onAccounts: (accounts: readonly PluginAccount[]) => void
  /** The account is gone, and its buttons with it: focus needs somewhere to go. */
  readonly onRemoved: () => void
}): ReactNode {
  const { t } = useLingui()
  const words = useAccountWords(account.plugin)
  const [mode, setMode] = useState<'rest' | 'replacing' | 'removing'>('rest')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const replaceButton = useRef<HTMLButtonElement>(null)
  const removeButton = useRef<HTMLButtonElement>(null)
  const name = account.name
  const saved = daySaved(new Date(account.savedAt))
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
    if (!result.ok) { setProblem(replacing ? words.problem(result.problem, true) : t`The account could not be removed. Nothing was changed. Try again.`); return }
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
  return <section className="plugin-account" aria-label={words.account(name)} onKeyDown={cancelOnEscape}>
    <div className="plugin-account__top">
      <div className="plugin-account__who">
        <b>{name}</b>
        <span>{words.saved(account, saved)}</span>
      </div>
      {mode === 'rest' ? <div className="plugin-row__actions">
        <Button ref={replaceButton} variant="secondary" disabled={!bridge} aria-label={words.replace(name)} onClick={() => setMode('replacing')}><Trans>Replace</Trans></Button>
        <Button ref={removeButton} variant="ghost" disabled={!bridge} aria-label={words.remove(name)} onClick={() => setMode('removing')}><Trans>Remove</Trans></Button>
      </div> : null}
    </div>
    {mode === 'replacing' ? <form className="plugin-account__change" aria-label={words.replace(name)}
      onSubmit={event => { event.preventDefault(); if (token.trim()) void run(() => bridge!.replaceSecret({ id: account.id, secret: token.trim() }), true) }}>
      <Field label={words.newSecretLabel} description={words.newSecretDescription}>
        <input className="tt-input" type="password" autoComplete="off" spellCheck={false} maxLength={PLUGIN_SECRET_MAX} value={token} placeholder={words.secretPlaceholder} autoFocus onChange={event => setToken(event.target.value)} />
      </Field>
      <div className="plugin-row__actions">
        <Button type="submit" variant="primary" aria-disabled={busy || token.trim() === ''}>{busy ? t`Checking…` : words.saveSecret}</Button>
        <Button variant="ghost" aria-disabled={busy} onClick={() => { if (!busy) rest('replace') }}><Trans>Cancel</Trans></Button>
      </div>
    </form> : null}
    {mode === 'removing' ? <div className="plugin-account__change" role="group" aria-label={words.remove(name)}>
      <p className="tt-paragraph">{words.removeAsk(name)}</p>
      <div className="plugin-row__actions">
        <Button variant="danger" autoFocus aria-disabled={busy} onClick={() => void run(() => bridge!.removeAccount({ id: account.id }), false)}><Trans>Remove account</Trans></Button>
        <Button variant="ghost" aria-disabled={busy} onClick={() => { if (!busy) rest('remove') }}><Trans>Keep it</Trans></Button>
      </div>
    </div> : null}
    {problem ? <p className="tt-field__error tt-paragraph" role="alert">{problem}</p> : null}
    <AccountThreads account={account} bridge={bridge} projects={projects} onAccounts={onAccounts} />
    <AccountCopies account={account} bridge={bridge} copies={copies} onCopies={onCopies} />
    <RecentUse name={name} uses={uses} elsewhere={elsewhere} />
  </section>
}

/**
 * Where an account's secret is kept (ADR-0205, amending ADR-0025): always on this computer, and on each of the user's
 * other computers that holds a copy, each with its own switch. The line under a switch says where that copy stands in
 * plain words: kept, waiting for the computer, or why the computer could not keep it. Nothing here shows a secret.
 */
function AccountCopies({ account, bridge, copies, onCopies }: {
  readonly account: PluginAccount; readonly bridge: PluginsBridge | undefined; readonly copies: PluginCopiesView | null; readonly onCopies: CopiesChoice
}): ReactNode {
  const { t } = useLingui()
  const accountWords = useAccountWords(account.plugin)
  const headingId = useId()
  const [failed, setFailed] = useState(false)
  // With no other computer paired there is one place it is kept, and nothing to choose.
  if (!copies || copies.computers.length === 0) return null
  const name = account.name
  const set = (computerId: string, on: boolean): void => {
    if (!bridge) return
    setFailed(false)
    void onCopies(() => bridge.setCopy({ accountId: account.id, computerId, on })).catch(() => setFailed(true))
  }
  const words = (state: PluginAccountCopyState, leaving: PluginAccountCopyLeaving, computer: string, connected: boolean): string => {
    // No copy is wanted, and only the computer can say it holds none: until it has, the line says what is still to happen.
    if ((state === 'off' || state === 'here-only') && leaving !== 'no') {
      const still = leaving === 'now' ? t`Sotto is taking the copy back from ${computer}.`
        : leaving === 'asking' ? t`Sotto is making sure ${computer} holds no copy.`
        : leaving === 'away' ? t`${computer} is not connected: if it holds a copy, it deletes it when it next connects.`
        : t`${computer}’s Sotto cannot keep account copies now, so it cannot say whether it holds one from before. Update Sotto on ${computer}, and a copy it holds is deleted.`
      return state === 'off' ? [t`No copy from now on.`, still].join(' ')
        : [t`${name} is kept to projects on this computer, so it is not copied.`, still, t`Choose Every project to copy it.`].join(' ')
    }
    switch (state) {
      case 'kept': return t`A copy is kept on ${computer}.`
      case 'waiting': return connected ? t`Sending the copy to ${computer}…` : t`${computer} is not connected. Sotto sends the copy, or checks the one there, when it is.`
      case 'off': return t`No copy. ${computer}’s threads cannot use this account.`
      case 'no-record': return t`Sotto cannot read its record of which computers keep a copy, so it is not sending one to ${computer}.`
      case 'here-only': return t`No copy. ${name} is kept to projects on this computer, so its secret stays here. Choose Every project to copy it.`
      case 'too-old': return accountWords.tooOld(computer)
      case 'no-key': return accountWords.noKey(computer)
      case 'full': return t`${computer} already holds as many accounts as a plugin takes. Nothing was kept there.`
      case 'name-taken': return t`Another of your computers already sent ${computer} an account called ${name}. Rename one of the two. Nothing was kept there.`
      case 'held': return t`Another of your computers already sent ${computer} this account. Nothing was changed there.`
      case 'locked': return accountWords.locked
      case 'failed': return t`The copy could not be sent to ${computer}. Sotto tries again.`
    }
  }
  return <section className="plugin-account__copies" aria-labelledby={headingId}>
    <h4 id={headingId}><Trans>Where its secret is kept</Trans></h4>
    <p className="plugin-account__here tt-paragraph"><b><Trans>This computer</Trans></b> <span><Trans>Always, in Sotto’s encrypted store.</Trans></span></p>
    {copies.computers.map(computer => {
      const copy = copies.copies.find(entry => entry.accountId === account.id && entry.computerId === computer.id)
      const state = copy?.state ?? 'waiting'
      const computerName = computer.name
      return <Toggle key={computer.id} label={t`Keep a copy of ${name} on ${computerName}`} checked={state !== 'off' && state !== 'here-only' && state !== 'no-record'} disabled={!bridge || !copies.readable || state === 'here-only'}
        description={words(state, copy?.leaving ?? 'no', computerName, computer.connected)} onCheckedChange={on => set(computer.id, on)} />
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
  const words = useAccountWords(account.plugin)
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
        {...(account.on ? {} : { description: words.off })} />
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
      {...(account.on ? {} : { description: words.off })} />
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
function RecentUse({ name, uses, elsewhere }: {
  readonly name: string; readonly uses: readonly ShownPluginUse[] | null
  /** Whether another computer is paired: its threads' uses are that computer's, and are not listed here. */
  readonly elsewhere: boolean
}): ReactNode {
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
    'mail-search': t`Searched mail`, 'mail-message': t`Read a message`, 'mail-send': t`Sent an email`,
  }
  // A change that was not made: what the agent asked to do, since nothing was done.
  const asked: Partial<Record<PluginReadKind, string>> = {
    comment: t`Asked to post a comment`, 'deployment-cancel': t`Asked to cancel a deployment’s build`,
    'issue-open': t`Asked to open an issue`, 'issue-close': t`Asked to close an issue`, 'issue-reopen': t`Asked to reopen an issue`,
    'deployment-promote': t`Asked to promote a deployment to production`, 'deployment-rollback': t`Asked to roll production back`,
    'mail-search': t`Asked to search mail`, 'mail-message': t`Asked to read a message`, 'mail-send': t`Asked to send an email`,
  }
  // A change asks each time, and so does a thread's first read of a mail account: both can end with the user's no.
  const changed = (use: ShownPluginUse): boolean => use.tool !== 'plugin_read' || use.outcome === 'denied' || use.outcome === 'lapsed'
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
                  // An email handed over whose answer never came may have gone, so it is not said to have been sent.
                  : use.outcome === 'unsure' ? <>{' '}<Trans>You allowed it, and Sotto cannot tell whether it was sent.</Trans></>
                  : changed(use) ? <>{' '}<Trans>You allowed it.</Trans></> : null}
        </span>
      </li>)}
    </ul>}
    <p className="tt-paragraph plugin-row__note"><Trans>Sotto records what was done and by which thread, never what was read or sent.</Trans>
      {elsewhere ? <> <Trans>Only this computer’s threads are listed. Your other computers keep no record of use.</Trans></> : null}</p>
  </section>
}
