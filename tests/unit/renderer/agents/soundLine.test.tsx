/**
 * A sound in its thread (ADR-0205; the plugins plan's slice 12, part 3, Zach's pick on #2498, variant A): the quiet line
 * in each state, Play and Pause, the details and their keyboard path, a file that is gone, a failure and a charged one,
 * and nothing at all with the `plugins` Owl feature off. Nothing plays before a press (ADR-0068). jsdom plays no audio,
 * so the element's play and pause stand in here, and say what a real one would.
 */
import React from 'react'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SoundView } from '../../../../src/shared/sounds'
import { VisualCard } from '../../../../src/renderer/src/agents/VisualCard'

const gate = vi.hoisted(() => ({ on: true }))
vi.mock('../../../../src/renderer/src/state/owlFeature', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../src/renderer/src/state/owlFeature')>(),
  useOwlFeature: (id: string) => id === 'plugins' && gate.on,
}))

const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64])
const WORDS = 'Welcome to Lumen. In the next two minutes you will set up your shop.'
const MADE: SoundView = { id: 'sound-1', name: 'Opening narration', kind: 'speech', state: 'made', cost: 0.02, voice: 'Rachel', words: WORDS,
  fileName: 'Opening narration.mp3', bytes: 130 * 1024, madeAt: '2026-11-15T18:52:00.000Z' }
const MAKING: SoundView = { id: 'sound-1', name: 'Opening narration', kind: 'speech', state: 'making', cost: 0.02, voice: 'Rachel', words: WORDS }

let listeners: ((view: SoundView) => void)[] = []
/** Every audio element a press played, and the addresses made and let go. */
let played: HTMLMediaElement[] = []
let addresses: { made: string[]; revoked: string[] } = { made: [], revoked: [] }
function bridge(view: SoundView | null, bytes: Uint8Array | null = MP3) {
  listeners = []
  const plugins = {
    sound: vi.fn(async () => view),
    soundBytes: vi.fn(async () => bytes),
    revealSound: vi.fn(async () => true),
    onSoundChanged: vi.fn((listener: (next: SoundView) => void) => { listeners.push(listener); return () => { listeners = listeners.filter(other => other !== listener) } }),
  }
  ;(window as { sotto?: unknown }).sotto = { plugins, platform: 'win32' }
  return plugins
}
const line = (): HTMLElement => screen.getByRole('group', { name: 'Sound: Opening narration' })
async function show(view: SoundView | null, bytes?: Uint8Array | null) {
  const plugins = bridge(view, bytes)
  const shown = await act(async () => render(<VisualCard visual={{ id: 'v1', title: 'Opening narration', kind: 'sound', source: 'sound-1' }} />))
  return { plugins, ...shown }
}
const send = async (view: SoundView): Promise<void> => { await act(async () => { for (const listener of listeners) listener(view) }) }

beforeEach(() => {
  gate.on = true
  played = []
  addresses = { made: [], revoked: [] }
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function play(this: HTMLMediaElement) {
    played.push(this)
    // The MP3 is eight seconds long, which the element learns once it has read its start.
    Object.defineProperty(this, 'duration', { configurable: true, value: 8 })
    this.dispatchEvent(new Event('loadedmetadata'))
    this.dispatchEvent(new Event('play'))
    return Promise.resolve()
  })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function pause(this: HTMLMediaElement) { this.dispatchEvent(new Event('pause')) })
  Object.assign(URL, {
    createObjectURL: vi.fn((blob: Blob) => { const address = `blob:sotto/${addresses.made.length}`; addresses.made.push(`${address} ${blob.type}`); return address }),
    revokeObjectURL: vi.fn((address: string) => { addresses.revoked.push(address) }),
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (window as { sotto?: unknown }).sotto
  delete document.documentElement.dataset.reducedMotion
})

