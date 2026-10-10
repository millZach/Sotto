import { hostsBridgeFixture, hostsState } from '../../fixtures/renderer/hostBridges'
import React from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { HostUpdateControl, hostUpdatePillText } from '../../../src/renderer/src/agents/HostUpdates'
import type { HostsCommand } from '../../../src/shared/hosts'
import type { HostUpdateState } from '../../../src/shared/hostUpdates'

afterEach(cleanup)
const FORGE = '11111111-1111-4111-8111-111111111111'
const ATLAS = '22222222-2222-4222-8222-222222222222'
const forge = (patch: Partial<HostUpdateState> = {}): HostUpdateState =>
  ({ id: FORGE, name: 'forge', from: '0.1.22', to: '0.1.24', phase: 'needs', owned: true, working: 0, commands: '# On forge:\ncd ~/.local/share/sotto-host', ...patch })
/** The hosts bridge, holding what main publishes: `answer` decides what each press changes. */
function hosts(initial: HostUpdateState[], answer: (command: HostsCommand, current: HostUpdateState[]) => HostUpdateState[] = (_command, current) => current) {
  const made = hostsBridgeFixture({ initial: hostsState({ updates: initial }),
    answer: (request, current) => ({ ...current, updates: answer(request, current.updates ?? []) }) })
  const publish = (updates: HostUpdateState[]): void => { act(() => made.publish({ updates })) }
  return { bridge: made.bridge, command: made.command, publish }
}
const sent = (command: ReturnType<typeof hosts>['command']) => command.mock.calls.map(([value]) => value)

describe('the pill', () => {
  it('speaks for the host the user most needs to hear about, or for all of them', () => {
    expect(hostUpdatePillText([forge()]).text).toBe('Update for forge')
    expect(hostUpdatePillText([forge({ phase: 'waiting' })]).text).toBe('forge waits to update')
    expect(hostUpdatePillText([forge({ phase: 'updating', step: 'check' })]).text).toBe('Updating forge · 2 of 4')
    expect(hostUpdatePillText([forge({ phase: 'done' })]).text).toBe('forge updated')
    expect(hostUpdatePillText([forge({ phase: 'failed' })]).text).toBe('forge not updated')
    expect(hostUpdatePillText([forge(), forge({ id: ATLAS, name: 'atlas' })]).text).toBe('Updates for 2 hosts')
    // An update under way, or one that failed, is named even beside another host.
    expect(hostUpdatePillText([forge(), forge({ id: ATLAS, name: 'atlas', phase: 'updating', step: 'restart' })]).text).toBe('Updating atlas · 4 of 4')
  })
  it('shows nothing while no host needs an update', async () => {
    const { bridge } = hosts([])
    const { container } = render(<HostUpdateControl bridge={bridge} />)
    await act(async () => undefined)
    expect(container).toBeEmptyDOMElement()
  })
  it('opens the panel on the host it names, and Escape or a click outside closes it', async () => {
    const user = userEvent.setup()
    const { bridge } = hosts([forge()])
    render(<><HostUpdateControl bridge={bridge} /><button type="button">Elsewhere</button></>)
    const pill = await screen.findByRole('button', { name: 'Update for forge. Show host updates' })
    expect(pill).toHaveAttribute('aria-expanded', 'false')
    await user.click(pill)
    const panel = screen.getByRole('dialog', { name: 'Host updates' })
    expect(within(panel).getByRole('heading', { name: 'Hosts running an older Sotto' })).toBeInTheDocument()
    await waitFor(() => expect(within(panel).getByText('forge')).toHaveFocus())
    expect(screen.getByRole('button', { name: 'Update for forge. Hide host updates' })).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Host updates' })).toBeNull()
    expect(pill).toHaveFocus()
    await user.click(pill)
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }))
    expect(screen.queryByRole('dialog', { name: 'Host updates' })).toBeNull()
  })
})

