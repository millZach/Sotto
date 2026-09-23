import React, { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { LoaderCircle } from 'lucide-react'
import { DEFAULT_HOST_DATA_DIRECTORY, DEFAULT_HOST_INSTALL_PATH, type HostsBridge, type HostsState, type HostStatus, type RemoteHost, type SshHostSuggestion } from '../../../../shared/hosts'
import { Button } from '../../components/Button'

/**
 * A modal for Settings > Hosts: focus starts inside it, Tab stays inside it, Escape answers it (after
 * anything open inside has answered first) and focus goes back to what opened it.
 */
export function HostsModal({ title, onClose, busy = false, children, footer, className = '' }: {
  readonly title: string; readonly onClose: () => void; readonly busy?: boolean
  readonly children: ReactNode; readonly footer: ReactNode; readonly className?: string
}): ReactNode {
  const dialog = useRef<HTMLElement>(null)
  const titleId = useId()
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.current?.querySelector<HTMLElement>('input:not(:disabled), button:not(:disabled)')?.focus()
    // Escape is heard on the document, so it still answers while focus sits on a control that just turned off.
    // Anything open inside the dialog (the suggestions list) answers it first and stops it there.
    const onEscape = (event: globalThis.KeyboardEvent): void => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); close.current() } }
    document.addEventListener('keydown', onEscape)
    return () => { document.removeEventListener('keydown', onEscape); queueMicrotask(() => { if (opener?.isConnected) opener.focus() }) }
  }, [])
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Tab') return
    const focusable = [...dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), summary, [tabindex]:not([tabindex="-1"])') ?? []]
    const first = focusable[0], last = focusable.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
  return <div className="tt-dialog-backdrop" role="presentation">
    <section ref={dialog} className={`tt-dialog hosts-dialog ${className}`.trim()} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy || undefined} onKeyDown={onKeyDown}>
      <h2 id={titleId}>{title}</h2>
      {children}
      <div className="tt-dialog__actions">{footer}</div>
    </section>
  </div>
}

/** The host part of an SSH target: `forge` in `zach@forge`. */
export const targetHost = (target: string): string => target.slice(target.lastIndexOf('@') + 1)
/** The user part of an SSH target, or '' when the SSH configuration decides. */
const targetUser = (target: string): string => target.includes('@') ? target.slice(0, target.lastIndexOf('@')) : ''

/**
 * "SSH host or alias": a combobox over the hosts this computer's SSH setup already knows. Arrow keys move
 * through the list, Enter takes the highlighted host (or, with none highlighted, adds what was typed), and
 * Escape closes the list before it closes the dialog.
 */
function HostCombobox({ value, onChange, suggestions, offer, disabled, onPick, onSubmit, describedBy }: {
  readonly value: string; readonly onChange: (value: string) => void; readonly suggestions: readonly SshHostSuggestion[]
  /** False in Edit connection, which changes a saved route rather than choosing a new one: no list opens. */
  readonly offer: boolean
  readonly disabled: boolean; readonly onPick: (suggestion: SshHostSuggestion) => void; readonly onSubmit: () => void
  readonly describedBy: string
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const listId = useId()
  const inputId = useId()
  const query = value.trim().toLowerCase()
  const matches = useMemo(() => suggestions.filter(item => item.alias.toLowerCase().includes(query) || (item.detail ?? '').toLowerCase().includes(query)), [suggestions, query])
  const shown = offer && open && !disabled && (matches.length > 0 || query !== '')
  const optionId = (index: number): string => `${listId}-option-${index}`
  const pick = (suggestion: SshHostSuggestion): void => { onPick(suggestion); setOpen(false); setActive(-1) }
  return <div className="hosts-combo">
    <label className="tt-field__label" htmlFor={inputId}>SSH host or alias</label>
    <input id={inputId} className="tt-input tt-focusable" role="combobox" aria-expanded={shown} aria-controls={listId} aria-autocomplete="list"
      aria-activedescendant={shown && active >= 0 ? optionId(active) : undefined} aria-describedby={describedBy}
      autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={256} disabled={disabled}
      placeholder="Search your SSH hosts or type user@server" value={value}
      onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onBlur={() => { setOpen(false); setActive(-1) }}
      onChange={event => { onChange(event.target.value); setOpen(true); setActive(-1) }}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); setOpen(true)
          if (!matches.length) return
          setActive(current => event.key === 'ArrowDown' ? Math.min(matches.length - 1, current + 1) : Math.max(-1, current - 1))
        } else if (event.key === 'Enter') {
          event.preventDefault()
          if (shown && active >= 0 && matches[active]) pick(matches[active]!)
          else { setOpen(false); onSubmit() }
        } else if (event.key === 'Escape' && shown) {
          // The list answers Escape first; the dialog only closes on the next one.
          event.preventDefault(); event.stopPropagation(); setOpen(false); setActive(-1)
        }
      }} />
    <ul className="hosts-combo__list" id={listId} role="listbox" aria-label="SSH hosts" hidden={!shown}>
      {matches.map((item, index) => <li key={item.alias} id={optionId(index)} role="option" aria-selected={index === active}
        onMouseDown={event => { event.preventDefault(); pick(item) }} onMouseEnter={() => setActive(index)}>
        <b>{item.alias}</b>{item.detail && item.detail !== item.alias ? <small>{item.detail}</small> : null}
        <span className="hosts-combo__source">{item.source === 'config' ? 'SSH configuration' : 'Known hosts'}</span>
      </li>)}
      {!matches.length && query ? <li role="option" aria-selected={false} aria-disabled="true" className="hosts-combo__empty"><small>No saved SSH hosts match "{value.trim()}". Press Enter to use it as typed.</small></li> : null}
    </ul>
  </div>
}

