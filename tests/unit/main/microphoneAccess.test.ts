import { describe, expect, it, vi } from 'vitest'

import {
  createMicrophoneAccessGate,
  type MediaAccessStatus,
  type MicrophoneAccessAdapter,
} from '../../../src/main/media/microphoneAccess'

function createAdapter(
  status: MediaAccessStatus,
  request: () => Promise<boolean> = async () => true,
): MicrophoneAccessAdapter & {
  readonly statusCalls: ReturnType<typeof vi.fn>
  readonly requestCalls: ReturnType<typeof vi.fn>
} {
  const statusCalls = vi.fn<() => MediaAccessStatus>(() => status)
  const requestCalls = vi.fn<() => Promise<boolean>>(request)
  return {
    status: statusCalls,
    request: requestCalls,
    statusCalls,
    requestCalls,
  }
}

function createDeferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

describe('createMicrophoneAccessGate', () => {
  it('allows an already granted microphone without prompting', async () => {
    const adapter = createAdapter('granted')

    await expect(createMicrophoneAccessGate(adapter).ensure()).resolves.toBe(true)
    expect(adapter.requestCalls).not.toHaveBeenCalled()
  })

  it.each(['denied', 'restricted'] as const)(
    'refuses a %s microphone without prompting',
    async (status) => {
      const adapter = createAdapter(status)

      await expect(createMicrophoneAccessGate(adapter).ensure()).resolves.toBe(false)
      expect(adapter.requestCalls).not.toHaveBeenCalled()
    },
  )

  it('fails open on an unknown status because capture is still gated downstream', async () => {
    const adapter = createAdapter('unknown')

    await expect(createMicrophoneAccessGate(adapter).ensure()).resolves.toBe(true)
    expect(adapter.requestCalls).not.toHaveBeenCalled()
  })

  it.each([true, false] as const)(
    'prompts once for an undecided microphone and reports %s',
    async (granted) => {
      const adapter = createAdapter('not-determined', async () => granted)

      await expect(createMicrophoneAccessGate(adapter).ensure()).resolves.toBe(granted)
      expect(adapter.requestCalls).toHaveBeenCalledOnce()
    },
  )

  it('shares one prompt across concurrent callers', async () => {
    const prompt = createDeferred<boolean>()
    const adapter = createAdapter('not-determined', () => prompt.promise)
    const gate = createMicrophoneAccessGate(adapter)

    const first = gate.ensure()
    const second = gate.ensure()
    const third = gate.ensure()
    prompt.resolve(true)

    await expect(Promise.all([first, second, third])).resolves.toEqual([true, true, true])
    expect(adapter.requestCalls).toHaveBeenCalledOnce()
  })

  it('never re-prompts once the operating system has been asked', async () => {
    const adapter = createAdapter('not-determined', async () => false)
    const gate = createMicrophoneAccessGate(adapter)

    await expect(gate.ensure()).resolves.toBe(false)
    await expect(gate.ensure()).resolves.toBe(false)

    expect(adapter.requestCalls).toHaveBeenCalledOnce()
  })

  it('reads the current status ahead of a settled prompt', async () => {
    let status: MediaAccessStatus = 'not-determined'
    const adapter: MicrophoneAccessAdapter = {
      status: () => status,
      request: vi.fn(async () => false),
    }
    const gate = createMicrophoneAccessGate(adapter)

    await expect(gate.ensure()).resolves.toBe(false)
    status = 'granted'

    await expect(gate.ensure()).resolves.toBe(true)
    expect(adapter.request).toHaveBeenCalledOnce()
  })

  it('refuses without leaking a rejected prompt', async () => {
    const adapter = createAdapter('not-determined', async () => {
      throw new Error('secret TCC failure C:/Users/private')
    })

    await expect(createMicrophoneAccessGate(adapter).ensure()).resolves.toBe(false)
  })

  it('refuses without leaking a synchronously throwing prompt', async () => {
    const adapter: MicrophoneAccessAdapter = {
      status: () => 'not-determined',
      request: vi.fn(() => {
        throw new Error('secret native bridge detail')
      }),
    }
    const gate = createMicrophoneAccessGate(adapter)

    await expect(gate.ensure()).resolves.toBe(false)
    await expect(gate.ensure()).resolves.toBe(false)
    expect(adapter.request).toHaveBeenCalledOnce()
  })

  it('fails open when the status probe throws', async () => {
    const adapter: MicrophoneAccessAdapter = {
      status: () => {
        throw new Error('secret native bridge detail')
      },
      request: vi.fn(async () => true),
    }

    await expect(createMicrophoneAccessGate(adapter).ensure()).resolves.toBe(true)
    expect(adapter.request).not.toHaveBeenCalled()
  })
})
