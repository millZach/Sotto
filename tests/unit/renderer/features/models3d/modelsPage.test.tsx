import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Model3dListed, Model3dRemoval, Model3dView } from '../../../../../src/shared/models3d'
import { ModelsPage } from '../../../../../src/renderer/src/features/models3d/ModelsPage'
import { PageLinks } from '../../../../../src/renderer/src/agents/SidebarFrame'

/** Settings › 3D models (the Meshy plan's ticket 5, Zach's variant C; in Settings since November 16, 2026), against a made-up bridge. */
const gate = vi.hoisted(() => ({ plugins: true, usage: false }))
vi.mock('../../../../../src/renderer/src/state/owlFeature', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../../src/renderer/src/state/owlFeature')>()
  return { ...actual, useOwlFeature: (id: string) => id === 'plugins' ? gate.plugins : id === 'usage' ? gate.usage : false }
})
// The view draws with WebGL, which jsdom has none of: a stand-in that says what it was asked to draw.
vi.mock('../../../../../src/renderer/src/agents/ModelView', () => ({
  default: ({ name, part }: { readonly name: string; readonly part: string }) => <div role="slider" aria-label={`Turn the ${name}`} data-part={part} tabIndex={0} />,
}))
const OWN_HOST = vi.hoisted(() => '11111111-1111-4111-8111-000000000001')
/** The paired hosts the window lists, and forge's thread (the Meshy plan's ticket 6, part 2). */
const FORGE = vi.hoisted(() => '33333333-3333-4333-8333-000000000001')
const hosts = vi.hoisted(() => ({ connections: [] as { hostId: string; name: string; kind: 'local' | 'remote'; connected: boolean; models3d?: true }[] }))
const command = vi.hoisted(() => vi.fn(async () => undefined))
const navigate = vi.hoisted(() => vi.fn())
vi.mock('../../../../../src/renderer/src/agents/AgentContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../../src/renderer/src/agents/AgentContext')>(),
  useOptionalAgents: () => ({ command, state: { connections: hosts.connections, host: {
    // The window names this computer's threads by a key that says whose they are; the record by the thread's own ID.
    threads: [{ id: 'thread-props', title: 'Treasure room props', projectId: 'game' }, { id: `host:${OWN_HOST}:thread-fox`, title: 'Fox NPC', projectId: 'game' },
      { id: `host:${FORGE}:thread-vault`, title: 'Vault lighting', projectId: 'game', remoteHost: true, hostId: FORGE }],
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
let forgotten: ((ids: readonly string[]) => void) | undefined
let creditsTold: (() => void) | undefined
const plugins = {
  models3d: vi.fn(async () => models),
  onModel3dChanged: vi.fn((listener: (view: Model3dView) => void) => { changed = listener; return () => { changed = undefined } }),
  meshyCredits: vi.fn(async (): Promise<Record<string, { here: number; credits: number; across: string[] }>> => ({ '22222222-2222-4222-8222-000000000001': { here: 80, credits: 80, across: [] } })),
  model3dBytes: vi.fn(async () => null),
  removeModel3d: vi.fn(async (): Promise<Model3dRemoval> => 'removed'),
  revealModel3d: vi.fn(async () => true),
  onModels3dRemoved: vi.fn((listener: (ids: readonly string[]) => void) => { forgotten = listener; return () => { forgotten = undefined } }),
  onMeshyCreditsChanged: vi.fn((listener: () => void) => { creditsTold = listener; return () => { creditsTold = undefined } }),
}
/** A promise the test settles when it chooses. */
function later<Value>(): { readonly promise: Promise<Value>; readonly settle: (value: Value) => void } {
  let settle: (value: Value) => void = () => undefined
  const promise = new Promise<Value>(done => { settle = done })
  return { promise, settle }
}
/** A listed 3D model as main's change notification carries it: no thread, account or words. */
function viewOf(model: Model3dListed): Model3dView {
  const view: Partial<Model3dListed> = { ...model }
  for (const key of ['threadId', 'account', 'askedAt', 'words', 'photo'] as const) delete view[key]
  return view as Model3dView
}
const done = (model: Model3dListed): Model3dView => {
  const view: Partial<Model3dView> = { ...viewOf(model), state: 'done', credits: 30, files: files(model.name) }
  for (const key of ['stage', 'percent', 'secondsLeft'] as const) delete view[key]
  return view as Model3dView
}
beforeEach(() => {
  hosts.connections = []
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
    expect(await screen.findByRole('heading', { level: 2, name: '3D models' })).toBeInTheDocument()
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
    // The tile has room for little, so its percent comes first.
    expect(mossy).toHaveTextContent('Mossy barrel68% · Step 2 of 2: painting the texture')
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
    // Main's view of it once done: no thread, account or words, which the page keeps from the list.
    act(() => changed!({ id: 'mossy', name: 'Mossy barrel', source: 'words', state: 'done', credits: 30, folder: 'models', files: files('Mossy barrel'), still: 'Mossy barrel.png' }))
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

  it('keeps what it heard while a read was on its way over that read’s older answer', async () => {
    models = [MOSSY, FOX, BARREL]
    render(<ModelsPage platform="win32" />)
    await within(await screen.findByRole('listbox', { name: 'Every 3D model' })).findByRole('option', { name: /^Mossy barrel/u })
    // The window comes back into focus: the list is read again, and its answer is slow.
    const slow = later<Model3dListed[]>()
    plugins.models3d.mockImplementationOnce(() => slow.promise)
    act(() => { window.dispatchEvent(new Event('focus')) })
    expect(plugins.models3d).toHaveBeenCalledTimes(2)
    // Meanwhile the mossy barrel finishes and the fox fails; the read answers as things stood when it began.
    act(() => changed!(done(MOSSY)))
    act(() => changed!({ ...viewOf(FOX), state: 'failed', failure: 'failed' }))
    await act(async () => { slow.settle([MOSSY, FOX, BARREL]) })
    expect(within(strip()).getAllByRole('option').map(tile => tile.getAttribute('aria-label'))).toEqual([expect.stringMatching(/^Mossy barrel, [A-Z][a-z]{2} \d+$/u), 'Oak barrel, Nov 13'])
  })

  it('looks again at whether the files are there on focus and every half minute while shown', async () => {
    const timers = vi.spyOn(window, 'setInterval')
    render(<ModelsPage platform="win32" />)
    await screen.findByRole('listbox', { name: 'Every 3D model' })
    const [again] = timers.mock.calls.find(([, ms]) => ms === 30_000) as [() => void, number]
    // The barrel's files were deleted meanwhile: its next read says so.
    models = [FOX, listed('barrel', { name: 'Oak barrel', askedAt: '2026-11-13T16:12:00.000Z', files: files('Oak barrel', true) })]
    act(() => again())
    expect(await within(strip()).findByRole('option', { name: 'Oak barrel, Nov 13, Its files are gone' })).toBeInTheDocument()
    // And put back: the next focus says so too.
    models = [FOX, BARREL]
    act(() => { window.dispatchEvent(new Event('focus')) })
    expect(await within(strip()).findByRole('option', { name: 'Oak barrel, Nov 13' })).toBeInTheDocument()
    timers.mockRestore()
  })

  it('lets a forgotten thread’s 3D models go', async () => {
    render(<ModelsPage platform="win32" />)
    await within(await screen.findByRole('listbox', { name: 'Every 3D model' })).findByRole('option', { name: 'Fox figurine, Nov 14' })
    act(() => forgotten!(['fox']))
    expect(within(strip()).getAllByRole('option').map(tile => tile.getAttribute('aria-label'))).toEqual(['Oak barrel, Nov 13'])
    expect(details('Oak barrel')).toBeInTheDocument()
    expect(screen.queryByText('fox-figurine.jpg')).toBeNull()
  })

  it('keeps the 3D model first shown when a newer one finishes', async () => {
    models = [MOSSY, BARREL]
    render(<ModelsPage platform="win32" />)
    expect(await screen.findByRole('complementary', { name: 'About the Oak barrel' })).toBeInTheDocument()
    act(() => changed!(done(MOSSY)))
    expect(details('Oak barrel')).toBeInTheDocument()
    expect(within(strip()).getByRole('option', { name: 'Oak barrel, Nov 13' })).toHaveAttribute('aria-selected', 'true')
  })

  it('moves the choice after a removal only when the removed one is still chosen', async () => {
    models = [listed('helmet', { name: 'Knight helmet', files: files('Knight helmet', true) }), FOX, BARREL]
    const pending = later<Model3dRemoval>()
    plugins.removeModel3d.mockImplementationOnce(() => pending.promise)
    render(<ModelsPage platform="win32" />)
    fireEvent.click(await within(await screen.findByRole('complementary', { name: 'About the Knight helmet' })).findByRole('button', { name: 'Remove from 3D models' }))
    // The oak barrel is chosen before main answers.
    fireEvent.click(within(strip()).getByRole('option', { name: 'Oak barrel, Nov 13' }))
    within(strip()).getByRole('option', { name: 'Oak barrel, Nov 13' }).focus()
    await act(async () => { pending.settle('removed') })
    await act(async () => { await new Promise(next => requestAnimationFrame(() => next(undefined))) })
    expect(within(strip()).getAllByRole('option').map(tile => tile.getAttribute('aria-label'))).toEqual(['Fox figurine, Nov 14', 'Oak barrel, Nov 13'])
    expect(within(strip()).getByRole('option', { name: 'Oak barrel, Nov 13' })).toHaveAttribute('aria-selected', 'true')
    expect(within(strip()).getByRole('option', { name: 'Oak barrel, Nov 13' })).toHaveFocus()
  })

  it('keeps a removed 3D model off the list, whatever a read already on its way says, and when another list removed it', async () => {
    const helmet = listed('helmet', { name: 'Knight helmet', files: files('Knight helmet', true) })
    models = [helmet, FOX, BARREL]
    render(<ModelsPage platform="win32" />)
    await screen.findByRole('complementary', { name: 'About the Knight helmet' })
    // A re-read is on its way, as on focus, when Remove finishes.
    const slow = later<Model3dListed[]>()
    plugins.models3d.mockImplementationOnce(() => slow.promise)
    act(() => { window.dispatchEvent(new Event('focus')) })
    fireEvent.click(within(details('Knight helmet')).getByRole('button', { name: 'Remove from 3D models' }))
    await waitFor(() => expect(within(strip()).getAllByRole('option')).toHaveLength(2))
    await act(async () => { slow.settle([helmet, FOX, BARREL]) })
    expect(within(strip()).getAllByRole('option').map(tile => tile.getAttribute('aria-label'))).toEqual(['Fox figurine, Nov 14', 'Oak barrel, Nov 13'])
    // Main says another list, such as Tools, removed the oak barrel's record.
    act(() => forgotten!(['barrel']))
    expect(within(strip()).getAllByRole('option').map(tile => tile.getAttribute('aria-label'))).toEqual(['Fox figurine, Nov 14'])
  })

  it.each([
    ['no-record', 'Sotto no longer has a record of it.'],
    ['changed', 'It changed meanwhile, so it stays.'],
  ] as const)('says plainly why a removal did not happen (%s), and reads the list again', async (removal, words) => {
    models = [listed('helmet', { name: 'Knight helmet', files: files('Knight helmet', true) })]
    plugins.removeModel3d.mockResolvedValueOnce(removal)
    render(<ModelsPage platform="win32" />)
    fireEvent.click(await within(await screen.findByRole('complementary', { name: 'About the Knight helmet' })).findByRole('button', { name: 'Remove from 3D models' }))
    expect(await screen.findByText(words)).toBeInTheDocument()
    expect(screen.queryByText('Its files are there again, so it stays.')).toBeNull()
    expect(plugins.models3d).toHaveBeenCalledTimes(2)
  })

  it('says a removal that could not be asked for changed nothing, and reads the list again', async () => {
    models = [listed('helmet', { name: 'Knight helmet', files: files('Knight helmet', true) })]
    plugins.removeModel3d.mockRejectedValueOnce(new Error('Open 3D models in the main Sotto window.'))
    render(<ModelsPage platform="win32" />)
    fireEvent.click(await within(await screen.findByRole('complementary', { name: 'About the Knight helmet' })).findByRole('button', { name: 'Remove from 3D models' }))
    expect(await screen.findByText('It could not be removed. Nothing was changed.')).toBeInTheDocument()
    expect(plugins.models3d).toHaveBeenCalledTimes(2)
  })

  it('says a file could not be found only under the 3D model it was asked for', async () => {
    const answer = later<boolean>()
    plugins.revealModel3d.mockImplementationOnce(() => answer.promise)
    render(<ModelsPage platform="win32" />)
    fireEvent.click(await within(await screen.findByRole('complementary', { name: 'About the Fox figurine' })).findByRole('button', { name: 'Show in File Explorer' }))
    fireEvent.click(within(strip()).getByRole('option', { name: 'Oak barrel, Nov 13' }))
    await act(async () => { answer.settle(false) })
    expect(details('Oak barrel')).toBeInTheDocument()
    expect(screen.queryByText('Sotto could not find that file. It may have been moved or deleted.')).toBeNull()
    // Asked for the one shown, it says so.
    plugins.revealModel3d.mockResolvedValueOnce(false)
    fireEvent.click(within(details('Oak barrel')).getByRole('button', { name: 'Show in File Explorer' }))
    expect(await screen.findByText('Sotto could not find that file. It may have been moved or deleted.')).toBeInTheDocument()
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
    expect(command).toHaveBeenCalledWith({ type: 'select-thread', threadId: `host:${OWN_HOST}:thread-fox` })
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
    plugins.removeModel3d.mockResolvedValueOnce('files-there')
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

  it('leaves the sidebar’s foot without a cube with plugins on: 3D models are a Settings page', () => {
    gate.usage = true
    render(<PageLinks className="pages" linkClassName="page" />)
    expect(screen.getAllByRole('link').map(link => link.textContent)).toEqual(['Usage', 'Settings', 'Help'])
  })

  it('reads nothing while its Settings page is closed, keeps its heading for Find a setting, and reads once it opens', async () => {
    const page = render(<ModelsPage platform="win32" shown={false} />)
    expect(screen.getByRole('heading', { level: 2, name: '3D models' })).toHaveAttribute('data-setting', 'models-3d')
    expect(plugins.models3d).not.toHaveBeenCalled()
    expect(plugins.meshyCredits).not.toHaveBeenCalled()
    expect(screen.queryByRole('listbox')).toBeNull()
    page.rerender(<ModelsPage platform="win32" shown />)
    expect(await screen.findByRole('listbox', { name: 'Every 3D model' })).toBeInTheDocument()
    expect(plugins.models3d).toHaveBeenCalled()
  })
})

describe('a paired host’s 3D models on the page', () => {
  const LAMP = listed(`host:${FORGE}:lamp`, { name: 'Brass lamp', threadId: `host:${FORGE}:thread-vault`, computer: 'forge', askedAt: '2026-11-15T18:05:00.000Z' })
  const CRATE = listed(`host:${FORGE}:crate`, { name: 'Supply crate', threadId: `host:${FORGE}:thread-vault`, computer: 'forge', files: files('Supply crate', true), askedAt: '2026-11-15T17:58:00.000Z' })
  const forge = (connected: boolean) => ({ hostId: FORGE, name: 'forge', kind: 'remote' as const, connected, models3d: true as const })
  beforeEach(() => {
    hosts.connections = [forge(true)]
    models = [LAMP, CRATE, FOX, BARREL]
    plugins.meshyCredits.mockResolvedValue({ '22222222-2222-4222-8222-000000000001': { here: 80, credits: 140, across: ['forge'] } })
  })

  it('lists them with this computer’s, says “on forge”, counts credits across computers, and offers no reveal of a host’s files', async () => {
    render(<ModelsPage platform="win32" />)
    expect(await screen.findByText('4 3D models from 3 threads · 140 credits this month, across this computer and forge')).toBeInTheDocument()
    const details = screen.getByRole('complementary', { name: 'About the Brass lamp' })
    expect(within(details).getByText('3D model · Meshy · made from words · on forge')).toBeInTheDocument()
    expect(within(details).queryByRole('button', { name: 'Show in File Explorer' })).toBeNull()
    expect(within(details).queryByRole('button', { name: /^Show in File Explorer:/u })).toBeNull()
    expect(within(details).getByRole('button', { name: 'Go to thread' })).toBeInTheDocument()
    expect(within(details).getByText('Vault lighting')).toBeInTheDocument()
    // This computer's own still has both.
    fireEvent.click(screen.getByRole('option', { name: /^Oak barrel/u }))
    const own = screen.getByRole('complementary', { name: 'About the Oak barrel' })
    expect(within(own).getByText('3D model · Meshy · made from words')).toBeInTheDocument()
    expect(within(own).getByRole('button', { name: 'Show in File Explorer' })).toBeInTheDocument()
  })

  it('reads the header’s credits again when a host’s report comes after its 3D model’s news', async () => {
    render(<ModelsPage platform="win32" />)
    expect(await screen.findByText('4 3D models from 3 threads · 140 credits this month, across this computer and forge')).toBeInTheDocument()
    // The list is as it was; only what forge said it spent moved.
    plugins.meshyCredits.mockResolvedValue({ '22222222-2222-4222-8222-000000000001': { here: 80, credits: 170, across: ['forge'] } })
    await act(async () => { creditsTold?.() })
    expect(await screen.findByText('4 3D models from 3 threads · 170 credits this month, across this computer and forge')).toBeInTheDocument()
  })

  it('opens the host thread from Go to thread', async () => {
    render(<ModelsPage platform="win32" />)
    fireEvent.click(within(await screen.findByRole('complementary', { name: 'About the Brass lamp' })).getByRole('button', { name: 'Go to thread' }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('threads'))
    expect(command).toHaveBeenCalledWith({ type: 'select-thread', threadId: `host:${FORGE}:thread-vault` })
  })

  it('offers Remove from 3D models for a host’s 3D model whose files are gone, saying they were on that host', async () => {
    render(<ModelsPage platform="win32" />)
    fireEvent.click(await screen.findByRole('option', { name: /^Supply crate/u }))
    const details = screen.getByRole('complementary', { name: 'About the Supply crate' })
    expect(within(details).getByText('The Supply crate’s files are no longer in models/ in its thread’s folder on forge: they were moved, renamed or deleted.')).toBeInTheDocument()
    fireEvent.click(within(details).getByRole('button', { name: 'Remove from 3D models' }))
    await waitFor(() => expect(screen.queryByRole('option', { name: /^Supply crate/u })).toBeNull())
    expect(plugins.removeModel3d).toHaveBeenCalledWith(`host:${FORGE}:crate`)
  })

  it('takes a host’s 3D models off the page while it is away, and reads the list again when it is back', async () => {
    const shown = render(<ModelsPage platform="win32" />)
    expect(await screen.findByRole('option', { name: /^Brass lamp/u })).toBeInTheDocument()
    expect(plugins.models3d).toHaveBeenCalledTimes(1)
    hosts.connections = [forge(false)]
    shown.rerender(<ModelsPage platform="win32" />)
    expect(screen.queryByRole('option', { name: /^Brass lamp/u })).toBeNull()
    expect(screen.getByRole('option', { name: /^Fox figurine/u })).toBeInTheDocument()
    hosts.connections = [forge(true)]
    shown.rerender(<ModelsPage platform="win32" />)
    await waitFor(() => expect(plugins.models3d).toHaveBeenCalledTimes(3))
    expect(await screen.findByRole('option', { name: /^Brass lamp/u })).toBeInTheDocument()
  })
})
