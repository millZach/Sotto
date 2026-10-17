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

  describe('a provider whose models come from several model sources', () => {
    // OpenCode lists models from each model source the user signed in to inside it, OpenCode Zen's free ones always (ADR-0087).
    const openCode = (id: string, name: string, source: string): AgentModel => ({ id, name, provider: 'OpenCode', providerId: 'opencode', source, ready: true })
    const sourced: AgentModel[] = [
      { id: 'astra', name: 'GPT-6-Astra', provider: 'Codex', providerId: 'codex', ready: true },
      openCode('anthropic/claude-sonnet-4-6', 'Claude Sonnet 4.6', 'Anthropic'),
      openCode('anthropic/claude-sonnet-5', 'Claude Sonnet 5', 'Anthropic'),
      openCode('opencode/big-pickle', 'Big Pickle', 'OpenCode Zen'),
      openCode('opencode/nemotron', 'Nemotron 3.5 Free', 'OpenCode Zen'),
      openCode('openrouter/claude-opus-5-5', 'Claude Opus 5.5', 'OpenRouter'),
      openCode('openrouter/gpt-6-sol', 'GPT-6-Sol', 'OpenRouter'),
    ]
    const open = async (modelId = 'anthropic/claude-sonnet-5') => {
      const user = userEvent.setup()
      const onChange = vi.fn()
      render(<ModelPicker models={sourced} modelId={modelId} disabled={false} onChange={onChange} />)
      const chip = screen.getByRole('combobox', { name: 'Thread model' })
      await user.click(chip)
      return { user, onChange, chip }
    }
    const sourceRows = (): HTMLElement[] => within(screen.getByRole('group', { name: 'OpenCode model sources' })).getAllByRole('button')

    it('opens on its model sources, each with its model count, Zen first with its free note and the chosen model’s source marked', async () => {
      await open()
      expect(screen.getByRole('tab', { name: 'OpenCode' })).toHaveAttribute('aria-selected', 'true')
      expect(screen.queryByRole('option')).not.toBeInTheDocument()
      expect(sourceRows().map(row => row.textContent)).toEqual(['OpenCode Zen2 models · Free with OpenCode Zen', 'Anthropic2 models', 'OpenRouter2 models'])
      expect(sourceRows().map(row => row.getAttribute('aria-label'))).toEqual([
        'Show OpenCode Zen models, 2 models, Free with OpenCode Zen', 'Show Anthropic models, 2 models', 'Show OpenRouter models, 2 models'])
      expect(sourceRows().map(row => row.getAttribute('aria-current'))).toEqual([null, 'true', null])
      expect(screen.getByRole('textbox', { name: 'Search models' })).toHaveAttribute('placeholder', 'Search all OpenCode models')
      // The glossary's words: a model source is neither a service nor a provider.
      expect(screen.getByRole('dialog', { name: 'Choose model' }).textContent).not.toMatch(/service|provider/iu)
    })

    it('shows a source’s models newest first under a back control and its count, and picks one', async () => {
      const { user, onChange, chip } = await open()
      await user.click(screen.getByRole('button', { name: /^Show Anthropic models/u }))
      const list = screen.getByRole('listbox', { name: 'Anthropic models' })
      expect(within(list).getAllByRole('option').map(option => option.textContent)).toEqual(['Claude Sonnet 5', 'Claude Sonnet 4.6'])
      // Focus lands on the thread's model, so Enter keeps it and the arrows move from there.
      expect(within(list).getByRole('option', { name: 'Claude Sonnet 5' })).toHaveFocus()
      const back = screen.getByRole('button', { name: 'Back to model sources' })
      expect(back).toHaveTextContent('Model sources')
      expect(back.parentElement).toHaveTextContent('Anthropic2 models')
      await user.click(within(list).getByRole('option', { name: 'Claude Sonnet 4.6' }))
      expect(onChange).toHaveBeenCalledExactlyOnceWith('anthropic/claude-sonnet-4-6')
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(chip).toHaveFocus()
    })

    it('goes back to the model sources with focus on the source it left', async () => {
      const { user } = await open()
      await user.click(screen.getByRole('button', { name: /^Show OpenRouter models/u }))
      expect(screen.getByRole('option', { name: 'GPT-6-Sol' })).toHaveFocus()
      await user.click(screen.getByRole('button', { name: 'Back to model sources' }))
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: /^Show OpenRouter models/u })).toHaveFocus()
    })

    it('searches every source at once under its heading, and matches a source by its name', async () => {
      const { user } = await open()
      await user.click(screen.getByRole('button', { name: /^Show OpenRouter models/u }))
      const search = screen.getByRole('textbox', { name: 'Search models' })
      await user.click(search)
      await user.keyboard('claude')
      const list = screen.getByRole('listbox', { name: 'OpenCode models' })
      expect(within(list).getAllByRole('group').map(group => group.getAttribute('aria-label'))).toEqual(['Anthropic', 'OpenRouter'])
      expect(within(within(list).getByRole('group', { name: 'Anthropic' })).getAllByRole('option').map(option => option.textContent)).toEqual(['Claude Sonnet 5', 'Claude Sonnet 4.6'])
      expect(within(within(list).getByRole('group', { name: 'OpenRouter' })).getAllByRole('option').map(option => option.textContent)).toEqual(['Claude Opus 5.5'])
      expect(screen.getByText('3 models')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Back to model sources' })).not.toBeInTheDocument()
      await user.clear(search)
      await user.keyboard('openrouter')
      expect(within(screen.getByRole('listbox', { name: 'OpenCode models' })).getAllByRole('group').map(group => group.getAttribute('aria-label'))).toEqual(['OpenRouter'])
      expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['GPT-6-Sol', 'Claude Opus 5.5'])
      await user.clear(search)
      await user.keyboard('nothing like it')
      expect(screen.getByText('No matching models.')).toBeInTheDocument()
    })

    it('takes the keys the model list takes: Down from search enters the sources, the arrows move, Enter opens and picks', async () => {
      const { user, onChange } = await open()
      await user.keyboard('{ArrowDown}')
      expect(sourceRows()[0]).toHaveFocus()
      await user.keyboard('{ArrowDown}{ArrowDown}')
      expect(sourceRows()[2]).toHaveFocus()
      await user.keyboard('{Home}{End}{Enter}')
      expect(screen.getByRole('option', { name: 'GPT-6-Sol' })).toHaveFocus()
      await user.keyboard('{ArrowDown}{Enter}')
      expect(onChange).toHaveBeenCalledExactlyOnceWith('openrouter/claude-opus-5-5')
    })

    it('returns to search from the first source on Up, rather than wrapping to the last', async () => {
      const { user } = await open()
      const search = screen.getByRole('textbox', { name: 'Search models' })
      await user.keyboard('{ArrowDown}')
      expect(sourceRows()[0]).toHaveFocus()
      await user.keyboard('{ArrowUp}')
      expect(search).toHaveFocus()
      await user.keyboard('{ArrowDown}{End}{ArrowUp}')
      expect(sourceRows()[1]).toHaveFocus()
      await user.keyboard('{Home}')
      expect(sourceRows()[0]).toHaveFocus()
    })

    it('makes the model sources one tab stop, on the chosen model’s source until the arrows move it', async () => {
      const { user } = await open()
      // Before any key, the stop is the source holding the thread's model.
      expect(sourceRows().map(row => row.tabIndex)).toEqual([-1, 0, -1])
      await user.keyboard('{ArrowDown}')
      expect(sourceRows()[0]).toHaveFocus()
      expect(sourceRows().map(row => row.tabIndex)).toEqual([0, -1, -1])
      // Tab leaves the list from any row rather than visiting each source.
      await user.tab()
      expect(sourceRows().some(row => row === document.activeElement)).toBe(false)
      await user.tab({ shift: true })
      expect(sourceRows()[0]).toHaveFocus()
    })

    it('closes the menu on Escape from a source row, with focus back on the chip', async () => {
      const { user, chip, onChange } = await open()
      await user.keyboard('{ArrowDown}{ArrowDown}')
      expect(sourceRows()[1]).toHaveFocus()
      await user.keyboard('{Escape}')
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(chip).toHaveFocus()
      expect(onChange).not.toHaveBeenCalled()
    })

    it('steps back one level for each Escape: the search, then the source, then the menu', async () => {
      const { user, onChange, chip } = await open()
      await user.keyboard('{ArrowDown}{ArrowDown}{Enter}')
      expect(screen.getByRole('option', { name: 'Claude Sonnet 5' })).toHaveFocus()
      const search = screen.getByRole('textbox', { name: 'Search models' })
      await user.click(search)
      await user.keyboard('pickle')
      expect(screen.getByRole('listbox', { name: 'OpenCode models' })).toBeInTheDocument()
      await user.keyboard('{Escape}')
      expect(search).toHaveValue('')
      expect(search).toHaveFocus()
      expect(screen.getByRole('listbox', { name: 'Anthropic models' })).toBeInTheDocument()
      await user.keyboard('{Escape}')
      expect(screen.getByRole('button', { name: /^Show Anthropic models/u })).toHaveFocus()
      await user.keyboard('{Escape}')
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(chip).toHaveFocus()
      expect(onChange).not.toHaveBeenCalled()
    })

    it('starts another visit to the provider on its sources, after the rail or the wheel has moved away', async () => {
      const { user } = await open()
      await user.click(screen.getByRole('button', { name: /^Show Anthropic models/u }))
      await user.click(screen.getByRole('tab', { name: 'Codex' }))
      expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['GPT-6-Astra'])
      expect(screen.queryByRole('group', { name: 'OpenCode model sources' })).not.toBeInTheDocument()
      fireEvent.wheel(screen.getByRole('tablist', { name: 'Model providers' }), { deltaY: 100 })
      expect(screen.getByRole('tab', { name: 'OpenCode' })).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByRole('group', { name: 'OpenCode model sources' })).toBeInTheDocument()
    })

    it('names the source before the model on the chip, with the OpenCode mark, and says the lot in its tooltip', () => {
      render(<ModelPicker models={sourced} modelId="anthropic/claude-sonnet-5" disabled={false} onChange={vi.fn()} />)
      const chip = screen.getByRole('combobox', { name: 'Thread model' })
      expect(chip).toHaveTextContent('Anthropic/Claude Sonnet 5')
      expect(chip.querySelector('.model-picker__source')).toHaveTextContent('Anthropic')
      expect(chip.querySelector('.model-picker__name')).toHaveTextContent('Claude Sonnet 5')
      expect(chip).toHaveAttribute('title', 'Claude Sonnet 5 from Anthropic, in OpenCode')
      expect(chip).toHaveAccessibleDescription('Claude Sonnet 5 from Anthropic, in OpenCode')
      expect(chip.querySelector('.provider-mark')).toHaveAttribute('data-provider', 'opencode')
    })

    it('finds a model by its source and its name together, a word of each, in either order', async () => {
      const { user } = await open()
      await user.keyboard('anthropic sonnet')
      expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['Claude Sonnet 5', 'Claude Sonnet 4.6'])
      await user.clear(screen.getByRole('textbox', { name: 'Search models' }))
      await user.keyboard('opus  openrouter')
      expect(within(screen.getByRole('listbox', { name: 'OpenCode models' })).getAllByRole('group').map(group => group.getAttribute('aria-label'))).toEqual(['OpenRouter'])
      expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['Claude Opus 5.5'])
    })

    it('keeps focus in the menu when a source has no model to choose, so Escape still steps back', async () => {
      const user = userEvent.setup()
      const waiting = [...sourced, { ...openCode('xai/grok-5', 'Grok 5', 'xAI'), ready: false }]
      render(<ModelPicker models={waiting} modelId="anthropic/claude-sonnet-5" disabled={false} onChange={vi.fn()} />)
      await user.click(screen.getByRole('combobox', { name: 'Thread model' }))
      await user.click(screen.getByRole('button', { name: /^Show xAI models/u }))
      expect(screen.getByRole('button', { name: 'Back to model sources' })).toHaveFocus()
      await user.keyboard('{Escape}')
      expect(screen.getByRole('dialog', { name: 'Choose model' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /^Show xAI models/u })).toHaveFocus()
    })

    it('forgets a source that leaves while it is open, so its return does not reopen it, and keeps focus in the menu', async () => {
      const user = userEvent.setup()
      const view = render(<ModelPicker models={sourced} modelId="opencode/big-pickle" disabled={false} onChange={vi.fn()} />)
      await user.click(screen.getByRole('combobox', { name: 'Thread model' }))
      await user.click(screen.getByRole('button', { name: /^Show Anthropic models/u }))
      expect(screen.getByRole('option', { name: 'Claude Sonnet 5' })).toHaveFocus()
      view.rerender(<ModelPicker models={sourced.filter(model => model.source !== 'Anthropic')} modelId="opencode/big-pickle" disabled={false} onChange={vi.fn()} />)
      expect(screen.getByRole('group', { name: 'OpenCode model sources' })).toBeInTheDocument()
      expect(screen.getByRole('textbox', { name: 'Search models' })).toHaveFocus()
      view.rerender(<ModelPicker models={sourced} modelId="opencode/big-pickle" disabled={false} onChange={vi.fn()} />)
      expect(screen.getByRole('group', { name: 'OpenCode model sources' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Back to model sources' })).not.toBeInTheDocument()
    })

    it('leaves a provider without model sources as it was: one list, and Escape left to the dialog', async () => {
      const user = userEvent.setup()
      render(<ModelPicker models={models} modelId="astra" disabled={false} onChange={vi.fn()} />)
      const chip = screen.getByRole('combobox', { name: 'Thread model' })
      expect(chip).toHaveTextContent('GPT-6-Astra')
      expect(chip).toHaveAttribute('title', 'GPT-6-Astra')
      expect(chip.querySelector('.model-picker__path')).toBeNull()
      await user.click(chip)
      expect(screen.getByRole('textbox', { name: 'Search models' })).toHaveAttribute('placeholder', 'Search Codex models')
      expect(screen.queryByRole('group')).not.toBeInTheDocument()
      await user.keyboard('gpt')
      // Not taken: the dialog's own cancel closes the menu, search and all, as before.
      expect(fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search models' }), { key: 'Escape' })).toBe(true)
      expect(screen.getByRole('textbox', { name: 'Search models' })).toHaveValue('gpt')
    })
  })
})
