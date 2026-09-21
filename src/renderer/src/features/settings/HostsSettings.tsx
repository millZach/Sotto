import React, { useEffect, useState, type ReactNode } from 'react'
import { Server } from 'lucide-react'
import { type HostsBridge, type HostsCommand, type HostsState, type RemoteHost } from '../../../../shared/hosts'
import { Button } from '../../components/Button'
import { Field } from '../../components/Field'
import { Toggle } from '../../components/Toggle'
import { ConfirmationDialog } from '../../components/ConfirmationDialog'
import './hosts.css'

export function HostsSettings({ localHostEnabled, onLocalHostChange, bridge = window.sotto?.hosts }: {
  localHostEnabled: boolean; onLocalHostChange: (enabled: boolean) => Promise<boolean>; bridge?: HostsBridge | undefined
}): ReactNode {
  const [state, setState] = useState<HostsState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<RemoteHost | null>(null)
  const [pairId, setPairId] = useState<string | null>(null)
  const [forgetId, setForgetId] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [answer, setAnswer] = useState('')
  useEffect(() => {
    if (!bridge) return
    let alive = true
    void bridge.get().then(value => { if (alive) setState(value) }).catch(() => { if (alive) setError('Hosts could not be read. Reopen Settings and try again.') })
    const off = bridge.onChanged(value => { if (alive) setState(value) })
    return () => { alive = false; off() }
  }, [bridge])
  const promptHost = state?.hosts.find(host => host.prompt)
  useEffect(() => { setAnswer('') }, [promptHost?.prompt?.id])
  const run = async (command: HostsCommand): Promise<boolean> => {
    if (!bridge) return false
    setError(null)
    try { setState(await bridge.command(command)); return true }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'The host could not be updated. Try again.'); return false }
  }
  const pair = state?.hosts.find(host => host.id === pairId)
  const forget = state?.hosts.find(host => host.id === forgetId)
  return <div className="hosts-settings">
    <div className="hosts-local"><div><h3>This computer</h3><p>Run local threads alongside your remote hosts. Changing this restarts Sotto and keeps saved data.</p></div>
      {state?.localHostId && <Button variant="secondary" disabled={state.activeHostId === state.localHostId} onClick={() => void run({ type: 'select', hostId: state.localHostId! })}>{state.activeHostId === state.localHostId ? 'Selected host' : 'Use this computer'}</Button>}
      <Toggle label="Run the local host" checked={localHostEnabled} onCheckedChange={enabled => { void onLocalHostChange(enabled) }} />
    </div>
    {state && state.localHostRunning !== localHostEnabled && <div className="hosts-restart"><p>Restart Sotto to apply the local host setting.</p><Button variant="secondary" onClick={() => void run({ type: 'restart' })}>Restart Sotto</Button></div>}
    <p>Dictation and automatic paste use this computer. They do not paste into a remote host.</p>
    <div className="hosts-heading"><h3>Remote hosts</h3><Button variant="secondary" disabled={!bridge} onClick={() => setDraft({ id: crypto.randomUUID(), name: 'Forge', target: 'zach@forge', installPath: '~/.local/share/sotto-host', dataDirectory: '~/.sotto', identityFile: '' })}>Add host</Button></div>
    {state?.hosts.length === 0 && <p>Connect to a host over SSH to use its threads on this computer.</p>}
    {state?.hosts.map(host => <section className="hosts-row" key={host.id} aria-label={host.name}>
      <Server size={24} aria-hidden="true" /><div className="hosts-row__info"><h4>{host.name}</h4><p>{host.target} · {host.phase === 'pairing' ? 'Pair this laptop' : host.phase === 'connecting' ? 'Connecting…' : host.phase === 'connected' ? 'Connected' : host.phase === 'error' ? 'Needs attention' : 'Disconnected'}</p>
        {host.clientId && <p>Client ID: <code>{host.clientId}</code></p>}
        {host.error && <p role="alert">{host.error}</p>}</div>
      <div className="hosts-row__actions">
        {host.phase === 'connected' && host.hostId && <Button variant="secondary" disabled={state.activeHostId === host.hostId} onClick={() => void run({ type: 'select', hostId: host.hostId! })}>{state.activeHostId === host.hostId ? 'Selected host' : 'Use this host'}</Button>}
        {host.phase === 'pairing' && <Button onClick={() => { setCode(''); setPairId(host.id) }}>Enter pairing code</Button>}
        {host.phase === 'connected' || host.phase === 'connecting' || host.phase === 'pairing'
          ? <Button variant="secondary" onClick={() => void run({ type: 'disconnect', id: host.id })}>Disconnect</Button>
          : <Button onClick={() => void run({ type: 'connect', id: host.id })}>Connect</Button>}
        {host.phase === 'disconnected' || host.phase === 'error' ? <Button variant="ghost" onClick={() => setDraft({ id: host.id, name: host.name, target: host.target, installPath: host.installPath, dataDirectory: host.dataDirectory, identityFile: host.identityFile })}>Edit</Button> : null}
        <Button variant="ghost" onClick={() => setForgetId(host.id)}>Forget</Button>
      </div>
    </section>)}
    {error && <p className="hosts-error" role="alert">{error}</p>}
    {draft && <ConfirmationDialog title={state?.hosts.some(host => host.id === draft.id) ? 'Edit SSH host' : 'Add SSH host'} danger={false} confirmLabel="Save host" cancelLabel="Cancel" onCancel={() => setDraft(null)} failureMessage={error}
      confirmDisabled={!draft.name.trim() || !draft.target.trim() || !draft.installPath.trim() || !draft.dataDirectory.trim()}
      onConfirm={() => run({ type: 'save', host: draft })} description={<div className="hosts-fields">
        <Field label="Host name"><input value={draft.name} maxLength={80} onChange={event => setDraft({ ...draft, name: event.target.value })} /></Field>
        <Field label="SSH target" description="Your SSH host alias or user@host."><input value={draft.target} maxLength={256} autoCapitalize="none" spellCheck={false} onChange={event => setDraft({ ...draft, target: event.target.value })} /></Field>
        <Field label="Host installation folder"><input value={draft.installPath} autoCapitalize="none" spellCheck={false} onChange={event => setDraft({ ...draft, installPath: event.target.value })} /></Field>
        <Field label="Host data folder"><input value={draft.dataDirectory} autoCapitalize="none" spellCheck={false} onChange={event => setDraft({ ...draft, dataDirectory: event.target.value })} /></Field>
        <Field label="SSH identity file" description="Optional. Leave blank to use your SSH configuration."><input value={draft.identityFile} autoCapitalize="none" spellCheck={false} onChange={event => setDraft({ ...draft, identityFile: event.target.value })} /></Field>
      </div>} />}
    {pair && <ConfirmationDialog title={`Pair with ${pair.name}`} danger={false} confirmLabel="Pair this laptop" cancelLabel="Cancel" confirmDisabled={!code.trim()} onCancel={() => { setPairId(null); setCode('') }}
      onConfirm={() => run({ type: 'pair', id: pair.id, code })} failureMessage={error} description={<div className="hosts-fields">
        <p>Read the pairing code on {pair.name} and enter it here.</p>
        <Field label="Pairing code"><input value={code} autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={32} onChange={event => setCode(event.target.value)} /></Field>
        <p>Pairing identifies this client. Permission requests still need your answer, and policy records decide whether this client may grant them.</p>
      </div>} />}
    {forget && <ConfirmationDialog title={`Forget ${forget.name}?`} confirmLabel="Forget host" cancelLabel="Keep host" onCancel={() => setForgetId(null)} onConfirm={() => run({ type: 'forget', id: forget.id })}
      failureMessage={error} description="This revokes this laptop's access and removes its saved connection. Threads stay on the host. A paired host must be connected to revoke access." />}
    {promptHost?.prompt && <ConfirmationDialog title={promptHost.prompt.kind === 'host-key' ? 'Trust this SSH host?' : 'Unlock the SSH connection'} danger={false}
      confirmLabel={promptHost.prompt.kind === 'host-key' ? 'Trust host' : 'Continue'} cancelLabel="Cancel connection" onCancel={() => { setAnswer(''); void run({ type: 'disconnect', id: promptHost.id }) }}
      onConfirm={async () => { await run({ type: 'ssh-answer', id: promptHost.id, promptId: promptHost.prompt!.id, answer: promptHost.prompt!.kind === 'host-key' ? 'yes' : answer }); setAnswer(''); return false }}
      description={<div className="hosts-fields"><pre className="hosts-challenge">{promptHost.prompt.text}</pre>{promptHost.prompt.kind !== 'host-key' && <Field label={promptHost.prompt.kind === 'passphrase' ? 'Key passphrase' : 'SSH password'}><input type="password" autoComplete="off" value={answer} onChange={event => setAnswer(event.target.value)} /></Field>}</div>} />}
  </div>
}
