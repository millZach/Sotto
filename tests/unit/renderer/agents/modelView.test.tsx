/**
 * The turnable view of a 3D model (the Meshy plan's ticket 4; Sol on the branch, findings 4 and 7), with three.js
 * standing in, since jsdom has no WebGL: a view nobody can see draws nothing until it can be seen, a closed one gives
 * its graphics context back, and where the model faces is said once it stops turning by itself.
 */
import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ModelView from '../../../../src/renderer/src/agents/ModelView'

const gl = vi.hoisted(() => ({ renders: 0, disposed: 0, lost: 0, gone: new WeakSet<object>() }))
vi.mock('three', () => {
  class Part { position = { set: () => undefined }; rotation = { set: () => undefined }; add(): void { /* Nothing to hold. */ } }
  class PerspectiveCamera extends Part { aspect = 1; updateProjectionMatrix(): void { /* Nothing to work out. */ } }
  class WebGLRenderer {
    // As WebGL does: a canvas whose context was given up gives a dead one back, and three cannot start on it.
    constructor(private readonly options: { canvas: object }) { if (gl.gone.has(options.canvas)) throw new Error("Cannot read properties of null (reading 'precision')") }
    setPixelRatio(): void { /* Nothing to set. */ }
    setSize(): void { /* Nothing to size. */ }
    render(): void { gl.renders++ }
    dispose(): void { gl.disposed++ }
    forceContextLoss(): void { gl.lost++; gl.gone.add(this.options.canvas) }
  }
  return { WebGLRenderer, PerspectiveCamera, Scene: Part, Group: Part, HemisphereLight: Part, DirectionalLight: Part }
})
vi.mock('../../../../src/renderer/src/agents/modelScene', () => ({ parseModel: async () => ({}), disposeScene: () => undefined }))

let frames: FrameRequestCallback[] = []
let seen: ((entries: { isIntersecting: boolean }[]) => void) | undefined
/** Runs the frames asked for, as the page would at `ms` past now. */
const tick = (ms = 16): void => { const now = performance.now() + ms; const due = frames; frames = []; for (const frame of due) frame(now) }

beforeEach(() => {
  Object.assign(gl, { renders: 0, disposed: 0, lost: 0, gone: new WeakSet<object>() })
  frames = []
  vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => frames.push(frame))
  vi.stubGlobal('cancelAnimationFrame', () => { frames = [] })
  vi.stubGlobal('ResizeObserver', class { observe(): void { /* Its size never changes here. */ } disconnect(): void { /* Nothing held. */ } })
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: (entries: { isIntersecting: boolean }[]) => void) { seen = callback }
    observe(): void { /* Told by the test. */ }
    disconnect(): void { seen = undefined }
  })
  ;(window as { sotto?: unknown }).sotto = { plugins: { model3dBytes: async () => new Uint8Array([1]) } }
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete (window as { sotto?: unknown }).sotto })

async function view(): Promise<ReturnType<typeof render>> {
  let shown: ReturnType<typeof render> | undefined
  await act(async () => { shown = render(<ModelView modelId="model-1" part="model" name="Oak barrel" reduced={false} onClose={() => undefined} onUnavailable={() => undefined} />) })
  await screen.findByText('Drag or use the arrow keys to turn')
  return shown!
}

it('draws nothing while it cannot be seen, draws again once it can, and gives its graphics context back when closed', async () => {
  const { unmount } = await view()
  tick()
  const drawn = gl.renders
  expect(drawn).toBeGreaterThan(0)
  // Its pane hidden, or scrolled out of sight: no frame is asked for, and nothing is drawn.
  act(() => { seen!([{ isIntersecting: false }]) })
  tick()
  expect(frames).toHaveLength(0)
  tick()
  expect(gl.renders).toBe(drawn)
  act(() => { seen!([{ isIntersecting: true }]) })
  tick()
  expect(gl.renders).toBeGreaterThan(drawn)
  unmount()
  expect(gl.disposed).toBe(1)
  expect(gl.lost).toBe(1)
  expect(frames).toHaveLength(0)
})

it('says where the model faces once it stops turning by itself', async () => {
  await view()
  const stage = screen.getByRole('slider')
  expect(stage).toHaveAttribute('aria-valuenow', '0')
  // A second of turning by itself: 15 degrees, at one whole turn in 24 seconds.
  tick(0)
  tick(1_000)
  await userEvent.click(screen.getByRole('button', { name: 'Stop turning' }))
  // About 15: the real time between frames counts too.
  const degrees = Number(stage.getAttribute('aria-valuenow'))
  expect(degrees).toBeGreaterThanOrEqual(15)
  expect(degrees).toBeLessThan(25)
  expect(stage).toHaveAttribute('aria-valuetext', `Turned ${degrees} degrees from the front`)
})

it('draws again when opened once more, on a canvas of its own, as React does twice in a development build', async () => {
  // Bug Bot on #2599, L1: a canvas kept across openings came back with its context given up, and read as no WebGL.
  const unavailable = vi.fn()
  await act(async () => { render(<React.StrictMode><ModelView modelId="model-1" part="model" name="Oak barrel" reduced={false} onClose={() => undefined} onUnavailable={unavailable} /></React.StrictMode>) })
  await screen.findByText('Drag or use the arrow keys to turn')
  expect(unavailable).not.toHaveBeenCalled()
  expect(gl.lost).toBe(1)
  expect(screen.getByRole('slider').querySelectorAll('canvas')).toHaveLength(1)
})
