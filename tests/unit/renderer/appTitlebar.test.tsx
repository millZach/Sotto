import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'

import { AppTitlebar } from '../../../src/renderer/src/components/AppTitlebar'
import {
  AppProvider,
  type AppControllerFactory,
} from '../../../src/renderer/src/state/AppContext'
import type { SottoBridge } from '../../../src/shared/contracts'
import type { SottoPlatform } from '../../../src/shared/platform'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'

const OK = Object.freeze({ ok: true as const })

afterEach(cleanup)

function createBridge(platform: SottoPlatform): SottoBridge {
  return {
    platform,
    listRecoveryNotices: vi.fn(async () => []),
    onRecoveryNotice: vi.fn(() => () => undefined),
    getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS })),
    updateSettings: vi.fn(async (patch) => ({ ...DEFAULT_SETTINGS, ...patch })),
    resetSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS })),
    onSettingsChanged: vi.fn(() => () => undefined),
    listHistory: vi.fn(async () => []),
    addHistory: vi.fn(async (entry) => [entry]),
    searchHistory: vi.fn(async () => []),
    deleteHistory: vi.fn(async () => true),
    clearHistory: vi.fn(async () => undefined),
    getHotkey: vi.fn(async () => DEFAULT_SETTINGS.hotkey),
    replaceHotkey: vi.fn(async () => OK),
    requestDictation: vi.fn(async () => OK),
    onDictationCommand: vi.fn(() => () => undefined),
    publishWidgetState: vi.fn(async () => OK),
    getModelStatus: vi.fn(async (preset) => ({ preset, state: 'ready' as const })),
    listModelDisclosures: vi.fn(async () => ({
      ok: false as const,
      reason: 'unavailable' as const,
    })),
    installModel: vi.fn(async () => OK),
    removeModel: vi.fn(async () => OK),
    onModelStatus: vi.fn(() => () => undefined),
    deliverOutput: vi.fn(async () => 'copied' as const),
    polishTranscript: vi.fn(async (request) => ({
      text: request.text,
      applied: false,
    })),
    getStartup: vi.fn(async () => ({ enabled: false })),
    setStartup: vi.fn(async (enabled) => ({ enabled })),
    showApp: vi.fn(async () => undefined),
    hideApp: vi.fn(async () => undefined),
    minimizeApp: vi.fn(async () => undefined),
    quitApp: vi.fn(async () => undefined),
  }
}

const createController: AppControllerFactory = () => ({
  getState: () => ({ status: 'idle' }),
  start: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
  toggle: vi.fn(async () => undefined),
  cancel: vi.fn(async () => undefined),
  dispose: vi.fn(),
})

async function renderTitlebar(platform: SottoPlatform) {
  const onMinimize = vi.fn()
  const onClose = vi.fn()
  let container!: HTMLElement
  await act(async () => {
    container = render(
      <AppProvider bridge={createBridge(platform)} createController={createController}>
        <AppTitlebar onMinimize={onMinimize} onClose={onClose} />
      </AppProvider>,
    ).container
  })
  return { container, onClose, onMinimize }
}

it('renders Sotto branding and invokes tray-safe controls', async () => {
  const user = userEvent.setup()
  const { container, onClose, onMinimize } = await renderTitlebar('win32')

  expect(screen.getByLabelText('Sotto application')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Minimize Sotto' }))
  await user.click(screen.getByRole('button', { name: 'Close Sotto to tray' }))

  expect(onMinimize).toHaveBeenCalledOnce()
  expect(onClose).toHaveBeenCalledOnce()
  expect(container.querySelector('.app-titlebar')?.className).toBe('app-titlebar')
})

it('leaves window controls to the native traffic lights on macOS', async () => {
  const { container } = await renderTitlebar('darwin')

  expect(screen.getByLabelText('Sotto application')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Minimize Sotto' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Close Sotto to tray' })).not.toBeInTheDocument()
  expect(container.querySelector('.app-titlebar__controls')).toBeNull()
  expect(container.querySelector('.app-titlebar')).toHaveClass('app-titlebar--mac')
})

it('reserves the traffic-light inset in the stylesheet', () => {
  const css = readFileSync(join(process.cwd(), 'src/renderer/src/styles/global.css'), 'utf8')

  expect(css).toMatch(/\.app-titlebar--mac\s*\{[^}]*padding-left:\s*78px;/su)
})
