import { plural, t } from '@lingui/core/macro'

import { PROVIDER_LABELS, type AgentProviderStatus, type AgentState } from '../../../../shared/agents'
import type { HostsState, HostStatus } from '../../../../shared/hosts'

/** How long the starting screen waits before it names what has not answered and offers to open without it (ADR-0086). */
export const LATE_AFTER_MS = 10_000
/**
 * How long the screen keeps its words back while it learns what there is to wait for. A launch with nothing to connect
 * hears back well inside this and opens the app without the screen ever saying anything.
 */
export const REVEAL_AFTER_MS = 200
/** The fade before the app replaces the screen. Reduced motion skips it. */
export const LEAVE_MS = 200

/**
 * Where one provider or host stands. `not-connected` is settled without connecting: an error such as not installed or
 * signed out, a question or approval waiting on the user, or turned off. Only `connecting` holds the screen.
 */
export type WatchedState = 'connecting' | 'ready' | 'not-connected'

/** One provider on this computer, or one saved host, as the starting screen watches it. */
export interface Watched {
  readonly key: string
  readonly name: string
  readonly state: WatchedState
}

/** A watched item's dot: `late` is one still connecting once ten seconds have passed. */
export type DotState = 'ready' | 'connecting' | 'late' | 'not-connected'

export interface StartingDot {
  readonly key: string
  readonly name: string
  readonly state: DotState
}

export interface StartingInput {
  /** The window's live agent state, or null until the first one arrives. A cached shell from the last run does not count. */
  readonly agent: AgentState | null
  /** Main has answered for the agent state, or said it cannot. */
  readonly agentKnown: boolean
  readonly hosts: HostsState | null
  /** Main has answered for the saved hosts, or this window has no hosts bridge. */
  readonly hostsKnown: boolean
  /**
   * Ten seconds have passed. Whatever has still not answered is named; if main has not given its first state, the screen
   * says so instead. Either way it offers to open Sotto now.
   */
  readonly late: boolean
  /** Everything this screen has seen connecting, so a provider that stops before it connects keeps its dot. */
  readonly seen: ReadonlySet<string>
}

export interface StartingView {
  /** The one line under the mark: what Sotto is doing now. */
  readonly line: string
  readonly dots: readonly StartingDot[]
  /** The keys still connecting: these hold the screen. */
  readonly pending: readonly string[]
  /**
   * After ten seconds: the sentence naming what has not answered, or saying Sotto has not loaded your threads, and the
   * button that opens Sotto anyway.
   */
  readonly late: { readonly text: string; readonly button: string } | null
  /** Nothing is left to wait for, so the app opens. */
  readonly settled: boolean
}

/**
 * This computer's providers as the window's agent state carries them: the local host's own list, whichever host is
 * selected. A remote host's providers belong to that host, which counts as one item once it is connected.
 */
export function localProviders(state: AgentState): readonly AgentProviderStatus[] {
  const local = state.connections?.find(connection => connection.kind === 'local')
  if (local !== undefined) return state.host.clientHosts?.find(host => host.hostId === local.hostId)?.providers ?? []
  return state.clientScoped === true ? [] : state.host.providers ?? []
}

function providerState(provider: AgentProviderStatus): WatchedState {
  if (provider.connection === 'connecting') return 'connecting'
  return provider.connection === 'connected' ? 'ready' : 'not-connected'
}

/** A host waiting on the user (SSH's question, a Tailscale approval) is waiting on them, not on the host. */
function hostState(host: HostStatus): WatchedState {
  if (host.phase === 'connected') return 'ready'
  if (host.phase === 'connecting' && host.prompt === undefined && host.tailscale?.waiting !== true) return 'connecting'
  return 'not-connected'
}

/** Every provider on this computer and every saved host that is switched on, in that order, with where each stands. */
export function watchedItems(agent: AgentState | null, hosts: HostsState | null): readonly Watched[] {
  const providers = agent === null ? [] : localProviders(agent).map(provider => ({
    key: `provider:${provider.id}`, name: provider.name || PROVIDER_LABELS[provider.id], state: providerState(provider),
  }))
  const saved = hosts === null ? [] : hosts.hosts.filter(host => host.enabled).map(host => ({
    key: `host:${host.id}`, name: host.name, state: hostState(host),
  }))
  return [...providers, ...saved]
}

/** "Codex", "Codex and forge", "Claude Code, Codex and forge". */
export function listNames(names: readonly string[]): string {
  if (names.length < 2) return names[0] ?? ''
  const first = names.slice(0, -1).join(', ')
  const last = names[names.length - 1]!
  return t`${first} and ${last}`
}

/**
 * What the starting screen says and whether it is done. It holds while a provider on this computer or a saved host is
 * connecting; anything else has settled. A provider that is not trying, or failed before the screen saw it try, has no
 * dot: the screen shows what it waited for.
 */
export function startingView(input: StartingInput): StartingView {
  const shown = watchedItems(input.agentKnown ? input.agent : null, input.hostsKnown ? input.hosts : null)
    .filter(item => item.state !== 'not-connected' || input.seen.has(item.key))
  const pending = shown.filter(item => item.state === 'connecting')
  const names = listNames(pending.map(item => item.name)), pendingCount = pending.length
  // Ten seconds never stand in for an answer: without main's first state the screen holds and, once late, says so.
  const settled = input.agentKnown && input.hostsKnown && pending.length === 0
  const loading = !input.agentKnown || pending.length === 0
  const connecting = pending[0]?.name ?? ''
  const line = settled ? t({ message: 'Ready', comment: 'The starting screen once every provider and host has connected' })
    : loading ? t`Loading your threads`
      : input.late ? t`Waiting for ${names}`
        : t`Connecting ${connecting}`
  const late = !input.late || settled ? null
    : loading ? { text: t`Sotto has not loaded your threads in 10 seconds. It keeps trying.`, button: t`Open Sotto now` }
      : {
          text: plural(pendingCount, {
            one: `${names} has not answered in 10 seconds. Sotto keeps trying in the background.`,
            other: `${names} have not answered in 10 seconds. Sotto keeps trying in the background.`,
          }),
          button: t`Open Sotto without ${names}`,
        }
  return {
    line,
    dots: shown.map(item => ({ key: item.key, name: item.name, state: item.state === 'connecting' && input.late ? 'late' : item.state })),
    pending: pending.map(item => item.key),
    late,
    settled,
  }
}
