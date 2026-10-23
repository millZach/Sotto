import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type AgentCommand, type AgentState } from '../../../src/shared/agents'
import { useAddProject } from '../../../src/renderer/src/agents/addProject'
import { threadsStateFixture } from '../../fixtures/renderer/liveAgentState'

const grok = { id: 'native:grok:model:grok-4.6', name: 'Grok 4.6', provider: 'Grok Build', providerId: 'grok' as const, ready: true }
function fixture(): AgentState {
  const state = threadsStateFixture()
  state.configuration = { ...state.configuration, provider: 'codex', reasoning: 'claude', reasoningModel: 'opus', defaultModelId: grok.id }
  state.host.models = [grok]
  return state
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

/** Add project, through the folder browser's File Explorer button, which answers with the stubbed folder. */
async function addWithExplorer(state: AgentState, command: (request: AgentCommand) => Promise<AgentState | null>) {
  function AddProject() {
    const addProject = useAddProject(state, command)
    return <><button type="button" onClick={() => void addProject.add()}>Add project</button>{addProject.dialog}</>
  }
  render(<AddProject />)
  fireEvent.click(screen.getByRole('button', { name: 'Add project' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Browse with File Explorer' }))
}

describe('inherited agent in folder registration', () => {
  it('registers the selected folder with the native agent even when its selected model is missing', async () => {
    const state = fixture()
    vi.stubGlobal('sotto', { agents: { chooseProjectDirectory: vi.fn(async () => 'C:/new-folder') } })
    const command = vi.fn(async () => state)
    await addWithExplorer(state, command)
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'create-project', title: 'new-folder', path: 'C:/new-folder', useExisting: true, provider: 'claude' }))
  })

  it('selects an existing folder without moving it to the inherited provider', async () => {
    const state = fixture()
    const project = state.host.projects[0]!
    vi.stubGlobal('sotto', { agents: { chooseProjectDirectory: vi.fn(async () => project.path) } })
    const command = vi.fn(async () => state)
    await addWithExplorer(state, command)
    await waitFor(() => expect(command).toHaveBeenCalledExactlyOnceWith({ type: 'select-project', projectId: project.id }))
  })
})
