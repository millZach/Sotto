import React from 'react'
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelPicker } from '../../../src/renderer/src/agents/ModelPicker'
import { MODEL_FAVORITES_KEY, toggleModelFavorite, useModelFavorites } from '../../../src/renderer/src/agents/modelFavorites'
import type { AgentModel } from '../../../src/shared/agents'

const owl = vi.hoisted(() => ({ on: true }))
vi.mock('../../../src/renderer/src/state/owlFeature', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/renderer/src/state/owlFeature')>()
  return { ...actual, useOwlFeature: (id: string) => id === 'model-favorites' ? owl.on : actual.useOwlFeature(id as never) }
})

const models: AgentModel[] = [
  { id: 'astra', name: 'GPT-6-Astra', provider: 'Codex', providerId: 'codex', ready: true },
  { id: 'terra', name: 'GPT-6-Terra', provider: 'Codex', providerId: 'codex', ready: true },
  { id: 'sonnet', name: 'Claude Sonnet 4.6', provider: 'Claude', providerId: 'claude', ready: true },
  { id: 'zen/glm', name: 'GLM 5.3', provider: 'OpenCode', providerId: 'opencode', source: 'OpenCode Zen', ready: true },
  { id: 'refuseless/glm', name: 'GLM 5.3', provider: 'OpenCode', providerId: 'opencode', source: 'Refuseless', ready: true },
]
const model = (id: string): AgentModel => models.find(item => item.id === id)!
const stored = (): unknown => JSON.parse(localStorage.getItem(MODEL_FAVORITES_KEY) ?? 'null')

afterEach(() => { cleanup(); localStorage.clear(); window.dispatchEvent(new StorageEvent('storage')); owl.on = true })

