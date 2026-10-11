import { cloudIphoneBridgeFixture, cloudStatus } from '../../fixtures/renderer/cloudIphoneBridge'
import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloudIphoneSettings } from '../../../src/renderer/src/features/settings/CloudIphoneSettings'
import { CloudIphoneStore } from '../../../src/renderer/src/tools/cloudIphoneStore'
import type { CloudIphoneStatus } from '../../../src/shared/cloudIphone'
import type { ToolsResult } from '../../../src/shared/tools'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'

const ok = <T,>(value: T): ToolsResult<T> => ({ ok: true, value })

const status = (patch: Partial<CloudIphoneStatus> = {}): CloudIphoneStatus => cloudStatus({ keySaved: false, ...patch })

function fakeBridge(initial: CloudIphoneStatus) {
  let current = initial
  const published = cloudIphoneBridgeFixture({ commands: {
    status: vi.fn(async () => ok(current)),
    setKey: vi.fn(async ({ value }) => {
      if (value === 'bad-key') return ok({ saved: false, problem: 'run.cloud rejected this key.' })
      current = { ...current, keySaved: Boolean(value) }
      return ok({ saved: true, problem: null })
    }),
    sessions: vi.fn(async () => ok([])),
    answer: vi.fn(),
    end: vi.fn(),
    mount: vi.fn(async () => ok(undefined)),
  } })
  return published.bridge
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function setup(initial: CloudIphoneStatus = status(), update: (patch: Record<string, unknown>) => Promise<boolean> = vi.fn(async () => true)) {
  const bridge = fakeBridge(initial)
  const store = new CloudIphoneStore()
  const onUpdateSettings = vi.fn(update)
  render(<CloudIphoneSettings settings={DEFAULT_SETTINGS} onUpdateSettings={onUpdateSettings as never} bridge={bridge} store={store} />)
  return { bridge, onUpdateSettings }
}

describe('Settings > Cloud iPhone', () => {
  it('saves a key, checked with run.cloud, and shows it saved', async () => {
    const { bridge } = setup()
    const input = await screen.findByLabelText('Key')
    await userEvent.type(input, 'a-real-key')
    await userEvent.click(screen.getByRole('button', { name: 'Save key' }))
    await waitFor(() => expect(bridge.setKey).toHaveBeenCalledWith({ value: 'a-real-key' }))
    expect(await screen.findByText('Key saved.')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Replace key' })).toBeInTheDocument()
  })

  it('shows run.cloud’s rejection and does not treat the key as saved', async () => {
    setup()
    const input = await screen.findByLabelText('Key')
    await userEvent.type(input, 'bad-key')
    await userEvent.click(screen.getByRole('button', { name: 'Save key' }))
    expect(await screen.findByText('run.cloud rejected this key.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Replace key' })).toBeNull()
  })

  it('removes a saved key', async () => {
    const { bridge } = setup(status({ keySaved: true }))
    await screen.findByRole('button', { name: 'Replace key' })
    await userEvent.click(screen.getByRole('button', { name: 'Remove key' }))
    await waitFor(() => expect(bridge.setKey).toHaveBeenCalledWith({ value: '' }))
    expect(await screen.findByText('Key removed.')).toBeInTheDocument()
  })

  it('shows this month’s minutes against the cap with a meter', async () => {
    setup(status({ monthMinutes: 38, capMinutes: 750 }))
    await screen.findByText('38 of 750 minutes')
    const meter = screen.getByRole('meter', { name: 'Cloud iPhone minutes used this month' })
    expect(meter).toHaveAttribute('aria-valuenow', '38')
    expect(meter).toHaveAttribute('aria-valuemax', '750')
  })

  it('rejects an out-of-range monthly cap without saving', async () => {
    const { onUpdateSettings } = setup()
    const input = screen.getByLabelText('Monthly cap')
    await userEvent.clear(input)
    await userEvent.type(input, '5')
    await userEvent.tab()
    expect(await screen.findByText('Enter a whole number between 10 and 100000.')).toBeInTheDocument()
    expect(onUpdateSettings).not.toHaveBeenCalled()
  })

  it('saves a valid monthly cap', async () => {
    const { onUpdateSettings } = setup()
    const input = screen.getByLabelText('Monthly cap')
    await userEvent.clear(input)
    await userEvent.type(input, '1000')
    await userEvent.tab()
    await waitFor(() => expect(onUpdateSettings).toHaveBeenCalledWith({ cloudIphoneMonthlyMinutes: 1000 }))
  })

  it('saves a valid idle timeout', async () => {
    const { onUpdateSettings } = setup()
    const input = screen.getByLabelText('Idle sessions end after')
    await userEvent.clear(input)
    await userEvent.type(input, '10')
    await userEvent.tab()
    await waitFor(() => expect(onUpdateSettings).toHaveBeenCalledWith({ cloudIphoneIdleMinutes: 10 }))
  })

  it('shows recent sessions, or says there are none', async () => {
    setup(status({ recent: [{ threadId: 'workshop', threadTitle: 'Workshop', startedAt: Date.parse('2026-10-03T12:00:00Z'), minutes: 11 }] }))
    expect(await screen.findByText('Workshop')).toBeInTheDocument()
    expect(screen.getByText('11 min')).toBeInTheDocument()
  })

  it('says there are no sessions yet', async () => {
    setup(status({ recent: [] }))
    expect(await screen.findByText('No sessions yet.')).toBeInTheDocument()
  })
})
