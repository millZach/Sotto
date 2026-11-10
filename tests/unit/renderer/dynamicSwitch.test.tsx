import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentState, AgentThread } from '../../../src/shared/agents'
import { DEFAULT_DYNAMIC_THREADS } from '../../../src/shared/dynamicThreads'
import { useDynamicSwitch, useNewThreadsDynamicSwitch } from '../../../src/renderer/src/agents/DynamicSwitch'
import { useOptionalApp } from '../../../src/renderer/src/state/AppContext'

vi.mock('../../../src/renderer/src/state/AppContext', () => ({ useOptionalApp: vi.fn() }))

const state = { host: { models: [] } } as unknown as AgentState
const command = vi.fn(async () => null)
const updateSettings = vi.fn(async () => true)
const thread = { id: 'dynamic', providerId: 'claude', nativeSessionStarted: true } as AgentThread

function ThreadSwitch({ fixed = false, dynamic = false }: { fixed?: boolean; dynamic?: boolean }): React.ReactNode {
  const view = useDynamicSwitch({ thread: { ...thread, ...dynamic ? { dynamic: true } : {} }, state, command, modelName: 'Opus', fixed })
  return <>{view.foot?.(() => undefined)}{view.dialog}</>
}

function NewThreadsSwitch(): React.ReactNode {
  const view = useNewThreadsDynamicSwitch({ state, provider: 'claude', modelName: 'Opus' })
  return <>{view.foot?.(() => undefined)}{view.dialog}</>
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(useOptionalApp).mockReturnValue({
    update: { owlFeatures: { 'dynamic-threads': true } },
    settings: { dynamicThreads: { ...DEFAULT_DYNAMIC_THREADS, providers: ['claude'] } },
    actions: { updateSettings },
  } as unknown as NonNullable<ReturnType<typeof useOptionalApp>>)
})
afterEach(cleanup)

describe('the one-row Dynamic switch', () => {
  it.each([false, true])('keeps an idle thread concise with Dynamic %s and still switches it', dynamic => {
    render(<ThreadSwitch dynamic={dynamic} />)
    const toggle = screen.getByRole('switch', { name: 'Dynamic' })
    expect(toggle).toHaveTextContent(/^Dynamic$/u)
    expect(toggle).not.toHaveAttribute('aria-describedby')
    expect(toggle).toHaveAttribute('aria-checked', String(dynamic))
    fireEvent.click(toggle)
    expect(command).toHaveBeenCalledWith({ type: 'set-thread-dynamic', threadId: 'dynamic', dynamic: !dynamic })
  })

  it('keeps the reason accessible while a turn prevents switching', () => {
    render(<ThreadSwitch fixed />)
    const toggle = screen.getByRole('switch', { name: 'Dynamic' })
    expect(toggle).toBeDisabled()
    expect(toggle).toHaveAccessibleDescription('It can change once this turn finishes.')
    fireEvent.click(toggle)
    expect(command).not.toHaveBeenCalled()
  })

  it('uses the same concise switch for new threads without changing the allowed providers', () => {
    render(<NewThreadsSwitch />)
    const toggle = screen.getByRole('switch', { name: 'Dynamic' })
    expect(toggle).toHaveTextContent(/^Dynamic$/u)
    expect(toggle).not.toHaveAttribute('aria-describedby')
    fireEvent.click(toggle)
    expect(updateSettings).toHaveBeenCalledWith({ dynamicThreads: { ...DEFAULT_DYNAMIC_THREADS, providers: ['claude'], newThreads: true } })
  })
})
