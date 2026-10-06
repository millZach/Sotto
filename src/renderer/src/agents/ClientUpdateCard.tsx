import React, { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { PROVIDER_LABELS, type ProviderClientUpdate, type ProviderId } from '../../../shared/agents'
import { Button } from '../components/Button'
import { useOptionalAgents } from './AgentContext'
import { ProviderMark } from './ProviderMark'
import './clientUpdates.css'

function sinceLabel(iso: string): string {
  const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60_000)
  if (!Number.isFinite(minutes) || minutes < 1) return 'Checked just now'
  if (minutes < 60) return `Checked ${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.floor(minutes / 60)
  return `Checked ${hours} hour${hours === 1 ? '' : 's'} ago`
}

/**
 * One card in the corner for every client that has fallen behind (ADR-0042). It says what is
 * installed, what is published and what a press will do, and after a press whether it worked. It
 * never speaks for a client Sotto cannot update: that row shows the command to run instead.
 */
export function ClientUpdateCard(): ReactNode {
  const agents = useOptionalAgents()
  const card = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const state = agents?.state
  const command = agents?.command
  const updates = state?.clientUpdates ?? []
  const dismissed = Boolean(state?.clientUpdatesDismissedAt)
  // An update in flight is the one thing a dismissal does not take down. Everything else the card
  // says stays in Settings → Providers, which is where it lives when the card is gone.
  const shown: ProviderClientUpdate[] = updates.filter(update => update.state === 'updating'
    || (!dismissed && (update.state === 'failed' || update.state === 'unchanged' || update.state === 'updated' || update.behind)))
  const updating = shown.some(update => update.state === 'updating')

  // The transient toasts share this corner; keep them clear of whatever height the card is.
  useLayoutEffect(() => {
    const root = document.documentElement
    if (!shown.length) { root.style.removeProperty('--tt-corner-inset'); return }
    const height = card.current?.getBoundingClientRect().height ?? 0
    root.style.setProperty('--tt-corner-inset', `${Math.round(height) + 28}px`)
    return () => { root.style.removeProperty('--tt-corner-inset') }
  })
  // Escape belongs to whatever the user is in. The card answers it only while it holds focus, so a
  // press meant for an open dialog or the effort card never puts this down as a side effect.
  useEffect(() => {
    if (!shown.length || updating) return
    const close = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && card.current?.contains(document.activeElement)) void dismiss()
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  })
  if (!state || !command || !shown.length) return null

  const run = async (type: 'update-client' | 'check-client-updates' | 'dismiss-client-updates', provider?: ProviderId): Promise<void> => {
    setBusy(true); setFailure(null)
    const ranBefore = updates.find(update => update.id === provider)?.ranAt
    try {
      const result = await command(type === 'update-client' ? { type, provider: provider! } : { type } as never)
      // An update that ran is told by the card itself; repeating it is noise. A press refused before
      // it ran changes nothing on the card, so that one is said.
      const ranAt = result?.clientUpdates?.find(update => update.id === provider)?.ranAt
      const ran = type === 'update-client' && ranAt !== undefined && ranAt !== ranBefore
      if (result?.error && !ran) setFailure(result.error)
    } catch { setFailure('Could not reach the update. Try again.') }
    finally { setBusy(false) }
  }
  const dismiss = (): Promise<void> => run('dismiss-client-updates')

  // One client that went wrong, is being updated or has just updated gets one sentence; why it went
  // wrong waits under Details. A card about several clients keeps the list. Nothing here mentions a
  // thread still working: the installer never stops one, and each moves to the new version when it
  // is next idle (ADR-0042), which is true without being said.
  const single = shown.length === 1 ? shown[0]! : undefined
  if (single && (single.state === 'failed' || single.state === 'unchanged' || single.state === 'updating' || single.state === 'updated')) {
    const name = PROVIDER_LABELS[single.id]
    const line = single.state === 'updating' ? `Updating ${name} to ${single.published ?? 'the published version'}…`
      : single.state === 'failed' ? `${name} did not update.`
      : single.state === 'updated' ? `${name} is now ${single.installed}.` : `${name} is still on ${single.installed}.`
    const under = single.state === 'updating' ? 'Your threads keep working.'
      : single.state === 'failed' ? 'Nothing was changed.'
      : single.state === 'unchanged' && single.published ? `${single.published} is published.` : undefined
    const details = single.state === 'updated' || single.state === 'updating' ? undefined : single.state === 'failed'
      ? `${single.error ? `The installer said: ${single.error}.` : 'The installer reported a failure.'} Another app may be using ${name}. Close it, then try again.`
      : single.error ? single.error
      : `The installer finished, but ${name} still reports ${single.installed}. Try again${single.command ? `, or run ${single.command} yourself to see what it says` : ''}.`
    return <div className="client-updates client-updates--single" ref={card} role="status" aria-live="polite" aria-label={line}
      data-tone={single.state === 'failed' ? 'error' : undefined}>
      <div className="client-updates__row" data-state={single.state}>
        <ProviderMark provider={single.id} name={name} size={16} />
        <div><span>{line}</span>{under ? <small>{under}</small> : null}</div>
        {single.state === 'updating' ? <span className="client-updates__spinner" aria-label="Updating" /> : <>
          {single.canInstall && single.state !== 'updated' ? <Button variant="secondary" disabled={busy} onClick={() => void run('update-client', single.id)}>Try again</Button> : null}
          <Button variant="ghost" iconOnly aria-label="Dismiss" disabled={busy} onClick={() => void dismiss()}><X size={14} /></Button>
        </>}
      </div>
      {failure === null ? null : <p className="client-updates__error">{failure}</p>}
      {details === undefined ? null : <details className="client-updates__details"><summary>Details</summary><p>{details}</p></details>}
    </div>
  }

  const behind = shown.filter(update => update.behind && update.state !== 'updated')
  const installable = behind.filter(update => update.canInstall)
  const failed = shown.filter(update => update.state === 'failed')
  const unchanged = shown.filter(update => update.state === 'unchanged')
  const heading = updating ? 'Updating clients' : failed.length ? 'A client did not update'
    : unchanged.length ? 'A client did not change' : behind.length ? 'Client updates' : 'Clients updated'
  const under = updating ? 'Your threads keep working'
    : failed.length ? 'Your installed version is unchanged'
    : unchanged.length ? 'The update ran, but the version did not move'
    : behind.length ? `${behind.length} of ${updates.length} clients ${behind.length === 1 ? 'has' : 'have'} a newer version`
    : undefined
  const checkedAt = shown.map(update => update.checkedAt).sort().at(-1) ?? new Date().toISOString()

  return <div className="client-updates" ref={card} role="status" aria-live="polite" aria-label={heading}>
    <div className="client-updates__head">
      <strong>{heading}</strong>{under ? <span>{under}</span> : null}
    </div>
    {shown.map(update => {
      const name = PROVIDER_LABELS[update.id]
      return <div className="client-updates__row" key={update.id} data-state={update.state}>
        <ProviderMark provider={update.id} name={name} size={16} />
        <div>
          <span>{name}</span>
          <small>
            {update.state === 'updated' ? `Now ${update.installed}`
              : update.state === 'unchanged' ? update.error ?? `Still ${update.installed}. Try again.`
              : update.state === 'failed' ? (update.error ?? 'The installer reported a failure')
              : update.behind ? `${update.installed} → ${update.published ?? ''}`
              : update.installed}
            {update.behind && !update.canInstall && update.state === 'idle'
              ? ` · update it with ${update.command ?? 'the installer you used'}`
              : ''}
          </small>
        </div>
        {update.state === 'updating' ? <span className="client-updates__spinner" aria-label="Updating" /> : null}
        {update.canInstall && update.state !== 'updating' && update.state !== 'updated'
          ? <Button variant="secondary" disabled={busy || updating}
            onClick={() => void run('update-client', update.id)}>
            {update.state === 'failed' || update.state === 'unchanged' ? 'Try again' : 'Update'}
          </Button>
          : null}
      </div>
    })}
    {failure === null ? null : <p className="client-updates__error">{failure}</p>}
    <div className="client-updates__foot">
      <span>{sinceLabel(checkedAt)}</span>
      <div>
        {installable.length > 1 && !updating
          ? <Button variant="primary" disabled={busy}
            onClick={() => void (async () => { for (const update of installable) await run('update-client', update.id) })()}>
            Update all {installable.length}
          </Button>
          : null}
        {updating ? null : <Button variant="ghost" disabled={busy} onClick={() => void dismiss()}>{behind.length ? 'Not now' : 'Dismiss'}</Button>}
      </div>
    </div>
  </div>
}
