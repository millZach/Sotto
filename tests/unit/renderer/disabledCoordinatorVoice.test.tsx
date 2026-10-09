import React from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentProvider, useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { DesktopHostRouter } from '../../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import { desktopWindowClient } from '../../../src/main/agents/hostService'
import { HostConnectionError } from '../../../src/main/agents/socketHostService'
import { remoteCommandRefusal } from '../../../src/host/remoteCommands'
import { REMOTE_PERMISSION_DENIED } from '../../../src/main/agents/authority'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import type { AgentCommand } from '../../../src/shared/agents'
import { agentWireBridge } from '../../fixtures/agentBridge'
import { hostEntityKey } from '../../../src/shared/clientIdentity'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it.each([
  { selected: 'remote', mayAnswer: true, settingsPending: false },
  { selected: 'remote', mayAnswer: false, settingsPending: false },
  { selected: 'local', mayAnswer: true, settingsPending: false },
  { selected: 'remote', mayAnswer: true, settingsPending: true },
])('opening $selected after voice removal and answer authority=$mayAnswer while settingsPending=$settingsPending does not produce the remote permission banner', async ({ selected, mayAnswer, settingsPending }) => {
  const hostId = '22222222-2222-4222-8222-222222222222'
  const state = emptyDesktopState(hostId)
  state.host.connected = true
  state.connection = 'connected'
  const sent: string[] = []
  const router = new DesktopHostRouter(emptyDesktopState)
  const localId = '11111111-1111-4111-8111-111111111111'
  const localState = emptyDesktopState(localId)
  localState.host.connected = true
  localState.connection = 'connected'
  localState.configuration = { ...localState.configuration, enabled: true, wakeModelDirectory: 'C:/local/wake', wakeRuntimeDirectory: 'C:/local/runtime' }
  state.configuration = { ...state.configuration, enabled: false, wakeModelDirectory: '', wakeRuntimeDirectory: '' }
  state.host.threads = [{ id: 'thread', projectId: 'project', title: 'Remote thread', modelId: '', status: 'idle', messages: [], requests: [] }]
  router.add({ hostId: localId, kind: 'local', name: 'This computer', detail: () => null, preview: () => null, service: {
    shell: () => localState, subscribe: () => () => undefined,
    command: async (request: AgentCommand) => { sent.push('local:' + request.type); return localState },
  } })
  router.add({ hostId, kind: 'remote', name: 'forge', detail: () => null, preview: () => null, service: {
    shell: () => state, subscribe: () => () => undefined,
    command: async (request: AgentCommand) => {
      sent.push(request.type)
      if (remoteCommandRefusal(request, { mayAnswer })) throw new HostConnectionError(REMOTE_PERMISSION_DENIED, 'forbidden')
      return state
    },
  } })
  router.select(localId)
  vi.stubGlobal('sotto', { agents: agentWireBridge({ get: async () => router.shell(), onState: listener => router.subscribe(listener), command: request => router.command(request, desktopWindowClient()) }) })
  let agents!: ReturnType<typeof useAgents>
  function Room() { agents = useAgents(); return <div role="alert">{agents.state?.error}</div> }
  try {
    render(<AgentProvider settings={settingsPending ? null : { ...DEFAULT_SETTINGS, onboardingComplete: true, voiceCoordinatorEnabled: false }}><Room /></AgentProvider>)
    await waitFor(() => expect(agents.state).not.toBeNull())
    expect(agents.state?.error).toBeNull()
    if (selected === 'remote') {
      await act(async () => { await agents.command({ type: 'select-thread', threadId: hostEntityKey(hostId, 'thread') }) })
    }
    expect(agents).not.toHaveProperty('voice')
    expect(agents).not.toHaveProperty('attention')
    expect(sent.filter(type => type === 'voice' || type === 'local:voice')).toEqual([])
    expect(sent.filter(type => type.endsWith(':voice-state') || type === 'voice-state')).toEqual([])
    expect(agents.state?.error).toBeNull()
  } finally { cleanup(); router.dispose() }
})
