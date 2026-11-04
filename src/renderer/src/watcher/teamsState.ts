import { useEffect, useState } from 'react'
import { localeFormatter } from '../agents/localeFormat'
import type { TeammateMessage, TeamsBridge, TeamsState } from '../../../shared/teams'
import { useOwlFeature } from '../state/owlFeature'

const dateFormat = localeFormatter({ month: 'long', day: 'numeric' }), timeFormat = localeFormatter({ hour: 'numeric', minute: '2-digit' })
export const dateOf = (iso: string): string => dateFormat(new Date(iso))
export const timeOf = (iso: string): string => timeFormat(new Date(iso))
/** Later today as a time, otherwise a date and a time. */
export function whenOf(iso: string, now: number): string {
  return new Date(iso).toDateString() === new Date(now).toDateString() ? timeOf(iso) : `${dateOf(iso)}, ${timeOf(iso)}`
}

/** The bridge, where main offers it: Owl, with Teams on (ADR-0186). */
export function useTeamsBridge(bridge: TeamsBridge | undefined = window.sotto?.teams): TeamsBridge | undefined {
  return useOwlFeature('teams') ? bridge : undefined
}

/** What main says of Teams, kept current while something on screen reads it. Null with Teams off or before the first read. */
export function useTeamsState(bridge: TeamsBridge | undefined): TeamsState | null {
  const [state, setState] = useState<TeamsState | null>(null)
  useEffect(() => {
    if (!bridge) { setState(null); return undefined }
    let live = true
    const off = bridge.subscribe(next => { if (live) setState(next) })
    void bridge.get().then(next => { if (live) setState(next) }).catch(() => undefined)
    return () => { live = false; off() }
  }, [bridge])
  return state
}

/** The rows under each message of Watcher's conversation. A row whose message has gone stays on the Teams tab. */
export function placeTeammateMessages(messages: readonly TeammateMessage[] | undefined): ReadonlyMap<string, readonly TeammateMessage[]> | undefined {
  if (!messages?.length) return undefined
  const placed = new Map<string, TeammateMessage[]>()
  for (const message of messages) {
    if (message.afterMessageId === null) continue
    const rows = placed.get(message.afterMessageId)
    if (rows) rows.push(message)
    else placed.set(message.afterMessageId, [message])
  }
  return placed.size ? placed : undefined
}