describe('the panel', () => {
  it('updates a host with nothing working on one press, and says what the update does first', async () => {
    const user = userEvent.setup()
    const { bridge, command } = hosts([forge()], (value, current) => value.type === 'host-update' && value.action === 'update' ? [forge({ phase: 'updating', step: 'download' })] : current)
    render(<HostUpdateControl bridge={bridge} />)
    await user.click(await screen.findByRole('button', { name: /Show host updates$/u }))
    expect(screen.getByText('forge’s threads keep working until you update. Updating restarts its host, so they are unavailable for a few seconds.')).toBeInTheDocument()
    expect(screen.getByText('0.1.22 → 0.1.24')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Update forge’s host to 0.1.24' }))
    expect(sent(command)).toEqual([{ type: 'host-update', id: FORGE, action: 'update' }])
    const steps = within(await screen.findByRole('list', { name: 'Steps to update forge' })).getAllByRole('listitem')
    expect(steps.map(step => step.textContent)).toEqual(['Download 0.1.24, in progressFrom Sotto’s releases on GitHub.', '2Check the download, not started', '3Install beside 0.1.22, not started', '4Restart forge’s host, not started'])
    expect(screen.getByText('Step 1 of 4')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel update, and leave forge on 0.1.22' })).toBeInTheDocument()
  })
  it('asks on a busy host, waits, and stops the threads only when asked', async () => {
    const user = userEvent.setup()
    const { bridge, command, publish } = hosts([forge({ phase: 'confirm', working: 2 })])
    render(<HostUpdateControl bridge={bridge} />)
    await user.click(await screen.findByRole('button', { name: /Show host updates$/u }))
    expect(screen.getByText('2 threads on forge are working. Updating restarts forge’s host, which stops them.')).toBeInTheDocument()
    expect(screen.getByText('Only the work in progress on those turns is lost. Drafts and history stay.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Update when they finish' }))
    publish([forge({ phase: 'waiting', working: 1 })])
    expect(screen.getByText('forge updates when its threads finish. 1 still working.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /waits to update/u })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Stop 1 thread and update now' }))
    await user.click(screen.getByRole('button', { name: 'Cancel update, and leave forge on 0.1.22' }))
    expect(sent(command).map(value => value.type === 'host-update' ? value.action : value.type)).toEqual(['when-idle', 'stop-threads', 'cancel'])
    // Escape answers a pending question the way Cancel does.
    publish([forge({ phase: 'confirm', working: 1 })])
    await user.keyboard('{Escape}')
    expect(sent(command).at(-1)).toEqual({ type: 'host-update', id: FORGE, action: 'cancel' })
  })
  it('offers Cancel update during the download and the check only', async () => {
    const user = userEvent.setup()
    const { bridge, publish } = hosts([forge({ phase: 'updating', step: 'check', route: 'desktop' })])
    render(<HostUpdateControl bridge={bridge} />)
    await user.click(await screen.findByRole('button', { name: /Show host updates$/u }))
    expect(screen.getByText('forge could not reach GitHub, so this computer is copying it over SSH.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Cancel update, and leave/u })).toBeInTheDocument()
    publish([forge({ phase: 'updating', step: 'install' })])
    expect(screen.getByText('The checksum matches.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Cancel update, and leave/u })).toBeNull()
  })
  it('says what happened when an update fails, that the old version still runs, and offers the commands to do it by hand', async () => {
    const user = userEvent.setup()
    const failure = { step: 'check' as const, message: 'The download on forge did not match the release’s checksum, so Sotto deleted it and installed nothing.', kept: 'forge still runs 0.1.22. Nothing was lost.', next: 'Try again to download it fresh, or update it by hand on forge.' }
    const { bridge, command } = hosts([forge({ phase: 'failed', failure })])
    render(<HostUpdateControl bridge={bridge} />)
    await user.click(await screen.findByRole('button', { name: 'forge not updated. Show host updates' }))
    expect(screen.getByText(failure.message)).toBeInTheDocument()
    expect(screen.getByText(failure.kept)).toBeInTheDocument()
    expect(screen.getByText('Still 0.1.22')).toBeInTheDocument()
    const show = screen.getByRole('button', { name: 'Show commands' })
    expect(show).toHaveAttribute('aria-expanded', 'false')
    await user.click(show)
    expect(screen.getByRole('button', { name: 'Hide commands' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByLabelText('Commands to update forge by hand')).toHaveTextContent('# On forge: cd ~/.local/share/sotto-host')
    expect(screen.getByRole('button', { name: 'Copy commands that update forge by hand' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Try again to update forge' }))
    await user.click(screen.getByRole('button', { name: 'Not now: hide this until Sotto next starts' }))
    expect(sent(command).map(value => value.type === 'host-update' ? value.action : value.type)).toEqual(['update', 'not-now'])
  })
  it('offers only the commands for a host Sotto did not start', async () => {
    const user = userEvent.setup()
    const { bridge } = hosts([forge({ owned: false })])
    render(<HostUpdateControl bridge={bridge} />)
    await user.click(await screen.findByRole('button', { name: /Show host updates$/u }))
    expect(screen.getByText('Sotto did not start this host, so it cannot restart it. Update it on forge with these commands.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Update forge/u })).toBeNull()
    expect(screen.getByRole('button', { name: 'Show commands' })).toBeInTheDocument()
  })
  it('shows a refusal where the press was made', async () => {
    const user = userEvent.setup()
    const { bridge, command } = hosts([forge()])
    command.mockRejectedValueOnce(new Error("Error invoking remote method 'hosts:command': Error: forge is not connected, so nothing was updated."))
    render(<HostUpdateControl bridge={bridge} />)
    await user.click(await screen.findByRole('button', { name: /Show host updates$/u }))
    await user.click(screen.getByRole('button', { name: 'Update forge’s host to 0.1.24' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('forge is not connected, so nothing was updated.')
  })
})

describe('a finished update', () => {
  it('says which version the host runs, and goes by itself a moment later unless it is hovered or focused', async () => {
    const user = userEvent.setup()
    const { bridge, command } = hosts([forge({ phase: 'done', from: '0.1.24' })], (value, current) => value.type === 'host-update' && value.action === 'dismiss' ? [] : current)
    render(<><HostUpdateControl bridge={bridge} doneMs={120} /><textarea aria-label="Prompt" className="thread-prompt" /></>)
    const pill = await screen.findByRole('button', { name: 'forge updated. Show host updates' })
    await user.click(pill)
    expect(screen.getByText('forge runs Sotto 0.1.24.')).toBeInTheDocument()
    // The pointer is over the pill: it stays.
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(command).not.toHaveBeenCalled()
    // A control in it has focus: it stays.
    screen.getByRole('button', { name: 'Dismiss the note that forge was updated' }).focus()
    await user.hover(screen.getByRole('textbox', { name: 'Prompt' }))
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(command).not.toHaveBeenCalled()
    // Nothing holds it: it goes.
    screen.getByRole('textbox', { name: 'Prompt' }).focus()
    await waitFor(() => expect(sent(command)).toEqual([{ type: 'host-update', id: FORGE, action: 'dismiss' }]))
    await waitFor(() => expect(screen.queryByRole('button', { name: /forge updated/u })).toBeNull())
  })
})
