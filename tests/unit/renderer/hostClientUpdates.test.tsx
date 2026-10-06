import React from 'react'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostProviders } from '../../../src/renderer/src/features/settings/HostProviders'
import { resetAcknowledgedClientUpdates } from '../../../src/renderer/src/features/settings/HostClientUpdates'
import { chipText, failedShort, hostClientUpdatesView, popoverStatus } from '../../../src/renderer/src/features/settings/hostClientUpdateWords'
import type { AgentProviderStatus, ClientUpdateRun, ProviderClientUpdate, ProviderId } from '../../../src/shared/agents'
import type { HostsBridge, HostStatus } from '../../../src/shared/hosts'

/** #480, variant D: a host's client updates on its provider tiles, and the chip beside Show providers that opens Update all. */
afterEach(() => { cleanup(); resetAcknowledgedClientUpdates() })
const HOST = '22222222-2222-4222-8222-222222222222'
const forge: HostStatus = { id: HOST, hostId: HOST, name: 'forge', target: 'forge', identityFile: '', installPath: '/opt/sotto', dataDirectory: '/data', phase: 'connected', enabled: true }
const capabilities = { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true }
const connected = (id: ProviderId, version: string): AgentProviderStatus => ({ id, name: id, version, connection: 'connected', account: 'Subscription', capabilities })
/** forge on September 29: every client a mise install, all three behind. Devin is not on forge. */
const PROVIDERS: AgentProviderStatus[] = [connected('claude', '2.1.281'), connected('codex', '0.155.1'), connected('grok', '1.0.41'),
  { id: 'devin', name: 'devin', version: '', connection: 'error', problem: 'not-installed', capabilities }]
const reading = (id: ProviderId, patch: Partial<ProviderClientUpdate> = {}): ProviderClientUpdate => ({
  id, installed: { claude: '2.1.281', codex: '0.155.1', grok: '1.0.41', devin: '' }[id], published: { claude: '2.1.284', codex: '0.158.0', grok: '1.0.43', devin: '' }[id],
  behind: true, channel: 'mise', command: `mise upgrade ${id === 'grok' ? 'npm:@xai-official/grok' : id}`, canInstall: true, checkedAt: '2026-09-29T12:00:00.000Z', state: 'idle',
  steps: id === 'grok' ? 2 : 1, ...patch,
})
const BEHIND = [reading('claude'), reading('codex'), reading('grok')]

function hosts() {
  const updateClients = vi.fn<HostsBridge['updateClients']>(async () => ({}))
  return { bridge: { providerAction: vi.fn(async () => ({})), signIn: vi.fn(async () => null), updateClients } as unknown as HostsBridge, updateClients }
}
function show(updates: readonly ProviderClientUpdate[] | undefined, bridge: HostsBridge, run?: ClientUpdateRun) {
  return render(<div className="hosts-settings"><HostProviders host={forge} providers={PROVIDERS} bridge={bridge} updates={updates} run={run} /></div>)
}
const tile = (name: string): HTMLElement => screen.getAllByRole('listitem').find(item => within(item).queryByRole('heading', { name: new RegExp(`^${name}$`, 'u') }))!

