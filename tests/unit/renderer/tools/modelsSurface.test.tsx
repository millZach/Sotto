import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Model3dListed, Model3dRemoval, Model3dView } from '../../../../src/shared/models3d'
import { ToolsPanel } from '../../../../src/renderer/src/tools/ToolsPanel'
import { ToolsPanelStore } from '../../../../src/renderer/src/tools/toolsPanelStore'
import { CloudIphoneStore } from '../../../../src/renderer/src/tools/cloudIphoneStore'
import { threadsStateFixture } from '../../../fixtures/renderer/liveAgentState'
import { TOKEN_A, fakeFilesBridge, text } from '../../../fixtures/renderer/fakeFilesBridge'

/** Tools › 3D models (the Meshy plan's ticket 5): the open thread's 3D models, behind the plugins Owl feature. */
const gate = vi.hoisted(() => ({ plugins: true }))
vi.mock('../../../../src/renderer/src/state/owlFeature', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../src/renderer/src/state/owlFeature')>()
  return { ...actual, useOwlFeature: (id: Parameters<typeof actual.useOwlFeature>[0]) => id === 'plugins' ? gate.plugins : actual.useOwlFeature(id) }
})
/** The names of the 3D models a view was drawn for, in order. */
const drawn = vi.hoisted(() => [] as string[])
vi.mock('../../../../src/renderer/src/agents/ModelView', () => ({
  default: ({ name, part }: { readonly name: string; readonly part: string }) => { drawn.push(name); return <div role="slider" aria-label={`Turn the ${name}`} data-part={part} tabIndex={0} /> },
}))

const THREAD = 'visual-gate'
const files = (name: string, gone = false): Model3dView['files'] => ['png', 'glb', 'usdz'].map(kind => ({ name: `${name}.${kind}`, ...(gone ? {} : { bytes: 600_000 }) }))
function listed(id: string, name: string, change: Partial<Model3dListed> = {}): Model3dListed {
  return { id, name, source: 'words', state: 'done', credits: 30, folder: 'models', files: files(name), threadId: THREAD, account: 'Studio', askedAt: '2026-11-13T16:30:00.000Z', ...change }
}
const POTION = listed('potion', 'Potion bottle')
const BARREL = listed('barrel', 'Oak barrel', { askedAt: '2026-11-13T16:12:00.000Z' })
const MOSSY = listed('mossy', 'Mossy barrel', { state: 'making', stage: 'texture', percent: 68, credits: 20, files: [], askedAt: '2026-11-15T17:52:00.000Z' })

