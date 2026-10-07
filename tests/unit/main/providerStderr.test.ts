// @vitest-environment node
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeProtocol } from '../../../src/main/agents/claudeProtocol'
import { CodexProcess } from '../../../src/main/agents/codexProcess'
import { GrokRpc } from '../../../src/main/agents/grokRpc'
import { DevinRpc } from '../../../src/main/agents/devinRpc'

vi.mock('node:child_process', () => ({ spawn: vi.fn(), execFile: vi.fn() }))
afterEach(() => { vi.restoreAllMocks(); vi.mocked(spawn).mockReset() })

const factories = {
  Claude: () => new ClaudeProtocol('claude', [], '.', {}, 5000, () => undefined, () => undefined),
  Codex: () => new CodexProcess({ executable: 'codex', args: [], cwd: '.', env: {}, requestTimeoutMs: 5000,
    enqueue: task => task(), onFrame: async () => undefined, onLost: () => undefined, rejection: () => new Error() }),
  Grok: () => new GrokRpc('grok', [], '.', {}, 5000, () => undefined, () => undefined),
  Devin: () => new DevinRpc('devin', [], '.', {}, 5000, () => undefined, () => undefined)
}

describe.each(Object.entries(factories))('%s stderr rate guard', (_name, create) => {
  it('allows steady diagnostics across windows and still stops a flood within one window', () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn() })
    vi.mocked(spawn).mockReturnValueOnce(child as never)
    create()
    for (let window = 0; window < 5; window++) {
      now = window * 1000
      child.stderr.write(Buffer.alloc(512 * 1024))
      expect(child.kill).not.toHaveBeenCalled()
    }
    now += 999
    child.stderr.write(Buffer.alloc(512 * 1024))
    expect(child.kill).not.toHaveBeenCalled()
    child.stderr.write(Buffer.alloc(1))
    expect(child.kill).toHaveBeenCalledTimes(1)
    child.emit('close')
  })
})
