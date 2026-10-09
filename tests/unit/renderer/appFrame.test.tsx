import { deferred, createBridge, shell, openPage, renderApp } from '../../fixtures/renderer/appHarness'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { threadsStateFixture } from '../../fixtures/renderer/liveAgentState'
import { platformCopy } from '../../../src/renderer/src/platformCopy'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../src/shared/settings'
import { agentWireBridge } from '../../fixtures/agentBridge'

describe('shared main-window frame', () => {
  it.each([
    {
      name: 'loading',
      createStateBridge: () => createBridge({
        getSettings: vi.fn(() => new Promise<AppSettings>(() => undefined)),
      }),
      stateText: /preparing sotto/i,
    },
    {
      name: 'unavailable',
      createStateBridge: () => createBridge({
        getSettings: vi.fn(async () => { throw new Error('startup failed') }),
      }),
      stateText: /could not finish starting/i,
    },
    {
      name: 'onboarding',
      createStateBridge: () => createBridge(),
      stateText: /dictation, ready when you are/i,
    },
  ])('renders exactly one strip and both window controls in the $name state', async ({
    createStateBridge,
    stateText,
  }) => {
    const { container } = renderApp(createStateBridge())

    await waitFor(() => expect(document.body).toHaveTextContent(stateText))

    expect(container.querySelectorAll('.app-strip')).toHaveLength(1)
    expect(container.querySelectorAll('.app-titlebar, .app-navigation, .dictation-strip')).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Minimize Sotto' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Close Sotto to tray' })).toBeVisible()
  })

  it('seats the Threads sidebar beside Dictate, with the window controls above the room and no strip', async () => {
    const { container } = renderApp(createBridge({
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })),
    }))
    await openPage('home')

    await waitFor(() => expect(document.body).toHaveTextContent(/ready when you are/i))
    expect(container.querySelectorAll('.app-strip')).toHaveLength(0)
    expect(container.querySelectorAll('.app-titlebar, .app-navigation, .dictation-strip')).toHaveLength(0)
    const sidebar = screen.getByRole('complementary', { name: 'Thread sidebar' })
    expect(within(sidebar).getByText('Sotto')).toBeInTheDocument()
    expect(within(sidebar).getByRole('tab', { name: 'Dictate' })).toHaveAttribute('aria-selected', 'true')
    expect(container.querySelector('.app-room__top')).toContainElement(screen.getByRole('button', { name: 'Minimize Sotto' }))
    expect(screen.getByRole('button', { name: 'Close Sotto to tray' })).toBeVisible()
    expect(screen.getByRole('contentinfo')).toHaveTextContent('Add your OpenRouter API key in Settings')
  })

  it('opens on Threads, which owns the whole window and carries the window controls once', async () => {
    const bridge = createBridge({ getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })) })
    const state = threadsStateFixture()
    window.sotto = {
      ...bridge,
      agents: agentWireBridge({ get: async () => state, command: async () => state, onState: () => () => undefined }),
    }
    try {
      const { container } = renderApp(bridge)

      const sidebar = await screen.findByRole('complementary', { name: 'Thread sidebar' })
      expect(sidebar).toBeVisible()
      expect(shell.navigation).toBe('threads')
      expect(container.querySelector('.app-shell')).toHaveClass('app-shell--page')
      expect(container.querySelectorAll('.app-strip')).toHaveLength(0)
      expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument()
      expect(screen.getAllByRole('main')).toHaveLength(1)
      expect(container.querySelectorAll('.app-controls')).toHaveLength(1)
      expect(screen.getByRole('button', { name: 'Minimize Sotto' })).toBeVisible()
      expect(screen.getByRole('button', { name: 'Close Sotto to tray' })).toBeVisible()
    } finally {
      delete window.sotto
    }
  })
})

describe('Sotto application onboarding integration', () => {
  it('renders loading and a finite recovery state when settings cannot load', async () => {
    const settings = deferred<AppSettings>()
    const bridge = createBridge({ getSettings: vi.fn(() => settings.promise) })
    renderApp(bridge)
    expect(screen.getByRole('status')).toHaveTextContent(/preparing sotto/i)

    settings.reject(new Error('private storage detail'))
    await waitFor(() => expect(screen.getByRole('heading', { name: /could not finish starting/i })).toBeVisible())
    expect(document.body).not.toHaveTextContent('private storage detail')
  })

  it('minimizes natively and closes only to the tray without quitting', async () => {
    const user = userEvent.setup()
    const minimizeApp = vi.fn(async () => undefined)
    const hideApp = vi.fn(async () => undefined)
    const quitApp = vi.fn(async () => undefined)
    renderApp(createBridge({
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })),
      minimizeApp,
      hideApp,
      quitApp,
    }))
    await openPage('home')
    await screen.findByRole('heading', { level: 1, name: /ready when you are/i })
    await user.click(screen.getByRole('button', { name: /minimize sotto/i }))
    await user.click(screen.getByRole('button', { name: /close sotto to tray/i }))
    expect(minimizeApp).toHaveBeenCalledOnce()
    expect(hideApp).toHaveBeenCalledOnce()
    expect(quitApp).not.toHaveBeenCalled()
  })
})

describe('transcription pipeline prewarm', () => {
  it('carries the bridge platform into every main-window view', async () => {
    const user = userEvent.setup()
    const copy = platformCopy('darwin')
    renderApp(createBridge({
      platform: 'darwin',
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })),
    }))
    await openPage('home')

    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: /ready when you are/i })).toBeInTheDocument())
    expect(screen.getByRole('contentinfo')).toHaveTextContent('Add your OpenRouter API key in Settings')
    expect(screen.queryByRole('button', { name: /minimize sotto/i })).not.toBeInTheDocument()

    await user.click(screen.getByRole('link', { name: /help/i }))
    expect(screen.getByText(copy.helpMicrophoneAccess)).toBeVisible()
    expect(screen.getByText(copy.accessibilityHelp ?? '')).toBeVisible()

    await user.click(screen.getByRole('link', { name: /settings/i }))
    await user.click(screen.getByRole('tab', { name: 'Application' }))
    expect(await screen.findByRole('switch', { name: copy.settingsLaunchAtStartupLabel })).toBeVisible()
  })
})
