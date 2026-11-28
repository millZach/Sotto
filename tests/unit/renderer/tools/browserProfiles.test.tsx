// Browser profiles in the empty pane (ADR-0221): which one new pages open in, Add with a copy of another browser's
// sign-ins, and Remove, which asks first. The chip says which profile a page is open in.
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserBridge } from '../../../../src/shared/browser'
import type { ToolsResult } from '../../../../src/shared/tools'
import { BrowserProfiles, ProfileChip } from '../../../../src/renderer/src/tools/BrowserProfiles'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
const ok = <T,>(value: T): ToolsResult<T> => ({ ok: true, value })
const work = { id: '6f1c1d0e-6a2b-4d39-9c43-1b0b9e1f4a11', name: 'Work' }
const firefox = { id: '0123456789abcdef', browser: 'Firefox' as const, name: 'default-release' }

function bridgeWith(patch: Partial<BrowserBridge> = {}) {
  const profiles = vi.fn<NonNullable<BrowserBridge['profiles']>>(async () => ok({ profiles: [work], sources: [firefox] }))
  const addProfile = vi.fn<NonNullable<BrowserBridge['addProfile']>>(async request => ok({ profile: { id: '7a1c1d0e-6a2b-4d39-9c43-1b0b9e1f4a12', name: request.name }, imported: request.importFrom ? 42 : 0, skipped: 0 }))
  const removeProfile = vi.fn<NonNullable<BrowserBridge['removeProfile']>>(async () => ok({ profiles: [], sources: [firefox] }))
  return { bridge: { profiles, addProfile, removeProfile, ...patch } as unknown as BrowserBridge, profiles, addProfile, removeProfile }
}

