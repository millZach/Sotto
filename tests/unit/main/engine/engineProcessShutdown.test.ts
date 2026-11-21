// @vitest-environment node
/** The engine child's shutdown when the shell's pipe closes part way through it (ADR-0210). */
import { describe, expect, it, vi } from 'vitest'
import type { EngineRpcConnection } from '../../../../src/main/engine/transport'

const held = vi.hoisted(() => {
  let release: () => void = () => undefined
  const cancelled = new Promise<void>(resolve => { release = resolve })
  return { cancelled, release: () => release() }
})

vi.mock('../../../../src/main/engine/createDesktopEngine', () => ({
  createDesktopEngine: async () => ({ metadata: {}, channels: () => [], watcherBridge: undefined, close: () => held.cancelled }),
}))

const { attachEngineProcessServer } = await import('../../../../src/main/engine/engineProcess')

function fakeConnection(): { connection: EngineRpcConnection; request: (method: string) => Promise<unknown>; close: () => void } {
  let handler: (method: string, args: readonly unknown[]) => unknown = () => undefined
  const init = { credentials: { available: true, plaintext: {}, sealed: {}, unreadable: {} }, browserToolDefinitions: [], options: {}, downloadsFolder: '' }
  const closeListeners: Array<(error?: Error) => void> = []
  const connection = {
    isClosed: false,
    onRequest: (next: typeof handler) => { handler = next },
    onPush: () => undefined,
    onClose: (listener: (error?: Error) => void) => { closeListeners.push(listener); return () => undefined },
    sendPush: () => undefined,
    request: async () => undefined,
    close: () => undefined,
  } as unknown as EngineRpcConnection
  return {
    connection,
    request: async method => handler(method, method === 'engine:init' ? [init] : []),
    close: () => { for (const listener of closeListeners) listener() },
  }
}

describe('attachEngineProcessServer shutdown (ADR-0210)', () => {
  it('lets a requested shutdown finish its cleanup before exiting when the pipe closes during it', async () => {
    const { connection, request, close } = fakeConnection()
    const onExit = vi.fn()
    const onShutdownStart = vi.fn()
    attachEngineProcessServer(connection, onExit, onShutdownStart)

    await request('engine:init')
    const closing = request('engine:close')
    await vi.waitFor(() => { expect(onShutdownStart).toHaveBeenCalledWith(18_000) })

    // The shell's quit deadline passes and its end of the pipe goes while cleanup is still held.
    close()
    await new Promise(resolve => setImmediate(resolve))
    expect(onExit).not.toHaveBeenCalled()

    held.release()
    await expect(closing).resolves.toBe(true)
    await vi.waitFor(() => { expect(onExit).toHaveBeenCalled() })
  })
})
