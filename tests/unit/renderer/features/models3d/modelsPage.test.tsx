import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Model3dListed, Model3dView } from '../../../../../src/shared/models3d'
import { ModelsPage } from '../../../../../src/renderer/src/features/models3d/ModelsPage'
import { PageLinks } from '../../../../../src/renderer/src/agents/SidebarFrame'

/** The 3D models page (the Meshy plan's ticket 5, Zach's variant C), against a made-up bridge. */
const gate = vi.hoisted(() => ({ plugins: true, usage: false }))
vi.mock('../../../../../src/renderer/src/state/owlFeature', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../../src/renderer/src/state/owlFeature')>()
  return { ...actual, useOwlFeature: (id: string) => id === 'plugins' ? gate.plugins : id === 'usage' ? gate.usage : false }
})
// The view draws with WebGL, which jsdom has none of: a stand-in that says what it was asked to draw.
vi.mock('../../../../../src/renderer/src/agents/ModelView', () => ({
  default: ({ name, part }: { readonly name: string; readonly part: string }) => <div role="slider" aria-label={`Turn the ${name}`} data-part={part} tabIndex={0} />,
}))
const command = vi.hoisted(() => vi.fn(async () => undefined))
const navigate = vi.hoisted(() => vi.fn())
vi.mock('../../../../../src/renderer/src/agents/AgentContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../../src/renderer/src/agents/AgentContext')>(),
  useOptionalAgents: () => ({ command, state: { host: {
    threads: [{ id: 'thread-props', title: 'Treasure room props', projectId: 'game' }, { id: 'thread-fox', title: 'Fox NPC', projectId: 'game' }],
    projects: [{ id: 'game', title: 'Godot game' }] } } }),
}))
vi.mock('../../../../../src/renderer/src/state/AppContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../../src/renderer/src/state/AppContext')>(),
  useOptionalApp: () => ({ actions: { navigate } }),
}))

const files = (name: string, gone = false): Model3dView['files'] => ['png', 'glb', 'usdz'].map(kind => ({ name: `${name}.${kind}`, ...(gone ? {} : { bytes: 200_000 }) }))
function listed(id: string, change: Partial<Model3dListed> = {}): Model3dListed {
  const name = change.name ?? id
  return { id, name, source: 'words', state: 'done', credits: 30, folder: 'models', files: files(name), still: `${name}.png`,
    threadId: 'thread-props', account: 'Studio', askedAt: '2026-11-14T15:08:00.000Z', words: `A ${name.toLowerCase()} for the treasure room`, ...change }
}
const BARREL = listed('barrel', { name: 'Oak barrel', askedAt: '2026-11-13T16:12:00.000Z' })
const FOX = listed('fox', { name: 'Fox figurine', source: 'photo', words: undefined, photo: 'fox-figurine.jpg', threadId: 'thread-fox', askedAt: '2026-11-14T15:08:00.000Z' })
delete (FOX as { words?: string }).words
const MOSSY = listed('mossy', { name: 'Mossy barrel', state: 'making', stage: 'texture', percent: 68, secondsLeft: 40, credits: 20, files: [], askedAt: '2026-11-15T17:52:00.000Z' })
delete (MOSSY as { still?: string }).still