describe('a sound’s line in its thread', () => {
  it('says ElevenLabs is making it, with a bar and nothing to press, and moves to made when main says so', async () => {
    await show(MAKING)
    expect(line()).toHaveTextContent('Making the speech with ElevenLabs…')
    const bar = within(line()).getByRole('progressbar', { name: 'Making the speech' })
    expect(bar).not.toHaveAttribute('aria-valuenow')
    expect(bar).not.toHaveClass('sound-line__busy--still')
    expect(within(line()).queryByRole('button')).toBeNull()
    await send(MADE)
    expect(line()).toHaveTextContent('Speech · about $0.02 · ElevenLabs')
    expect(within(line()).getByRole('button', { name: 'Play Opening narration' })).toBeEnabled()
  })

  it('holds the bar still while motion is reduced', async () => {
    document.documentElement.dataset.reducedMotion = 'on'
    await show({ ...MAKING, kind: 'music' })
    expect(line()).toHaveTextContent('Making the music with ElevenLabs…')
    expect(within(line()).getByRole('progressbar', { name: 'Making the music' })).toHaveClass('sound-line__busy--still')
  })

  it('fetches nothing and plays nothing before Play is pressed, and leaves the length out until the audio says it', async () => {
    const { plugins } = await show(MADE)
    expect(line()).toHaveTextContent('Speech · about $0.02 · ElevenLabs')
    expect(line()).not.toHaveTextContent('0:')
    // A change main sends, the details opened, time passing: still nothing fetched, made or played.
    await send({ ...MADE })
    await userEvent.click(within(line()).getByRole('button', { name: 'Show the details' }))
    expect(plugins.soundBytes).not.toHaveBeenCalled()
    expect(played).toEqual([])
    expect(addresses.made).toEqual([])
    expect(document.querySelectorAll('audio')).toHaveLength(0)
    expect(within(line()).queryByRole('slider')).toBeNull()
  })

  it('fetches the MP3 on the first press of Play, plays it, pauses on Pause and plays on, and lets its address go when the line goes', async () => {
    const { plugins, unmount } = await show(MADE)
    await userEvent.click(within(line()).getByRole('button', { name: 'Play Opening narration' }))
    expect(plugins.soundBytes.mock.calls).toEqual([['sound-1']])
    expect(addresses.made).toEqual(['blob:sotto/0 audio/mpeg'])
    expect(played).toHaveLength(1)
    expect(played[0]!.src).toBe('blob:sotto/0')
    expect(played[0]!.autoplay).toBe(false)
    // The length once the audio has read it, and the place in it under the row.
    expect(line()).toHaveTextContent('Speech · 0:08 · about $0.02 · ElevenLabs')
    expect(within(line()).getByRole('slider', { name: 'Place in Opening narration' })).toHaveAttribute('aria-valuetext', '0:00 of 0:08')
    await userEvent.click(within(line()).getByRole('button', { name: 'Pause Opening narration' }))
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(1)
    const play = within(line()).getByRole('button', { name: 'Play Opening narration' })
    // Space and Enter press it as they press any button; the MP3 is not fetched again.
    play.focus()
    await userEvent.keyboard(' ')
    expect(played).toHaveLength(2)
    await userEvent.keyboard('{Enter}')
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(2)
    expect(plugins.soundBytes).toHaveBeenCalledTimes(1)
    unmount()
    expect(addresses.revoked).toEqual(['blob:sotto/0'])
  })

  it('opens the details from the chevron, closes them on Escape with focus back on it, and shows the file in File Explorer by the sound’s ID', async () => {
    const { plugins } = await show(MADE)
    const toggle = within(line()).getByRole('button', { name: 'Show the details' })
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(toggle).toHaveAccessibleName('Hide the details')
    expect(line()).toHaveTextContent(`“${WORDS}”`)
    expect(line()).toHaveTextContent(/Spoken in the voice Rachel · about \$0\.02 · made \d{1,2}:52/u)
    expect(line()).toHaveTextContent('.mp3')
    await userEvent.click(within(line()).getByRole('button', { name: 'Show in File Explorer' }))
    expect(plugins.revealSound.mock.calls).toEqual([['sound-1']])
    within(line()).getByRole('button', { name: 'Show in File Explorer' }).focus()
    await userEvent.keyboard('{Escape}')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveAccessibleName('Show the details')
    expect(toggle).toHaveFocus()
    expect(screen.queryByText(`“${WORDS}”`)).toBeNull()
  })

  it('says what an effect or music was made from', async () => {
    await show({ ...MADE, kind: 'effect', name: 'Opening narration', voice: undefined, words: 'A short, bright two-note chime' } as SoundView)
    expect(line()).toHaveTextContent('Sound effect · about $0.02 · ElevenLabs')
    await userEvent.click(within(line()).getByRole('button', { name: 'Show the details' }))
    expect(line()).toHaveTextContent('Made from “A short, bright two-note chime”')
    expect(line()).not.toHaveTextContent('Spoken in the voice')
  })

  it('says File gone, with Play off, for a sound whose file is gone, and finds out on a press when it went since', async () => {
    await show({ ...MADE, bytes: undefined, madeAt: undefined } as SoundView)
    expect(line()).toHaveTextContent('Speech · File gone · about $0.02 · ElevenLabs')
    expect(within(line()).getByRole('button', { name: 'Play Opening narration' })).toBeDisabled()
    await userEvent.click(within(line()).getByRole('button', { name: 'Show the details' }))
    expect(within(line()).queryByRole('button', { name: 'Show in File Explorer' })).toBeNull()
    cleanup()
    // Drawn while it was there, gone by the press: main hands nothing over, and the view read again says so.
    const { plugins } = await show(MADE, null)
    plugins.sound.mockResolvedValue({ ...MADE, bytes: undefined, madeAt: undefined } as SoundView)
    await userEvent.click(within(line()).getByRole('button', { name: 'Play Opening narration' }))
    expect(await within(line()).findByText('Speech · File gone · about $0.02 · ElevenLabs')).toBeInTheDocument()
    expect(within(line()).getByRole('button', { name: 'Play Opening narration' })).toBeDisabled()
    expect(played).toEqual([])
  })

  it('says it could not make it, that nothing was saved and nothing spent, and what happened on a press', async () => {
    await show({ ...MAKING, state: 'failed', failure: 'rejected', cost: 0 })
    expect(line()).toHaveTextContent('Could not make it · nothing saved · nothing spent')
    expect(within(line()).queryByRole('button', { name: /Play/u })).toBeNull()
    const toggle = within(line()).getByRole('button', { name: 'Show what happened' })
    await userEvent.click(toggle)
    expect(line()).toHaveTextContent('The Opening narration was not made.')
    expect(line()).toHaveTextContent('ElevenLabs would not make this speech from these words in this voice. Sotto saved no file, and nothing was counted against this month’s limit.')
    await userEvent.keyboard('{Escape}')
    expect(within(line()).getByRole('button', { name: 'Show what happened' })).toHaveFocus()
  })

  it('says a sound ElevenLabs charged for and Sotto could not save was counted', async () => {
    await show({ ...MAKING, state: 'failed', failure: 'unreachable', cost: 0.02 })
    expect(line()).toHaveTextContent('Could not save it · nothing saved · about $0.02 counted')
    await userEvent.click(within(line()).getByRole('button', { name: 'Show what happened' }))
    expect(line()).toHaveTextContent('The Opening narration was not saved.')
    expect(line()).toHaveTextContent('ElevenLabs made it and charged for it, but its answer stopped before the whole file arrived. Sotto saved no file. Its cost, about $0.02, was counted against this month’s limit.')
  })

  it('is not there at all with the plugins Owl feature off, and asks main nothing', async () => {
    gate.on = false
    const { plugins, container } = await show(MADE)
    expect(container).toBeEmptyDOMElement()
    expect(plugins.sound).not.toHaveBeenCalled()
    expect(plugins.onSoundChanged).not.toHaveBeenCalled()
    expect(plugins.soundBytes).not.toHaveBeenCalled()
  })
})
