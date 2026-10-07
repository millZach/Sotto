import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react'
import { writeClipboard } from '../../agents/richActions'
import { Check, Copy } from 'lucide-react'
import { PROVIDER_LABELS, type ClientUpdateRun, type ProviderClientUpdate, type ProviderId } from '../../../../shared/agents'
import { Button } from '../../components/Button'
import {
  byHandLines, byHandReason, chipText, namesOf, failedLong, failedShort, hostClientUpdatesView, popoverStatus, printedHeading, rowState,
  targetVersion, tileLine, type ClientUpdatePhase, type HostClientUpdatesView,
} from './hostClientUpdateWords'

/**
 * A host's client updates in Settings > Hosts (#480, variant D of `prototype/host-client-updates`): the line and the
 * Update press on each provider tile, and the chip beside Show providers that opens Update all. Both put clients in the
 * host's own one-at-a-time update line; the host runs them and its shell says how each went.
 */

/**
 * Updates the user put away with Done, by saved host and provider, until Sotto restarts. Done is this window's own:
 * the host keeps saying the client updated, and nothing about the host changes.
 */
const acknowledged = new Map<string, string>()
const listeners = new Set<() => void>()
let revision = 0
const subscribe = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const key = (hostId: string, provider: ProviderId): string => `${hostId}\u0000${provider}`
/** Whether an update that finished was put away with Done. */
export function isAcknowledged(hostId: string, update: ProviderClientUpdate): boolean {
  return update.state === 'updated' && update.ranAt !== undefined && acknowledged.get(key(hostId, update.id)) === update.ranAt
}
function acknowledge(hostId: string, updates: readonly ProviderClientUpdate[]): void {
  for (const update of updates) if (update.state === 'updated' && update.ranAt) acknowledged.set(key(hostId, update.id), update.ranAt)
  revision += 1
  for (const listener of listeners) listener()
}
/** Forgets every Done, so a test starts clean. */
export function resetAcknowledgedClientUpdates(): void { acknowledged.clear(); revision += 1; for (const listener of listeners) listener() }
/** Re-renders when a Done changes what a host's tiles and chip show. */
export function useAcknowledgedRevision(): number { return useSyncExternalStore(subscribe, () => revision) }

/** What asks the host: `update` puts clients in its line, `cancel` takes a waiting one out. Answers with a refusal or nothing. */
export type SendClientUpdate = (action: 'update' | 'cancel', providers: readonly ProviderId[]) => Promise<string | undefined>

export function HostSpinner(): ReactNode { return <span className="host-client-update__spinner" aria-hidden="true" /> }

/** The command to run on the host by hand, a line each, with Copy. */
export function CommandLines({ lead, lines, name, host }: { readonly lead: string; readonly lines: readonly string[]; readonly name: string; readonly host: string }): ReactNode {
  const [copied, setCopied] = useState<'copied' | 'failed' | null>(null)
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(null), 1500); return () => clearTimeout(timer) }, [copied])
  const copy = async (): Promise<void> => { try { await writeClipboard(lines.join('\n')); setCopied('copied') } catch { setCopied('failed') } }
  return <div className="host-provider__command">
    <p>{lead}</p>
    <code>{lines.map((line, index) => <React.Fragment key={index}>{index ? <br /> : null}{line}</React.Fragment>)}</code>
    <Button variant="secondary" aria-label={`Copy the command that updates ${name} on ${host}`} onClick={() => void copy()}>
      {copied === 'copied' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}{copied === 'copied' ? 'Copied' : 'Copy'}
    </Button>
    {copied === 'failed' ? <p>The command could not be copied. Select it and copy it yourself.</p> : null}
    <span className="tt-visually-hidden" role="status">{copied === 'copied' ? 'Copied the command' : ''}</span>
  </div>
}

/** A connected tile's update: the line under its version, what goes below it, its press, and its note. */
export interface TileUpdateParts { readonly line?: ReactNode; readonly below?: ReactNode; readonly action?: ReactNode; readonly note?: string; readonly phase: ClientUpdatePhase }