describe('the words', () => {
  it('counts what is behind on the chip, and says how Update all went', () => {
    const view = (updates: ProviderClientUpdate[]) => hostClientUpdatesView(updates, ['claude', 'codex', 'grok', 'devin'], () => false)
    expect(chipText(view(BEHIND), undefined)).toEqual({ tone: 'update', text: '3 updates' })
    expect(chipText(view([reading('claude', { state: 'updated' }), reading('codex', { state: 'updating' }), reading('grok', { state: 'queued' })]), { total: 3, done: 1 }))
      .toEqual({ tone: 'update', text: 'Updating 2 of 3' })
    expect(chipText(view([reading('codex', { state: 'updating' })]), { total: 1, done: 0 })).toEqual({ tone: 'update', text: 'Updating Codex' })
    const mixed = view([reading('claude', { state: 'updated', installed: '2.1.284', behind: false }), reading('codex', { state: 'failed', failure: 'download' }), reading('grok', { state: 'updated', installed: '1.0.43', behind: false })])
    expect(chipText(mixed, undefined)).toEqual({ tone: 'error', text: '1 did not update' })
    expect(popoverStatus(mixed, undefined, 'forge')).toBe('Updated Claude Code and Grok Build on forge. Codex did not update.')
    expect(chipText(view([reading('claude'), reading('codex', { state: 'failed' }), reading('grok')]), undefined)).toEqual({ tone: 'error', text: '3 updates · 1 failed' })
    expect(chipText(view([reading('claude', { state: 'updated', behind: false })]), undefined)).toEqual({ tone: 'done', text: '1 updated' })
    // Nothing announces up to date, and an install Sotto will not update counts toward the chip.
    expect(chipText(view([reading('codex', { behind: false })]), undefined)).toBeUndefined()
    expect(chipText(view([reading('codex', { canInstall: false })]), undefined)).toEqual({ tone: 'update', text: '1 update' })
  })

  it('reads an update that left the client behind what is published as behind, Done or not', () => {
    const view = (updates: ProviderClientUpdate[], acknowledged = false) => hostClientUpdatesView(updates, ['claude', 'codex', 'grok', 'devin'], () => acknowledged)
    const stillBehind = reading('claude', { state: 'updated', installed: '2.1.283', ranAt: 'a' })
    expect(view([stillBehind]).phases.get('claude')).toBe('behind')
    expect(view([stillBehind], true).phases.get('claude')).toBe('behind')
    expect(chipText(view([stillBehind]), undefined)).toEqual({ tone: 'update', text: '1 update' })
    expect(view([{ ...stillBehind, canInstall: false }]).phases.get('claude')).toBe('by-hand')
    expect(view([{ ...stillBehind, behind: false }]).phases.get('claude')).toBe('updated')
    expect(view([{ ...stillBehind, behind: false }], true).phases.get('claude')).toBe('current')
  })

  it('keeps a failed tile to one line, the owner’s words', () => {
    expect(failedShort(reading('codex', { state: 'failed', failure: 'download' }), 'forge')).toBe('The download dropped partway. 0.155.1 is still installed.')
    expect(failedShort(reading('grok', { state: 'failed', failure: 'install-step', step: 2 }), 'forge')).toBe('The install step did not finish, so forge still starts 1.0.41.')
  })
})

