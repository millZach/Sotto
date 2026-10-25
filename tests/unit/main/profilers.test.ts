// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import { protocolProfiler, windowProfiler, type DebuggerLike } from '../../../src/main/performance/profilers'

const profile = { nodes: [], startTime: 0, endTime: 1, samples: [], timeDeltas: [] }

function connection(options: { failStop?: boolean } = {}) {
  const sent: string[] = []
  const open = vi.fn(), close = vi.fn()
  const send = vi.fn(async (method: string) => {
    sent.push(method)
    if (method === 'Profiler.stop') { if (options.failStop) throw new Error('gone'); return { profile } }
    return {}
  })
  return { sent, open, close, send }
}

describe('protocolProfiler', () => {
  it('enables the profiler, samples every millisecond, starts, and hands back the profile once stopped', async () => {
    const link = connection()
    const target = protocolProfiler(link)
    await target.start()
    expect(link.open).toHaveBeenCalledOnce()
    expect(link.sent).toEqual(['Profiler.enable', 'Profiler.setSamplingInterval', 'Profiler.start'])
    expect(link.send).toHaveBeenCalledWith('Profiler.setSamplingInterval', { interval: 1_000 })
    await expect(target.stop()).resolves.toBe(profile)
    expect(link.close).toHaveBeenCalledOnce()
    // Cancelling after a stop sends nothing more and closes nothing twice.
    await target.cancel()
    expect(link.sent).toHaveLength(4)
    expect(link.close).toHaveBeenCalledOnce()
  })

  it('closes the connection when a stop fails, and a cancel that was never started does nothing', async () => {
    const link = connection({ failStop: true })
    const target = protocolProfiler(link)
    await target.cancel()
    expect(link.send).not.toHaveBeenCalled()
    await target.start()
    await expect(target.stop()).rejects.toThrow('gone')
    expect(link.close).toHaveBeenCalledOnce()
  })

  it('cancel stops without keeping anything, and never throws', async () => {
    const link = connection({ failStop: true })
    const target = protocolProfiler({ ...link, close: () => { link.close(); throw new Error('already gone') } })
    await target.start()
    await expect(target.cancel()).resolves.toBeUndefined()
    expect(link.close).toHaveBeenCalledOnce()
  })
})

describe('windowProfiler', () => {
  it('attaches to the window\'s debugger, runs the same lifecycle through it, and detaches', async () => {
    const commands: string[] = []
    const debuggerLike: DebuggerLike = {
      attach: vi.fn(), detach: vi.fn(), isAttached: () => true,
      sendCommand: vi.fn(async (method: string) => { commands.push(method); return method === 'Profiler.stop' ? { profile } : {} }),
    }
    const target = windowProfiler(debuggerLike)
    await target.start()
    expect(debuggerLike.attach).toHaveBeenCalledWith('1.3')
    await expect(target.stop()).resolves.toBe(profile)
    expect(commands).toEqual(['Profiler.enable', 'Profiler.setSamplingInterval', 'Profiler.start', 'Profiler.stop'])
    expect(debuggerLike.detach).toHaveBeenCalledOnce()
  })
})
