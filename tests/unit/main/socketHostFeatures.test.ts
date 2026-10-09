// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import { SocketHostService } from '../../../src/main/agents/socketHostService'
import type { HostOperation } from '../../../src/shared/hostProtocol'
import { hostIsNewer, hostVersionMismatch } from '../../../src/shared/hostProtocol'
import { hostId } from '../../fixtures/socketHostService'

describe('the window\'s own refresh (#820)', () => {
  it.each([false, true])('sends background only to a host that lists background-refresh (listed: %s)', async listed => {
    const client = new SocketHostService({ url: 'http://127.0.0.1:4319', token: 'paired-token', catchUpEvents: false })
    const state = emptyDesktopState(hostId), call = vi.fn(async () => state)
    Object.assign(client, { features: listed ? ['background-refresh'] : [], cached: state, call })
    await client.command({ type: 'refresh-thread-worktree', threadId: 'thread', background: true }, undefined, 'focus-refresh')
    expect(call).toHaveBeenCalledWith({ op: 'command', command: listed ? { type: 'refresh-thread-worktree', threadId: 'thread', background: true } : { type: 'refresh-thread-worktree', threadId: 'thread' } }, 'focus-refresh')
  })
})

describe('socket early start', () => {
  it('sends the start and reads nothing after it, so a failed read can show no error (#769)', async () => {
    const state = emptyDesktopState(hostId), onPushError = vi.fn()
    const call = vi.fn(async (operation: HostOperation) => { if (operation.op === 'command') return state; throw new Error('The link dropped.') })
    const client = new SocketHostService({ url: 'http://127.0.0.1:4319', token: 'paired-token', onPushError })
    Object.assign(client, { features: [], cached: state, call })
    await client.command({ type: 'start-thread-session', threadId: 'thread' }, undefined, 'early-start')
    expect(call).toHaveBeenCalledExactlyOnceWith({ op: 'command', command: { type: 'start-thread-session', threadId: 'thread' } }, 'early-start')
    expect(onPushError).not.toHaveBeenCalled()
  })
})

describe('explicit socket answer checks', () => {
  const answer = { threadId: 'thread', providerId: 'grok' as const, requestId: 'question', questionsDigest: 'a'.repeat(64) }
  it('refuses an older host without making a cached detail or receipt read', async () => {
    const client = new SocketHostService({ url: 'http://127.0.0.1:4319', token: 'paired-token' }), call = vi.fn()
    Object.assign(client, { features: ['answer-receipts'], call })
    await expect(client.checkRequestAnswer(answer)).rejects.toThrow('Update the host')
    expect(call).not.toHaveBeenCalled()
  })
  it('publishes only a fresh native Check shell on the same connection generation', async () => {
    const client = new SocketHostService({ url: 'http://127.0.0.1:4319', token: 'paired-token' })
    const before = emptyDesktopState(hostId), fresh = { ...before, error: 'Fresh check state' }, call = vi.fn(async () => fresh), listener = vi.fn()
    Object.assign(client, { features: ['answer-check'], cached: before, call })
    client.subscribe(listener)
    await client.checkRequestAnswer(answer)
    expect(call).toHaveBeenCalledWith({ op: 'check-answer', answer })
    expect(client.shell().error).toBe('Fresh check state'); expect(listener).toHaveBeenCalledTimes(1)
    call.mockImplementationOnce(async () => { Object.assign(client, { generation: 1 }); return { ...fresh, error: 'Old connection response' } })
    await expect(client.checkRequestAnswer(answer)).rejects.toMatchObject({ code: 'disconnected' })
    expect(client.shell().error).toBe('Fresh check state'); expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('the version sentence', () => {
  it('says which side to bring up to date, and offers Stop host only for a host Sotto started', () => {
    expect(hostIsNewer('0.1.16', '0.1.15')).toBe(true)
    expect(hostIsNewer('0.2.0', '0.10.0')).toBe(false)
    expect(hostIsNewer('0.1.15', '0.1.15')).toBe(false)
    expect(hostIsNewer(undefined, '0.1.15')).toBe(false)
    expect(hostVersionMismatch('0.1.16', '0.1.15', true)).toBe('This host is running a different version of Sotto. Nothing on the host was lost. Update it from the Threads page, or put the Sotto 0.1.16 host in its installation folder, press Stop host, then connect again.')
    expect(hostVersionMismatch('0.1.16', undefined, false)).toBe('This host is running a different version of Sotto. Nothing on the host was lost. Put the Sotto 0.1.16 host in its installation folder, stop the host on that machine, then connect again.')
    expect(hostVersionMismatch('0.1.15', '0.1.16', true)).toBe('This host is running a newer version of Sotto than this computer. Nothing on the host was lost. Update Sotto on this computer, then connect again.')
  })
})