describe('a host’s tiles and chip', () => {
  it('show nothing new for a host that does not offer client updates', async () => {
    const user = userEvent.setup()
    show(undefined, hosts().bridge)
    await user.click(screen.getByRole('button', { name: 'Show providers on forge' }))
    expect(screen.queryByRole('button', { name: /client updates/u })).toBeNull()
    expect(screen.queryByText(/available/u)).toBeNull()
  })

  it('says what is available on each tile, and Update runs that client’s update on the host', async () => {
    const user = userEvent.setup()
    const { bridge, updateClients } = hosts()
    show(BEHIND, bridge)
    await user.click(screen.getByRole('button', { name: 'Show providers on forge' }))
    expect(within(tile('Codex')).getByText('0.158.0 available')).toBeInTheDocument()
    expect(within(tile('Codex')).getByText('Subscription · 0.155.1')).toBeInTheDocument()
    await user.click(within(tile('Codex')).getByRole('button', { name: 'Update Codex on forge to 0.158.0' }))
    expect(updateClients).toHaveBeenCalledWith({ id: HOST, action: 'update', providers: ['codex'] })
    // Update sits beside Disconnect.
    expect(within(tile('Codex')).getByRole('button', { name: 'Disconnect Codex on forge' })).toBeInTheDocument()
  })

  it('says what a waiting tile waits for, shows the step of Grok Build’s two, and lets a waiting one be cancelled', async () => {
    const user = userEvent.setup()
    const { bridge, updateClients } = hosts()
    show([reading('claude', { state: 'updated', installed: '2.1.284', behind: false, ranAt: '2026-09-29T12:01:00.000Z' }), reading('codex', { state: 'queued' }), reading('grok', { state: 'updating', step: 2 })], bridge, { total: 3, done: 1 })
    await user.click(screen.getByRole('button', { name: 'Show providers on forge' }))
    expect(within(tile('Grok Build')).getByText('Updating to 1.0.43 · step 2 of 2…')).toBeInTheDocument()
    expect(within(tile('Grok Build')).getByText('Your threads on forge keep working.')).toBeInTheDocument()
    expect(within(tile('Codex')).getByText('Updates to 0.158.0 after Grok Build')).toBeInTheDocument()
    expect(within(tile('Claude Code')).getByText('Claude Code is now 2.1.284.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Show the client updates on forge/u })).toHaveTextContent('Updating 2 of 3')
    await user.click(within(tile('Codex')).getByRole('button', { name: 'Cancel the Codex update on forge' }))
    expect(updateClients).toHaveBeenCalledWith({ id: HOST, action: 'cancel', providers: ['codex'] })
  })

  it('names what a waiting tile waits for in the order the host runs its line, not the tiles’', async () => {
    const user = userEvent.setup()
    show([reading('claude', { state: 'updating' }), reading('codex', { state: 'queued' }), reading('grok', { state: 'queued' })], hosts().bridge, { total: 3, done: 0, line: ['grok', 'codex'] })
    await user.click(screen.getByRole('button', { name: 'Show providers on forge' }))
    expect(within(tile('Grok Build')).getByText('Updates to 1.0.43 after Claude Code')).toBeInTheDocument()
    expect(within(tile('Codex')).getByText('Updates to 0.158.0 after Grok Build')).toBeInTheDocument()
  })

  it('moves focus to the chip once Update has gone, never to Disconnect', async () => {
    const user = userEvent.setup()
    const { bridge } = hosts()
    const { rerender } = show(BEHIND, bridge)
    await user.click(screen.getByRole('button', { name: 'Show providers on forge' }))
    within(tile('Codex')).getByRole('button', { name: 'Update Codex on forge to 0.158.0' }).focus()
    await user.keyboard('{Enter}')
    act(() => { rerender(<div className="hosts-settings"><HostProviders host={forge} providers={PROVIDERS} bridge={bridge} updates={[reading('claude'), reading('codex', { state: 'updating' }), reading('grok')]} run={{ total: 1, done: 0 }} /></div>) })
    await vi.waitFor(() => { expect(screen.getByRole('button', { name: /^Show the client updates on forge/u })).toHaveFocus() })
    expect(within(tile('Codex')).getByRole('button', { name: 'Disconnect Codex on forge' })).not.toHaveFocus()
  })

  it('keeps a failed tile short, with Try again, and the rest behind Details', async () => {
    const user = userEvent.setup()
    const { bridge, updateClients } = hosts()
    show([reading('grok', { state: 'failed', failure: 'install-step', step: 2, printed: 'Error: EACCES: permission denied',
      byHand: ['mise upgrade npm:@xai-official/grok', 'cd "$(mise where npm:@xai-official/grok)/node_modules/@xai-official/grok"', 'node bin/postinstall.js'] })], bridge)
    await user.click(screen.getByRole('button', { name: 'Show providers on forge' }))
    const grok = tile('Grok Build')
    expect(within(grok).getByText('Did not update to 1.0.43')).toBeInTheDocument()
    expect(within(grok).getByText('The install step did not finish, so forge still starts 1.0.41.')).toBeInTheDocument()
    const details = within(grok).getByText('Details').closest('details')!
    expect(details).not.toHaveAttribute('open')
    await user.click(within(grok).getByText('Details'))
    expect(within(grok).getByText(/mise installed 1\.0\.43, but Grok Build's install step did not finish/u)).toBeVisible()
    expect(within(grok).getByText('Or run this on forge:')).toBeVisible()
    expect(within(grok).getByText('node bin/postinstall.js', { exact: false })).toBeVisible()
    expect(within(grok).getByText('What mise printed')).toBeVisible()
    await user.click(within(grok).getByRole('button', { name: 'Try updating Grok Build on forge again' }))
    expect(updateClients).toHaveBeenCalledWith({ id: HOST, action: 'update', providers: ['grok'] })
  })

  it('shows the command for an install Sotto will not update, and counts it on the chip as By hand', async () => {
    const user = userEvent.setup()
    show([reading('codex', { canInstall: false, byHand: ['mise upgrade codex'] })], hosts().bridge)
    await user.click(screen.getByRole('button', { name: 'Show providers on forge' }))
    expect(within(tile('Codex')).getByText('Sotto could not find mise on forge, so it will not run the update itself. Run this on forge:')).toBeInTheDocument()
    expect(within(tile('Codex')).queryByRole('button', { name: /^Update Codex/u })).toBeNull()
    await user.click(screen.getByRole('button', { name: /^Show the client updates on forge/u }))
    const panel = screen.getByRole('dialog', { name: 'Client updates on forge' })
    expect(within(panel).getByText('By hand')).toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: /^Update Codex/u })).toBeNull()
  })

  it('opens Update all from the chip, with focus on it; Update all updates every client that is behind, and Escape goes back to the chip', async () => {
    const user = userEvent.setup()
    const { bridge, updateClients } = hosts()
    show(BEHIND, bridge)
    const chip = screen.getByRole('button', { name: /^Show the client updates on forge/u })
    expect(chip).toHaveTextContent('3 updates')
    expect(chip).toHaveAttribute('aria-haspopup', 'dialog')
    chip.focus()
    await user.keyboard('{Enter}')
    const panel = screen.getByRole('dialog', { name: 'Client updates on forge' })
    expect(within(panel).getByRole('status')).toHaveTextContent('3 clients are behind on forge.')
    expect(within(panel).getAllByRole('listitem').map(item => item.textContent)).toEqual(['Claude Code 2.1.281 →  to 2.1.284', 'Codex 0.155.1 →  to 0.158.0', 'Grok Build 1.0.41 →  to 1.0.43'])
    const all = within(panel).getByRole('button', { name: 'Update Claude Code, Codex and Grok Build on forge, one after another' })
    expect(all).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    await vi.waitFor(() => { expect(chip).toHaveFocus() })
    await user.keyboard('{Enter}')
    await user.click(screen.getByRole('button', { name: /^Update Claude Code, Codex and Grok Build/u }))
    expect(updateClients).toHaveBeenCalledWith({ id: HOST, action: 'update', providers: ['claude', 'codex', 'grok'] })
  })

  it('ends an Update all with one failure by saying so, with Try again on that row, and Done puts the rest away', async () => {
    const user = userEvent.setup()
    const { bridge, updateClients } = hosts()
    const ended = [reading('claude', { state: 'updated', installed: '2.1.284', behind: false, ranAt: 'a' }), reading('codex', { state: 'failed', failure: 'download', ranAt: 'b' }),
      reading('grok', { state: 'updated', installed: '1.0.43', behind: false, ranAt: 'c' })]
    const { rerender } = show(ended, bridge)
    const chip = screen.getByRole('button', { name: /^Show the client updates on forge/u })
    expect(chip).toHaveTextContent('1 did not update')
    await user.click(chip)
    const panel = screen.getByRole('dialog', { name: 'Client updates on forge' })
    expect(within(panel).getByRole('status')).toHaveTextContent('Updated Claude Code and Grok Build on forge. Codex did not update.')
    expect(within(panel).getByText('The download dropped partway. 0.155.1 is still installed.')).toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: /one after another/u })).toBeNull()
    await user.click(within(panel).getByRole('button', { name: 'Try updating Codex on forge again' }))
    expect(updateClients).toHaveBeenCalledWith({ id: HOST, action: 'update', providers: ['codex'] })
    await user.click(within(panel).getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    // The updated ones are put away; the one that did not update stays on the chip.
    act(() => { rerender(<div className="hosts-settings"><HostProviders host={forge} providers={PROVIDERS} bridge={bridge} updates={ended} /></div>) })
    expect(screen.getByRole('button', { name: /^Show the client updates on forge/u })).toHaveTextContent('1 did not update')
  })

  it('says a refusal from the host where the press was', async () => {
    const user = userEvent.setup()
    const { bridge, updateClients } = hosts()
    updateClients.mockResolvedValueOnce({ error: 'forge is not connected. Nothing was changed. Switch it on, then try again.' })
    show(BEHIND, bridge)
    await user.click(screen.getByRole('button', { name: 'Show providers on forge' }))
    await user.click(within(tile('Claude Code')).getByRole('button', { name: 'Update Claude Code on forge to 2.1.284' }))
    expect(await within(tile('Claude Code')).findByText('forge is not connected. Nothing was changed. Switch it on, then try again.')).toBeInTheDocument()
  })
})