/** What the dialog is for: adding a new host, or changing a saved host's connection. */
export type HostDialogMode = { readonly kind: 'add' } | { readonly kind: 'edit'; readonly host: HostStatus }

/**
 * Add host and Edit connection. Add host connects from inside the dialog and saves the host only once it
 * answers and pairs: the dialog shows that it is connecting, asks SSH's questions itself, and says what
 * happened when it fails. Edit connection saves the new route; a host that is on connects again with it.
 */
export function HostDialog({ mode, bridge, state, onClose }: {
  readonly mode: HostDialogMode; readonly bridge: HostsBridge; readonly state: HostsState | null; readonly onClose: () => void
}): ReactNode {
  const editing = mode.kind === 'edit' ? mode.host : undefined
  const [host, setHost] = useState(editing ? targetHost(editing.target) : '')
  const [user, setUser] = useState(editing ? targetUser(editing.target) : '')
  const [port, setPort] = useState(editing?.sshPort ? String(editing.sshPort) : '')
  const [installPath, setInstallPath] = useState(editing?.installPath ?? DEFAULT_HOST_INSTALL_PATH)
  const [dataDirectory, setDataDirectory] = useState(editing?.dataDirectory ?? DEFAULT_HOST_DATA_DIRECTORY)
  const [identityFile, setIdentityFile] = useState(editing?.identityFile ?? '')
  const [suggestions, setSuggestions] = useState<SshHostSuggestion[]>([])
  const [attempt, setAttempt] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [answer, setAnswer] = useState('')
  const [answering, setAnswering] = useState(false)
  const addButton = useRef<HTMLButtonElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const hintId = useId()
  const userId = useId(), portId = useId(), installId = useId(), dataId = useId(), dataHintId = useId(), identityId = useId(), answerId = useId()
  // The add this dialog started, as main reports it; it leaves `adding` for `hosts` once the host is saved.
  const adding = attempt !== null && state?.adding?.id === attempt ? state.adding : undefined
  const added = attempt !== null && state?.hosts.some(item => item.id === attempt) === true
  const connecting = sending || adding?.phase === 'connecting'
  const prompt = adding?.prompt
  const shownError = error ?? (adding?.phase === 'error' ? adding.error ?? null : null)
  useEffect(() => {
    if (editing) return
    let alive = true
    void bridge.sshSuggestions().then(found => { if (alive) setSuggestions(found) }, () => undefined)
    return () => { alive = false }
  }, [bridge, editing])
  useEffect(() => { if (added) closeRef.current() }, [added])
  useEffect(() => { setAnswer('') }, [prompt?.id])
  const saved = new Set(state?.hosts.map(item => targetHost(item.target).toLowerCase()) ?? [])
  const offered = suggestions.filter(item => !saved.has(item.alias.toLowerCase()))
  const close = (): void => {
    // A failed or unfinished add is dropped with the dialog: main keeps nothing for it.
    if (attempt !== null && !added) void bridge.command({ type: 'cancel-add', id: attempt }).catch(() => undefined)
    onClose()
  }
  const connection = (): Omit<RemoteHost, 'enabled' | 'id' | 'name'> | string => {
    const name = host.trim()
    if (!name) return 'Enter an SSH host or alias, such as forge or user@server.'
    const portText = port.trim()
    const portNumber = portText === '' ? undefined : Number(portText)
    if (portNumber !== undefined && (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535)) return 'Enter a port between 1 and 65535, or leave Port empty to use your SSH configuration.'
    // A username typed here wins over one typed in front of the host.
    const target = user.trim() ? `${user.trim()}@${targetHost(name)}` : name
    return { target, installPath: installPath.trim(), dataDirectory: dataDirectory.trim(), identityFile: identityFile.trim(), ...(portNumber !== undefined ? { sshPort: portNumber } : {}) }
  }
  const submit = async (): Promise<void> => {
    if (connecting) return
    const route = connection()
    if (typeof route === 'string') { setError(route); return }
    setError(null)
    if (editing) {
      setSending(true)
      try { await bridge.command({ type: 'save', host: { id: editing.id, name: editing.name, ...route } }); onClose() }
      catch (failure) { setError(failure instanceof Error ? failure.message : 'The connection could not be saved. Nothing was changed. Try again.') }
      finally { setSending(false) }
      return
    }
    const id = crypto.randomUUID()
    setAttempt(id); setSending(true)
    try { await bridge.command({ type: 'add', host: { id, name: targetHost(route.target), ...route } }) }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'The host could not be added. Nothing was saved. Try again.') }
    finally { setSending(false) }
  }
  const answerPrompt = async (): Promise<void> => {
    if (!prompt || attempt === null || answering) return
    setAnswering(true)
    try { await bridge.command({ type: 'ssh-answer', id: attempt, promptId: prompt.id, answer: prompt.kind === 'host-key' ? 'yes' : answer }) }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'SSH did not take the answer. Cancel and add the host again.') }
    finally { setAnswer(''); setAnswering(false) }
  }
  const fieldsDisabled = connecting
  // Add host turns off while it connects; focus moves to Cancel rather than being dropped.
  useEffect(() => {
    const focused = document.activeElement
    if (connecting && (focused === null || focused === document.body || (focused instanceof HTMLButtonElement || focused instanceof HTMLInputElement) && focused.disabled)) cancelButton.current?.focus()
  }, [connecting])
  return <HostsModal title={editing ? `Edit connection to ${editing.name}` : 'Add host'} onClose={close} busy={connecting} className="hosts-dialog--connection"
    footer={<>
      <Button ref={cancelButton} variant="secondary" onClick={close}>Cancel</Button>
      <Button ref={addButton} disabled={connecting || prompt !== undefined} onClick={() => void submit()}>
        {editing ? (sending ? 'Saving…' : 'Save connection') : connecting ? 'Connecting…' : 'Add host'}</Button>
    </>}>
    <p className="hosts-dialog__intro">{editing ? 'The new connection is used the next time Sotto connects. A host that is on connects again now.' : 'Sotto connects as soon as you add it.'}</p>
    <form className="hosts-dialog__fields" onSubmit={event => { event.preventDefault(); void submit() }}
      onKeyDown={event => { const target = event.target as HTMLElement; if (event.key === 'Enter' && target instanceof HTMLInputElement && target.getAttribute('role') !== 'combobox') { event.preventDefault(); void submit() } }}>
      <div className="tt-field">
        <HostCombobox value={host} onChange={setHost} suggestions={offered} offer={!editing} disabled={fieldsDisabled} describedBy={hintId}
          onPick={item => { setHost(item.alias); if (item.port) setPort(String(item.port)); addButton.current?.focus() }} onSubmit={() => void submit()} />
        <p className="tt-field__description" id={hintId}>{editing ? 'An alias from your SSH configuration, or a host name.' : 'Suggestions come from your SSH configuration and known hosts.'}</p>
      </div>
      <div className="hosts-dialog__pair">
        <div className="tt-field"><label className="tt-field__label" htmlFor={userId}>Username <span className="hosts-dialog__optional">(optional)</span></label>
          <input id={userId} className="tt-input tt-focusable" value={user} disabled={fieldsDisabled} autoCapitalize="none" spellCheck={false} maxLength={64} placeholder="From your SSH configuration" onChange={event => setUser(event.target.value)} /></div>
        <div className="tt-field"><label className="tt-field__label" htmlFor={portId}>Port <span className="hosts-dialog__optional">(optional)</span></label>
          <input id={portId} className="tt-input tt-focusable" value={port} disabled={fieldsDisabled} inputMode="numeric" maxLength={5} placeholder="22" onChange={event => setPort(event.target.value)} /></div>
      </div>
      <details className="hosts-dialog__advanced">
        <summary className="tt-focusable">Folders on the host</summary>
        <div className="tt-field"><label className="tt-field__label" htmlFor={installId}>Host installation folder</label>
          <input id={installId} className="tt-input tt-focusable" value={installPath} disabled={fieldsDisabled} autoCapitalize="none" spellCheck={false} onChange={event => setInstallPath(event.target.value)} /></div>
        <div className="tt-field"><label className="tt-field__label" htmlFor={dataId}>Host data folder</label>
          <input id={dataId} className="tt-input tt-focusable" value={dataDirectory} disabled={fieldsDisabled} autoCapitalize="none" spellCheck={false} aria-describedby={dataHintId} onChange={event => setDataDirectory(event.target.value)} />
          <p className="tt-field__description" id={dataHintId}>Threads, pairing and settings for this host live here.</p></div>
        {/* An identity file is now read from the SSH configuration; one saved by an earlier Sotto can still be changed or cleared. */}
        {editing?.identityFile ? <div className="tt-field"><label className="tt-field__label" htmlFor={identityId}>SSH identity file</label>
          <input id={identityId} className="tt-input tt-focusable" value={identityFile} disabled={fieldsDisabled} autoCapitalize="none" spellCheck={false} placeholder="From your SSH configuration" onChange={event => setIdentityFile(event.target.value)} /></div> : null}
      </details>
      {editing?.clientId ? <p className="hosts-dialog__client">This computer's client ID on {editing.name}: <code>{editing.clientId}</code></p> : null}
    </form>
    {connecting && !prompt ? <div className="hosts-notice hosts-notice--work" role="status"><LoaderCircle size={16} aria-hidden="true" className="hosts-spin" />
      <p>{editing ? 'Saving the connection.' : `Connecting to ${targetHost(host.trim())}. Sotto signs in over SSH, starts the host if it is not running, and pairs this computer.`}</p></div> : null}
    {prompt ? <div className="hosts-notice hosts-prompt" role="group" aria-label={prompt.kind === 'host-key' ? 'Trust this SSH host?' : 'SSH needs an answer'}>
      <p className="hosts-prompt__lead">{prompt.kind === 'host-key' ? 'SSH has not seen this host before. Check its key, then trust it to continue.' : prompt.kind === 'passphrase' ? 'SSH needs your key passphrase to sign in.' : 'SSH needs your password to sign in.'}</p>
      <pre className="hosts-challenge">{prompt.text}</pre>
      {prompt.kind !== 'host-key' ? <div className="tt-field"><label className="tt-field__label" htmlFor={answerId}>{prompt.kind === 'passphrase' ? 'Key passphrase' : 'SSH password'}</label>
        <input id={answerId} className="tt-input tt-focusable" type="password" autoComplete="off" autoFocus value={answer} onChange={event => setAnswer(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void answerPrompt() } }} /></div> : null}
      <div className="hosts-prompt__actions"><Button autoFocus={prompt.kind === 'host-key'} disabled={answering} onClick={() => void answerPrompt()}>{prompt.kind === 'host-key' ? 'Trust host and continue' : 'Continue'}</Button></div>
    </div> : null}
    {shownError && !connecting ? <div className="hosts-notice hosts-notice--error" role="alert"><p>{shownError}</p></div> : null}
  </HostsModal>
}
