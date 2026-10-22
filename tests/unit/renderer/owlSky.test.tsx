import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ReleaseTrack } from '../../../src/shared/releaseTrack'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { OWL_SKY_STARS } from '../../../src/renderer/src/agents/OwlSky'
import { agentWireBridge } from '../../fixtures/agentBridge'
import { createBridge, renderApp } from '../../fixtures/renderer/appHarness'
import { threadsStateFixture } from '../../fixtures/renderer/liveAgentState'

const VERSIONS = { stable: '0.1.34', owl: '0.1.35-owl.20261010.1' } as const satisfies Record<ReleaseTrack, string>
const NAMES = { stable: 'Sotto', owl: 'Sotto Owl' } as const satisfies Record<ReleaseTrack, string>

async function renderThreads(track: ReleaseTrack): Promise<HTMLElement> {
  const bridge = createBridge({
    getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })),
    getUpdateStatus: vi.fn(async () => ({ currentVersion: VERSIONS[track], releaseTrack: track, phase: { phase: 'unsupported' as const }, checkedAt: null })),
  })
  const state = threadsStateFixture()
  window.sotto = { ...bridge, agents: agentWireBridge({ get: async () => state, command: async () => state, onState: () => () => undefined }) }
  renderApp(bridge)
  const sidebar = await screen.findByRole('complementary', { name: 'Thread sidebar' })
  // The track arrives with main's update information; the title says when it has.
  await waitFor(() => expect(document.title).toBe(NAMES[track]))
  return sidebar
}

afterEach(() => {
  delete window.sotto
  document.title = ''
})

describe('the Sotto Owl night sky', () => {
  it('is not painted on stable', async () => {
    const sidebar = await renderThreads('stable')
    expect(sidebar).not.toHaveAttribute('data-sky')
    expect(sidebar.querySelector('.thread-nav__sky, .thread-nav__star')).toBeNull()
  })

  it('lies behind an Owl build\'s sidebar header as decoration, and goes with the sidebar when it collapses', async () => {
    const user = userEvent.setup()
    const sidebar = await renderThreads('owl')
    const sky = await waitFor(() => {
      const found = sidebar.querySelector<HTMLElement>('.thread-nav__sky')
      expect(found).not.toBeNull()
      return found!
    })
    expect(sidebar).toHaveAttribute('data-sky')
    // Hidden from assistive technology, nothing in it to reach, and outside the drag strip, so it changes neither
    // the row's names, its Tab order nor the region a press drags.
    expect(sky).toHaveAttribute('aria-hidden', 'true')
    expect(sky.querySelector('a, button, input, [tabindex]')).toBeNull()
    expect(sky.closest('.thread-nav__top')).toBeNull()
    expect(sky.parentElement).toHaveClass('thread-nav__expanded')
    const stars = [...sky.querySelectorAll<HTMLElement>('.thread-nav__star')]
    expect(stars).toHaveLength(11)
    expect(stars.filter(star => star.dataset.ink === 'accent')).toHaveLength(3)
    expect(stars.map(star => star.dataset.twinkle).filter(Boolean).sort()).toEqual(['1', '2', '3', '4'])
    expect(stars.every(star => star.textContent === '' && star.childElementCount === 0)).toBe(true)
    // The row keeps every control it has on stable.
    const row = sidebar.querySelector<HTMLElement>('.thread-nav__top')!
    for (const name of ['Add project', 'Collapse sidebar']) expect(within(row).getByRole('button', { name })).toBeVisible()

    await user.click(within(row).getByRole('button', { name: 'Collapse sidebar' }))
    expect(sidebar).not.toHaveAttribute('data-sky')
    expect(sidebar.querySelector('.thread-nav__sky')).toBeNull()
    await user.click(within(sidebar).getByRole('button', { name: 'Expand sidebar' }))
    expect(sidebar).toHaveAttribute('data-sky')
    expect(sidebar.querySelectorAll('.thread-nav__star')).toHaveLength(11)
  })

  it('keeps its stars in the header strip, in four strengths, with one star on each slow cycle', () => {
    for (const star of OWL_SKY_STARS) {
      // The night is solid to 76 pixels; every star sits within the top row's 44 and clear of the field below it.
      expect(star.top + star.size).toBeLessThanOrEqual(42)
      expect(star.size).toBeLessThanOrEqual(1.6)
    }
    expect(new Set(OWL_SKY_STARS.map(star => star.tier))).toEqual(new Set([1, 2, 3, 4]))
    expect(OWL_SKY_STARS.filter(star => star.twinkle !== undefined)).toHaveLength(4)
  })
})
