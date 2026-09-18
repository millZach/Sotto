import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import type { PersonalChat, PersonalChatBridge, PersonalChatState } from '../../../src/shared/personalChats'
import type { AppContextValue } from '../../../src/renderer/src/state/AppContext'
import { useOptionalApp } from '../../../src/renderer/src/state/AppContext'
import { useOptionalAgents } from '../../../src/renderer/src/agents/AgentContext'
import { PersonalVoice } from '../../../src/renderer/src/agents/personal/PersonalVoice'
import { PersonalDraftStore } from '../../../src/renderer/src/agents/personal/personalDrafts'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'

vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(),
  useOptionalApp: vi.fn(),
}))
vi.mock('../../../src/renderer/src/agents/AgentContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/agents/AgentContext')>(),
  useOptionalAgents: vi.fn(),
}))

const AT = '2026-09-13T17:00:00.000Z'

function chat(): PersonalChat {
  return {
    id: 'trip', kind: 'personal', providerId: 'codex', title: 'Trip ideas', modelId: 'codex:gpt-6-astra',
    createdAt: AT, updatedAt: AT, nativeState: 'ready', status: 'idle', requests: [], submissions: [],
    draft: { revision: 0, text: '', skills: [] }, messages: [],
  }
}

function snapshot(): PersonalChatState {
  return { selectedChatId: 'trip', chats: [chat()], connected: true, connecting: false, availability: { provider: 'codex', supported: true } }
}

/** The whole chat, with the coordinator either shown or hidden for the beta. */
function view(voiceCoordinatorEnabled: boolean): void {
  vi.mocked(useOptionalApp).mockReturnValue({
    settings: { ...DEFAULT_SETTINGS, voiceCoordinatorEnabled },
    dictation: { status: 'idle' },
    actions: { start: vi.fn(), stop: vi.fn() },
  } as unknown as AppContextValue)
  vi.mocked(useOptionalAgents).mockReturnValue({
    state: { configuration: { speechProvider: 'grok' } }, command: vi.fn(async () => null),
    claimPersonalAudio: vi.fn(() => () => undefined), waitForPersonalAudio: vi.fn(async () => undefined),
  } as unknown as ReturnType<typeof useOptionalAgents>)
  render(<PersonalVoice bridge={{} as unknown as PersonalChatBridge} chat={chat()} state={snapshot()} store={new PersonalDraftStore()} />)
}

afterEach(() => { cleanup(); vi.clearAllMocks() })

it('keeps dictation but offers no talk controls while the voice coordinator is hidden', () => {
  view(false)
  expect(screen.getByRole('button', { name: 'Dictate' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Talk' })).toBeNull()
  expect(screen.queryByRole('combobox', { name: 'Chat reply voice' })).toBeNull()
})

it('offers the talk controls again once the voice coordinator is shown', () => {
  view(true)
  expect(screen.getByRole('button', { name: 'Dictate' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Talk' })).toBeEnabled()
  expect(screen.getByRole('combobox', { name: 'Chat reply voice' })).toHaveValue('grok')
})
