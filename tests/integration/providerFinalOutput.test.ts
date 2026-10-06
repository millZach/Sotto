// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { ClaudeProtocol } from '../../src/main/agents/claudeProtocol'
import { CodexProcess } from '../../src/main/agents/codexProcess'
import { GrokSubscriptionClient } from '../../src/main/agents/subscriptionGrok'

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    const child = actual.spawn(...args)
    const write = child.stdin!.write.bind(child.stdin!)
    // Force the valid Node ordering: process exit precedes delivery of buffered stdout.
    // The child and its final write are real; only the parent's read is held until exit.
    vi.spyOn(child.stdin!, 'write').mockImplementation((...values: Parameters<typeof write>) => {
      const frame = JSON.parse(String(values[0])) as { method?: string; type?: string }
      if (frame.method === 'session/new' || frame.method === 'initialize' && !('jsonrpc' in frame) || frame.type === 'control_request') child.stdout!.pause()
      return write(...values)
    })
    child.once('exit', () => { setImmediate(() => child.stdout!.resume()) })
    return child
  } }
})

it.each(['Codex', 'Claude', 'Grok'] as const)('%s delivers a final response written immediately before exit', async provider => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-final-output-'))
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-final-output-')) throw new Error('Unexpected fixture directory')
  const script = join(root, 'provider.cjs')
  await writeFile(script, `
const { createInterface } = require('node:readline');
createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  let result, final = true;
  if (frame.jsonrpc) {
    if (frame.method === 'initialize') { result = { protocolVersion: 1, authMethods: [{ id: 'cached_token' }] }; final = false; }
    else if (frame.method === 'authenticate') { result = {}; final = false; }
    else result = { sessionId: 'final', models: { currentModelId: 'final-model', availableModels: [{ modelId: 'final-model', name: 'Final model' }] } };
  } else result = { final: true };
  const response = frame.type === 'control_request'
    ? { type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: result } }
    : { id: frame.id, result, ...(frame.jsonrpc ? { jsonrpc: '2.0' } : {}) };
  process.stdout.write(JSON.stringify(response) + '\\n', () => { if (final) process.exit(0); });
});
`)
  let stop = () => {}
  let closed = Promise.resolve()
  try {
    if (provider === 'Codex') {
      const protocol = new CodexProcess({ executable: process.execPath, args: [script], cwd: root, env: process.env,
        requestTimeoutMs: 5000, enqueue: task => task(), onFrame: async () => {}, onLost: () => {}, rejection: () => new Error('Rejected') })
      stop = () => protocol.end(); closed = protocol.closed
      let result: unknown
      await protocol.rpc('initialize', {}, value => { result = value })
      expect(result).toEqual({ final: true })
    } else if (provider === 'Claude') {
      const protocol = new ClaudeProtocol(process.execPath, [script], root, process.env, 5000, () => {}, () => {})
      stop = () => protocol.stop(); closed = protocol.closed
      expect(await protocol.control({ subtype: 'initialize' })).toEqual({ final: true })
    } else {
      const controller = new AbortController(); stop = () => controller.abort()
      const client = new GrokSubscriptionClient(join(root, 'sessions'), { executable: process.execPath, prefixArgs: [script], statusTimeoutMs: 5000 })
      expect(await client.status(controller.signal)).toMatchObject({ ready: true, defaultModelId: 'final-model' })
    }
    await closed
  } finally {
    stop(); await closed
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  }
})
