import React, { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { ChevronRight, Code } from 'lucide-react'
import { PLUGIN_USE_SHOWN, PLUGINS, type GitHubSignIn, type PluginEntry, type PluginGroupId, type PluginReadKind, type PluginsBridge, type ShownPluginUse } from '../../../../shared/plugins'
import { localeFormatter } from '../../agents/localeFormat'
import { useTransientFlag, writeClipboard } from '../../agents/richActions'
import { Button } from '../../components/Button'
import { PluginMark } from './PluginMark'
import { SettingsGroup } from './SettingsGroup'
import './plugins.css'

const GH_SIGN_IN_COMMAND = 'gh auth login'

/** What the page knows of gh's sign-in: main's answer, still asking, or a read that failed. */
type SignInView = GitHubSignIn | { readonly state: 'checking' }

/** When a use happened, as the day and the time of day. */
const whenUsed = localeFormatter({ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

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
  const groupTitle: Record<PluginGroupId, string> = { code: t`Code and deploys` }
  return <div className="plugins-settings">
    <p className="tt-paragraph plugins-lead"><Trans>A thread’s agent uses a plugin through Sotto’s tools. So far they only read, and reading never asks you.</Trans></p>
    <SettingsGroup title={groupTitle.code} icon={Code} rows={false}>
      <div className="plugins-list">
        {PLUGINS.filter(plugin => plugin.group === 'code').map(plugin => <GitHubRow key={plugin.id} plugin={plugin} signIn={signIn} uses={uses} onCheck={() => { check(); readUses() }} />)}
      </div>
    </SettingsGroup>
  </div>
}

function GitHubRow({ plugin, signIn, uses, onCheck }: { readonly plugin: PluginEntry; readonly signIn: SignInView; readonly uses: readonly ShownPluginUse[] | null; readonly onCheck: () => void }): ReactNode {
  const { t } = useLingui()
  const [open, setOpen] = useState(false)
  const [copied, showCopied] = useTransientFlag<'copied'>()
  const [copyFailed, setCopyFailed] = useState(false)
  const bodyId = useId()
  const head = useRef<HTMLButtonElement>(null)
  // Escape closes the open row from anywhere in it and gives focus back to its header, as a provider's row does.
  const closeOnEscape = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || !open || event.defaultPrevented) return
    event.preventDefault()
    event.stopPropagation()
    setOpen(false)
    head.current?.focus()
  }
  const login = signIn.state === 'signed-in' ? signIn.login : ''
  const summary = signIn.state === 'signed-in' ? t`Signed in as ${login} through gh`
    : signIn.state === 'signed-out' ? t`Not signed in`
      : signIn.state === 'not-installed' ? t`gh isn’t installed`
        : signIn.state === 'checking' ? t`Checking…` : t`Couldn’t check`
  const copy = async (): Promise<void> => {
    setCopyFailed(false)
    try { await writeClipboard(GH_SIGN_IN_COMMAND); showCopied('copied') } catch { setCopyFailed(true) }
  }
  return <div className="plugin-row" data-setting={`plugin-${plugin.id}`} data-state={signIn.state} onKeyDown={closeOnEscape}>
    <button ref={head} type="button" className="plugin-row__head tt-focusable" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(value => !value)}>
      <PluginMark plugin={plugin.id} />
      <span className="plugin-row__name">{plugin.name}</span>
      {/* A space between the two, so the row's name reads "GitHub Signed in…" and not one run-together word. */}
      {' '}
      <span className="plugin-row__state"><span className="plugin-row__dot" aria-hidden="true" />{summary}</span>
      <ChevronRight className="plugin-row__chevron" size={16} strokeWidth={1.7} aria-hidden="true" />
    </button>
    {open ? <div className="plugin-row__body" id={bodyId}>
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
      <RecentUse plugin={plugin} uses={uses} />
      <div className="plugin-row__actions"><Button variant="secondary" aria-disabled={signIn.state === 'checking'} aria-label={t`Check GitHub’s sign-in again`} onClick={() => { if (signIn.state !== 'checking') onCheck() }}><Trans>Check again</Trans></Button></div>
    </div> : null}
  </div>
}

/** A plugin's newest uses by threads' agents: what was done and by which thread, never what was read. */
function RecentUse({ plugin, uses }: { readonly plugin: PluginEntry; readonly uses: readonly ShownPluginUse[] | null }): ReactNode {
  const { t } = useLingui()
  const headingId = useId()
  if (uses === null) return null
  const name = plugin.name
  const shown = uses.filter(use => use.plugin === plugin.id).slice(0, PLUGIN_USE_SHOWN)
  const what: Record<PluginReadKind, string> = {
    issues: t`Read issues`, 'pull-requests': t`Read pull requests`, repository: t`Read a repository`, commits: t`Read commits`, checks: t`Read checks`,
    releases: t`Read releases`, search: t`Searched ${name}`, account: t`Read account details`, other: t`Read from ${name}`,
  }
  return <section className="plugin-use" aria-labelledby={headingId}>
    <h4 id={headingId}><Trans>Recent use</Trans></h4>
    {shown.length === 0 ? <p className="tt-paragraph plugin-row__note"><Trans>No thread has used {name} yet.</Trans></p> : <ul>
      {shown.map(use => <li key={use.id}>
        <time dateTime={use.at}>{whenUsed(new Date(use.at))}</time>
        <span>
          {what[use.kind]}{' '}
          <span className="plugin-use__thread">{use.threadTitle === null ? t`in a thread that is gone` : t`in “${use.threadTitle}”`}</span>
          {use.outcome === 'refused' ? <>{' '}<Trans>Sotto refused it.</Trans></> : use.outcome === 'failed' ? <>{' '}<Trans>It failed.</Trans></> : null}
        </span>
      </li>)}
    </ul>}
    <p className="tt-paragraph plugin-row__note"><Trans>Sotto records what was done and by which thread, never what was read.</Trans></p>
  </section>
}
