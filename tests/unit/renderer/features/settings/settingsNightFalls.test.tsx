import { baseProps, selectCategory } from '../../../../fixtures/renderer/settingsViewHarness'
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsView } from '../../../../../src/renderer/src/features/settings/SettingsView'

const owl = vi.hoisted(() => ({ on: new Set<string>() }))
vi.mock('../../../../../src/renderer/src/state/owlFeature', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../../src/renderer/src/state/owlFeature')>(),
  useOwlFeature: (id: string) => owl.on.has(id),
}))

afterEach(() => {
  cleanup()
  owl.on = new Set()
})

const nightFallsSwitch = () => screen.queryByRole('switch', { name: /Night falls between Threads and Watcher/ })

describe('SettingsView night falls (Owl night-falls)', () => {
  it.each([[[]], [['watcher']], [['night-falls']]])('shows nothing of it with only %j on', async on => {
    owl.on = new Set(on)
    render(<SettingsView {...baseProps()} />)
    await selectCategory('Appearance')
    expect(nightFallsSwitch()).not.toBeInTheDocument()
    expect(screen.queryByRole('slider', { name: 'Night falls speed' })).not.toBeInTheDocument()
  })

  it('shows the switch and the speed dial with Watcher and night falls on', async () => {
    owl.on = new Set(['watcher', 'night-falls'])
    render(<SettingsView {...baseProps()} />)
    await selectCategory('Appearance')
    expect(nightFallsSwitch()).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: 'Night falls speed' })).toBeInTheDocument()
  })
})