/** The parts of a provider tile that say how its client's update stands, or nothing while it is current. */
export function tileUpdateParts({ update, phase, host, waitingFor, busy, send }: {
  readonly update: ProviderClientUpdate | undefined; readonly phase: ClientUpdatePhase; readonly host: string
  readonly waitingFor: ProviderId | undefined; readonly busy: boolean; readonly send: SendClientUpdate
}): TileUpdateParts {
  if (!update || phase === 'current') return { phase: 'current' }
  const name = PROVIDER_LABELS[update.id], to = targetVersion(update)
  const line = (tone?: 'quiet' | 'error'): ReactNode => <p className="host-client-update__line" data-tone={tone}>
    {phase === 'updating' ? <HostSpinner /> : null}{tileLine(update, phase, waitingFor)}</p>
  switch (phase) {
    case 'behind': return { phase, line: line(),
      action: <Button key="update" data-update-action="" variant="secondary" disabled={busy} aria-label={`Update ${name} on ${host} to ${to}`} onClick={() => void send('update', [update.id])}>Update</Button> }
    case 'queued': return { phase, line: line('quiet'),
      action: <Button key="cancel" data-update-action="" variant="secondary" disabled={busy} aria-label={`Cancel the ${name} update on ${host}`} onClick={() => void send('cancel', [update.id])}>Cancel update</Button> }
    case 'updating': return { phase, line: line(), note: `Your threads on ${host} keep working.` }
    case 'updated': return { phase, note: `${name} is now ${update.installed}.` }
    case 'by-hand': {
      const lines = byHandLines(update)
      return { phase, line: line(), below: lines.length
        ? <CommandLines lead={`${byHandReason(update, host)} Run this on ${host}:`} lines={lines} name={name} host={host} />
        : <p className="host-client-update__words">{byHandReason(update, host)} Update it the way you installed it.</p> }
    }
    case 'failed': {
      const lines = byHandLines(update)
      return { phase, line: line('error'),
        below: <>
          <p className="host-client-update__words" role="status">{failedShort(update, host)}</p>
          <details className="host-client-update__details">
            <summary>Details<span className="tt-visually-hidden"> of why {name} did not update</span></summary>
            <div className="host-client-update__details-body">
              <p className="host-client-update__words">{failedLong(update, host)}</p>
              {lines.length ? <CommandLines lead={`Or run this on ${host}:`} lines={lines} name={name} host={host} /> : null}
              {update.printed ? <details className="host-client-update__printed">
                <summary>{printedHeading(update)}</summary><pre>{update.printed}</pre>
              </details> : null}
            </div>
          </details>
        </>,
        action: update.canInstall ? <Button key="again" data-update-action="" variant="secondary" disabled={busy} aria-label={`Try updating ${name} on ${host} again`} onClick={() => void send('update', [update.id])}>Try again</Button> : undefined }
    }
    default: return { phase }
  }
}

/** Which client a waiting one waits for: the one running, or the one before it in the line. */
export function waitingForOf(view: HostClientUpdatesView, provider: ProviderId, run: ClientUpdateRun | undefined, order: readonly ProviderId[]): ProviderId | undefined {
  if (view.phases.get(provider) !== 'queued') return undefined
  // The host runs its line in the order the clients joined it, and says that order; tile order stands in for a host
  // that does not.
  const waiting = run?.line ?? order.filter(id => view.queued.includes(id))
  const at = waiting.indexOf(provider)
  return at <= 0 ? view.running?.id : waiting[at - 1]
}

/**
 * The chip beside Show providers, there with the tiles open or closed, and its popover: "Client updates on forge", one
 * row per client, Not now and Update all. Update all puts every client that is behind, and every one that did not update,
 * in the host's line; a failure carries on with the rest and leaves Try again on its row. Enter opens it with focus on
 * its main press, Escape closes it back onto the chip, and at the minimum size it opens above the chip.
 */
