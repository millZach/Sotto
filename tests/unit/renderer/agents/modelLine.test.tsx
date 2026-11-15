/**
 * A 3D model in its thread (ADR-0141; the Meshy plan's ticket 4, Zach's variant A): the quiet line in each state, the
 * view it opens, its keyboard path, and nothing at all with the `plugins` Owl feature off. jsdom has no WebGL, so the
 * view itself stands in here.
 */
import React, { useEffect, useRef } from 'react'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Model3dView } from '../../../../src/shared/models3d'
import type { ModelViewProps } from '../../../../src/renderer/src/agents/ModelView'
import { VisualCard } from '../../../../src/renderer/src/agents/VisualCard'

const gate = vi.hoisted(() => ({ on: true, webgl: true }))
vi.mock('../../../../src/renderer/src/state/owlFeature', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../src/renderer/src/state/owlFeature')>(),
  useOwlFeature: (id: string) => id === 'plugins' && gate.on,
}))
vi.mock('../../../../src/renderer/src/agents/ModelView', () => ({
  default: function ModelViewStandIn({ name, part, onUnavailable }: ModelViewProps) {
    const stage = useRef<HTMLDivElement>(null)
    // As the view does: it takes focus as it opens, and only then learns whether WebGL can draw.
    useEffect(() => { stage.current?.focus(); if (!gate.webgl) onUnavailable() }, [onUnavailable])
    return <div ref={stage} tabIndex={0} role="slider" aria-valuenow={0} aria-label={`Turn the ${name}.`} data-part={part} />
  },
}))

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const DONE: Model3dView = { id: 'model-1', name: 'Oak barrel', source: 'words', state: 'done', credits: 30, folder: 'models', still: 'Oak barrel.png',
  files: [{ name: 'Oak barrel.png', bytes: 0.3 * 1024 * 1024 }, { name: 'Oak barrel.glb', bytes: 4.1 * 1024 * 1024 }, { name: 'Oak barrel.usdz', bytes: 5.2 * 1024 * 1024 }] }
const MAKING: Model3dView = { id: 'model-1', name: 'Oak barrel', source: 'words', state: 'making', stage: 'shape', credits: 20, folder: 'models', files: [] }

let listeners: ((view: Model3dView) => void)[] = []
let removedListeners: ((ids: readonly string[]) => void)[] = []
function bridge(view: Model3dView | null) {
  listeners = []
  removedListeners = []
  const plugins = {
    onModels3dRemoved: vi.fn((listener: (ids: readonly string[]) => void) => { removedListeners.push(listener); return () => { removedListeners = removedListeners.filter(other => other !== listener) } }),
    model3d: vi.fn(async () => view),
    model3dBytes: vi.fn(async () => PNG),
    onModel3dChanged: vi.fn((listener: (next: Model3dView) => void) => { listeners.push(listener); return () => { listeners = listeners.filter(other => other !== listener) } }),
  }
  ;(window as { sotto?: unknown }).sotto = { plugins }
  return plugins
}
const line = (): HTMLElement => screen.getByRole('group', { name: '3D model: Oak barrel' })
async function show(view: Model3dView | null): Promise<void> {
  bridge(view)
  await act(async () => { render(<VisualCard visual={{ id: 'v1', title: 'Oak barrel', kind: '3d-model', source: 'model-1' }} />) })
}

beforeEach(() => { gate.on = true; gate.webgl = true })
afterEach(() => { cleanup(); delete (window as { sotto?: unknown }).sotto })

