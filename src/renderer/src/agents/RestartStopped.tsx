import React, { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Clock } from 'lucide-react'
import { useLingui } from '@lingui/react/macro'

import type { AgentThread } from '../../../shared/agents'
import { useOptionalApp } from '../state/AppContext'
import { useWatcherEnabled } from '../state/watcherFeature'
import type { AgentConnection } from './AgentContext'
import { RESTART_STOPPED_FEATURE } from '../../../shared/limitRestart'
import { useOwlFeature } from '../state/owlFeature'
import { restartBandCancelLabel, restartBandLead, restartBandRest, restartGroups, restartStripWords, type RestartGroup } from './restartWords'
import './restartStopped.css'

type Command = AgentConnection['command']

/** Ask before any part of it exists. With it off, the window is as it was: babysitting and the resume note stay. */
export function useRestartStopped(): boolean {
  return useOwlFeature(RESTART_STOPPED_FEATURE)
}

/**
 * Restarting stopped threads in the window (ADR-0144, Zach's pick B and C of the mock-up): a band at the top of the
 * Threads sidebar for each provider whose limit stopped threads, and a strip over a stopped thread's composer. Each says
 * when Sotto restarts the threads, and offers Don't restart while a restart is scheduled. Nothing here announces itself.
 */

/**
 * Don't restart, for each thread a press names: one `cancel-restart` apiece, as the host takes them. Resolves to why it
 * did not go through, or null once every one was taken.
 */
async function cancelRestarts(command: Command, threadIds: readonly string[], unconfirmed: string): Promise<string | null> {
  const results = await Promise.all(threadIds.map(threadId => command({ type: 'cancel-restart', threadId }).catch(() => null)))
  for (const result of results) {
    if (result === null) return unconfirmed
    if (result.error !== null) return result.error
  }
  return null
}

/** The bands under the sidebar's search, soonest first. `threads` is every thread the host publishes, Watcher's own included. */
export function RestartBands({ threads, command, onOpen }: {
  readonly threads: readonly AgentThread[]
  readonly command: Command
  readonly onOpen: (threadId: string) => void
}): ReactNode {
  const enabled = useRestartStopped()
  const watcherOn = useWatcherEnabled()
  const groups = useMemo(() => enabled ? restartGroups(threads, watcherOn) : [], [enabled, threads, watcherOn])
  if (groups.length === 0) return null
  return <div className="restart-bands">{groups.map(group => <RestartBand key={group.key} group={group} command={command} onOpen={onOpen} />)}</div>
}

function RestartBand({ group, command, onOpen }: { readonly group: RestartGroup; readonly command: Command; readonly onOpen: (threadId: string) => void }): ReactNode {
  const { t } = useLingui()
  const navigate = useOptionalApp()?.actions.navigate
  const band = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Once a press the host took has taken the band away, focus waits in the search field above it, as Dismiss all's line leaves it.
  const handOff = useRef<HTMLInputElement | null>(null)
  useEffect(() => () => {
    // Only when the press's focus went with the band; a user who moved on keeps their place.
    const search = handOff.current
    if (search?.isConnected && (document.activeElement === null || document.activeElement === document.body)) search.focus()
  }, [])
  const scheduled = Number.isFinite(group.at)
  const lead = restartBandLead(group)
  const cancel = (): void => {
    if (busy) return
    const search = band.current?.closest('.thread-nav')?.querySelector<HTMLInputElement>('.threads-search input') ?? null
    setBusy(true); setError(null)
    void cancelRestarts(command, group.threads.map(thread => thread.id), t`Sotto could not confirm the restarts were called off. Press Don’t restart them again.`).then(refused => {
      if (band.current === null || !band.current.isConnected) { search?.focus(); return }
      setBusy(false)
      setError(refused)
      // Taken: the band goes when the host's next state clears the restarts.
      if (refused === null) handOff.current = search
    })
  }
  return <div ref={band} className="restart-band" role="group" aria-label={lead}>
    <p className="restart-band__words tt-paragraph"><Clock size={14} aria-hidden="true" /><span><strong>{lead}</strong> {restartBandRest(group)}</span></p>
    <ul className="restart-band__threads" aria-label={t`Threads to restart`}>
      {group.threads.map(thread => {
        // Watcher's own thread lives in its room; every other entry opens its thread here.
        const watcher = thread.kind === 'watcher'
        return <li key={thread.id}><button type="button" className="restart-band__thread tt-focusable" title={watcher ? t`Open Watcher’s room` : thread.title}
          onClick={() => { if (watcher) navigate?.('watcher'); else onOpen(thread.id) }}>{watcher ? 'Watcher' : thread.title}</button></li>
      })}
    </ul>
    {scheduled ? <button type="button" className="restart-band__cancel tt-focusable" aria-label={restartBandCancelLabel(group)} aria-disabled={busy || undefined}
      onClick={cancel}>{t`Don’t restart them`}</button> : null}
    {error === null ? null : <p className="restart-band__error tt-paragraph" role="alert">{error}</p>}
  </div>
}

/**
 * Over a stopped thread's composer, where the continue strip sits: when Sotto restarts it, with Don't restart before the
 * prompt in keyboard order. Not in Watcher's own pane, whose entry in the band is enough.
 */
export function RestartStrip({ thread, command, composerId }: { readonly thread: AgentThread; readonly command: Command; readonly composerId: string }): ReactNode {
  const { t } = useLingui()
  const enabled = useRestartStopped()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ readonly threadId: string; readonly text: string } | null>(null)
  const words = enabled ? restartStripWords(thread) : undefined
  if (words === undefined) return null
  const scheduled = thread.scheduledRestart?.at !== undefined
  const cancel = (): void => {
    if (busy) return
    setBusy(true); setError(null)
    const threadId = thread.id
    void cancelRestarts(command, [threadId], t`Sotto could not confirm the restart was called off. Press Don’t restart again.`).then(refused => {
      setBusy(false)
      if (refused !== null) { setError({ threadId, text: refused }); return }
      // The strip goes with the restart; the prompt under it takes the focus.
      document.getElementById(composerId)?.focus()
    })
  }
  const shownError = error?.threadId === thread.id ? error.text : null
  return <div className="restart-strip" data-tone={shownError === null ? undefined : 'error'}>
    <div className="restart-strip__lead">
      <Clock size={14} aria-hidden="true" />
      <p className="tt-paragraph">{words}</p>
      {scheduled ? <button type="button" className="restart-strip__cancel tt-focusable" aria-label={t`Don’t restart this thread`} aria-disabled={busy || undefined}
        onClick={cancel}>{t`Don’t restart`}</button> : null}
    </div>
    {shownError === null ? null : <p className="restart-strip__error tt-paragraph" role="alert">{shownError}</p>}
  </div>
}
