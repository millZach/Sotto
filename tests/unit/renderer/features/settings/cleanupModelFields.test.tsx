import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CleanupModelFields, matchModels, matchOwnModels } from '../../../../../src/renderer/src/components/CleanupModelFields'
import type { OwnServer } from '../../../../../src/shared/ownModelServers'
import type { OwnCleanupMeasured, OwnServerCleanupBridge } from '../../../../../src/shared/ownServerCleanup'
import { SettingsView } from '../../../../../src/renderer/src/features/settings/SettingsView'
import { baseProps, selectCategory } from '../../../../fixtures/renderer/settingsViewHarness'

const SPARKS: OwnServer = {
  id: 'own-sparks', name: 'Sparks', address: 'http://spark-head:8888/v1', keyed: false,
  models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', context: 131_072, thinking: true, images: false }],
}
const KEYED: OwnServer = { ...SPARKS, id: 'own-office', name: 'Office', address: 'https://office.example.com/v1', keyed: true,
  models: [{ id: 'qwen3-32b', name: 'Qwen3 32B', context: 32_768, thinking: true, images: false }] }
const SPARKS_CHOICE = { server: 'own-sparks', model: 'deepseek-v4.1-flash' }

function ownBridges(measured: OwnCleanupMeasured[] = []) {
  const ownServers = { list: vi.fn(async () => [SPARKS, KEYED]) }
  const ownCleanup: OwnServerCleanupBridge = {
    measured: vi.fn(async () => measured),
    measure: vi.fn(async () => ({ status: 'measured' as const, tuning: { status: 'fastest' as const, thinking: 'off' as const, ms: 412 } })),
  }
  return { ownServers, ownCleanup }
}

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

  it('lists only the models of servers added without a key, matched by model, ID or server', () => {
    expect(matchOwnModels([SPARKS, KEYED], '').map(model => model.own)).toEqual([SPARKS_CHOICE])
    expect(matchOwnModels([SPARKS, KEYED], 'sparks').map(model => model.name)).toEqual(['DeepSeek V4.1 Flash'])
    expect(matchOwnModels([SPARKS, KEYED], 'qwen')).toEqual([])
  })

  it('lists the user’s own servers after Default, and picking one saves it and measures it', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    const { ownServers, ownCleanup } = ownBridges()
    const onListModels = vi.fn(async () => ({ ok: true as const, complete: true, models: MODELS }))
    render(<CleanupModelFields settings={{ llmModel: null, llmMode: 'default', llmOwnModel: null }} onSave={onSave} onListModels={onListModels}
      ownServers={ownServers} ownCleanup={ownCleanup} />)
    await user.click(screen.getByRole('combobox', { name: 'Cleanup model' }))
    const options = await screen.findAllByRole('option')
    expect(options.map(option => option.textContent)).toEqual([
      'DefaultSotto’s choice', 'DeepSeek V4.1 Flashdeepseek-v4.1-flash on Sparks', ...MODELS.map(model => `${model.name}${model.id}`),
    ])
    expect(screen.getByText('Your own servers')).toBeVisible()
    expect(screen.getByText(/Servers added with a key are not listed/u)).toBeVisible()
    expect(ownCleanup.measure).not.toHaveBeenCalled()

    await user.keyboard('{ArrowDown}{Enter}')
    expect(onSave).toHaveBeenCalledWith({ llmOwnModel: SPARKS_CHOICE })
    expect(ownCleanup.measure).toHaveBeenCalledWith(SPARKS_CHOICE)
  })

  it('shows what Measure found, hides Mode, and Measure again asks once more', async () => {
    const user = userEvent.setup()
    const { ownServers, ownCleanup } = ownBridges([{ ...SPARKS_CHOICE, tuning: { status: 'fastest', thinking: 'least', ms: 1_260 } }])
    render(<CleanupModelFields settings={{ llmModel: null, llmMode: 'nitro', llmOwnModel: SPARKS_CHOICE }} onSave={vi.fn()} onListModels={vi.fn()}
      ownServers={ownServers} ownCleanup={ownCleanup} />)
    expect(await screen.findByText('Fastest: least thinking, 1.3 s.')).toBeVisible()
    expect(screen.getByRole('combobox', { name: 'Cleanup model' })).toHaveValue('DeepSeek V4.1 Flash')
    expect(screen.queryByRole('radio', { name: 'Nitro' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Measure again' }))
    expect(await screen.findByText('Fastest: thinking off, 0.4 s.')).toBeVisible()
    expect(ownCleanup.measure).toHaveBeenCalledOnce()
  })

  it('says when the chosen server is gone or did not answer, and going back to OpenRouter clears the choice', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    const { ownServers, ownCleanup } = ownBridges()
    vi.mocked(ownCleanup.measure).mockResolvedValueOnce({ status: 'unreachable' })
    const { rerender } = render(<CleanupModelFields settings={{ llmModel: null, llmMode: 'default', llmOwnModel: SPARKS_CHOICE }} onSave={onSave}
      onListModels={vi.fn(async () => ({ ok: true as const, complete: true, models: MODELS }))} ownServers={ownServers} ownCleanup={ownCleanup} />)
    expect(await screen.findByText(/Not measured yet/u)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Measure again' }))
    expect(await screen.findByText(/Nothing answered at Sparks\. Nothing was changed\./u)).toBeVisible()

    await user.click(screen.getByRole('combobox', { name: 'Cleanup model' }))
    await user.click(await screen.findByRole('option', { name: /Gemini 3.1 Flash Lite/u }))
    expect(onSave).toHaveBeenCalledWith({ llmModel: 'google/gemini-3.1-flash-lite', llmOwnModel: null })

    rerender(<CleanupModelFields settings={{ llmModel: null, llmMode: 'default', llmOwnModel: { ...SPARKS_CHOICE, model: 'removed' } }} onSave={onSave}
      onListModels={vi.fn()} ownServers={ownServers} ownCleanup={ownCleanup} />)
    expect(await screen.findByText(/no longer in Your own model servers, so Mercury 2 cleans up instead/u)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Measure again' })).toBeNull()
  })

  it('does not call the choice gone when the servers could not be read, and reads them again on every open', async () => {
    const user = userEvent.setup()
    const { ownServers, ownCleanup } = ownBridges()
    ownServers.list.mockRejectedValueOnce(new Error('unreadable'))
    render(<CleanupModelFields settings={{ llmModel: null, llmMode: 'default', llmOwnModel: SPARKS_CHOICE }} onSave={vi.fn()}
      onListModels={vi.fn(async () => ({ ok: true as const, complete: true, models: MODELS }))} ownServers={ownServers} ownCleanup={ownCleanup} />)
    expect(await screen.findByText(/Not measured yet/u)).toBeVisible()
    expect(screen.queryByText(/no longer in Your own model servers/u)).toBeNull()
    const box = screen.getByRole('combobox', { name: 'Cleanup model' })
    await user.click(box)
    expect(await screen.findByRole('option', { name: /DeepSeek V4.1 Flash/u })).toBeVisible()
    await user.keyboard('{Escape}')
    await user.click(box)
    await waitFor(() => expect(ownServers.list).toHaveBeenCalledTimes(3))
  })

  it('ignores a saved own model while the feature is off', () => {
    render(<CleanupModelFields settings={{ llmModel: null, llmMode: 'default', llmOwnModel: SPARKS_CHOICE }} onSave={vi.fn()} onListModels={vi.fn()} />)
    expect(screen.getByRole('combobox', { name: 'Cleanup model' })).toHaveValue('Default')
    expect(screen.getByRole('radio', { name: 'Default' })).toBeVisible()
  })

  it('stays out of Settings while the Owl feature is off', async () => {
    render(<SettingsView {...baseProps()} />)
    await selectCategory('Cleanup')
    expect(screen.queryByRole('combobox', { name: 'Cleanup model' })).toBeNull()
  })
})
