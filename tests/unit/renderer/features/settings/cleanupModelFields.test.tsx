import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CleanupModelFields, matchModels } from '../../../../../src/renderer/src/components/CleanupModelFields'
import { SettingsView } from '../../../../../src/renderer/src/features/settings/SettingsView'
import { baseProps, selectCategory } from '../../../../fixtures/renderer/settingsViewHarness'

const MODELS = [
  { id: 'anthropic/claude-haiku-5.5', name: 'Anthropic: Claude Haiku 5.5' },
  { id: 'google/gemini-3.1-flash-lite', name: 'Google: Gemini 3.1 Flash Lite' },
]

describe('CleanupModelFields', () => {
  it('matches every typed word against the name or slug, Default first when nothing is typed', () => {
    expect(matchModels(MODELS, '').map(model => model.name)).toEqual(['Default', ...MODELS.map(model => model.name)])
    expect(matchModels(MODELS, 'google lite').map(model => model.id)).toEqual(['google/gemini-3.1-flash-lite'])
    expect(matchModels(MODELS, 'nothing')).toEqual([])
  })

  it('reads the list only when opened, saves the model picked from the keyboard, and Escape closes without saving', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    const onListModels = vi.fn(async () => ({ ok: true as const, complete: true, models: MODELS }))
    render(<CleanupModelFields settings={{ llmModel: null, llmMode: 'default' }} onSave={onSave} onListModels={onListModels} />)
    const box = screen.getByRole('combobox', { name: 'Cleanup model' })
    expect(box).toHaveValue('Default')
    await user.tab()
    expect(box).toHaveFocus()
    expect(onListModels).not.toHaveBeenCalled()

    await user.click(box)
    await user.type(box, 'gemini')
    await waitFor(() => expect(screen.getByRole('option', { name: /Gemini 3.1 Flash Lite/u })).toBeVisible())
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(onSave).not.toHaveBeenCalled()

    await user.type(box, 'gemini')
    expect(box).toHaveValue('gemini')
    await user.keyboard('{Enter}')
    expect(onSave).toHaveBeenCalledWith({ llmModel: 'google/gemini-3.1-flash-lite' })
    expect(onListModels).toHaveBeenCalledOnce()
  })

  it('saves the mode and says when the saved model is gone or the list did not come', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    const onListModels = vi.fn()
      .mockResolvedValueOnce({ ok: true, complete: true, models: MODELS })
      .mockResolvedValueOnce({ ok: false, reason: 'network' })
    render(<CleanupModelFields settings={{ llmModel: 'old/model', llmMode: 'default' }} onSave={onSave} onListModels={onListModels} />)
    await user.click(screen.getByRole('radio', { name: 'Nitro' }))
    expect(onSave).toHaveBeenCalledWith({ llmMode: 'nitro' })

    await user.click(screen.getByRole('combobox', { name: 'Cleanup model' }))
    expect(await screen.findByText(/no longer lists this model/u)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Refresh models' }))
    expect(await screen.findByText(/Could not reach OpenRouter/u)).toBeVisible()
  })

  it('does not call a model gone from a list cut short', async () => {
    const user = userEvent.setup()
    const onListModels = vi.fn(async () => ({ ok: true as const, complete: false, models: MODELS }))
    render(<CleanupModelFields settings={{ llmModel: 'old/model', llmMode: 'default' }} onSave={vi.fn()} onListModels={onListModels} />)
    await user.click(screen.getByRole('combobox', { name: 'Cleanup model' }))
    await waitFor(() => expect(onListModels).toHaveBeenCalledOnce())
    expect(screen.queryByText(/no longer lists this model/u)).toBeNull()
  })

  it('stays out of Settings while the Owl feature is off', async () => {
    render(<SettingsView {...baseProps()} />)
    await selectCategory('Cleanup')
    expect(screen.queryByRole('combobox', { name: 'Cleanup model' })).toBeNull()
  })
})
