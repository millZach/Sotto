import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelPicker, newestModelsFirst } from '../../../src/renderer/src/agents/ModelPicker'
import type { AgentModel } from '../../../src/shared/agents'

const models: AgentModel[] = [
  { id: 'old', name: 'GPT-5.6', provider: 'Codex', ready: true },
  { id: 'sonnet', name: 'Claude Sonnet 4.6', provider: 'Claude', ready: true },
  { id: 'astra', name: 'GPT-6-Astra', provider: 'Codex', ready: true },
  { id: 'minor', name: 'GPT-5.10', provider: 'Codex', ready: true },
  { id: 'terra', name: 'GPT-6-Terra', provider: 'Codex', ready: true },
  { id: 'unavailable', name: 'Claude Opus 4.6', provider: 'Claude', ready: false },
]
afterEach(cleanup)

describe('provider model picker', () => {
  it('sorts numeric versions newest first and keeps provider order for the same version', () => {
    expect(newestModelsFirst(models.filter(model => model.provider === 'Codex')).map(model => model.id)).toEqual(['astra', 'terra', 'minor', 'old'])
    expect(models[0].id).toBe('old')
  })

  it('keeps the provider’s own recommendation at the top of its list, whatever it is called', () => {
    const catalog: AgentModel[] = [
      { id: 'fable', name: 'Fable 5.1', provider: 'Claude', ready: true },
      { id: 'default', name: 'Default (recommended)', provider: 'Claude', ready: true, recommended: true },
      { id: 'haiku', name: 'Haiku 4.5', provider: 'Claude', ready: true },
    ]
    expect(newestModelsFirst(catalog).map(model => model.id)).toEqual(['default', 'fable', 'haiku'])
  })

  it('names each provider on a rail of marks rather than in a row of tabs', async () => {
    const user = userEvent.setup()
    render(<ModelPicker models={models} modelId="astra" disabled={false} onChange={vi.fn()} />)
    await user.click(screen.getByRole('combobox', { name: 'Thread model' }))
    const rail = screen.getByRole('tablist', { name: 'Model providers' })
    // Marks only: the provider's name is the tile's accessible name, not text the menu has to find room for.
    expect(within(rail).getAllByRole('tab').map(tab => tab.getAttribute('aria-label'))).toEqual(['Codex', 'Claude'])
    expect(rail.textContent).not.toMatch(/Codex|Claude/u)
    expect(within(rail).getByRole('tab', { name: 'Codex' })).toHaveAttribute('aria-selected', 'true')
  })

  it('opens the selected provider and only changes the model when a model is chosen', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<ModelPicker models={models} modelId="astra" disabled={false} onChange={onChange} />)
    const trigger = screen.getByRole('combobox', { name: 'Thread model' })
    await user.click(trigger)
    expect(screen.getByRole('textbox', { name: 'Search models' })).toHaveFocus()
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['GPT-6-Astra', 'GPT-6-Terra', 'GPT-5.10', 'GPT-5.6'])
    await user.click(screen.getByRole('tab', { name: 'Claude', exact: true }))
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('option', { name: /Claude Opus/ })).toBeDisabled()
    expect(screen.queryByRole('option', { name: 'GPT-6-Astra' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('option', { name: 'Claude Sonnet 4.6' }))
    expect(onChange).toHaveBeenCalledExactlyOnceWith('sonnet')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('filters models and supports arrow-key selection without submitting the parent form', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn(event => event.preventDefault())
    const onChange = vi.fn()
    render(<form onSubmit={onSubmit}><ModelPicker models={models} modelId="astra" disabled={false} onChange={onChange} /><button type="submit">Create thread</button></form>)
    await user.click(screen.getByRole('combobox'))
    await user.type(screen.getByRole('textbox'), '5.')
    expect(screen.getAllByRole('option')).toHaveLength(2)
    await user.keyboard('{Enter}')
    expect(onSubmit).not.toHaveBeenCalled()
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}')
    expect(onChange).toHaveBeenCalledExactlyOnceWith('old')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('cancels only the model popup, preserving the parent dialog and selection', () => {
    const onCancel = vi.fn()
    const onChange = vi.fn()
    render(<dialog open aria-label="New thread" onCancel={onCancel}><ModelPicker models={models} modelId="astra" disabled={false} onChange={onChange} /></dialog>)
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent(screen.getByRole('dialog', { name: 'Choose model' }), new Event('cancel', { bubbles: true, cancelable: true }))
    expect(screen.queryByRole('dialog', { name: 'Choose model' })).not.toBeInTheDocument()
    expect(within(screen.getByRole('dialog', { name: 'New thread' })).getByRole('combobox')).toHaveFocus()
    expect(onCancel).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
  })
})
