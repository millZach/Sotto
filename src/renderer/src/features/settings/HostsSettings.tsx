import { isCompositionKey } from '../../agents/composerKeys'
import React, { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, Check, Copy, Laptop, MoreHorizontal, Plus, Server, Smartphone } from 'lucide-react'
import { i18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { type HostForgotten, type HostPhonesView, type HostSetupChoice, type HostSetupState, type HostsBridge, type HostsCommand, type HostsState, type HostStatus } from '../../../../shared/hosts'
import type { HostProviderJobState } from '../../../../shared/hostProviders'
import type { HostConnectionName } from '../../../../shared/hostConnection'
import { Button } from '../../components/Button'
import { Toggle } from '../../components/Toggle'
import { ConfirmationDialog } from '../../components/ConfirmationDialog'
import { HostDialog, type HostDialogMode } from './HostDialog'
import { HostsModal } from './HostsModal'
import { TailscaleRow, useTailscale } from './TailscaleConnect'
import { HostProviders, connectedProvidersLabel } from './HostProviders'
import { HostPhonesDialog, hostPhonesLabel, phoneWords } from './HostPhonesDialog'
import { tailnetRowNote } from './hostTailnetWords'
import { shownWords, type LaterWords } from './laterWords'
import { hostQuestionKey, useHostQuestionDismissals } from './hostQuestionDismissals'
import { useOptionalAgents } from '../../agents/AgentContext'
import { useTransientFlag, writeClipboard } from '../../agents/richActions'
import { HostBootDialog, HostBootResult, bootMenuLabel, bootStartOn, canChangeBoot } from './HostBootStart'
import type { HostBootState } from '../../../../shared/bootStart'
import type { AgentClientHost, AgentProviderStatus } from '../../../../shared/agents'
import './hosts.css'

/** What a saved host's row says about it, after "SSH forge ·". Read while the row renders, in the interface language. */
export function hostStatusLabel(host: HostStatus): string {
  if (host.phase === 'connected') return i18n._(msg({ message: 'Connected', comment: 'A provider on a host, or a host: connected and ready.' }))
  if (host.phase === 'connecting' && host.tailscale?.waiting) return i18n._(msg`Waiting for your approval in Tailscale`)
  if (host.phase === 'connecting') return host.reconnecting ? i18n._(msg`Reconnecting…`) : i18n._(msg`Connecting…`)
  if (host.phase === 'error') return i18n._(msg`Needs attention`)
  return host.enabled ? i18n._(msg`Not connected`) : i18n._(msg({ message: 'Switched off', comment: 'A saved host whose switch is off.' }))
}
/**
 * How a saved host is connected, for the start of its row (ADR-0053): `Tailnet` on its tailnet connection, and its SSH
 * target otherwise, and so does a reconnect. While a host that prefers the tailnet connects for the first time, the whole line
 * says which connection it is trying. The words after the connection are as they were. `via` is the connection the words
 * name, for the row to style.
 */
export function hostConnectionLine(host: HostStatus): { readonly connection: string | null; readonly via: HostConnectionName | null; readonly status: string | null; readonly note: string | null } {
  const target = host.target, port = host.sshPort
  const ssh = port ? i18n._(msg`SSH ${target}, port ${port}`) : `SSH ${target}`
  const tailnet = host.prefer === 'tailnet'
  const overTailnet = i18n._(msg({ message: 'Tailnet', comment: 'How a host is connected: over Tailscale\'s private network, the tailnet. Shown where "SSH forge" would be.' }))
  if (host.phase === 'connected' && host.via === 'tailnet') return { connection: overTailnet, via: 'tailnet', status: hostStatusLabel(host), note: null }
  if (tailnet && host.phase === 'connecting' && !host.reconnecting && !host.tailscale?.waiting && !host.prompt) {
    return { connection: null, via: null, status: host.via === 'tailnet' ? i18n._(msg`Connecting over your tailnet…`) : i18n._(msg`Connecting over SSH…`), note: null }
  }
  // The tailnet did not answer at its address, or the host has not set it up yet; the line under the row says which.
  const note = tailnet && host.phase === 'connected' && host.via === 'ssh' && host.tailnetNote ? host.tailnetNote === 'unreachable' ? i18n._(msg`Tailnet did not answer`) : i18n._(msg`Tailnet not ready`) : null
  // A reconnect says which connection it is trying, as a connected host does.
  const reconnectingOverTailnet = host.phase === 'connecting' && host.via === 'tailnet'
  return { connection: reconnectingOverTailnet ? overTailnet : ssh, via: reconnectingOverTailnet ? 'tailnet' : 'ssh', status: hostStatusLabel(host), note }
}
/** Why a host its owner put on the tailnet is on SSH, with the operator's command set apart. */
function TailnetRowNote({ name, note }: { readonly name: string; readonly note: NonNullable<HostStatus['tailnetNote']> }): ReactNode {
  const words = tailnetRowNote(name, note)
  return <p className="hosts-row__note tt-paragraph">{words.text}{words.command ? <code className="phones-mono">{words.command}</code> : null}{words.after}</p>
}
/** A host of another version Sotto started is still reached through the SSH session kept for Stop host. */
const reachable = (host: HostStatus): boolean => host.phase === 'connected' || host.phase === 'error' && host.owned === true
/** Stop host is offered only for a host Sotto started that it can still reach. */
const canStop = (host: HostStatus): boolean => host.owned === true && reachable(host)

type MenuAction = 'boot' | 'stop' | 'rename' | 'edit' | 'forget'

/** The row's More menu: arrow keys move through it, Escape and Tab close it, and focus goes back to its button. */
function HostMenu({ host, onAction }: { readonly host: HostStatus; readonly onAction: (action: MenuAction) => void }): ReactNode {
  const { t } = useLingui()
  const name = host.name
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const menuId = useId()
  // Start at boot… or Stop starting at boot… comes first, above a line, where the host can start at boot (ADR-0054), and
  // Forget comes last, below another, as the prototype draws them.
  const items: { action: MenuAction; label: string; danger?: boolean; line?: boolean }[] = [
    ...(canChangeBoot(host) ? [{ action: 'boot' as const, label: bootMenuLabel(host), line: true }] : []),
    ...(canStop(host) ? [{ action: 'stop' as const, label: t`Stop host` }] : []),
    { action: 'rename', label: t`Rename` },
    { action: 'edit', label: t`Edit connection`, line: true },
    { action: 'forget', label: t`Forget ${name}…`, danger: true },
  ]
  useEffect(() => {
    if (!open) return
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const outside = (event: PointerEvent): void => { if (!menu.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  const close = (refocus = true): void => { setOpen(false); if (refocus) button.current?.focus() }
  return <span className="hosts-menu">
    <Button ref={button} variant="ghost" iconOnly aria-label={t`More for ${name}`} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      onClick={() => setOpen(value => !value)}
      onKeyDown={event => { if (event.key === 'ArrowDown' && !open) { event.preventDefault(); setOpen(true) } }}><MoreHorizontal size={16} /></Button>
    {open ? <div ref={menu} id={menuId} role="menu" aria-label={t`${name} actions`} className="hosts-menu__list"
      onKeyDown={event => {
        const entries = [...menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []]
        const index = entries.indexOf(document.activeElement as HTMLElement)
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
        else if (event.key === 'Tab') close(false)
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); entries[(index + (event.key === 'ArrowDown' ? 1 : entries.length - 1)) % entries.length]?.focus() }
        else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); (event.key === 'Home' ? entries[0] : entries.at(-1))?.focus() }
      }}>
      {items.map(item => <React.Fragment key={item.action}>
        <button type="button" role="menuitem" tabIndex={-1} className="tt-focusable" data-danger={item.danger || undefined}
          onClick={() => { close(); onAction(item.action) }}>{item.label}</button>
        {item.line ? <div role="separator" /> : null}
      </React.Fragment>)}
    </div> : null}
  </span>
}

/** What the row says of a start at boot change that carries on after its modal closed. */
function bootLabel(boot: HostBootState | undefined): string | undefined {
  if (boot?.phase === 'waiting') return boot.change === 'install' ? i18n._(msg`Starts at boot when its threads finish`) : i18n._(msg`Stops starting at boot when its threads finish`)
  if (boot?.phase === 'changing') return boot.change === 'install' ? i18n._(msg`Starting at boot…`) : i18n._(msg`Stopping start at boot…`)
  return undefined
}

/**
 * A saved host: its name, where it is and how it is, the switch that keeps it connected, and its menu. A connected host
 * also says how many of its providers are connected, and Show providers opens its tiles (ADR-0037).
 */
function HostRow({ host, onCommand, onAction, onOpenPhones, phones, providers, client, bridge, job, choice, boot, bootShownElsewhere = false }: {
  readonly host: HostStatus
  /** The host's start at boot change, while one is waiting or running, or failed with nothing showing it (ADR-0054). */
  readonly boot?: HostBootState | undefined
  /** A start at boot modal or Add host's card shows the change now, so the row leaves its failure to them. */
  readonly bootShownElsewhere?: boolean
  /** The host's phone access as this computer last read it, and the press that opens its Phones dialog (ADR-0050). */
  readonly phones?: HostPhonesView | undefined
  readonly onOpenPhones: () => void
  readonly onCommand: (command: HostsCommand) => Promise<boolean>
  readonly onAction: (host: HostStatus, action: MenuAction) => void
  readonly providers?: readonly AgentProviderStatus[] | undefined
  /** The host as the window has it: its client updates, only from a host that offers them (#480). */
  readonly client?: Pick<AgentClientHost, 'clientUpdates' | 'clientUpdateRun'> | undefined
  readonly bridge?: HostsBridge | undefined
  readonly job?: HostProviderJobState | undefined
  readonly choice?: HostSetupChoice | undefined
}): ReactNode {
  const { t } = useLingui()
  const name = host.name
  const { dismissedQuestionKeys, resumeQuestion, registerAnswerTarget } = useHostQuestionDismissals(bridge)
  const rowRef = useRef<HTMLElement>(null)
  const questionKey = hostQuestionKey(host)
  const waitingForAnswer = questionKey !== null && dismissedQuestionKeys.has(questionKey)
  const line = hostConnectionLine(host)
  const shown = host.phase === 'connected' && providers?.length ? providers : undefined
  // On a tailnet connection, what its hello said, until the Phones dialog reads the host.
  const phonesLabel = hostPhonesLabel(phones) ?? (host.phase === 'connected' && host.phoneAccess ? phoneWords(host.phoneAccess) : null)
  const booting = bootLabel(boot)
  return <section ref={rowRef} className="hosts-row" aria-label={host.name} data-phase={host.phase}>
    <span className="hosts-row__icon" aria-hidden="true"><Server size={18} /></span>
    <div className="hosts-row__info">
      <h4>{host.name}</h4>
      <p className="hosts-row__meta">{line.connection ? <><span className="hosts-row__via" data-via={line.via ?? undefined}>{line.connection}</span> · </> : ''}<span data-phase={host.phase}>{waitingForAnswer ? t`Waiting for your answer` : line.status}</span>{line.note ? ` · ${line.note}` : ''}{shown ? ` · ${connectedProvidersLabel(shown)}` : ''}{phonesLabel ? ` · ${phonesLabel}` : ''}{booting ? ` · ${booting}` : ''}</p>
      {line.note && host.tailnetNote ? <TailnetRowNote name={host.name} note={host.tailnetNote} /> : null}
      {host.error ? <p className="hosts-row__error" role="alert">{host.error}</p> : null}
    </div>
    <div className="hosts-row__actions">
      {waitingForAnswer ? <Button aria-label={t`Answer ${name}`} ref={button => {
        if (!button) return
        return registerAnswerTarget(questionKey, () => {
          if (button.closest('[hidden]')) return
          rowRef.current?.scrollIntoView?.({ block: 'center', behavior: 'instant' })
          button.focus({ preventScroll: true })
        })
      }}
        onClick={() => resumeQuestion(questionKey)}>{t({ message: 'Answer', comment: 'Opens the question a host is waiting on, so the user can answer it.' })}</Button> : null}
      {/* Tailscale SSH holds a reconnect until it is approved, and only the browser can approve it. */}
      {host.phase === 'connecting' && host.tailscale?.waiting && host.tailscale.url ? <Button variant="secondary" aria-label={t`Open the Tailscale approval page for ${name}`}
        onClick={() => void onCommand({ type: 'open-approval', id: host.id })}>{t`Open approval page`}</Button> : null}
      {/* The sentence under a host that needs attention asks for one of these; each is also where it always is. */}
      {host.phase === 'error' && canStop(host) ? <Button variant="secondary" onClick={() => onAction(host, 'stop')}>{t`Stop host`}</Button> : null}
      {host.phase === 'error' && host.enabled && !canStop(host) ? <Button variant="secondary" onClick={() => void onCommand({ type: 'set-enabled', id: host.id, enabled: true })}>{t`Connect again`}</Button> : null}
      {host.phase === 'connected' || phones?.state ? <Button variant="secondary" aria-label={t`Open phone access for ${name}`} onClick={onOpenPhones}><Smartphone size={16} aria-hidden="true" />{t`Phones…`}</Button> : null}
      <span className="hosts-switch">
        <span className="hosts-switch__state" aria-hidden="true">{host.enabled ? t({ message: 'On', comment: 'A switch that is on.' }) : t({ message: 'Off', comment: 'A switch that is off.' })}</span>
        <button type="button" role="switch" aria-checked={host.enabled} aria-label={t`Keep ${name} connected, now and when Sotto starts`}
          className="tt-toggle tt-focusable hosts-switch__control" onClick={() => void onCommand({ type: 'set-enabled', id: host.id, enabled: !host.enabled })}>
          <span className="tt-toggle__track" aria-hidden="true"><span className="tt-toggle__thumb" /></span>
        </button>
      </span>
      <HostMenu host={host} onAction={action => onAction(host, action)} />
    </div>
    {boot && !bootShownElsewhere ? <HostBootResult view={boot} onDismiss={() => {
      // The notice and its focused button go away, so focus goes to the row's More button.
      rowRef.current?.querySelector<HTMLElement>('[aria-haspopup="menu"]')?.focus()
      void onCommand({ type: 'host-boot', id: host.id, action: 'dismiss' })
    }} /> : null}
    {shown && bridge ? <HostProviders host={host} providers={shown} bridge={bridge} job={job} choice={choice} updates={client?.clientUpdates} run={client?.clientUpdateRun} /> : null}
  </section>
}

function RenameDialog({ host, onRename, onClose }: { readonly host: HostStatus; readonly onRename: (name: string) => Promise<LaterWords | null>; readonly onClose: () => void }): ReactNode {
  const { t } = useLingui()
  const current = host.name
  const [name, setName] = useState(host.name)
  const [error, setError] = useState<LaterWords | null>(null)
  const [saving, setSaving] = useState(false)
  const inputId = useId()
  const hintId = useId()
  const save = async (): Promise<void> => {
    if (!name.trim() || saving) return
    setSaving(true)
    const failure = await onRename(name.trim())
    setSaving(false)
    if (failure === null) onClose(); else setError(failure)
  }
  return <HostsModal title={t`Rename ${current}`} onClose={onClose} busy={saving}
    footer={<><Button variant="secondary" onClick={onClose}>{t`Cancel`}</Button><Button disabled={!name.trim() || saving} onClick={() => void save()}>{t`Save name`}</Button></>}>
    <div className="hosts-dialog__fields"><div className="tt-field">
      <label className="tt-field__label" htmlFor={inputId}>{t`Host name`}</label>
      <input id={inputId} className="tt-input tt-focusable" value={name} maxLength={80} aria-describedby={hintId} onChange={event => setName(event.target.value)}
        onKeyDown={event => { if (isCompositionKey(event.nativeEvent)) { event.stopPropagation(); return } if (event.key === 'Enter') { event.preventDefault(); void save() } }} />
      <p className="tt-field__description tt-paragraph" id={hintId}><Trans>Shown on this row and beside the host's projects and threads. How Sotto connects to it does not change.</Trans></p>
    </div></div>
    {error ? <div className="hosts-notice hosts-notice--error" role="alert"><p className={typeof error === 'string' ? undefined : 'tt-paragraph'}>{shownWords(error)}</p></div> : null}
  </HostsModal>
}

/** What a Forget notice says happened, by its cause, and what the owner runs on the host to finish the job. */
function forgottenSentence({ name, revoke }: HostForgotten): string {
  if (!revoke) return i18n._(msg`Sotto removed ${name} from this computer but could not remove its start at boot unit there, so its host still starts when ${name} restarts. To remove the unit, run this on ${name}:`)
  const { cause } = revoke
  if (cause === 'refused') return i18n._(msg`The host on ${name} did not revoke this computer’s access, so Sotto removed ${name} from this computer and left its host running. ${name} still trusts this computer until it is removed there. To remove it, run this on ${name}:`)
  if (cause === 'not-running') return i18n._(msg`The host on ${name} was not running, so Sotto removed ${name} from this computer without revoking this computer’s access there. ${name} still trusts this computer until it is removed there. To remove it, start the host on ${name}, then run this there:`)
  return i18n._(msg`SSH could not reach ${name}, so Sotto removed it from this computer without revoking this computer’s access there. ${name} still trusts this computer until it is removed there. To remove it, run this on ${name} while its host is running:`)
}

/** One command of a Forget notice, with Copy. When it cannot be copied, it is selected for the keyboard's copy shortcut. */
function ForgottenCommand({ command, label, copyLabel, children }: { readonly command: string; readonly label: string; readonly copyLabel: string; readonly children?: ReactNode }): ReactNode {
  const { t } = useLingui()
  const [copied, showCopied] = useTransientFlag()
  const [failed, setFailed] = useState(false)
  const commandRef = useRef<HTMLElement>(null)
  /** Selects the whole command, so the keyboard's copy shortcut takes exactly that line. */
  const select = (): void => { const element = commandRef.current; if (element) window.getSelection()?.selectAllChildren(element) }
  const copy = async (): Promise<void> => {
    try { await writeClipboard(command); setFailed(false); showCopied('copied') }
    catch { setFailed(true); commandRef.current?.focus(); select() }
  }
  return <>
    <code ref={commandRef} className="hosts-forgotten__command tt-focusable" role="region" aria-label={label} tabIndex={0} onFocus={select}>{command}</code>
    <span className="hosts-forgotten__actions">
      <Button variant="secondary" aria-label={copyLabel} onClick={() => void copy()}>{copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}{copied ? t`Copied` : t`Copy command`}</Button>
      {children}
      {failed ? <span className="hosts-forgotten__failed" role="alert"><Trans>The command could not be copied. It is selected above: copy it with your keyboard’s copy shortcut.</Trans></span> : null}
    </span>
  </>
}

/**
 * A Forget notice (ADR-0053, ADR-0054): Forget removed a host here without finishing there. When it did not revoke this
 * computer, the host still trusts this computer, and the notice gives the one line that removes it there; when it could
 * not remove the host's start at boot unit, it says so with the line that does. Sotto never runs either. It stays until
 * dismissed.
 */
function ForgottenNotice({ forgotten, onDismiss }: { readonly forgotten: HostForgotten; readonly onDismiss: () => void }): ReactNode {
  const { t } = useLingui()
  const { name, bootCommand } = forgotten, command = forgotten.revoke?.command
  const dismiss = <Button variant="ghost" aria-label={t`Dismiss what Sotto said about ${name}`} onClick={onDismiss}>{t`Dismiss`}</Button>
  return <section className="hosts-notice hosts-notice--error hosts-forgotten" role="status" aria-label={command ? t`${name} still trusts this computer` : t`${name} still starts at boot`}>
    <AlertTriangle size={16} aria-hidden="true" />
    <div className="hosts-forgotten__copy">
      <p className="tt-paragraph">{forgottenSentence(forgotten)}</p>
      {command ? <ForgottenCommand command={command} label={t`Command to run on ${name}`} copyLabel={t`Copy the command to run on ${name}`}>{bootCommand ? null : dismiss}</ForgottenCommand> : null}
      {command && bootCommand ? <p className="tt-paragraph"><Trans>{name}’s host also still starts when {name} restarts, since Sotto could not remove its start at boot unit there. To remove the unit, run this on {name} afterwards:</Trans></p> : null}
      {bootCommand ? <ForgottenCommand command={bootCommand} label={t`Command that removes start at boot on ${name}`} copyLabel={t`Copy the command that removes start at boot on ${name}`}>{dismiss}</ForgottenCommand> : null}
    </div>
  </section>
}

/** A host setup running without its dialog, or ended and not yet put away (ADR-0035). */
function HostSetupLine({ setup, onShow, onDismiss }: { readonly setup: HostSetupState; readonly onShow: () => void; readonly onDismiss: () => void }): ReactNode {
  const { t } = useLingui()
  const running = setup.phase === 'starting' || setup.phase === 'running'
  const { name, modelName: model, threadTitle: thread } = setup
  const waiting = setup.waiting === 'connection'
    ? setup.attempt?.prompt ? t`SSH is waiting for your answer before it connects to ${name}. Show setup to answer it.` : t`Tailscale is waiting for you to approve the connection to ${name}. Show setup to approve it.`
    : setup.waiting ? t`It is waiting for your answer there.` : ''
  // The setup's own sentence from main, when it ended with one.
  return <div className="hosts-setup-line" role="status" data-phase={setup.phase}>
    <p className="tt-paragraph">{running ? <><Trans><b>{model}</b> is setting up {name} in the thread <b>{thread}</b>.</Trans>{waiting ? <> {waiting}</> : null}</>
      : setup.phase === 'connected' ? <Trans>{name} is set up and connected. <b>{model}</b> set it up in the thread <b>{thread}</b>.</Trans>
        : setup.phase === 'stopped' ? <><Trans>The setup of {name} stopped.</Trans> {setup.error ?? t`Nothing was saved as a host.`}</>
          : <>{setup.error ?? t`The setup of ${name} could not carry on. Nothing was saved as a host.`}</>}</p>
    <Button variant="secondary" aria-label={t`Show setup of ${name}`} onClick={onShow}>{t`Show setup`}</Button>
    {running ? null : <Button variant="ghost" aria-label={t`Dismiss setup of ${name}`} onClick={onDismiss}>{t`Dismiss`}</Button>}
  </div>
}

export function HostsSettings({ localHostEnabled, onLocalHostChange, bridge = window.sotto?.hosts }: {
  localHostEnabled: boolean; onLocalHostChange: (enabled: boolean) => Promise<boolean>; bridge?: HostsBridge | undefined
}): ReactNode {
  const { t } = useLingui()
  const [state, setState] = useState<HostsState | null>(null)
  const [error, setError] = useState<LaterWords | null>(null)
  const [localSaveFailed, setLocalSaveFailed] = useState(false)
  const [dialog, setDialog] = useState<HostDialogMode | null>(null)
  const [renameId, setRenameId] = useState<string | null>(null)
  const [forgetId, setForgetId] = useState<string | null>(null)
  const [stopId, setStopId] = useState<string | null>(null)
  const [phonesId, setPhonesId] = useState<string | null>(null)
  const [bootId, setBootId] = useState<string | null>(null)
  // Which change the modal is for is fixed when it opens: the change itself flips what the menu offers.
  const [bootChange, setBootChange] = useState<'install' | 'remove'>('install')
  const addButton = useRef<HTMLButtonElement>(null)
  const tailscale = useTailscale(bridge)
  // Each connected host's providers, as that host publishes them (ADR-0037).
  const clientHosts = useOptionalAgents()?.state?.host.clientHosts
  useEffect(() => {
    if (!bridge) return
    let alive = true
    void bridge.get().then(value => { if (alive) setState(value) }).catch(() => { if (alive) setError(msg`Hosts could not be read. Reopen Settings and try again.`) })
    const off = bridge.onChanged(value => { if (alive) setState(value) })
    return () => { alive = false; off() }
  }, [bridge])
  const run = async (command: HostsCommand): Promise<boolean> => {
    if (!bridge) return false
    setError(null)
    try { setState(await bridge.command(command)); return true }
    catch (failure) { setError(failure instanceof Error ? failure.message : msg`The host could not be updated. Nothing was changed. Try again.`); return false }
  }
  const forget = state?.hosts.find(host => host.id === forgetId)
  const stopping = state?.hosts.find(host => host.id === stopId)
  const forgetName = forget?.name, stoppingName = stopping?.name
  const renaming = state?.hosts.find(host => host.id === renameId)
  const phonesHost = state?.hosts.find(host => host.id === phonesId)
  const bootHost = state?.hosts.find(host => host.id === bootId)
  const closeBoot = useRef(() => setBootId(null)).current
  // The start at boot modal's presses show what they changed at once, before main's next broadcast.
  const bootBridge = useMemo<HostsBridge | undefined>(() => bridge && { ...bridge, command: async command => { const next = await bridge.command(command); setState(next); return next } }, [bridge])
  const closePhones = useRef(() => setPhonesId(null)).current
  const { resumeQuestion } = useHostQuestionDismissals(bridge)
  const forgetDescription = (host: HostStatus): string => {
    const name = host.name
    if (!reachable(host)) {
      return t`Sotto signs in to ${name} over SSH to revoke this computer's access there, stops the host if Sotto started it, and removes the saved connection. If its host starts at boot, Sotto removes that too, so it does not start again when ${name} restarts. If ${name} can't be reached, it is still removed here, and Sotto shows the command that revokes this computer there. Threads stay on the host.`
    }
    // Forget takes a boot unit away too, so a forgotten host does not start again at the next boot (ADR-0054).
    const boot = host.bootStart?.installed === true
    if (host.owned) return boot
      ? t`This revokes this computer's access on the host and removes the saved connection. It also stops the host Sotto started there. It removes start at boot from ${name}, so its host does not start again when ${name} restarts. Threads stay on the host.`
      : t`This revokes this computer's access on the host and removes the saved connection. It also stops the host Sotto started there. Threads stay on the host.`
    return boot
      ? t`This revokes this computer's access on the host and removes the saved connection. It removes start at boot from ${name}, so its host does not start again when ${name} restarts. Threads stay on the host.`
      : t`This revokes this computer's access on the host and removes the saved connection. Threads stay on the host.`
  }
  /**
   * Forget's own sign-in, while it waits for the user (ADR-0053): Tailscale SSH holding it for approval, or SSH's question,
   * which is asked over this dialog and comes back with Answer if it was put away. Keep host stops the sign-in.
   */
  const forgetWaiting = (host: HostStatus): ReactNode => {
    if (!host.adminSignIn) return undefined
    const questionKey = hostQuestionKey(host)
    const name = host.name
    if (host.prompt && questionKey) return <span className="hosts-forget-wait">{t`SSH is waiting for your answer.`}
      <Button variant="secondary" aria-label={t`Answer SSH's question for ${name}`} onClick={() => resumeQuestion(questionKey)}>{t({ message: 'Answer', comment: 'Opens the question a host is waiting on, so the user can answer it.' })}</Button></span>
    if (!host.tailscale?.waiting) return undefined
    return <span className="hosts-forget-wait">{t`Waiting for your approval in Tailscale.`}{host.tailscale.url
      ? <Button variant="secondary" aria-label={t`Open the Tailscale approval page for ${name}`} onClick={() => void run({ type: 'open-approval', id: host.id })}>{t`Open approval page`}</Button> : null}</span>
  }
  const act = (host: HostStatus, action: MenuAction): void => {
    if (action === 'boot') { setBootChange(bootStartOn(host) ? 'remove' : 'install'); setBootId(host.id) }
    else if (action === 'stop') setStopId(host.id)
    else if (action === 'rename') setRenameId(host.id)
    else if (action === 'edit') setDialog({ kind: 'edit', host })
    else setForgetId(host.id)
  }
  const closeDialog = useRef(() => setDialog(null)).current
  // Each group of rows is a card, as on every other Settings page (ADR-0110, #1831): this computer and Tailscale on one,
  // the remote hosts on another.
  return <div className="hosts-settings">
    <div className="hosts-card">
    <div className="hosts-local">
      <span className="hosts-row__icon hosts-row__icon--local" aria-hidden="true"><Laptop size={18} /></span>
      <div className="hosts-local__copy"><h3>{t`This computer`}</h3><p className="tt-paragraph"><Trans>Runs threads here as well as on remote hosts. Changes apply after a restart, and saved data stays.</Trans></p></div>
      <div>
        <Toggle setting="local-host" label={t`Run the local host`} checked={localHostEnabled} onCheckedChange={enabled => { void onLocalHostChange(enabled).then(saved => setLocalSaveFailed(!saved)) }} />
        {localSaveFailed ? <p className="tt-field__error tt-paragraph" role="alert"><Trans>The local host setting could not be saved. Nothing was changed. Try again.</Trans></p> : null}
      </div>
    </div>
    {bridge ? <TailscaleRow control={tailscale} /> : null}
    {state && state.localHostRunning !== localHostEnabled && <div className="hosts-restart"><p className="tt-paragraph"><Trans>Restart Sotto to apply the local host setting.</Trans></p><Button variant="secondary" onClick={() => void run({ type: 'restart' })}>{t`Restart Sotto`}</Button></div>}
    </div>
    <p className="hosts-card__note tt-paragraph"><Trans>Dictation and paste always happen on this computer, never on a remote host.</Trans></p>
    <div className="hosts-heading"><h3>{t`Remote hosts`}</h3><Button ref={addButton} variant="secondary" data-setting="remote-hosts" disabled={!bridge} onClick={() => setDialog({ kind: 'add' })}><Plus size={16} aria-hidden="true" />{t`Add host`}</Button></div>
    <p className="tt-paragraph"><Trans>Run threads on other machines over your tailnet or SSH. Sotto sets each one up with your SSH access, and a host it starts keeps running until you stop it.</Trans></p>
    {/* A setup the dialog was closed on carries on in its thread, and one that ended stays until put away: this is the way back to it. */}
    {state?.setup && !dialog ? <HostSetupLine setup={state.setup} onShow={() => setDialog({ kind: 'setup' })} onDismiss={() => void run({ type: 'dismiss-setup', id: state.setup!.id })} /> : null}
    {state?.forgotten?.map(forgotten => <ForgottenNotice key={forgotten.id} forgotten={forgotten}
      // The notice and its focused button go away, so focus goes to the control above the list.
      onDismiss={() => { addButton.current?.focus(); void run({ type: 'dismiss-forgotten', id: forgotten.id }) }} />)}
    <div className="hosts-list hosts-card">
      {state?.hosts.map(host => <HostRow key={host.id} host={host} onCommand={run} onAction={act} bridge={bridge} job={state.providerJob} choice={state.setupChoice}
        phones={state.phones?.find(item => item.id === host.id)} onOpenPhones={() => setPhonesId(host.id)} boot={state.boot?.find(item => item.id === host.id)}
        bootShownElsewhere={bootId === host.id || dialog?.kind === 'add'}
        providers={host.hostId ? clientHosts?.find(item => item.hostId === host.hostId)?.providers : undefined}
        client={host.hostId ? clientHosts?.find(item => item.hostId === host.hostId) : undefined} />)}
      {state && !state.hosts.length ? <p className="hosts-empty tt-paragraph"><Trans>No remote hosts yet.</Trans></p> : null}
    </div>
    {error && <p className={typeof error === 'string' ? 'hosts-error' : 'hosts-error tt-paragraph'} role="alert">{shownWords(error)}</p>}
    {dialog && bridge ? <HostDialog key={dialog.kind === 'edit' ? dialog.host.id : dialog.kind} mode={dialog} bridge={bridge} state={state} tailscale={tailscale} onClose={closeDialog} /> : null}
    {bootHost && bootBridge ? <HostBootDialog host={bootHost} view={state?.boot?.find(item => item.id === bootHost.id)} change={bootChange} bridge={bootBridge} onClose={closeBoot} /> : null}
    {phonesHost && bridge ? <HostPhonesDialog host={phonesHost} view={state?.phones?.find(item => item.id === phonesHost.id)} bridge={bridge} onClose={closePhones} /> : null}
    {renaming ? <RenameDialog host={renaming} onClose={() => setRenameId(null)} onRename={async name => {
      if (!bridge) return msg`Hosts are not available in this window.`
      try { setState(await bridge.command({ type: 'rename', id: renaming.id, name })); return null }
      catch (failure) { return failure instanceof Error ? failure.message : msg`The name could not be saved. Try again.` }
    }} /> : null}
    {forget && <ConfirmationDialog title={t`Forget ${forgetName}?`} confirmLabel={t`Forget host`} cancelLabel={t`Keep host`} onCancel={() => setForgetId(null)} onConfirm={() => run({ type: 'forget', id: forget.id })}
      fallbackFocusRef={addButton} failureMessage={shownWords(error)} description={forgetDescription(forget)} pendingStatus={forgetWaiting(forget)}
      // While Forget signs in, nothing has been sent: Keep host stops the sign-in, and Forget changes nothing.
      onCancelPending={forget.adminSignIn ? () => void run({ type: 'stop-admin-sign-in', id: forget.id }) : undefined} />}
    {stopping && <ConfirmationDialog title={t`Stop the host on ${stoppingName}?`} confirmLabel={t`Stop host`} cancelLabel={t`Keep it running`} onCancel={() => setStopId(null)}
      failureMessage={shownWords(error)} onConfirm={() => run({ type: 'stop-host', id: stopping.id })}
      description={bootStartOn(stopping)
        // A host that starts at boot comes back with its machine, whatever this computer's switch says (ADR-0054).
        ? t`${stoppingName}’s host stops now and starts again when ${stoppingName} restarts or when you switch it on. Turns running there are interrupted; threads and history stay in its data folder.`
        : t`This stops the host Sotto started on ${stoppingName} and switches it off. Turns running there are interrupted; threads and history stay in its data folder. Switch it on to start it again.`} />}
  </div>
}
