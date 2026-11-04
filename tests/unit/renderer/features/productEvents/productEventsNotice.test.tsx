import React, { act, useState } from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProductEventsNotice } from '../../../../../src/renderer/src/features/productEvents/ProductEventsNotice'
import { useProductEventsNotice } from '../../../../../src/renderer/src/features/productEvents/useProductEventsNotice'
import { ProductEventsSettings } from '../../../../../src/renderer/src/features/settings/ProductEventsSettings'
import type { ProductEventsState } from '../../../../../src/shared/productEvents'
import type { SettingsPatch } from '../../../../../src/shared/settings'

const openExternalLink = vi.fn(async () => ({ ok: true }))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); openExternalLink.mockClear() })

function withMain(state: ProductEventsState): void {
  vi.stubGlobal('sotto', { productEvents: { toolOpened: vi.fn(), state: vi.fn(async () => state) }, openExternalLink })
}

/** The notice as App holds it: settings live here, as they do in main. */
function Room({ start = {}, save }: { readonly start?: { productEventsEnabled?: boolean; productEventsNoticeAnswered?: boolean }; readonly save: (patch: SettingsPatch) => boolean }) {
  const [settings, setSettings] = useState({ productEventsEnabled: true, productEventsNoticeAnswered: false, ...start })
  const control = useProductEventsNotice(settings, async patch => {
    const saved = save(patch)
    if (saved) setSettings(current => ({ ...current, ...patch }))
    return saved
  })
  return <>
    <button type="button" onClick={() => setSettings(current => ({ ...current, productEventsEnabled: !current.productEventsEnabled }))}>flip</button>
    <textarea aria-label="composer" />
    {control.open ? <ProductEventsNotice onAnswer={control.answer} onPutOff={control.putOff} /> : null}
    {control.turnedOff ? <p>turned off</p> : null}
  </>
}
const notice = () => screen.queryByRole('status', { name: 'Sotto now sends product events' })

