// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import { SocketHostService } from '../../../src/main/agents/socketHostService'
import type { HostOperation } from '../../../src/shared/hostProtocol'
import { hostIsNewer, hostVersionMismatch } from '../../../src/shared/hostProtocol'
import { hostId } from '../../fixtures/socketHostService'

describe('quiet remote connections', () => {
  it.each([false, true])('keeps successive providers quiet across pre-connect pushes (overlapping: %s)', async overlapping => {
    const client = new SocketHostService({ url: 'http://127.0.0.1:4319', token: 'paired-token', catchUpEvents: false })
    let state = emptyDesktopState(hostId)
    let finishFirst: (() => void) | undefined
    const first = new Promise<void>(resolve => { finishFirst = resolve })
    const call = vi.fn(async (operation: HostOperation) => {
      if (operation.op !== 'command') return state
      const connect = z.object({ type: z.literal('connect'), provider: z.enum(['codex', 'claude']) }).strict().parse(operation.command)
      await client.readShell() // Old hosts push their previous notice before awaiting the next provider.
      state = { ...state, connection: 'connected', host: { ...state.host, connected: true },
        notice: connect.provider === 'codex' ? 'Codex connected' : 'Claude Code connected' }
      await client.readShell()
      if (overlapping && connect.provider === 'codex') await first
      return state
    })
    Object.assign(client, { features: [], cached: state, call })
    const notices: string[] = []
    client.subscribe(shell => { notices.push(shell.notice) })
    const codex = client.command({ type: 'connect', provider: 'codex', notice: false })
    if (overlapping) await vi.waitFor(() => expect(state.notice).toBe('Codex connected'))
    else await codex
    await client.command({ type: 'connect', provider: 'claude', notice: false })
    finishFirst?.()
    await codex
    expect(notices.every(notice => notice === '')).toBe(true)
    expect(client.shell().notice).toBe('')
    const requested = await client.command({ type: 'connect', provider: 'codex' })
    expect(requested.notice).toBe('Codex connected')
  })

  it.each([undefined, 'codex'] as const)('keeps the old v1 connect packet and quiet desktop feedback (provider: %s)', async provider => {
    const oldConnect = z.object({ type: z.literal('connect'), provider: z.literal('codex').optional() }).strict()
    const client = new SocketHostService({ url: 'http://127.0.0.1:4319', token: 'paired-token', catchUpEvents: false })
    let state = emptyDesktopState(hostId)
    const call = vi.fn(async (operation: HostOperation) => {
      if (operation.op === 'command') {
        oldConnect.parse(operation.command)
        state = { ...state, connection: 'connected', host: { ...state.host, connected: true }, notice: 'Codex connected' }
      }
      return state
    })
    Object.assign(client, { features: [], cached: state, call })
    const quiet = await client.command({ type: 'connect', ...(provider ? { provider } : {}), notice: false })
    expect(quiet).toMatchObject({ notice: '', connection: 'connected', error: null })
    expect(call).toHaveBeenCalledWith({ op: 'command', command: { type: 'connect', ...(provider ? { provider } : {}) } }, expect.any(String))
    expect((await client.readShell()).notice).toBe('')
    state = { ...state, notice: 'Draft cleared.' }
    expect((await client.readShell()).notice).toBe('Draft cleared.')
    const requested = await client.command({ type: 'connect', ...(provider ? { provider } : {}) })
    expect(requested.notice).toBe('Codex connected')
    expect((await client.readShell()).notice).toBe('Codex connected')
  })

  it('preserves connection refusal and existing unrelated feedback on a quiet legacy connect', async () => {
    const before = { ...emptyDesktopState(hostId), notice: 'Opened Workshop.' }
    const failed = { ...before, error: 'Sign in through Codex, then reconnect.' }
    const client = new SocketHostService({ url: 'http://127.0.0.1:4319', token: 'paired-token', catchUpEvents: false })
    const call = vi.fn(async () => failed)
    Object.assign(client, { features: [], cached: before, call })
    expect(await client.command({ type: 'connect', notice: false })).toMatchObject({ notice: before.notice, error: failed.error })
  })

  it('keeps a quiet legacy connect quiet when the host picks a different installed default provider', async () => {
    const before = emptyDesktopState(hostId)
    const connected = { ...before, configuration: { ...before.configuration, provider: 'claude' as const },
      connection: 'connected' as const, host: { ...before.host, connected: true }, notice: 'Claude Code connected' }
    const client = new SocketHostService({ url: 'http://127.0.0.1:4319', token: 'paired-token', catchUpEvents: false })
    Object.assign(client, { features: [], cached: before, call: vi.fn(async () => connected) })
    expect(await client.command({ type: 'connect', notice: false })).toMatchObject({ notice: '', configuration: { provider: 'claude' } })
    expect((await client.readShell()).notice).toBe('')
  })

  it('keeps an explicit Threads success visible when an earlier quiet connection acknowledges late', async () => {
    const before = emptyDesktopState(hostId)
    const connected = { ...before, connection: 'connected' as const, host: { ...before.host, connected: true }, notice: 'Codex connected' }
    let finishQuiet: (() => void) | undefined
    const held = new Promise<void>(resolve => { finishQuiet = resolve })
    const call = vi.fn().mockImplementationOnce(async () => { await held; return connected }).mockResolvedValue(connected)
    const client = new SocketHostService({ url: 'http://127.0.0.1:4319', token: 'paired-token', catchUpEvents: false })
    Object.assign(client, { features: [], cached: before, call })
    const quiet = client.command({ type: 'connect', provider: 'codex', notice: false })
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect((await client.command({ type: 'connect', provider: 'codex' })).notice).toBe('Codex connected')
    finishQuiet?.()
    expect((await quiet).notice).toBe('Codex connected')
    expect((await client.readShell()).notice).toBe('Codex connected')
  })

  it('keeps unrelated feedback arriving during a quiet connection when the old host pushes success before replying', async () => {
    let state = emptyDesktopState(hostId)
    const client = new SocketHostService({ url: 'http://127.0.0.1:4319', token: 'paired-token', catchUpEvents: false })
    const call = vi.fn(async (operation: HostOperation) => {
      if (operation.op !== 'command') return state
      state = { ...state, notice: 'Draft cleared.' }
      await client.readShell()
      state = { ...state, connection: 'connected', host: { ...state.host, connected: true }, notice: 'Codex connected' }
      await client.readShell()
      return state
    })
    Object.assign(client, { features: [], cached: state, call })
    expect(await client.command({ type: 'connect', provider: 'codex', notice: false })).toMatchObject({ notice: 'Draft cleared.', error: null })
    expect((await client.readShell()).notice).toBe('Draft cleared.')
  })
})

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