describe('browser profiles in the pane', () => {
  it('chooses where new pages open, fresh by default', async () => {
    const { bridge } = bridgeWith()
    const onChange = vi.fn()
    render(<BrowserProfiles bridge={bridge} value={null} onChange={onChange} disabled={false} />)
    const fresh = await screen.findByRole('radio', { name: /A fresh page/u }) as HTMLInputElement
    expect(fresh.checked).toBe(true)
    expect(screen.getByRole('radiogroup', { name: 'Open new pages in' })).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: /Work/u }))
    expect(onChange).toHaveBeenCalledWith(work.id)
  })

  it('adds a profile with another browser\'s sign-ins copied once, then opens new pages in it', async () => {
    const { bridge, addProfile } = bridgeWith()
    const onChange = vi.fn()
    render(<BrowserProfiles bridge={bridge} value={null} onChange={onChange} disabled={false} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add a profile that keeps sign-ins' }))
    const name = screen.getByRole('textbox', { name: 'Profile name' })
    await waitFor(() => expect(document.activeElement).toBe(name))
    fireEvent.click(screen.getByRole('button', { name: 'Add profile' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Name the profile first.')
    fireEvent.change(name, { target: { value: 'Personal' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Copy sign-ins from' }), { target: { value: firefox.id } })
    expect(screen.getByText(/Close that browser first/u)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add profile' }))
    await waitFor(() => expect(addProfile).toHaveBeenCalledWith({ name: 'Personal', importFrom: firefox.id }))
    expect((await screen.findByRole('status')).textContent).toContain('Added Personal and copied its sign-ins (42 cookies)')
    expect(onChange).toHaveBeenCalledWith('7a1c1d0e-6a2b-4d39-9c43-1b0b9e1f4a12')
    expect(screen.getByRole('radio', { name: /Personal/u })).toBeTruthy()
  })

  it('says why an add was refused, and offers no copy when no other browser is found', async () => {
    const { bridge } = bridgeWith({
      profiles: vi.fn(async () => ok({ profiles: [], sources: [] })),
      addProfile: vi.fn(async () => ({ ok: false as const, error: { code: 'invalid-request' as const, message: 'A profile already has that name. Choose another.' } })),
    })
    render(<BrowserProfiles bridge={bridge} value={null} onChange={vi.fn()} disabled={false} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add a profile that keeps sign-ins' }))
    expect(screen.queryByRole('combobox', { name: 'Copy sign-ins from' })).toBeNull()
    fireEvent.change(screen.getByRole('textbox', { name: 'Profile name' }), { target: { value: 'Work' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add profile' }))
    expect((await screen.findByRole('alert')).textContent).toContain('already has that name')
  })

  it('removes a profile only after asking, and goes back to fresh pages', async () => {
    const { bridge, removeProfile } = bridgeWith()
    const onChange = vi.fn()
    render(<BrowserProfiles bridge={bridge} value={work.id} onChange={onChange} disabled={false} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Work' }))
    expect(removeProfile).not.toHaveBeenCalled()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep' })))
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove Work' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete sign-ins' }))
    await waitFor(() => expect(removeProfile).toHaveBeenCalledWith({ id: work.id }))
    expect((await screen.findByRole('status')).textContent).toBe('Removed Work and deleted its sign-ins.')
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('closes the Add form on Escape from any of its controls, and gives focus back to the button that opened it', async () => {
    const { bridge, addProfile } = bridgeWith()
    render(<BrowserProfiles bridge={bridge} value={null} onChange={vi.fn()} disabled={false} />)
    await screen.findByRole('button', { name: 'Add a profile that keeps sign-ins' })
    for (const control of [() => screen.getByRole('combobox', { name: 'Copy sign-ins from' }), () => screen.getByRole('button', { name: 'Cancel' }), () => screen.getByRole('textbox', { name: 'Profile name' })]) {
      fireEvent.click(screen.getByRole('button', { name: 'Add a profile that keeps sign-ins' }))
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Profile name' })))
      control().focus()
      fireEvent.keyDown(control(), { key: 'Escape' })
      expect(screen.queryByRole('textbox', { name: 'Profile name' })).toBeNull()
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add a profile that keeps sign-ins' })))
    }
    // Cancel gives focus back the same way.
    fireEvent.click(screen.getByRole('button', { name: 'Add a profile that keeps sign-ins' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add a profile that keeps sign-ins' })))
    expect(addProfile).not.toHaveBeenCalled()
  })

  it('closes the Remove question on Escape from either answer, and gives focus back to that row\'s Remove', async () => {
    const { bridge, removeProfile } = bridgeWith({ profiles: vi.fn(async () => ok({ profiles: [work, { id: '8b1c1d0e-6a2b-4d39-9c43-1b0b9e1f4a13', name: 'Home' }], sources: [] })) })
    render(<BrowserProfiles bridge={bridge} value={null} onChange={vi.fn()} disabled={false} />)
    for (const answer of ['Delete sign-ins', 'Keep']) {
      fireEvent.click(await screen.findByRole('button', { name: 'Remove Home' }))
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep' })))
      screen.getByRole('button', { name: answer }).focus()
      fireEvent.keyDown(screen.getByRole('button', { name: answer }), { key: 'Escape' })
      expect(screen.queryByRole('button', { name: 'Keep' })).toBeNull()
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove Home' })))
    }
    // Keep pressed gives it back too.
    fireEvent.click(screen.getByRole('button', { name: 'Remove Home' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Keep' }))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove Home' })))
    expect(removeProfile).not.toHaveBeenCalled()
  })

  it('puts focus in the list once a removed profile\'s row is gone, and back on Remove when the removal was refused', async () => {
    const refused = { ok: false as const, error: { code: 'unavailable' as const, message: 'Sotto could not delete that profile. Nothing was removed.' } }
    const removeProfile = vi.fn<NonNullable<BrowserBridge['removeProfile']>>(async () => refused)
    const { bridge } = bridgeWith({ removeProfile })
    render(<BrowserProfiles bridge={bridge} value={null} onChange={vi.fn()} disabled={false} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Work' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete sign-ins' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Nothing was removed')
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove Work' })))

    removeProfile.mockImplementation(async () => ok({ profiles: [], sources: [firefox] }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove Work' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete sign-ins' }))
    await screen.findByRole('status')
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('radio', { name: /A fresh page/u })))
  })

  it('shows nothing without a bridge that lists profiles, and drops a choice that is gone', async () => {
    const { container, rerender } = render(<BrowserProfiles bridge={{} as BrowserBridge} value={null} onChange={vi.fn()} disabled={false} />)
    expect(container.textContent).toBe('')
    const onChange = vi.fn()
    rerender(<BrowserProfiles bridge={bridgeWith().bridge} value="9a1c1d0e-6a2b-4d39-9c43-1b0b9e1f4a19" onChange={onChange} disabled={false} />)
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(null))
  })

  it('names the profile a page is open in', () => {
    render(<ProfileChip profile={work} />)
    const chip = screen.getByText('Work').closest('span')!
    expect(chip.getAttribute('title')).toContain('The agent sees this page only when you share it')
  })
})
