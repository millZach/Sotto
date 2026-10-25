import { baseProps, selectCategory } from '../../../../fixtures/renderer/settingsViewHarness'
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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

const nightFallsSwitch = () => screen.queryByRole('switch', { name: /Night falls between Dictate or Threads and Watcher/ })

describe('SettingsView night falls (Owl night-falls)', () => {
  it.each([[[]], [['watcher']], [['night-falls']]])('shows nothing of it with only %j on', async on => {
    owl.on = new Set(on)
    render(<SettingsView {...baseProps()} />)
    await selectCategory('Appearance')
    expect(nightFallsSwitch()).not.toBeInTheDocument()
    expect(screen.queryByRole('slider', { name: 'Night falls speed' })).not.toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: 'Night falls look' })).not.toBeInTheDocument()
  })

  it('shows the switch and the speed dial with Watcher and night falls on', async () => {
    owl.on = new Set(['watcher', 'night-falls'])
    render(<SettingsView {...baseProps()} />)
    await selectCategory('Appearance')
    expect(nightFallsSwitch()).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: 'Night falls speed' })).toBeInTheDocument()
  })

  it('sets the look between the switch and the dial, Band chosen by default, each choice with its own line', async () => {
    owl.on = new Set(['watcher', 'night-falls'])
    render(<SettingsView {...baseProps()} />)
    await selectCategory('Appearance')
    const group = screen.getByRole('radiogroup', { name: 'Night falls look' })
    const order = (a: Element, b: Element): boolean => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    expect(order(nightFallsSwitch()!, group)).toBe(true)
    expect(order(group, screen.getByRole('slider', { name: 'Night falls speed' }))).toBe(true)
    const band = screen.getByRole('radio', { name: 'Band' }), stars = screen.getByRole('radio', { name: 'Stars' })
    expect(band).toHaveAttribute('aria-checked', 'true')
    expect(stars).toHaveAttribute('aria-checked', 'false')
    expect(band).toHaveAccessibleDescription('A band of text characters sweeps across the window.')
    expect(stars).toHaveAccessibleDescription('A line of stars sweeps across, with a faint trail behind it.')
  })

  it('saves Stars when it is pressed or reached with the arrow keys, and nothing for the look already chosen', async () => {
    owl.on = new Set(['watcher', 'night-falls'])
    const props = baseProps()
    render(<SettingsView {...props} />)
    await selectCategory('Appearance')
    fireEvent.click(screen.getByRole('radio', { name: 'Band' }))
    expect(props.onUpdateSettings).not.toHaveBeenCalledWith(expect.objectContaining({ roomTransitionLook: expect.anything() }))
    fireEvent.click(screen.getByRole('radio', { name: 'Stars' }))
    expect(props.onUpdateSettings).toHaveBeenLastCalledWith({ roomTransitionLook: 'stars' })
    vi.mocked(props.onUpdateSettings).mockClear()
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Band' }), { key: 'ArrowRight' })
    expect(props.onUpdateSettings).toHaveBeenLastCalledWith({ roomTransitionLook: 'stars' })
    expect(screen.getByRole('radio', { name: 'Stars' })).toHaveFocus()
  })

  it('rests the look while night falls is off', async () => {
    owl.on = new Set(['watcher', 'night-falls'])
    const props = baseProps()
    render(<SettingsView {...props} settings={{ ...props.settings, roomTransition: false, roomTransitionLook: 'stars' }} />)
    await selectCategory('Appearance')
    expect(screen.getByRole('radio', { name: 'Band' })).toBeDisabled()
    expect(screen.getByRole('radio', { name: 'Stars' })).toBeDisabled()
    expect(screen.getByRole('radio', { name: 'Stars' })).toHaveAttribute('aria-checked', 'true')
  })
})
