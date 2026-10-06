// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { ClaudeProtocol } from '../../src/main/agents/claudeProtocol'
import { CodexProcess } from '../../src/main/agents/codexProcess'
import { GrokSubscriptionClient } from '../../src/main/agents/subscriptionGrok'

it.each(['Codex', 'Claude', 'Grok'] as const)('%s settles after exit while a descendant holds its output pipes', async provider => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-inherited-pipes-'))
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-inherited-pipes-')) throw new Error('Unexpected fixture directory')
  const script = join(root, 'provider.cjs'), pidFile = join(root, 'descendant.pid')
  await writeFile(script, `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
createInterface({ input: process.stdin }).once('line', () => {
  const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000); process.send("ready")'],
    { stdio: ['ignore', process.stdout, process.stderr, 'ipc'], windowsHide: true, detached: true });
  descendant.once('message', () => {
    writeFileSync(${JSON.stringify(pidFile)}, String(descendant.pid));
    process.exit(0);
  });
});
`)
  let pid = 0
  let settled = false
  let result: unknown
  const lost = vi.fn()
  let completion: Promise<void> = Promise.resolve()
  let stop = () => {}
  try {
    if (provider === 'Codex') {
      const protocol = new CodexProcess({ executable: process.execPath, args: [script], cwd: root, env: process.env,
        requestTimeoutMs: 60_000, enqueue: task => task(), onFrame: async () => {}, onLost: lost, rejection: () => new Error('Rejected') })
      stop = () => protocol.end()
      completion = protocol.rpc('initialize', {}).catch(error => { result = error }).then(() => protocol.closed)
    } else if (provider === 'Claude') {
      const protocol = new ClaudeProtocol(process.execPath, [script], root, process.env, 60_000, () => {}, lost)
      stop = () => protocol.stop()
      completion = protocol.control({ subtype: 'initialize' }).catch(error => { result = error }).then(() => protocol.closed)
    } else {
      const controller = new AbortController()
      stop = () => controller.abort()
      const client = new GrokSubscriptionClient(join(root, 'sessions'), { executable: process.execPath, prefixArgs: [script], statusTimeoutMs: 60_000 })
      completion = client.status(controller.signal).then(account => { result = account })
    }
    completion = completion.then(() => { settled = true })
    await expect.poll(async () => {
      pid = Number(await readFile(pidFile, 'utf8').catch(() => '0'))
      return pid > 0
    }).toBe(true)
    await expect.poll(() => settled).toBe(true)
    // Shutdown must settle before the inherited handles are released by the descendant.
    expect(() => process.kill(pid, 0)).not.toThrow()
    if (provider === 'Grok') expect(result).toMatchObject({ installed: true, ready: false })
    else {
      expect(result).toBeInstanceOf(Error)
      expect((result as Error).message).toMatch(/disconnected before acknowledg/)
      expect(lost).toHaveBeenCalledTimes(1)
    }
  } finally {
    stop()
    // Only the synthetic descendant whose PID this fixture recorded is stopped.
    if (!pid) pid = Number(await readFile(pidFile, 'utf8').catch(() => '0'))
    if (pid) { try { process.kill(pid) } catch { /* Already stopped. */ } }
    await completion
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  }
})
