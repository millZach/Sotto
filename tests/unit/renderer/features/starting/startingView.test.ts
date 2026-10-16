import { describe, expect, it } from 'vitest'

import type { HostsState, HostStatus } from '../../../../../src/shared/hosts'
import { listNames, localProviders, startingView, type StartingInput } from '../../../../../src/renderer/src/features/starting/startingView'
import { hostStatus, hostsState } from '../../../../fixtures/renderer/hostBridges'
import { FORGE_HOST_ID as FORGE, providerStatus as provider, startingAgentState as agent } from '../../../../fixtures/renderer/startingScreenState'

function forge(patch: Partial<HostStatus> = {}): HostsState {
  return hostsState({ hosts: [hostStatus({ id: FORGE, name: 'forge', phase: 'connecting', ...patch })] })
}

function view(patch: Partial<StartingInput>) {
  return startingView({ agent: agent([]), agentKnown: true, hosts: hostsState(), hostsKnown: true, late: false, seen: new Set(), ...patch })
}

describe('the starting screen', () => {
  it('holds while a provider on this computer connects, and names the first one still connecting', () => {
    const shown = view({ agent: agent([provider('codex', 'connected'), provider('claude', 'connecting'), provider('grok', 'connecting')]) })
    expect(shown.settled).toBe(false)
    expect(shown.line).toBe('Connecting Claude Code')
    expect(shown.pending).toEqual(['provider:claude', 'provider:grok'])
    expect(shown.dots).toEqual([
      { key: 'provider:codex', name: 'Codex', state: 'ready' },
      { key: 'provider:claude', name: 'Claude Code', state: 'connecting' },
      { key: 'provider:grok', name: 'Grok Build', state: 'connecting' },
    ])
    expect(shown.late).toBeNull()
  })

  it('says it is loading your threads until main answers for the agent state', () => {
    const shown = view({ agent: null, agentKnown: false, hosts: forge() })
    expect(shown).toMatchObject({ line: 'Loading your threads', settled: false, dots: [{ key: `host:${FORGE}`, state: 'connecting' }] })
    expect(view({ agent: null, agentKnown: false }).settled).toBe(false)
    expect(view({ hosts: null, hostsKnown: false }).settled).toBe(false)
  })

  it('is not held by a provider that connected, failed, or is not trying', () => {
    const shown = view({ agent: agent([
      provider('codex', 'connected'),
      provider('claude', 'error', { problem: 'not-installed', error: 'Install Claude Code.' }),
      provider('grok', 'error', { problem: 'signed-out', error: 'Sign in to Grok Build.' }),
      provider('devin', 'disconnected'),
    ]) })
    expect(shown.settled).toBe(true)
    expect(shown.line).toBe('Ready')
    // A failure the screen never saw happen, and a provider that is not trying, have no dot.
    expect(shown.dots.map(dot => dot.key)).toEqual(['provider:codex'])
  })

  it('opens at once when nothing is enabled and no host is saved', () => {
    expect(view({ agent: agent([]), hosts: hostsState() })).toMatchObject({ settled: true, dots: [], pending: [] })
    // A window whose agent bridge cannot answer is no reason to wait either.
    expect(view({ agent: null, agentKnown: true }).settled).toBe(true)
  })

  it('holds while a saved host connects, and not for one that is connected, failed, off or waiting on the user', () => {
    expect(view({ hosts: forge() })).toMatchObject({ settled: false, line: 'Connecting forge', pending: [`host:${FORGE}`] })
    expect(view({ hosts: forge({ reconnecting: true }) }).settled).toBe(false)
    for (const patch of [
      { phase: 'connected' },
      { phase: 'error', error: 'The host identity changed.' },
      { phase: 'disconnected' },
      { enabled: false },
      { prompt: { id: 'question', kind: 'host-key', text: 'Trust this host?' } },
      { tailscale: { waiting: true, url: 'https://login.tailscale.com/a/approve' } },
    ] satisfies Partial<HostStatus>[]) {
      expect(view({ hosts: forge(patch) }).settled, JSON.stringify(patch)).toBe(true)
    }
    expect(view({ hosts: forge({ enabled: false }) }).dots).toEqual([])
  })

  it('reads only this computer’s providers: a remote host is one item, whatever its own providers are doing', () => {
    const state = agent([provider('codex', 'connected')], [provider('claude', 'connecting')])
    expect(localProviders(state).map(item => item.id)).toEqual(['codex'])
    expect(view({ agent: state, hosts: forge({ phase: 'connected' }) })).toMatchObject({ settled: true, pending: [] })
    // A window with the local host turned off has no local providers to wait for.
    expect(localProviders({ ...state, connections: state.connections!.filter(item => item.kind === 'remote') })).toEqual([])
  })

  it('after ten seconds names what has not answered and offers to open Sotto without it', () => {
    const one = view({ hosts: forge(), late: true })
    expect(one.line).toBe('Waiting for forge')
    expect(one.late).toEqual({
      text: 'forge has not answered in 10 seconds. Sotto keeps trying in the background.',
      button: 'Open Sotto without forge',
    })
    expect(one.dots).toEqual([{ key: `host:${FORGE}`, name: 'forge', state: 'late' }])
    const three = view({ agent: agent([provider('codex', 'connecting'), provider('devin', 'connecting'), provider('claude', 'connected')]), hosts: forge(), late: true })
    expect(three.line).toBe('Waiting for Codex, Devin and forge')
    expect(three.late).toEqual({
      text: 'Codex, Devin and forge have not answered in 10 seconds. Sotto keeps trying in the background.',
      button: 'Open Sotto without Codex, Devin and forge',
    })
    expect(three.dots.find(dot => dot.key === 'provider:claude')?.state).toBe('ready')
    // Nothing late, nothing to say.
    expect(view({ late: true }).late).toBeNull()
  })

  it('at ten seconds says main has not given its first state, and offers to open Sotto now rather than opening by itself', () => {
    const notLoaded = { text: 'Sotto has not loaded your threads in 10 seconds. It keeps trying.', button: 'Open Sotto now' }
    expect(view({ agent: null, agentKnown: false, late: true })).toMatchObject({ settled: false, line: 'Loading your threads', late: notLoaded })
    expect(view({ hosts: null, hostsKnown: false, late: true })).toMatchObject({ settled: false, line: 'Loading your threads', late: notLoaded })
    // A host still connecting does not change what the line and the note are about while the agent state is missing.
    expect(view({ agent: null, agentKnown: false, hosts: forge(), late: true })).toMatchObject({
      settled: false, line: 'Loading your threads', late: notLoaded, dots: [{ key: `host:${FORGE}`, state: 'late' }],
    })
    // Once the agent state is in, what is still connecting is named, whether or not the hosts state has come.
    expect(view({ hosts: null, hostsKnown: false, agent: agent([provider('codex', 'connecting')]), late: true })).toMatchObject({
      settled: false, line: 'Waiting for Codex', pending: ['provider:codex'], late: { button: 'Open Sotto without Codex' },
    })
  })

  it('keeps the dot of a provider it saw connecting that then failed', () => {
    const failed = agent([provider('devin', 'error', { problem: 'cannot-start', error: 'Devin could not start.' })])
    expect(view({ agent: failed }).dots).toEqual([])
    expect(view({ agent: failed, seen: new Set(['provider:devin']) })).toMatchObject({
      settled: true, dots: [{ key: 'provider:devin', name: 'Devin', state: 'not-connected' }],
    })
  })

  it('lists names the way a sentence does', () => {
    expect(listNames([])).toBe('')
    expect(listNames(['forge'])).toBe('forge')
    expect(listNames(['Codex', 'forge'])).toBe('Codex and forge')
    expect(listNames(['Claude Code', 'Codex', 'forge'])).toBe('Claude Code, Codex and forge')
  })
})