describe('a 3D model’s line in its thread', () => {
  it('says Sotto no longer holds the 3D model once its record is removed, whether it was open or not', async () => {
    await show(DONE)
    await userEvent.click(within(line()).getByRole('button', { name: 'Show the model' }))
    expect(await screen.findByRole('slider', { name: 'Turn the Oak barrel.' })).toBeInTheDocument()
    // Another 3D model's record going changes nothing here.
    await act(async () => { for (const listener of removedListeners) listener(['model-2']) })
    expect(screen.getByRole('slider', { name: 'Turn the Oak barrel.' })).toBeInTheDocument()
    await act(async () => { for (const listener of removedListeners) listener(['model-1']) })
    expect(line()).toHaveTextContent('Sotto no longer holds this 3D model.')
    expect(screen.queryByRole('slider')).toBeNull()
    expect(within(line()).queryByRole('button')).toBeNull()
  })

  it('says the step, Meshy’s percent and the time left while Meshy makes the shape, with nothing to open yet', async () => {
    await show({ ...MAKING, percent: 42, secondsLeft: 58 })
    expect(line()).toHaveTextContent('Oak barrel')
    expect(line()).toHaveTextContent('Step 1 of 2: making the shape · 42%, about a minute left')
    expect(within(line()).getByRole('progressbar', { name: 'Step 1 of 2: making the shape' })).toHaveAttribute('aria-valuenow', '42')
    expect(within(line()).queryByRole('button')).toBeNull()
  })

  it('offers the shape while Meshy paints the texture, and follows each change main sends', async () => {
    await show({ ...MAKING, stage: 'texture', credits: 30, percent: 68, secondsLeft: 40, shape: true })
    expect(line()).toHaveTextContent('Step 2 of 2: painting the texture · 68%, about 40 seconds left')
    await userEvent.click(within(line()).getByRole('button', { name: 'Show the shape' }))
    expect(await screen.findByRole('slider', { name: 'Turn the Oak barrel.' })).toHaveAttribute('data-part', 'shape')
    expect(line()).toHaveTextContent('The shape is ready to turn. The texture follows, then the files go to models/.')
    // The files are being saved: the shape goes, and the line says so.
    await act(async () => { for (const listener of listeners) listener({ ...MAKING, stage: 'files', credits: 30 }) })
    expect(line()).toHaveTextContent('Saving the files')
    expect(screen.queryByRole('slider')).toBeNull()
    // The view and its button went with the shape; the focus the view had stays with the line.
    expect(line()).toHaveFocus()
    await act(async () => { for (const listener of listeners) listener(DONE) })
    expect(line()).toHaveTextContent('3D model · 30 credits · 3 files')
  })

  it('makes a 3D model from a photo in one step', async () => {
    await show({ ...MAKING, source: 'photo', credits: 30, percent: 10 })
    expect(line()).toHaveTextContent('Making the 3D model · 10%')
  })

  it('stays closed once done, and opens in place into the view, what it was made from and its files', async () => {
    await show(DONE)
    expect(line()).toHaveTextContent('3D model · 30 credits · 3 files')
    const toggle = within(line()).getByRole('button', { name: 'Show the model' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('slider')).toBeNull()
    await userEvent.click(toggle)
    expect(toggle).toHaveAccessibleName('Hide the model')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    // The view takes focus as it opens.
    expect(await screen.findByRole('slider', { name: 'Turn the Oak barrel.' })).toHaveFocus()
    expect(line()).toHaveTextContent('Made from words · 30 credits')
    const files = within(line()).getByRole('list', { name: 'Files' })
    expect(within(files).getAllByRole('listitem').map(item => item.textContent)).toEqual(['.png0.3 MB', '.glb4.1 MB', '.usdz5.2 MB'])
  })

  it('closes on Escape and gives focus back to its button', async () => {
    await show(DONE)
    await userEvent.click(within(line()).getByRole('button', { name: 'Show the model' }))
    expect(await screen.findByRole('slider')).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('slider')).toBeNull()
    expect(within(line()).getByRole('button', { name: 'Show the model' })).toHaveFocus()
  })

  it('shows the still picture, the name and the files where WebGL cannot draw', async () => {
    gate.webgl = false
    await show(DONE)
    await userEvent.click(within(line()).getByRole('button', { name: 'Show the model' }))
    expect(await within(line()).findByRole('img', { name: 'Oak barrel' })).toHaveAttribute('src', expect.stringMatching(/^data:image\/png;base64,/u))
    expect(line()).toHaveTextContent('Sotto cannot draw 3D models on this computer, so this is the still picture.')
    expect(within(line()).getByRole('list', { name: 'Files' })).toBeInTheDocument()
    // The view that had focus is gone; its button has it, and Escape still closes what it opened.
    const toggle = within(line()).getByRole('button', { name: 'Hide the model' })
    expect(toggle).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect(toggle).toHaveAccessibleName('Show the model')
  })

  it('says what happened when Meshy could not finish, what was counted and that nothing was saved, with no Try again', async () => {
    await show({ ...MAKING, state: 'failed', failure: 'failed', credits: 20, stage: undefined } as Model3dView)
    expect(line()).toHaveTextContent('Could not finish · nothing saved · 20 credits counted')
    await userEvent.click(within(line()).getByRole('button', { name: 'Show what happened' }))
    expect(line()).toHaveTextContent('The Oak barrel was not made.')
    expect(line()).toHaveTextContent('Meshy could not finish it, and gave back the credits of what it could not make. Sotto saved no files. 20 credits were counted against this month’s limit.')
    expect(within(line()).queryByRole('button', { name: /try again/iu })).toBeNull()
    await userEvent.keyboard('{Escape}')
    expect(within(line()).getByRole('button', { name: 'Show what happened' })).toHaveFocus()
  })

  it('says when Sotto lost track of one, and charged nothing', async () => {
    await show({ ...MAKING, state: 'lost', failure: 'stopped', credits: 0, stage: undefined } as Model3dView)
    expect(line()).toHaveTextContent('Sotto lost track of it · nothing saved · nothing charged')
  })

  it('shows nothing at all with the plugins Owl feature off, and asks main nothing', async () => {
    gate.on = false
    const plugins = bridge(DONE)
    const { container } = render(<VisualCard visual={{ id: 'v1', title: 'Oak barrel', kind: '3d-model', source: 'model-1' }} />)
    expect(container).toBeEmptyDOMElement()
    expect(plugins.model3d).not.toHaveBeenCalled()
    expect(plugins.onModel3dChanged).not.toHaveBeenCalled()
  })
})
