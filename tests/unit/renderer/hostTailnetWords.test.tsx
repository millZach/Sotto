import { describe, expect, it } from 'vitest'
import { lastReached, tailnetRowNote, tailnetStepNote } from '../../../src/renderer/src/features/settings/hostTailnetWords'
import { tailnetStepView } from '../../../src/renderer/src/features/settings/HostSetupChecklist'
import type { HostStatus } from '../../../src/shared/hosts'

const ADDRESS = 'https://forge.tail5728ca.ts.net:8443'

describe('what Add host’s tailnet step says when it kept the host on SSH (ADR-0053)', () => {
  it.each([
    ['operator', 'forge’s Tailscale Serve needs your SSH account to be Tailscale’s operator there, so forge is connected over SSH and nothing was lost. Run this on forge, then press Try the tailnet again.', 'sudo tailscale set --operator=$USER'],
    ['no-tailscale', 'Tailscale isn’t running on forge, so forge is connected over SSH and nothing was lost. Start Tailscale there, then press Try the tailnet again.', undefined],
    ['no-address', 'forge hasn’t said where your tailnet reaches it yet, so forge is connected over SSH and nothing was lost. Sotto tries again every 5 minutes.', undefined],
    ['old-host', 'The host on forge can’t be reached over your tailnet until it is updated, so forge is connected over SSH and nothing was lost. Update it from the Threads page, then press Try the tailnet again.', undefined],
    ['refused', 'The host on forge didn’t turn on its tailnet connections, so forge is connected over SSH and nothing was lost. Press Try the tailnet again.', undefined],
    ['unreachable', `forge didn’t answer at ${ADDRESS}, so forge is connected over SSH and nothing was lost. Sotto tries the tailnet again every 5 minutes.`, undefined],
  ] as const)('says why for %s', (why, text, command) => {
    expect(tailnetStepNote({ state: 'ssh', why }, 'forge', ADDRESS)).toEqual({ text, ...(command ? { command } : {}) })
  })

  it('says what a press that failed came back with, and names no address it does not have', () => {
    expect(tailnetStepNote({ state: 'ssh', why: 'error', error: 'The host on forge is busy. Nothing was changed. Try again in a moment.' }, 'forge', undefined))
      .toEqual({ text: 'The host on forge is busy. Nothing was changed. Try again in a moment.' })
    expect(tailnetStepNote({ state: 'ssh', why: 'unreachable' }, 'forge', undefined).text).toMatch(/^forge didn’t answer at its tailnet address,/u)
  })
})

describe('the line under a row on SSH although the tailnet was chosen', () => {
  it.each([
    ['operator', { text: 'forge’s Tailscale Serve needs ', command: 'sudo tailscale set --operator=$USER', after: ', run on forge. Sotto stays on SSH until it can, and tries again every 5 minutes.' }],
    ['no-tailscale', { text: 'Tailscale isn’t running on forge, so Sotto connects over SSH. It tries the tailnet again every 5 minutes.' }],
    ['no-address', { text: 'forge hasn’t said where your tailnet reaches it yet. Sotto tries again every 5 minutes.' }],
    ['unreachable', { text: 'Sotto tries it again every 5 minutes.' }],
  ] as const)('says why for %s', (note, words) => {
    expect(tailnetRowNote('forge', note)).toEqual(words)
  })
})

describe('Add host’s tailnet step as the dialog shows it', () => {
  const forge = (patch: Partial<HostStatus>): HostStatus => ({ id: 'a', name: 'forge', target: 'forge', identityFile: '', installPath: '/opt/sotto', dataDirectory: '/data', phase: 'connected', enabled: true, prefer: 'tailnet', ...patch })

  it('is main’s while the add runs, and still to come before it has begun', () => {
    expect(tailnetStepView(undefined, undefined, null)).toEqual({ state: 'todo' })
    expect(tailnetStepView(undefined, forge({ phase: 'connecting', addTailnet: { state: 'active' } }), null)).toEqual({ state: 'active' })
    expect(tailnetStepView(forge({ via: 'ssh', addTailnet: { state: 'active' } }), undefined, null)).toEqual({ state: 'active' })
    expect(tailnetStepView(forge({ via: 'ssh' }), undefined, null)).toEqual({ state: 'todo' })
  })

  it('keeps main’s reason while the host stays on SSH, and follows the host once it reaches the tailnet', () => {
    expect(tailnetStepView(forge({ via: 'ssh', tailnetNote: 'unreachable', addTailnet: { state: 'ssh', why: 'old-host' } }), undefined, null)).toEqual({ state: 'ssh', why: 'old-host' })
    expect(tailnetStepView(forge({ via: 'tailnet', addTailnet: { state: 'ssh', why: 'operator' } }), undefined, null)).toEqual({ state: 'done' })
    // Reconnecting over the tailnet after the step was done is still done.
    expect(tailnetStepView(forge({ phase: 'connecting', via: 'tailnet', addTailnet: { state: 'done' } }), undefined, null)).toEqual({ state: 'done' })
  })

  it('follows a press of Try the tailnet again: under way, failed with its sentence, or the host’s connection after it', () => {
    const kept = forge({ via: 'ssh', tailnetNote: 'operator', addTailnet: { state: 'ssh', why: 'old-host' } })
    expect(tailnetStepView(kept, undefined, { running: true })).toEqual({ state: 'active' })
    expect(tailnetStepView(kept, undefined, { running: false, error: 'Nothing was changed.' })).toEqual({ state: 'ssh', why: 'error', error: 'Nothing was changed.' })
    expect(tailnetStepView(kept, undefined, { running: false })).toEqual({ state: 'ssh', why: 'operator' })
    expect(tailnetStepView(forge({ via: 'ssh', addTailnet: { state: 'ssh', why: 'old-host' } }), undefined, { running: false })).toEqual({ state: 'ssh', why: 'unreachable' })
    expect(tailnetStepView(forge({ via: 'tailnet', addTailnet: { state: 'ssh', why: 'operator' } }), undefined, { running: false })).toEqual({ state: 'done' })
  })
})

it('says when this computer last reached a host as a time today, and a day and time before that', () => {
  const now = new Date(2026, 9, 6, 15, 0).getTime()
  expect(lastReached(new Date(2026, 9, 6, 9, 41).getTime(), now)).toBe(new Date(2026, 9, 6, 9, 41).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))
  expect(lastReached(new Date(2026, 9, 2, 9, 41).getTime(), now)).toBe(new Date(2026, 9, 2, 9, 41).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))
})