let models: Model3dListed[]
let changed: ((view: Model3dView) => void) | undefined
const plugins = {
  models3d: vi.fn(async () => models),
  onModel3dChanged: vi.fn((listener: (view: Model3dView) => void) => { changed = listener; return () => { changed = undefined } }),
  meshyCredits: vi.fn(async () => ({ '22222222-2222-4222-8222-000000000001': 80 })),
  model3dBytes: vi.fn(async () => null),
  removeModel3d: vi.fn(async () => true),
  revealModel3d: vi.fn(async () => true),
}
beforeEach(() => {
  gate.plugins = true
  gate.usage = false
  models = [FOX, BARREL]
  Object.defineProperty(window, 'sotto', { configurable: true, value: { plugins } })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

const strip = (): HTMLElement => screen.getByRole('listbox', { name: 'Every 3D model' })
const details = (name: string): HTMLElement => screen.getByRole('complementary', { name: `About the ${name}` })

describe('the 3D models page', () => {
  it('shows the chosen 3D model large, with its details and files, and a filmstrip of every one', async () => {
    render(<ModelsPage platform="win32" />)
    expect(await screen.findByRole('heading', { level: 1, name: '3D models' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('2 3D models from 2 threads · 80 credits this month')).toBeInTheDocument())
    expect(within(strip()).getAllByRole('option').map(tile => tile.getAttribute('aria-label'))).toEqual(['Fox figurine, Nov 14', 'Oak barrel, Nov 13'])
    // The newest that is done is chosen first.
    const fox = details('Fox figurine')
    expect(within(fox).getByText('3D model · Meshy · made from a photo')).toBeInTheDocument()
    expect(within(fox).getByRole('button', { name: 'Go to thread' })).toBeInTheDocument()
    expect(within(fox).getByRole('button', { name: 'Show in File Explorer' })).toBeInTheDocument()
    expect(within(fox).getByText('Fox NPC')).toBeInTheDocument()
    expect(within(fox).getByText('· Godot game')).toBeInTheDocument()
    expect(within(fox).getByText('Photo sent')).toBeInTheDocument()
    expect(within(fox).getByText('fox-figurine.jpg')).toBeInTheDocument()
    expect(within(fox).queryByText('Words sent')).toBeNull()
    expect(within(fox).getByText('30 credits')).toBeInTheDocument()
    expect(within(within(fox).getByRole('list', { name: 'Files' })).getAllByRole('listitem').map(item => item.textContent)).toEqual(['models/Fox figurine.png0.2 MB', 'models/Fox figurine.glb0.2 MB', 'models/Fox figurine.usdz0.2 MB'])
    expect(await screen.findByRole('slider', { name: 'Turn the Fox figurine' })).toHaveAttribute('data-part', 'model')

    // Show in File Explorer shows the GLB; each file's button shows that file.
    fireEvent.click(within(fox).getByRole('button', { name: 'Show in File Explorer' }))
    fireEvent.click(within(fox).getByRole('button', { name: 'Show in File Explorer: Fox figurine.usdz' }))
    expect(plugins.revealModel3d.mock.calls).toEqual([[{ id: 'fox' }], [{ id: 'fox', file: 'Fox figurine.usdz' }]])
  })

  it('names the folder app as each platform does', async () => {
    render(<ModelsPage platform="darwin" />)
    expect(await screen.findByRole('button', { name: 'Show in Finder' })).toBeInTheDocument()
  })

  it('moves along the filmstrip with the arrow keys, Home and End, and chooses as it goes', async () => {
    models = [MOSSY, FOX, BARREL]
    render(<ModelsPage platform="win32" />)
    const fox = await within(await screen.findByRole('listbox', { name: 'Every 3D model' })).findByRole('option', { name: 'Fox figurine, Nov 14' })
    expect(fox).toHaveAttribute('aria-selected', 'true')
    expect(within(strip()).getAllByRole('option').filter(tile => tile.tabIndex === 0)).toEqual([fox])
    fox.focus()
    fireEvent.keyDown(fox, { key: 'ArrowRight' })
    expect(within(strip()).getByRole('option', { name: 'Oak barrel, Nov 13' })).toHaveAttribute('aria-selected', 'true')
    expect(details('Oak barrel')).toBeInTheDocument()
    expect(within(details('Oak barrel')).getByText('A oak barrel for the treasure room')).toBeInTheDocument()
    fireEvent.keyDown(strip(), { key: 'ArrowRight' })
    expect(within(strip()).getByRole('option', { name: 'Oak barrel, Nov 13' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(strip(), { key: 'Home' })
    // One being made: its tile says its step and percent, and its details its progress.
    const mossy = within(strip()).getByRole('option', { name: 'Mossy barrel, Step 2 of 2: painting the texture · 68%' })
    expect(mossy).toHaveAttribute('aria-selected', 'true')
    const making = details('Mossy barrel')
    expect(within(making).getByText('Step 2 of 2: painting the texture · 68%, about 40 seconds left')).toBeInTheDocument()
    expect(within(making).getByRole('progressbar', { name: 'Step 2 of 2: painting the texture' })).toHaveAttribute('aria-valuenow', '68')
    expect(within(making).getByText('The files go to models/ in the thread’s folder when it is done.')).toBeInTheDocument()
    expect(within(making).getByText('20 credits, counted while it is made')).toBeInTheDocument()
    expect(within(making).queryByRole('button', { name: 'Show in File Explorer' })).toBeNull()
    fireEvent.keyDown(strip(), { key: 'End' })
    expect(within(strip()).getByRole('option', { name: 'Oak barrel, Nov 13' })).toHaveAttribute('aria-selected', 'true')
    await waitFor(() => expect(within(strip()).getByRole('option', { name: 'Oak barrel, Nov 13' })).toHaveFocus())
  })

  it('follows one being made to done, takes in a new one, and lets one that failed go', async () => {
    models = [MOSSY, BARREL]
    render(<ModelsPage platform="win32" />)
    fireEvent.click(await within(await screen.findByRole('listbox', { name: 'Every 3D model' })).findByRole('option', { name: /^Mossy barrel/u }))
    expect(details('Mossy barrel')).toBeInTheDocument()
    const { threadId: _thread, account: _account, askedAt: _asked, words: _words, ...view } = MOSSY
    act(() => changed!({ ...view, state: 'done', credits: 30, files: files('Mossy barrel'), still: 'Mossy barrel.png', stage: undefined, percent: undefined, secondsLeft: undefined } as Model3dView))
    expect(within(details('Mossy barrel')).getByRole('button', { name: 'Show in File Explorer' })).toBeInTheDocument()
    expect(within(details('Mossy barrel')).getByText('A mossy barrel for the treasure room')).toBeInTheDocument()
    expect(plugins.models3d).toHaveBeenCalledTimes(1)
    // A new one reads the list again.
    models = [listed('lantern', { name: 'Brass lantern', state: 'making', stage: 'shape', files: [], askedAt: '2026-11-15T18:00:00.000Z' }), { ...MOSSY, state: 'done', files: files('Mossy barrel') }, BARREL]
    act(() => changed!({ id: 'lantern', name: 'Brass lantern', source: 'words', state: 'making', stage: 'shape', credits: 20, folder: 'models', files: [] }))
    await waitFor(() => expect(within(strip()).getAllByRole('option')).toHaveLength(3))
    // One that failed leaves the page; it stays as its line in its thread.
    act(() => changed!({ id: 'lantern', name: 'Brass lantern', source: 'words', state: 'failed', failure: 'failed', credits: 20, folder: 'models', files: [] }))
    expect(within(strip()).getAllByRole('option')).toHaveLength(2)
    expect(within(strip()).queryByRole('option', { name: /^Brass lantern/u })).toBeNull()
  })

  it('filters by name and by the words it was made from', async () => {
    render(<ModelsPage platform="win32" />)
    const search = await screen.findByRole('searchbox', { name: 'Search 3D models' })
    fireEvent.change(search, { target: { value: 'treasure' } })
    expect(within(strip()).getAllByRole('option').map(tile => tile.getAttribute('aria-label'))).toEqual(['Oak barrel, Nov 13'])
    expect(details('Oak barrel')).toBeInTheDocument()
    fireEvent.change(search, { target: { value: 'FOX' } })
    expect(within(strip()).getAllByRole('option').map(tile => tile.getAttribute('aria-label'))).toEqual(['Fox figurine, Nov 14'])
    fireEvent.change(search, { target: { value: 'dragon' } })
    expect(screen.getByText('No 3D models match “dragon”')).toBeInTheDocument()
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(within(strip()).getAllByRole('option')).toHaveLength(2)
  })

  it('opens the 3D model’s thread', async () => {
    render(<ModelsPage platform="win32" />)
    fireEvent.click(await within(await screen.findByRole('complementary', { name: 'About the Fox figurine' })).findByRole('button', { name: 'Go to thread' }))
    expect(command).toHaveBeenCalledWith({ type: 'select-thread', threadId: 'thread-fox' })
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('threads'))
  })

  it('says when a record’s files are gone, and removes the record only when asked', async () => {
    models = [listed('helmet', { name: 'Knight helmet', files: files('Knight helmet', true) }), BARREL]
    render(<ModelsPage platform="win32" />)
    const tile = await within(await screen.findByRole('listbox', { name: 'Every 3D model' })).findByRole('option', { name: 'Knight helmet, Nov 14, Its files are gone' })
    expect(within(tile).getByText('Files gone')).toBeInTheDocument()
    const helmet = details('Knight helmet')
    expect(within(helmet).getByText('Its files are gone.')).toBeInTheDocument()
    expect(within(helmet).getByText(/The Knight helmet’s files are no longer in models\/ in its thread’s folder: they were moved, renamed or deleted\./u)).toBeInTheDocument()
    expect(within(helmet).getByText('Removing it takes it off this list. It deletes no file.')).toBeInTheDocument()
    expect(within(helmet).queryByRole('button', { name: 'Show in File Explorer' })).toBeNull()
    expect(within(helmet).getByRole('button', { name: 'Go to thread' })).toBeInTheDocument()
    expect(screen.queryByRole('slider')).toBeNull()
    fireEvent.click(within(helmet).getByRole('button', { name: 'Remove from 3D models' }))
    await waitFor(() => expect(within(strip()).getAllByRole('option').map(option => option.getAttribute('aria-label'))).toEqual(['Oak barrel, Nov 13']))
    expect(plugins.removeModel3d).toHaveBeenCalledWith('helmet')
    expect(details('Oak barrel')).toBeInTheDocument()
  })

  it('keeps a record main found its files for, and reads the list again', async () => {
    models = [listed('helmet', { name: 'Knight helmet', files: files('Knight helmet', true) })]
    plugins.removeModel3d.mockResolvedValueOnce(false)
    render(<ModelsPage platform="win32" />)
    fireEvent.click(await within(await screen.findByRole('complementary', { name: 'About the Knight helmet' })).findByRole('button', { name: 'Remove from 3D models' }))
    expect(await screen.findByText('Its files are there again, so it stays.')).toBeInTheDocument()
    expect(plugins.models3d).toHaveBeenCalledTimes(2)
  })

  it('says there are none yet, in one plain sentence', async () => {
    models = []
    render(<ModelsPage platform="win32" />)
    expect(await screen.findByText('No 3D models yet')).toBeInTheDocument()
    expect(screen.getByText('When a thread makes one with Meshy, it shows here, with its files and the thread it came from.')).toBeInTheDocument()
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('is not there with the plugins Owl feature off, and neither is its icon at the sidebar’s foot', () => {
    gate.plugins = false
    const { container } = render(<><ModelsPage platform="win32" /><PageLinks className="pages" linkClassName="page" /></>)
    expect(container.querySelector('.models-page')).toBeNull()
    expect(screen.queryByRole('link', { name: '3D models' })).toBeNull()
    expect(plugins.models3d).not.toHaveBeenCalled()
  })

  it('puts a cube at the sidebar’s foot, between Usage and Settings, with plugins on', () => {
    gate.usage = true
    render(<PageLinks className="pages" linkClassName="page" />)
    expect(screen.getAllByRole('link').map(link => link.textContent)).toEqual(['Usage', '3D models', 'Settings', 'Help'])
  })
})
