import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ReleaseTrack } from '../../../src/shared/releaseTrack'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { agentWireBridge } from '../../fixtures/agentBridge'
import { createBridge, openPage, renderApp, shell } from '../../fixtures/renderer/appHarness'
import type { AppNavigation } from '../../../src/renderer/src/state/AppContext'
import { threadsStateFixture } from '../../fixtures/renderer/liveAgentState'

const VERSIONS = { stable: '0.1.34', owl: '0.1.37-owl.20261011.1' } as const satisfies Record<ReleaseTrack, string>
const NAMES = { stable: 'Sotto', owl: 'Sotto Owl' } as const satisfies Record<ReleaseTrack, string>

function trackBridge(track: ReleaseTrack, onboardingComplete: boolean, platform: 'win32' | 'darwin' = 'win32') {
  return createBridge({
    platform,
    getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete })),
    getUpdateStatus: vi.fn(async () => ({
      currentVersion: VERSIONS[track], releaseTrack: track, phase: { phase: 'unsupported' as const }, checkedAt: null,
    })),
  })
}

/** The brand at the start of a sidebar top row or the strip: the mark beside "Sotto", or Sotto Owl's tile alone. */
async function expectBrand(row: () => HTMLElement, track: ReleaseTrack): Promise<void> {
  if (track === 'owl') {
    const tile = await waitFor(() => within(row()).getByRole('img', { name: 'Sotto Owl' }))
    // The real mark, alone, at the tile's size: no wordmark beside it.
    expect(tile.querySelectorAll('svg')).toHaveLength(1)
    expect(tile.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(tile.firstElementChild).toHaveClass(row().classList.contains('app-strip') ? 'app-mark__tile' : 'thread-nav__tile')
    expect(tile).toHaveTextContent(/^$/)
    expect(within(row()).queryByLabelText('Sotto application')).toBeNull()
    return
  }
  const brand = await waitFor(() => within(row()).getByLabelText('Sotto application'))
  expect(brand).toHaveTextContent(/^Sotto$/)
  expect(within(row()).queryByRole('img', { name: 'Sotto Owl' })).toBeNull()
}

/** Sotto opens on Threads, so the first page is reached through openPage and the rest straight from wherever it is. */
function go(destination: AppNavigation): void {
  act(() => shell.navigate(destination))
}

const topRow = (): HTMLElement => screen.getByRole('complementary', { name: 'Thread sidebar' }).querySelector<HTMLElement>('.thread-nav__top')!

afterEach(() => {
  delete window.sotto
  document.title = ''
})

describe.each(['stable', 'owl'] as const)('the %s build names itself', (track) => {
  it('in the sidebar top row on Threads, Dictate, Help and Settings, and in the window title', async () => {
    const user = userEvent.setup()
    const bridge = trackBridge(track, true)
    const state = threadsStateFixture()
    window.sotto = { ...bridge, agents: agentWireBridge({ get: async () => state, command: async () => state, onState: () => () => undefined }) }
    renderApp(bridge)

    await screen.findByRole('complementary', { name: 'Thread sidebar' })
    await expectBrand(topRow, track)
    // The toolbar beside the brand keeps every control it has on the other track.
    for (const name of ['Add project', 'Collapse sidebar']) expect(within(topRow()).getByRole('button', { name })).toBeVisible()
    await waitFor(() => expect(document.title).toBe(NAMES[track]))

    await openPage('home')
    await screen.findByRole('heading', { level: 1, name: /ready when you are/i })
    await expectBrand(topRow, track)

    go('help')
    await screen.findByRole('heading', { level: 1, name: 'Help' })
    await expectBrand(topRow, track)
    const about = document.querySelector('.help-about')!
    expect(about.textContent).toMatch(new RegExp(`^${NAMES[track]} ${VERSIONS[track].replaceAll('.', '\\.')}, Windows\\. No account with Sotto`))
    // An Owl version is one word on the line, never broken at its hyphen; stable keeps the line as it was.
    if (track === 'owl') expect(about.querySelector('.help-about__version')).toHaveTextContent(/^0\.1\.37-owl\.20261011\.1$/)
    else expect(about.querySelector('.help-about__version')).toBeNull()

    go('settings')
    await screen.findByRole('heading', { level: 1, name: 'Settings' })
    // The Settings column wears the sidebar's frame, its top row included.
    await expectBrand(() => document.querySelector<HTMLElement>('.settings-sidebar .thread-nav__top')!, track)
    await user.click(screen.getByRole('tab', { name: 'Application' }))
    expect(screen.getByText(`${NAMES[track]} ${VERSIONS[track]}`)).toHaveClass('settings-update-version')
    expect(document.title).toBe(NAMES[track])
  })

  it('in the strip over first-run setup', async () => {
    renderApp(trackBridge(track, false))
    await screen.findByRole('heading', { name: /talk to your computer and your coding agents/i })
    await expectBrand(() => screen.getByRole('banner'), track)
    await waitFor(() => expect(document.title).toBe(NAMES[track]))
  })
})

/** No mark sits beside the traffic lights, in either track: the row's left end stays empty. */
function expectNoCornerBrand(row: () => HTMLElement): void {
  expect(within(row()).queryByLabelText('Sotto application')).toBeNull()
  expect(within(row()).queryByRole('img', { name: 'Sotto Owl' })).toBeNull()
  expect(row().querySelector('svg[data-tile]')).toBeNull()
}

describe.each(['stable', 'owl'] as const)('the %s build on macOS', (track) => {
  it('shows no mark beside the traffic lights in the sidebar top row, the Settings column or the collapsed rail', async () => {
    const user = userEvent.setup()
    const bridge = trackBridge(track, true, 'darwin')
    const state = threadsStateFixture()
    window.sotto = { ...bridge, agents: agentWireBridge({ get: async () => state, command: async () => state, onState: () => () => undefined }) }
    renderApp(bridge)

    await screen.findByRole('complementary', { name: 'Thread sidebar' })
    expectNoCornerBrand(topRow)
    for (const name of ['Add project', 'Collapse sidebar']) expect(within(topRow()).getByRole('button', { name })).toBeVisible()
    await waitFor(() => expect(document.title).toBe(NAMES[track]))

    await openPage('settings')
    await screen.findByRole('heading', { level: 1, name: 'Settings' })
    expectNoCornerBrand(() => document.querySelector<HTMLElement>('.settings-sidebar .thread-nav__top')!)

    go('threads')
    await screen.findByRole('button', { name: 'Collapse sidebar' })
    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    const rail = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('.thread-nav__rail')
      expect(found).not.toBeNull()
      return found!
    })
    expect(rail.querySelector('svg[data-tile]')).toBeNull()
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeVisible()
  })

  it('shows no mark in the strip over first-run setup', async () => {
    renderApp(trackBridge(track, false, 'darwin'))
    await screen.findByRole('heading', { name: /talk to your computer and your coding agents/i })
    expectNoCornerBrand(() => screen.getByRole('banner'))
    await waitFor(() => expect(document.title).toBe(NAMES[track]))
  })
})
