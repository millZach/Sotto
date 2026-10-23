import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessage } from '../../../src/shared/agents'
import { RESUME_NOTE } from '../../../src/shared/restartResume'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { MessageList, type ActivityContext } from '../../../src/renderer/src/agents/ThreadTranscript'
import { placeActivities } from '../../../src/renderer/src/agents/threadActivityView'
import { SettingsView } from '../../../src/renderer/src/features/settings/SettingsView'
import { useOptionalApp, type AppContextValue } from '../../../src/renderer/src/state/AppContext'
import { baseProps, selectCategory } from '../../fixtures/renderer/settingsViewHarness'

vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(), useOptionalApp: vi.fn() }))

/** Resuming threads after a restart (ADR-0076) as the window shows it, only where the Owl list turns it on. */
function owl(on: boolean): void {
  vi.mocked(useOptionalApp).mockReturnValue(on ? { update: { currentVersion: '0.1.37-owl.20261012.1', phase: { phase: 'up-to-date' }, checkedAt: null,
    owlFeatures: { watcher: true, 'resume-after-restart': true, 'update-all': true } } } as unknown as AppContextValue : null)
}
afterEach(() => { cleanup(); vi.clearAllMocks() })

const context: ActivityContext = { liveTurn: null, running: false, connected: true, provider: 'claude', onDisclosure: () => undefined }
function transcript(messages: AgentMessage[]) {
  render(<MessageList messages={messages} provider="Claude Code" running={false} placement={placeActivities(messages, messages, [])} context={context} />)
}
const note = (patch: Partial<AgentMessage> = {}): AgentMessage => ({ id: 'r1', role: 'user', text: RESUME_NOTE, createdAt: '2026-10-12T21:00:00.000Z', wakeUp: true, ...patch })

describe('a resume note in the thread', () => {
  it('is Sotto’s, tagged Resumed, with every word the provider received', () => {
    owl(true)
    transcript([note()])
    const message = document.querySelector('.thread-message')!
    expect(message).toHaveAttribute('data-from', 'sotto')
    expect(within(message.querySelector('header') as HTMLElement).getByText('Resumed')).toBeVisible()
    expect(message).toHaveTextContent(RESUME_NOTE)
  })

  it('stays the user’s when the same words come without the host’s mark', () => {
    owl(true)
    transcript([note({ wakeUp: undefined })])
    const header = document.querySelector('.thread-message header')!
    expect(header).toHaveTextContent('You')
    expect(header).not.toHaveTextContent('Resumed')
  })

  it('is a plain wake-up where the Owl list keeps the feature off', () => {
    owl(false)
    transcript([note()])
    expect(document.querySelector('.thread-message header')).toHaveTextContent('Wake-up')
  })
})

describe('Resume threads after a restart in Settings', () => {
  it('sits with what happens in a thread, after Generated thread titles, on by default, and says what each value does', async () => {
    owl(true)
    const user = userEvent.setup()
    const update = vi.fn(async () => true)
    const view = render(<SettingsView {...baseProps({ onUpdateSettings: update })} />)
    await selectCategory('Threads')
    const toggle = screen.getByRole('switch', { name: 'Resume threads after a restart' })
    expect(toggle).toBeChecked()
    expect(toggle).toHaveAccessibleDescription('A thread working when Sotto closes, for an update, a quit, a crash or a restart, carries on when Sotto opens again, with a short note from Sotto in the thread.')
    const switches = screen.getAllByRole('switch').map(item => item.getAttribute('aria-label'))
    expect(switches.indexOf('Resume threads after a restart')).toBe(switches.indexOf('Generated thread titles') + 1)
    await user.click(toggle)
    expect(update).toHaveBeenCalledWith({ resumeThreadsAfterRestart: false })
    view.rerender(<SettingsView {...baseProps({ onUpdateSettings: update, settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, resumeThreadsAfterRestart: false } })} />)
    expect(screen.getByRole('switch', { name: 'Resume threads after a restart' })).toHaveAccessibleDescription('A thread working when Sotto closes waits for your next message.')
  })

  it('is not there where the Owl list keeps the feature off', async () => {
    owl(false)
    render(<SettingsView {...baseProps()} />)
    await selectCategory('Threads')
    expect(screen.queryByRole('switch', { name: 'Resume threads after a restart', hidden: true })).toBeNull()
  })
})