export function HostClientUpdatesChip({ host, hostId, view, run, busy, refusal, send }: {
  readonly host: string; readonly hostId: string; readonly view: HostClientUpdatesView; readonly run: ClientUpdateRun | undefined
  readonly busy: boolean; readonly refusal: string | undefined; readonly send: SendClientUpdate
}): ReactNode {
  const [open, setOpen] = useState(false)
  const chip = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const panelId = useId(), titleId = useId()
  const shown = chipText(view, run)
  const close = useCallback((focusChip: boolean): void => {
    setOpen(false)
    // Back onto the chip, or onto Show providers once the chip has gone with the last update.
    if (focusChip) setTimeout(() => (chip.current ?? document.querySelector<HTMLElement>(`[data-host-providers="${CSS.escape(hostId)}"] .host-providers__toggle`))?.focus(), 0)
  }, [hostId])
  // Nothing left to show: the popover goes with the chip.
  useEffect(() => { if (!shown && open) close(true) }, [shown, open, close])
  // Below the chip where it fits, else above it; never past the window's edge. Placed on the element itself, before the
  // first paint, so it is never seen anywhere else and its presses can take focus as soon as it opens.
  const placePanel = useCallback((): void => {
    const button = chip.current, box = panel.current
    if (!button || !box) return
    const rect = button.getBoundingClientRect(), width = box.offsetWidth, height = box.offsetHeight
    const left = Math.max(12, Math.min(rect.left, innerWidth - width - 12))
    const below = rect.bottom + 6
    const top = below + height <= innerHeight - 12 ? below : Math.max(TOP_CLEAR, Math.min(rect.top - height - 6, innerHeight - height - 12))
    box.style.left = `${left}px`; box.style.top = `${top}px`
  }, [])
  useLayoutEffect(() => { if (open) placePanel() })
  useEffect(() => {
    if (!open) return
    addEventListener('resize', placePanel)
    addEventListener('scroll', placePanel, true)
    // A click anywhere else closes it, and leaves focus where the click put it.
    const outside = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!panel.current?.contains(target) && !chip.current?.contains(target)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside, true)
    return () => { removeEventListener('resize', placePanel); removeEventListener('scroll', placePanel, true); document.removeEventListener('pointerdown', outside, true) }
  }, [open, placePanel])
  // Opening puts focus on the popover's main press: Update all, else Done, else the first press there is.
  useEffect(() => { if (open) focusMain(panel.current) }, [open])
  // Update all or Try again goes as the line starts: focus moves to the popover's own next press rather than being dropped.
  const settled = !view.running && !view.queued.length
  useEffect(() => {
    if (!open) return
    const focused = document.activeElement
    if (focused === null || focused === document.body || !focused.isConnected) focusMain(panel.current)
  }, [open, settled, view.behind.length, view.failed.length])
  if (!shown) return null
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') return
    event.preventDefault(); event.stopPropagation()
    close(true)
  }
  // Focus leaving the popover and its chip closes it, the way a menu does.
  const onBlur = (event: React.FocusEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget as Node | null
    if (next && !panel.current?.contains(next) && !chip.current?.contains(next)) setOpen(false)
  }
  const done = (): void => { acknowledge(hostId, view.shown); close(true) }
  const status = popoverStatus(view, run, host)
  const busyNow = view.running !== undefined || view.queued.length > 0
  const summary = view.failed.length ? `${view.failed.length === 1 ? PROVIDER_LABELS[view.failed[0]!] : `${view.failed.length} clients`} did not update` : shown.text
  return <>
    <button ref={chip} type="button" className="host-client-updates__chip tt-focusable" data-tone={shown.tone}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined}
      aria-label={`Show the client updates on ${host}. ${summary}`} onClick={() => { if (open) close(false); else setOpen(true) }}>
      {shown.tone === 'done' ? <Check size={13} aria-hidden="true" /> : busyNow ? <HostSpinner /> : null}{shown.text}
    </button>
    {open ? <div ref={panel} id={panelId} className="host-client-updates__panel" role="dialog" aria-labelledby={titleId}
      onKeyDown={onKeyDown} onBlur={onBlur}>
      <h6 id={titleId}>Client updates on {host}</h6>
      <p className="host-client-updates__status" role="status">{status}</p>
      <ul className="host-client-updates__list" aria-label={`Clients on ${host}`}>
        {view.shown.map(update => {
          const phase = view.phases.get(update.id)!
          const name = PROVIDER_LABELS[update.id]
          const state = rowState(update, phase)
          return <li key={update.id} data-phase={phase}>
            <div><span className="host-client-updates__name">{name}</span> <span className="host-client-updates__versions">{phase === 'updated' ? `now ${update.installed}` : <>{update.installed}<span aria-hidden="true"> → </span><span className="tt-visually-hidden"> to </span>{targetVersion(update)}</>}</span></div>
            {state ? <span className="host-client-updates__state">{phase === 'updating' ? <HostSpinner /> : phase === 'updated' ? <Check size={13} aria-hidden="true" /> : null}{state}</span> : <span />}
            {phase === 'failed' ? <div className="host-client-updates__why"><p>{failedShort(update, host)}</p>
              {update.canInstall ? <Button variant="secondary" disabled={busy} aria-label={`Try updating ${name} on ${host} again`} onClick={() => void send('update', [update.id])}>Try again</Button> : null}</div>
              : phase === 'by-hand' ? <div className="host-client-updates__why"><p>{byHandReason(update, host)} Its tile has the command to run.</p></div> : null}
          </li>
        })}
      </ul>
      {!settled || view.behind.length ? <p className="host-client-updates__note">One client updates at a time. Your threads keep working, and move to the new version when they are idle.</p> : null}
      {refusal ? <p className="host-client-updates__refusal" role="alert">{refusal}</p> : null}
      <div className="host-client-updates__actions">
        {settled && !view.behind.length
          ? <Button variant="primary" data-main="" onClick={done}>Done</Button>
          : <Button variant="ghost" onClick={() => close(true)}>{busyNow ? 'Close' : 'Not now'}</Button>}
        {/* Update all joins the host's line, behind an update a tile started, as long as something is behind. */}
        {view.updateAll.length ? <Button variant="primary" data-main="" disabled={busy}
          aria-label={`Update ${namesOf(view.updateAll)} on ${host}, one after another`}
          onClick={() => void send('update', view.updateAll)}>Update all</Button> : null}
      </div>
    </div> : null}
  </>
}

/** The popover opens no higher than this, clear of the window controls in the strip at the top. */
const TOP_CLEAR = 48
function focusMain(box: HTMLElement | null): void {
  (box?.querySelector<HTMLElement>('[data-main]:not(:disabled)') ?? box?.querySelector<HTMLElement>('button:not(:disabled)'))?.focus()
}

/** The view a host's tiles and chip share, from the host's readings and the Dones this window keeps. */
export function useHostClientUpdates(hostId: string, updates: readonly ProviderClientUpdate[] | undefined, order: readonly ProviderId[]): HostClientUpdatesView {
  useAcknowledgedRevision()
  return hostClientUpdatesView(updates ?? [], order, update => isAcknowledged(hostId, update))
}
