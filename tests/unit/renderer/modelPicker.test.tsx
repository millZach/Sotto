import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
    expect(models[0]?.id).toBe('old')
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
    await user.click(screen.getByRole('tab', { name: 'Claude' }))
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('option', { name: /Claude Opus/ })).toBeDisabled()
    expect(screen.queryByRole('option', { name: 'GPT-6-Astra' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('option', { name: 'Claude Sonnet 4.6' }))
    expect(onChange).toHaveBeenCalledExactlyOnceWith('sonnet')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  describe('the wheel over the provider rail', () => {
    // The rail tells one turn of the wheel from the next by the time between its events, so the tests set that time.
    let clock = 0
    beforeEach(() => { clock = 1000; vi.spyOn(performance, 'now').mockImplementation(() => clock) })
    afterEach(() => { vi.restoreAllMocks() })
    const threeProviders: AgentModel[] = [...models, { id: 'grok', name: 'Grok 4.7', provider: 'Grok', ready: true }]
    const open = async (list: AgentModel[] = threeProviders) => {
      const user = userEvent.setup()
      const onChange = vi.fn()
      const view = render(<ModelPicker models={list} modelId="astra" disabled={false} onChange={onChange} />)
      await user.click(screen.getByRole('combobox', { name: 'Thread model' }))
      const rail = screen.getByRole('tablist', { name: 'Model providers' })
      const chosen = (): string | null | undefined => within(rail).getAllByRole('tab').find(tab => tab.getAttribute('aria-selected') === 'true')?.getAttribute('aria-label')
      return { user, onChange, view, rail, chosen }
    }
    /** One wheel event `after` milliseconds after the last; returns false when the rail took it for itself. */
    const wheel = (rail: HTMLElement, deltaY: number, after: number, init: WheelEventInit = {}): boolean => {
      clock += after
      return fireEvent.wheel(rail, { deltaY, ...init })
    }

    it('steps one provider for each turn of the wheel and stops at either end', async () => {
      const { rail, chosen, onChange } = await open()
      // Not passive: the rail does not scroll under the step.
      expect(wheel(rail, 100, 400)).toBe(false)
      expect(chosen()).toBe('Claude')
      expect(screen.getByRole('option', { name: 'Claude Sonnet 4.6' })).toBeInTheDocument()
      wheel(rail, 100, 400)
      wheel(rail, 100, 400)
      expect(chosen()).toBe('Grok')
      wheel(rail, -100, 400)
      wheel(rail, -100, 400)
      wheel(rail, -100, 400)
      expect(chosen()).toBe('Codex')
      // The search line keeps focus, so typing goes on where it was, and nothing is chosen until a model is.
      expect(screen.getByRole('textbox', { name: 'Search models' })).toHaveFocus()
      expect(onChange).not.toHaveBeenCalled()
    })

    it('counts a touchpad swipe with its momentum, or a quick burst of notches, as one turn', async () => {
      const { rail, chosen } = await open()
      wheel(rail, 15, 400)
      wheel(rail, 15, 16)
      expect(chosen()).toBe('Codex')
      wheel(rail, 15, 16)
      expect(chosen()).toBe('Claude')
      for (let event = 0; event < 20; event += 1) wheel(rail, 12, 16)
      expect(chosen()).toBe('Claude')
      wheel(rail, 100, 400)
      wheel(rail, 100, 20)
      wheel(rail, 100, 20)
      expect(chosen()).toBe('Grok')
    })

    it('starts a new turn at once when the wheel turns the other way', async () => {
      const { rail, chosen } = await open()
      wheel(rail, 100, 400)
      expect(chosen()).toBe('Claude')
      wheel(rail, -100, 10)
      expect(chosen()).toBe('Codex')
    })

    it('moves focus on the rail with the choice, so its one tab stop follows', async () => {
      const { user, rail } = await open()
      await user.tab({ shift: true })
      expect(within(rail).getByRole('tab', { name: 'Codex' })).toHaveFocus()
      wheel(rail, 100, 400)
      expect(within(rail).getByRole('tab', { name: 'Claude' })).toHaveFocus()
      expect(within(rail).getByRole('tab', { name: 'Claude' })).toHaveAttribute('tabindex', '0')
    })

    it('keeps a turn going when the owner hands over a fresh list of the same models', async () => {
      const { view, rail } = await open(models)
      wheel(rail, 25, 400)
      view.rerender(<ModelPicker models={models.map(model => ({ ...model }))} modelId="astra" disabled={false} onChange={vi.fn()} />)
      wheel(screen.getByRole('tablist', { name: 'Model providers' }), 25, 16)
      expect(screen.getByRole('tab', { name: 'Claude' })).toHaveAttribute('aria-selected', 'true')
    })

    it('counts every turn that lands before the menu redraws', async () => {
      const { rail, chosen } = await open()
      // Both turns inside one act: React commits neither step until both have been handled.
      act(() => {
        rail.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }))
        clock += 400
        rail.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }))
      })
      expect(chosen()).toBe('Grok')
    })

    it('starts afresh when the menu opens again', async () => {
      const { rail } = await open()
      wheel(rail, 35, 400)
      fireEvent(screen.getByRole('dialog', { name: 'Choose model' }), new Event('cancel', { bubbles: true, cancelable: true }))
      fireEvent.click(screen.getByRole('combobox', { name: 'Thread model' }))
      wheel(screen.getByRole('tablist', { name: 'Model providers' }), 5, 16)
      expect(screen.getByRole('tab', { name: 'Codex' })).toHaveAttribute('aria-selected', 'true')
    })

    it('leaves zoom, a pinch and sideways scrolling alone', async () => {
      const { rail, chosen } = await open()
      expect(wheel(rail, 100, 400, { ctrlKey: true })).toBe(true)
      expect(wheel(rail, 100, 400, { metaKey: true })).toBe(true)
      expect(fireEvent.wheel(rail, { deltaX: 100, deltaY: 0 })).toBe(true)
      expect(chosen()).toBe('Codex')
    })

    it('brings the chosen provider into view on a rail taller than the menu', async () => {
      const scrolled = vi.fn()
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrolled })
      try {
        const { rail } = await open()
        wheel(rail, 100, 400)
        expect(scrolled).toHaveBeenCalledExactlyOnceWith({ block: 'nearest' })
        expect(scrolled.mock.contexts[0]).toBe(within(rail).getByRole('tab', { name: 'Claude' }))
      } finally { delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView }
    })
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
