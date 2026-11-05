import React from 'react'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentState } from '../../../src/shared/agents'
import { E2E_THREADS_NOW as NOW } from '../../../src/shared/e2e'
import { describeThreads, organizeWorkspace } from '../../../src/renderer/src/agents/threadFacts'
import { FOLDER_TOGGLES_KEY, ThreadSidebar } from '../../../src/renderer/src/agents/ThreadSidebar'
import { useOptionalApp, type AppContextValue } from '../../../src/renderer/src/state/AppContext'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { threadsStateFixture } from '../../fixtures/renderer/liveAgentState'

/**
 * Zach's pick B of November 5, 2026 (ADR-0135): while Needs you stands, a waiting thread's row in its folder reads In Needs
 * you with its ring at rest, and pointing at the row or its entry lights the other.
 */
vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(), useOptionalApp: vi.fn() }))

function owl(queue: boolean, settings: Record<string, unknown> = {}): void {
  vi.mocked(useOptionalApp).mockReturnValue({ navigation: 'threads', platform: 'win32', settings: { ...DEFAULT_SETTINGS, ...settings },
    actions: { navigate: vi.fn() }, update: { currentVersion: '0.1.40', phase: { phase: 'up-to-date' }, checkedAt: null, owlFeatures: { 'needs-you-queue': queue } } } as unknown as AppContextValue)
}
function atWindowWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  fireEvent(window, new Event('resize'))
}
beforeEach(() => { vi.mocked(useOptionalApp).mockReset(); localStorage.removeItem('sotto.threadWorkspace.sidebar'); sessionStorage.setItem(FOLDER_TOGGLES_KEY, JSON.stringify(['open:workshop'])) })
afterEach(() => { cleanup(); atWindowWidth(1024); localStorage.removeItem('sotto.threadWorkspace.sidebar'); sessionStorage.removeItem(FOLDER_TOGGLES_KEY) })

function mount(state: AgentState = threadsStateFixture()) {
  const onOpen = vi.fn()
  render(<ThreadSidebar state={state} organization={organizeWorkspace(state, describeThreads(state, NOW), '', state.activeProjectId, false, NOW)}
    command={vi.fn(async () => state)} query="" onQuery={vi.fn()} onOpen={onOpen} onNewThread={vi.fn()} shortcutsLive
    currentThreadId={null} openThreadIds={[]} onOpenBeside={vi.fn()} onDragThread={vi.fn()} />)
  return { onOpen }
}
const sidebar = (): HTMLElement => document.querySelector<HTMLElement>('aside.thread-nav')!

describe('a waiting thread said once, in Needs you (ADR-0135, November 5, 2026)', () => {
  const row = (title: string): HTMLElement => within(document.querySelector<HTMLElement>('.thread-folder')!).getByRole('button', { name: title }).closest('li')!
  const entry = (title: string): HTMLElement => within(document.querySelector<HTMLElement>('.needs-you')!).getByRole('button', { name: `Open ${title}` }).closest('li')!

  it('rests the row in its folder and has it read In Needs you, with the need kept for a screen reader', () => {
    owl(true)
    mount()
    const waiting = row('Visual gate flake')
    expect(waiting).toHaveAttribute('data-in-queue', 'visual-gate')
    expect(waiting.querySelector('.thread-nav__ring')).toHaveAttribute('data-queued')
    expect(waiting.querySelector('.thread-nav__ring')).not.toHaveAttribute('data-state')
    const status = waiting.querySelector('.thread-nav__status')!
    expect(status).not.toHaveAttribute('data-state', 'needs')
    expect(status).toHaveTextContent('In Needs you')
    expect(status).toHaveTextContent('Needs your approval')
    expect(status).toHaveAttribute('title', 'Needs your approval')
    // A row whose thread does not wait keeps its own words.
    expect(row('Grok voice previews').querySelector('.thread-nav__status')).not.toHaveTextContent('In Needs you')
  })

  it('says the need on the row as before while the card is off', () => {
    owl(false)
    mount()
    const waiting = row('Visual gate flake')
    expect(waiting).not.toHaveAttribute('data-in-queue')
    expect(waiting.querySelector('.thread-nav__status')).toHaveAttribute('data-state', 'needs')
  })

  it('lights the entry when the row is pointed at, and the row when the entry is', () => {
    owl(true)
    mount()
    fireEvent.pointerOver(within(row('Visual gate flake')).getByRole('button', { name: 'Visual gate flake' }))
    expect(entry('Visual gate flake')).toHaveAttribute('data-peer')
    expect(row('Visual gate flake')).not.toHaveAttribute('data-peer')
    fireEvent.pointerOver(entry('Visual gate flake'))
    expect(row('Visual gate flake')).toHaveAttribute('data-peer')
    expect(entry('Visual gate flake')).not.toHaveAttribute('data-peer')
    fireEvent.pointerOver(within(row('Grok voice previews')).getByRole('button', { name: 'Grok voice previews' }))
    expect(document.querySelector('[data-peer]')).toBeNull()
    fireEvent.pointerOver(entry('Visual gate flake'))
    fireEvent.pointerLeave(sidebar())
    expect(document.querySelector('[data-peer]')).toBeNull()
  })
})
