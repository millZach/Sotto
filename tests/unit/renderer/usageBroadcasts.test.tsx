import React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useOptionalAgents } from '../../../src/renderer/src/agents/AgentContext'
import { UsageView } from '../../../src/renderer/src/features/usage/UsageView'
import { presentUsage, scopeHost } from '../../../src/renderer/src/features/usage/usagePresentation'
import { liveAgentState, threadsStateFixture } from '../../fixtures/renderer/liveAgentState'
import { USAGE_NOW, USAGE_ZONE, dashboard, fixtureBridge } from '../../fixtures/renderer/usageReads'

vi.mock('../../../src/renderer/src/agents/AgentContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/agents/AgentContext')>(),
  useOptionalAgents: vi.fn(),
}))
vi.mock('../../../src/renderer/src/features/usage/usagePresentation', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/renderer/src/features/usage/usagePresentation')>()
  return { ...actual, presentUsage: vi.fn(actual.presentUsage), scopeHost: vi.fn(actual.scopeHost) }
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('Usage broadcast computations', () => {
  it.each([['In Sotto', 'sotto'], ['Outside Sotto', 'outside']])('retains the %s summary through unrelated agent broadcasts', async (label, source) => {
    const live = liveAgentState(threadsStateFixture())
    vi.mocked(useOptionalAgents).mockImplementation(live.useLive)
    const bridge = fixtureBridge(dashboard())
    render(<UsageView bridge={bridge} now={() => USAGE_NOW} timeZone={USAGE_ZONE} computers={[{ hostId: 'laptop', name: 'Laptop', kind: 'local' }]} />)
    const user = userEvent.setup()
    await screen.findByRole('tablist', { name: 'Usage measures' })
    await user.click(screen.getByRole('button', { name: 'Where: Everywhere' }))
    await user.click(screen.getByRole('option', { name: label }))
    await waitFor(() => expect(bridge.reads.at(-1)?.sources).toEqual([source]))
    vi.mocked(scopeHost).mockClear()
    vi.mocked(presentUsage).mockClear()
    const reads = bridge.reads.length

    for (let index = 0; index < 10; index++) act(() => { live.publish({ activeThreadId: `unrelated-${index}` }) })
    expect(scopeHost).not.toHaveBeenCalled()
    expect(presentUsage).not.toHaveBeenCalled()
    expect(bridge.reads).toHaveLength(reads)

    await user.click(screen.getByRole('button', { name: `Where: ${label}` }))
    await user.click(screen.getByRole('option', { name: 'Everywhere' }))
    expect(scopeHost).toHaveBeenCalled()
    expect(presentUsage).toHaveBeenCalled()
    await waitFor(() => expect(bridge.reads.at(-1)?.sources).toBeUndefined())
  })
})