describe('model favorites', () => {
  it('keeps each starred model by provider and id, in the order starred, and survives a fresh read', () => {
    const { result } = renderHook(() => useModelFavorites())
    act(() => { toggleModelFavorite(model('refuseless/glm')); toggleModelFavorite(model('sonnet')) })
    expect(result.current.map(favorite => favorite.id)).toEqual(['refuseless/glm', 'sonnet'])
    expect(stored()).toEqual([
      { id: 'refuseless/glm', name: 'GLM 5.3', provider: 'OpenCode', providerId: 'opencode', source: 'Refuseless' },
      { id: 'sonnet', name: 'Claude Sonnet 4.6', provider: 'Claude', providerId: 'claude' },
    ])
    // The same list between changes, so React reads it without looping.
    expect(renderHook(() => useModelFavorites()).result.current).toBe(result.current)
    act(() => toggleModelFavorite(model('refuseless/glm')))
    expect(result.current.map(favorite => favorite.id)).toEqual(['sonnet'])
  })

  it('drops only an entry that no longer reads, and reads unreadable text as none', () => {
    localStorage.setItem(MODEL_FAVORITES_KEY, JSON.stringify([{ id: 'gone', name: 'Gone', provider: 'Gone', providerId: 'not-a-provider' }, { id: 'sonnet', name: 'Claude Sonnet 4.6', provider: 'Claude' }]))
    expect(renderHook(() => useModelFavorites()).result.current.map(favorite => favorite.id)).toEqual(['sonnet'])
    localStorage.setItem(MODEL_FAVORITES_KEY, '{')
    expect(renderHook(() => useModelFavorites()).result.current).toEqual([])
  })

  it('opens on the providers with an empty Favorites while nothing is starred', async () => {
    const user = userEvent.setup()
    render(<ModelPicker models={models} modelId="astra" disabled={false} onChange={vi.fn()} />)
    await user.click(screen.getByRole('combobox', { name: 'Thread model' }))
    const rail = screen.getByRole('tablist', { name: 'Model providers' })
    expect(within(rail).getAllByRole('tab').map(tab => tab.getAttribute('aria-label'))).toEqual(['Favorites', 'Codex', 'Claude', 'OpenCode'])
    expect(within(rail).getByRole('tab', { name: 'Codex' })).toHaveAttribute('aria-selected', 'true')
    await user.click(within(rail).getByRole('tab', { name: 'Favorites' }))
    expect(screen.getByText('Star a model to keep it here.')).toBeInTheDocument()
  })

  it('stars a row by its star and by F, and opens on Favorites with the current model chosen', async () => {
    const user = userEvent.setup()
    render(<ModelPicker models={models} modelId="astra" disabled={false} onChange={vi.fn()} />)
    const trigger = screen.getByRole('combobox', { name: 'Thread model' })
    await user.click(trigger)
    const astra = screen.getByRole('option', { name: 'GPT-6-Astra' })
    await user.click(astra.querySelector('.model-picker__star')!)
    // A press on the star stars the model and chooses nothing.
    expect(screen.getByRole('dialog', { name: 'Choose model' })).toBeInTheDocument()
    expect(astra.querySelector('.model-picker__star')).toHaveAttribute('data-starred', 'true')
    await user.click(screen.getByRole('tab', { name: 'Claude' }))
    screen.getByRole('option', { name: 'Claude Sonnet 4.6' }).focus()
    await user.keyboard('f')
    expect(stored()).toEqual([expect.objectContaining({ id: 'astra' }), expect.objectContaining({ id: 'sonnet' })])
    await user.keyboard('{Escape}')
    await user.click(trigger)
    expect(screen.getByRole('tab', { name: 'Favorites' })).toHaveAttribute('aria-selected', 'true')
    const favorites = screen.getByRole('listbox', { name: 'Favorites' })
    expect(within(favorites).getAllByRole('option').map(option => option.textContent)).toEqual(['GPT-6-Astra', 'Claude Sonnet 4.6'])
    expect(within(favorites).getByRole('option', { name: 'GPT-6-Astra' })).toHaveAttribute('aria-selected', 'true')
  })

  it('chooses from Favorites as from the model’s own provider, and tells same-named models apart by source', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    act(() => { toggleModelFavorite(model('zen/glm')); toggleModelFavorite(model('refuseless/glm')) })
    render(<ModelPicker models={models} modelId="astra" disabled={false} onChange={onChange} />)
    await user.click(screen.getByRole('combobox', { name: 'Thread model' }))
    expect(within(screen.getByRole('listbox', { name: 'Favorites' })).getAllByRole('option').map(option => option.textContent)).toEqual(['GLM 5.3OpenCode Zen', 'GLM 5.3Refuseless'])
    await user.click(screen.getByRole('option', { name: /GLM 5.3.*Refuseless/ }))
    expect(onChange).toHaveBeenCalledExactlyOnceWith('refuseless/glm')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('keeps a favorite whose model has gone, unavailable, and lets its star come off with focus on the next row', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    act(() => { toggleModelFavorite({ id: 'gone', name: 'Old Model', provider: 'Claude', providerId: 'claude', ready: true }); toggleModelFavorite(model('sonnet')) })
    render(<ModelPicker models={models} modelId="astra" disabled={false} onChange={onChange} />)
    await user.click(screen.getByRole('combobox', { name: 'Thread model' }))
    const gone = screen.getByRole('option', { name: /Old Model/ })
    expect(gone).toHaveAttribute('aria-disabled', 'true')
    await user.click(gone)
    expect(onChange).not.toHaveBeenCalled()
    gone.focus()
    await user.keyboard('f')
    expect(screen.queryByRole('option', { name: /Old Model/ })).not.toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Claude Sonnet 4.6' })).toHaveFocus()
  })

  it('leaves out favorites of providers this menu does not offer, and then opens as before', async () => {
    const user = userEvent.setup()
    act(() => toggleModelFavorite(model('astra')))
    render(<ModelPicker models={models.filter(item => item.provider !== 'Codex')} modelId="sonnet" disabled={false} onChange={vi.fn()} />)
    await user.click(screen.getByRole('combobox', { name: 'Thread model' }))
    expect(screen.getByRole('tab', { name: 'Claude' })).toHaveAttribute('aria-selected', 'true')
    await user.click(screen.getByRole('tab', { name: 'Favorites' }))
    expect(screen.queryByRole('option', { name: /GPT-6-Astra/ })).not.toBeInTheDocument()
    expect(screen.getByText('Star a model to keep it here.')).toBeInTheDocument()
  })

  it('searches every provider’s models from Favorites, and Escape clears the search first', async () => {
    const user = userEvent.setup()
    act(() => toggleModelFavorite(model('sonnet')))
    render(<ModelPicker models={models} modelId="astra" disabled={false} onChange={vi.fn()} />)
    await user.click(screen.getByRole('combobox', { name: 'Thread model' }))
    await user.type(screen.getByRole('textbox', { name: 'Search models' }), 'gpt')
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['GPT-6-Astra', 'GPT-6-Terra'])
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search models' }), { key: 'Escape' })
    expect(screen.getByRole('textbox', { name: 'Search models' })).toHaveValue('')
    expect(screen.getByRole('listbox', { name: 'Favorites' })).toBeInTheDocument()
  })

  it('shows no Favorites and no stars on stable', async () => {
    owl.on = false
    act(() => toggleModelFavorite(model('sonnet')))
    const user = userEvent.setup()
    render(<ModelPicker models={models} modelId="astra" disabled={false} onChange={vi.fn()} />)
    await user.click(screen.getByRole('combobox', { name: 'Thread model' }))
    expect(screen.queryByRole('tab', { name: 'Favorites' })).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Codex' })).toHaveAttribute('aria-selected', 'true')
    expect(document.querySelector('.model-picker__star')).toBeNull()
  })
})
