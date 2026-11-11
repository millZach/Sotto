// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { neighbouringStop, NOTE_MIN_WIDTH, NOTE_WIDTH, passedOver, placeNote, setupStops, stopDone, stopsLeft, type Box, type SetupFacts } from '../../../src/renderer/src/features/setup/setupStops'

const NOTHING: SetupFacts = { agentReady: false, projectAdded: false, threadOpen: false, omarchyDone: false, microphoneHeard: false, speechModelChosen: false, shortcutTried: false,
  tailscaleOn: false, hostAdded: false, phoneAccess: false, dictationOn: true }
const ids = (platform: 'win32' | 'darwin' | 'linux') => setupStops(platform).map(stop => stop.id)
const overlap = (a: Box, b: Box): number => Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top))

describe('first-run setup’s stops (ADR-0200)', () => {
  it('walks the first thread, then dictation, then other places, with Omarchy’s stop only on Linux', () => {
    expect(ids('win32')).toEqual(['welcome', 'agents', 'project', 'thread', 'microphone', 'speech-model', 'shortcut', 'tailscale', 'computers', 'iphone', 'end'])
    expect(ids('darwin')).toEqual(ids('win32'))
    expect(ids('linux')).toEqual(['welcome', 'agents', 'project', 'thread', 'omarchy', 'microphone', 'speech-model', 'shortcut', 'tailscale', 'computers', 'iphone', 'end'])
  })

  it('counts a stop done by its own task, and the first and last notes always', () => {
    for (const stop of setupStops('linux')) expect(stopDone(stop.id, NOTHING), stop.id).toBe(stop.id === 'welcome' || stop.id === 'end')
    const everything: SetupFacts = { agentReady: true, projectAdded: true, threadOpen: true, omarchyDone: true, microphoneHeard: true, speechModelChosen: true, shortcutTried: true,
      tailscaleOn: true, hostAdded: true, phoneAccess: true, dictationOn: true }
    for (const stop of setupStops('linux')) expect(stopDone(stop.id, everything), stop.id).toBe(true)
    expect(stopDone('thread', { ...NOTHING, agentReady: true, projectAdded: true })).toBe(false)
  })

  it('passes over the project and the thread while no agent is ready, forward and back, rather than stopping where nothing can be pressed', () => {
    const stops = setupStops('win32')
    const at = (id: string): number => stops.findIndex(stop => stop.id === id)
    expect(stops.filter(stop => passedOver(stop, NOTHING)).map(stop => stop.id)).toEqual(['project', 'thread'])
    expect(neighbouringStop(stops, at('agents'), 1, NOTHING)).toBe(at('microphone'))
    expect(neighbouringStop(stops, at('microphone'), -1, NOTHING)).toBe(at('agents'))
    const ready = { ...NOTHING, agentReady: true }
    expect(neighbouringStop(stops, at('agents'), 1, ready)).toBe(at('project'))
    expect(neighbouringStop(stops, at('project'), 1, ready)).toBe(at('thread'))
    expect(neighbouringStop(stops, at('welcome'), -1, ready)).toBe(at('welcome'))
    expect(neighbouringStop(stops, at('end'), 1, ready)).toBe(at('end'))
  })

  it('passes over the dictation stops while dictation is turned off, and does not list them as left', () => {
    const stops = setupStops('linux'), off = { ...NOTHING, agentReady: true, dictationOn: false }
    const at = (id: string): number => stops.findIndex(stop => stop.id === id)
    expect(neighbouringStop(stops, at('thread'), 1, off)).toBe(at('tailscale'))
    expect(neighbouringStop(stops, at('tailscale'), -1, off)).toBe(at('thread'))
    expect(stopsLeft(stops, off)).toEqual(['project', 'thread', 'tailscale', 'computers', 'iphone'])
  })

  it('lists every task still to do for the last note, visited or not', () => {
    const stops = setupStops('win32')
    expect(stopsLeft(stops, NOTHING)).toEqual(['agents', 'project', 'thread', 'microphone', 'speech-model', 'shortcut', 'tailscale', 'computers', 'iphone'])
    expect(stopsLeft(stops, { ...NOTHING, agentReady: true, projectAdded: true, threadOpen: true, microphoneHeard: true, speechModelChosen: true, shortcutTried: true })).toEqual(['tailscale', 'computers', 'iphone'])
  })
})

describe('where a note goes (ADR-0200)', () => {
  const height = () => 200
  const cases: [string, Box, { width: number; height: number }][] = [
    ['a button at the right edge of the default window', { top: 363, left: 923, width: 117, height: 46 }, { width: 1080, height: 720 }],
    ['a wide card beside the sidebar', { top: 131, left: 310, width: 730, height: 394 }, { width: 1080, height: 720 }],
    ['a tall card at the smallest window', { top: 18, left: 282, width: 506, height: 548 }, { width: 820, height: 560 }],
    ['the sidebar’s own button', { top: 8, left: 108, width: 32, height: 28 }, { width: 820, height: 560 }],
    ['a composer along the bottom', { top: 600, left: 300, width: 760, height: 100 }, { width: 1080, height: 720 }],
    ['a bar across the top', { top: 46, left: 76, width: 709, height: 118 }, { width: 820, height: 560 }],
  ]
  it.each(cases)('keeps the note off %s and inside the window', (_name, target, view) => {
    const placed = placeNote(target, height, view)
    const note: Box = { ...placed, height: height() }
    expect(overlap(note, target)).toBe(0)
    expect(note.left).toBeGreaterThanOrEqual(0)
    expect(note.top).toBeGreaterThanOrEqual(0)
    expect(note.left + note.width).toBeLessThanOrEqual(view.width)
    expect(note.top + note.height).toBeLessThanOrEqual(view.height)
    expect(note.width).toBeGreaterThanOrEqual(NOTE_MIN_WIDTH)
    expect(note.width).toBeLessThanOrEqual(NOTE_WIDTH)
  })

  it('narrows to the sidebar’s width at the smallest window rather than covering the control', () => {
    const placed = placeNote({ top: 18, left: 282, width: 506, height: 548 }, height, { width: 820, height: 560 })
    expect(placed.left + placed.width).toBeLessThanOrEqual(282)
    expect(placed.width).toBeLessThan(NOTE_WIDTH)
  })

  it('stands in the middle of the window when a stop lights nothing', () => {
    expect(placeNote(null, height, { width: 1080, height: 720 })).toEqual({ width: NOTE_WIDTH, left: 375, top: 260 })
  })

  it('takes the corner farthest from a control that leaves no side free', () => {
    const placed = placeNote({ top: 10, left: 10, width: 800, height: 540 }, height, { width: 820, height: 560 })
    expect(placed).toEqual({ width: NOTE_WIDTH, left: 12, top: 12 })
  })
})