describe('the product events notice', () => {
  it('says accounts are hashed and linked, and what is never sent', async () => {
    withMain({ canSend: true, offBy: null })
    render(<Room save={() => true} />)
    const card = await screen.findByRole('status', { name: 'Sotto now sends product events' })
    expect(card).toHaveTextContent('Hashed is not anonymous: those IDs link your computers to one person.')
    expect(card).toHaveTextContent('It never sends your words, code, file names, paths, repo or branch names, thread IDs or keys.')
  })

  it.each<[string, ProductEventsState]>([['has no endpoint', { canSend: false, offBy: null }], ['is off by its environment', { canSend: false, offBy: 'DO_NOT_TRACK' }]])('does not ask in a build that %s', async (_name, state) => {
    const asked = vi.fn(async () => state)
    vi.stubGlobal('sotto', { productEvents: { toolOpened: vi.fn(), state: asked } })
    render(<Room save={() => true} />)
    await waitFor(() => expect(asked).toHaveBeenCalled())
    await act(async () => undefined)
    expect(notice()).toBeNull()
  })

  it('does not ask once answered', async () => {
    withMain({ canSend: true, offBy: null })
    render(<Room start={{ productEventsNoticeAnswered: true }} save={() => true} />)
    await act(async () => undefined)
    expect(notice()).toBeNull()
  })

  it('takes no focus when it appears, so a press meant for the composer cannot answer it', async () => {
    withMain({ canSend: true, offBy: null })
    const save = vi.fn(() => true)
    render(<Room save={save} />)
    const composer = screen.getByRole('textbox', { name: 'composer' })
    composer.focus()
    await screen.findByRole('status', { name: 'Sotto now sends product events' })
    expect(composer).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(save).not.toHaveBeenCalled()
  })

  it('Got it saves the answer and leaves the switch on', async () => {
    withMain({ canSend: true, offBy: null })
    const save = vi.fn(() => true)
    render(<Room save={save} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Got it' }))
    expect(save).toHaveBeenCalledExactlyOnceWith({ productEventsNoticeAnswered: true })
    await waitFor(() => expect(notice()).toBeNull())
    expect(screen.queryByText('turned off')).toBeNull()
  })

  it('Turn off turns the switch off with the answer, and says so once', async () => {
    withMain({ canSend: true, offBy: null })
    const save = vi.fn(() => true)
    render(<Room save={save} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Turn off' }))
    expect(save).toHaveBeenCalledExactlyOnceWith({ productEventsEnabled: false, productEventsNoticeAnswered: true })
    await waitFor(() => expect(notice()).toBeNull())
    expect(screen.getByText('turned off')).toBeVisible()
  })

  it('keeps asking, and says so, when the answer cannot be saved', async () => {
    withMain({ canSend: true, offBy: null })
    render(<Room save={() => false} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Got it' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('nothing was sent')
    expect(notice()).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Got it' })).toBeEnabled()
  })

  it('Escape puts it off with nothing saved, from wherever focus is', async () => {
    withMain({ canSend: true, offBy: null })
    const save = vi.fn(() => true)
    render(<Room save={save} />)
    await screen.findByRole('button', { name: 'Got it' })
    screen.getByRole('textbox', { name: 'composer' }).focus()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(notice()).toBeNull())
    expect(save).not.toHaveBeenCalled()
  })

  it('leaves Escape to whatever claimed it first', async () => {
    withMain({ canSend: true, offBy: null })
    render(<Room save={() => true} />)
    await screen.findByRole('button', { name: 'Got it' })
    const composer = screen.getByRole('textbox', { name: 'composer' })
    composer.addEventListener('keydown', event => { if (event.key === 'Escape') event.preventDefault() })
    composer.focus()
    await userEvent.keyboard('{Escape}')
    expect(notice()).not.toBeNull()
  })

  it('goes down while the switch is off in Settings, and asks again when it comes back on', async () => {
    withMain({ canSend: true, offBy: null })
    render(<Room save={() => true} />)
    await screen.findByRole('status', { name: 'Sotto now sends product events' })
    await userEvent.click(screen.getByRole('button', { name: 'flip' }))
    expect(notice()).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'flip' }))
    expect(notice()).not.toBeNull()
  })

  it('See every event opens the list over it; Escape closes only the list, and focus goes back', async () => {
    withMain({ canSend: true, offBy: null })
    render(<Room save={() => true} />)
    const see = await screen.findByRole('button', { name: 'See every event' })
    await userEvent.click(see)
    const list = screen.getByRole('dialog', { name: 'Every product event' })
    for (const event of ['install.owner_observed', 'app.started', 'thread.started', 'turn.completed', 'feature.used']) expect(within(list).getByText(event)).toBeVisible()
    await userEvent.click(within(list).getByRole('button', { name: 'Read every field on the docs page' }))
    expect(openExternalLink).toHaveBeenCalledExactlyOnceWith('https://github.com/millZach/Sotto/blob/main/docs/product-events.md')
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(notice()).not.toBeNull()
    expect(see).toHaveFocus()
  })
})

describe('Settings > Application > Send product events', () => {
  const toggle = () => screen.findByRole('switch', { name: 'Send product events' })

  it('saves what a press says', async () => {
    withMain({ canSend: true, offBy: null })
    const onSave = vi.fn()
    render(<ProductEventsSettings settings={{ productEventsEnabled: true }} onSave={onSave} />)
    const row = await toggle()
    expect(row).toBeChecked()
    expect(row).toHaveAccessibleDescription(/Hashed is not anonymous: those IDs link your computers to one person\./)
    await userEvent.click(row)
    expect(onSave).toHaveBeenCalledExactlyOnceWith({ productEventsEnabled: false })
  })

  it.each([['SOTTO_TELEMETRY_ENABLED', 'because SOTTO_TELEMETRY_ENABLED is set to false'], ['DO_NOT_TRACK', 'because DO_NOT_TRACK is set']] as const)('shows off and says why when %s turned it off, whatever is saved', async (offBy, why) => {
    withMain({ canSend: false, offBy })
    const onSave = vi.fn()
    render(<ProductEventsSettings settings={{ productEventsEnabled: true }} onSave={onSave} />)
    expect(await screen.findByText(new RegExp(why))).toBeVisible()
    const row = await toggle()
    expect(row).not.toBeChecked()
    expect(row).toBeDisabled()
  })

  it('opens every event from the row', async () => {
    withMain({ canSend: true, offBy: null })
    render(<ProductEventsSettings settings={{ productEventsEnabled: true }} onSave={vi.fn()} />)
    await userEvent.click(await screen.findByRole('button', { name: 'See every event' }))
    expect(screen.getByRole('dialog', { name: 'Every product event' })).toBeVisible()
  })
})
