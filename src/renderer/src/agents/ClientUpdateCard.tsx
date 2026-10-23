import React, { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { plural, t } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import { PROVIDER_LABELS, type ProviderClientUpdate, type ProviderId } from '../../../shared/agents'
import { Button } from '../components/Button'
import { useOptionalAgents } from './AgentContext'
import { ProviderMark } from './ProviderMark'
import './clientUpdates.css'

function sinceLabel(iso: string): string {
  const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60_000)
  if (!Number.isFinite(minutes) || minutes < 1) return t`Checked just now`
  if (minutes < 60) return plural(minutes, { one: 'Checked # minute ago', other: 'Checked # minutes ago' })
  const hours = Math.floor(minutes / 60)
  return plural(hours, { one: 'Checked # hour ago', other: 'Checked # hours ago' })
}

/**
 * One card in the corner for every client that has fallen behind (ADR-0042). It says what is
 * installed, what is published and what a press will do, and after a press whether it worked. It
 * never speaks for a client Sotto cannot update: that row shows the command to run instead.
 */
export function ClientUpdateCard(): ReactNode {
  const { t } = useLingui()
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
      if (event.key !== 'Escape' || !card.current?.contains(document.activeElement)) return
      // Claim the press, so the Dictate room does not also dismiss its error with it.
      event.preventDefault()
      void dismiss()
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
    } catch { setFailure(t`Could not reach the update. Try again.`) }
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
    const { installed, published, error, command: byHand } = single
    const line = single.state === 'updating'
      ? published ? t({ message: `Updating ${name} to ${published}…`, comment: '{name} is a provider\'s name; {published} is a version number.' }) : t({ message: `Updating ${name} to the published version…`, comment: '{name} is a provider\'s name.' })
      : single.state === 'failed' ? t({ message: `${name} did not update.`, comment: '{name} is a provider\'s name.' })
      : single.state === 'updated' ? t({ message: `${name} is now ${installed}.`, comment: '{name} is a provider\'s name; {installed} is a version number.' })
      : t({ message: `${name} is still on ${installed}.`, comment: '{name} is a provider\'s name; {installed} is a version number.' })
    const under = single.state === 'updating' ? t`Your threads keep working.`
      : single.state === 'failed' ? t`Nothing was changed.`
      : single.state === 'unchanged' && published ? t({ message: `${published} is published.`, comment: '{published} is a version number.' }) : undefined
    const details = single.state === 'updated' || single.state === 'updating' ? undefined : single.state === 'failed'
      ? error
        ? t({ message: `The installer said: ${error}. Another app may be using ${name}. Close it, then try again.`, comment: '{error} is what the installer said; {name} is a provider\'s name.' })
        : t({ message: `The installer reported a failure. Another app may be using ${name}. Close it, then try again.`, comment: '{name} is a provider\'s name.' })
      : error ? error
      : byHand
        ? t({ message: `The installer finished, but ${name} still reports ${installed}. Try again, or run ${byHand} yourself to see what it says.`, comment: '{name} is a provider\'s name; {installed} is a version number; {byHand} is a terminal command.' })
        : t({ message: `The installer finished, but ${name} still reports ${installed}. Try again.`, comment: '{name} is a provider\'s name; {installed} is a version number.' })
    return <div className="client-updates client-updates--single" ref={card} role="status" aria-live="polite" aria-label={line}
      data-tone={single.state === 'failed' ? 'error' : undefined}>
      <div className="client-updates__row" data-state={single.state}>
        <ProviderMark provider={single.id} name={name} size={16} />
        <div><span>{line}</span>{under ? <small>{under}</small> : null}</div>
        {single.state === 'updating' ? <span className="client-updates__spinner" aria-label={t({ message: 'Updating', comment: 'A provider\'s client is being updated.' })} /> : <>
          {single.canInstall && single.state !== 'updated' ? <Button variant="secondary" disabled={busy} onClick={() => void run('update-client', single.id)}>{t`Try again`}</Button> : null}
          <Button variant="ghost" iconOnly aria-label={t`Dismiss`} disabled={busy} onClick={() => void dismiss()}><X size={14} /></Button>
        </>}
      </div>
      {failure === null ? null : <p className="client-updates__error">{failure}</p>}
      {details === undefined ? null : <details className="client-updates__details"><summary>{t`Details`}</summary><p className="tt-paragraph">{details}</p></details>}
    </div>
  }

  const behind = shown.filter(update => update.behind && update.state !== 'updated')
  const installable = behind.filter(update => update.canInstall)
  const failed = shown.filter(update => update.state === 'failed')
  const unchanged = shown.filter(update => update.state === 'unchanged')
  const heading = updating ? t`Updating clients` : failed.length ? t`A client did not update`
    : unchanged.length ? t`A client did not change` : behind.length ? t`Client updates` : t`Clients updated`
  const behindCount = behind.length, total = updates.length
  const under = updating ? t`Your threads keep working`
    : failed.length ? t`Your installed version is unchanged`
    : unchanged.length ? t`The update ran, but the version did not move`
    : behindCount ? plural(behindCount, { one: `# of ${total} clients has a newer version`, other: `# of ${total} clients have a newer version` })
    : undefined
  const installCount = installable.length
  const checkedAt = shown.map(update => update.checkedAt).sort().at(-1) ?? new Date().toISOString()

  return <div className="client-updates" ref={card} role="status" aria-live="polite" aria-label={heading}>
    <div className="client-updates__head">
      <strong>{heading}</strong>{under ? <span>{under}</span> : null}
    </div>
    {shown.map(update => {
      const name = PROVIDER_LABELS[update.id]
      const { installed, command: runIt } = update
      return <div className="client-updates__row" key={update.id} data-state={update.state}>
        <ProviderMark provider={update.id} name={name} size={16} />
        <div>
          <span>{name}</span>
          <small>
            {update.state === 'updated' ? t({ message: `Now ${installed}`, comment: '{installed} is a version number.' })
              : update.state === 'unchanged' ? update.error ?? t({ message: `Still ${installed}. Try again.`, comment: '{installed} is a version number.' })
              : update.state === 'failed' ? (update.error ?? t`The installer reported a failure`)
              : update.behind ? `${update.installed} → ${update.published ?? ''}`
              : update.installed}
            {update.behind && !update.canInstall && update.state === 'idle'
              ? ' · ' + (runIt ? t({ message: `update it with ${runIt}`, comment: '{runIt} is a terminal command.' }) : t`update it with the installer you used`)
              : ''}
          </small>
        </div>
        {update.state === 'updating' ? <span className="client-updates__spinner" aria-label={t({ message: 'Updating', comment: 'A provider\'s client is being updated.' })} /> : null}
        {update.canInstall && update.state !== 'updating' && update.state !== 'updated'
          ? <Button variant="secondary" disabled={busy || updating}
            onClick={() => void run('update-client', update.id)}>
            {update.state === 'failed' || update.state === 'unchanged' ? t`Try again` : t({ message: 'Update', comment: 'A button that installs the published version of a provider\'s client.' })}
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
            {t({ message: `Update all ${installCount}`, comment: '{installCount} is how many clients the press updates.' })}
          </Button>
          : null}
        {updating ? null : <Button variant="ghost" disabled={busy} onClick={() => void dismiss()}>{behind.length ? t`Not now` : t`Dismiss`}</Button>}
      </div>
    </div>
  </div>
}
