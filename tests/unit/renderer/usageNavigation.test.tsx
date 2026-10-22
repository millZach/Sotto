import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppShell, layoutFor } from '../../../src/renderer/src/components/AppShell'
import { PageLinks } from '../../../src/renderer/src/agents/SidebarFrame'

const gate = vi.hoisted(() => ({ usage: false }))
vi.mock('../../../src/renderer/src/state/owlFeature', () => ({ useOwlFeature: (id: string) => id === 'usage' && gate.usage }))
afterEach(() => { cleanup(); gate.usage = false })

describe('Usage navigation', () => {
  it.each([true, false])('asks the feature answer before adding a page link (%s)', enabled => {
    gate.usage = enabled
    render(<><AppShell navigation="help" platform="win32" onMaximize={() => undefined} onMinimize={() => undefined} onClose={() => undefined}><p>Room</p></AppShell><PageLinks className="pages" linkClassName="page" /></>)
    expect(screen.queryAllByRole('link', { name: 'Usage' })).toHaveLength(enabled ? 2 : 0)
  })
  it('uses the existing sidebar beside Usage and the Threads page when its feature is hidden', () => {
    expect(layoutFor('usage', false)).toBe('sidebar')
    expect(layoutFor('usage', true)).toBe('page')
  })
})