let models: Model3dListed[]
const plugins = {
  models3d: vi.fn(async (threadId?: string) => threadId === THREAD ? models : []),
  onModel3dChanged: vi.fn(() => () => undefined),
  onModels3dRemoved: vi.fn(() => () => undefined),
  meshyCredits: vi.fn(async () => ({})),
  model3dBytes: vi.fn(async () => null),
  removeModel3d: vi.fn(async (): Promise<Model3dRemoval> => 'removed'),
  revealModel3d: vi.fn(async () => true),
}
beforeEach(() => {
  gate.plugins = true
  models = [MOSSY, POTION, BARREL]
  Object.defineProperty(window, 'sotto', { configurable: true, value: { plugins } })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

function setup(surface: 'models' | 'files' = 'models', state = threadsStateFixture()) {
  const store = new ToolsPanelStore()
  store.setSurface(surface)
  store.setOpen(true)
  const bridge = fakeFilesBridge({ [THREAD]: { root: 'D:\\work\\workshop', token: TOKEN_A, tree: { models: { kind: 'directory' as const }, 'models/Potion bottle.glb': { kind: 'file' as const, content: text('glb') } } } })
  const cloudStore = new CloudIphoneStore()
  const ui = (focused: string) => <div className="thread-workspace__body"><ToolsPanel focusedThreadId={focused} state={state} files={bridge} store={store} cloudStore={cloudStore} /></div>
  const view = render(ui(THREAD))
  return { store, focus: (focused: string) => view.rerender(ui(focused)) }
}
const rail = (): HTMLElement => screen.getByRole('tablist', { name: 'Tools' })

describe('Tools › 3D models', () => {
  it('sits between iPhone and Terminal, with the chosen 3D model’s view and every one the thread made', async () => {
    setup()
    expect(within(rail()).getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Browser', 'iPhone', '3D', 'Terminal', 'Files', 'Changes', 'PR', 'Agents'])
    // The tile's word is short; its name is the surface's own.
    expect(within(rail()).getByRole('tab', { name: '3D models' })).toHaveTextContent('3D')
    expect(await screen.findByText('Made with the Meshy account Studio · 80 credits in this thread')).toBeInTheDocument()
    expect(plugins.models3d).toHaveBeenCalledWith(THREAD)
    // The newest that is done is chosen: its view, its facts and a chip for each file.
    const card = screen.getByRole('region', { name: 'Potion bottle' })
    expect(await within(card).findByRole('slider', { name: 'Turn the Potion bottle' })).toBeInTheDocument()
    expect(within(card).getByText('Made from words ·')).toBeInTheDocument()
    expect(within(within(card).getByRole('list', { name: 'Files' })).getAllByRole('button').map(chip => chip.getAttribute('aria-label'))).toEqual(['Show Potion bottle.png in Files', 'Show Potion bottle.glb in Files', 'Show Potion bottle.usdz in Files'])
    expect(screen.getByRole('heading', { name: 'Made in this thread 3' })).toBeInTheDocument()
    const rows = within(screen.getByRole('list', { name: 'Made in this thread' })).getAllByRole('button')
    expect(rows.map(row => row.textContent)).toEqual(['Mossy barrelStep 2 of 2: painting the texture · 68%20 credits', 'Potion bottleNov 13 · .png .glb .usdz30 credits', 'Oak barrelNov 13 · .png .glb .usdz30 credits'])
    expect(rows[1]).toHaveAttribute('aria-current', 'true')
    fireEvent.click(rows[2]!)
    expect(screen.getByRole('region', { name: 'Oak barrel' })).toBeInTheDocument()
    expect(rows[2]).toHaveAttribute('aria-current', 'true')
  })

  it('opens a file’s chip in Files', async () => {
    const { store } = setup()
    fireEvent.click(await screen.findByRole('button', { name: 'Show Potion bottle.glb in Files' }))
    expect(store.getSnapshot().surface).toBe('files')
    await waitFor(() => expect(within(rail()).getByRole('tab', { name: 'Files' })).toHaveFocus())
  })

  it('lights its rail item while one of the thread’s 3D models is being made', async () => {
    setup('files')
    const tab = within(rail()).getByRole('tab', { name: '3D models' })
    await waitFor(() => expect(tab.querySelector('.tools-rail__live')).not.toBeNull())
    expect(tab).toHaveAttribute('aria-description', 'A 3D model is being made')
  })

  it('has no dot once none is being made', async () => {
    models = [POTION]
    setup('files')
    await waitFor(() => expect(plugins.models3d).toHaveBeenCalled())
    await screen.findAllByRole('tab')
    expect(within(rail()).getByRole('tab', { name: '3D models' }).querySelector('.tools-rail__live')).toBeNull()
  })

  it('says when a record’s files are gone, as the page does', async () => {
    models = [listed('helmet', 'Knight helmet', { files: files('Knight helmet', true) })]
    setup()
    const card = await screen.findByRole('region', { name: 'Knight helmet' })
    expect(within(card).getByText('Its files are gone.')).toBeInTheDocument()
    expect(within(card).queryByRole('list', { name: 'Files' })).toBeNull()
    fireEvent.click(within(card).getByRole('button', { name: 'Remove from 3D models' }))
    expect(await screen.findByText('No 3D models in this thread yet')).toBeInTheDocument()
    expect(plugins.removeModel3d).toHaveBeenCalledWith('helmet')
  })

  it('looks again at whether the files are there on focus while 3D models is the open surface, and not on another', async () => {
    const { store } = setup('files')
    await waitFor(() => expect(plugins.models3d).toHaveBeenCalledTimes(1))
    act(() => { window.dispatchEvent(new Event('focus')) })
    expect(plugins.models3d).toHaveBeenCalledTimes(1)
    act(() => store.setSurface('models'))
    act(() => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(plugins.models3d).toHaveBeenCalledTimes(2))
  })

  it('lets the last thread’s 3D models go as another thread is opened, before drawing any of them', async () => {
    const { focus } = setup()
    expect(await screen.findByRole('region', { name: 'Potion bottle' })).toBeInTheDocument()
    await waitFor(() => expect(drawn).toContain('Potion bottle'))
    // The other thread's list is slow to come.
    const slow = new Promise<Model3dListed[]>(() => undefined)
    plugins.models3d.mockImplementationOnce(() => slow)
    drawn.length = 0
    act(() => focus('grok-previews'))
    expect(drawn).toEqual([])
    expect(screen.queryByRole('region', { name: 'Potion bottle' })).toBeNull()
    expect(within(rail()).getByRole('tab', { name: '3D models' }).querySelector('.tools-rail__live')).toBeNull()
  })

  it('is not on the rail with the plugins Owl feature off, and reads nothing', async () => {
    gate.plugins = false
    const { store } = setup()
    expect(within(rail()).queryByRole('tab', { name: '3D models' })).toBeNull()
    // A panel left on 3D models shows Files.
    await waitFor(() => expect(store.getSnapshot().surface).toBe('files'))
    expect(plugins.models3d).not.toHaveBeenCalled()
  })
})

/** Every thread on a paired host saved here as forge (the Meshy plan's ticket 6, part 2). */
const FORGE = '33333333-3333-4333-8333-000000000001'
function onForge(host: { connected: boolean; models3d?: true }) {
  const state = threadsStateFixture()
  state.connections = [{ hostId: FORGE, name: 'forge', kind: 'remote', ...host }]
  state.host.threads = state.host.threads.map(thread => ({ ...thread, remoteHost: true, hostId: FORGE }))
  return state
}

describe('Tools › 3D models on a host thread', () => {
  it('shows the host thread’s 3D models as a local thread’s, in place of saying they are on the host', async () => {
    setup('models', onForge({ connected: true, models3d: true }))
    expect(await screen.findByRole('region', { name: 'Potion bottle' })).toBeInTheDocument()
    expect(plugins.models3d).toHaveBeenCalledWith(THREAD)
    expect(screen.queryByText('3D models is on the host machine.')).toBeNull()
    expect(screen.getByRole('button', { name: 'Show Potion bottle.glb in Files' })).toBeInTheDocument()
  })

  it('says the host isn’t connected while it is away, and reads nothing', async () => {
    setup('models', onForge({ connected: false, models3d: true }))
    expect(await screen.findByText('forge isn’t connected')).toBeInTheDocument()
    expect(screen.getByText('Its 3D models show here again once it is.')).toBeInTheDocument()
    expect(plugins.models3d).not.toHaveBeenCalled()
  })

  it('tells an older host apart, which cannot show its 3D models here', async () => {
    setup('models', onForge({ connected: true }))
    expect(await screen.findByText('This host cannot show its 3D models here yet.')).toBeInTheDocument()
    expect(screen.getByText('Update Sotto on forge in Settings > Hosts & phones to see them here.')).toBeInTheDocument()
    expect(plugins.models3d).not.toHaveBeenCalled()
  })
})
