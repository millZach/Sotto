// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { useProviderLauncher } from '../../src/main/agents/git/gitLauncher'
import { ClaudeProtocol } from '../../src/main/agents/providers/claude/claudeProtocol'
import { CodexProcess } from '../../src/main/agents/providers/codex/codexProcess'
import { GrokSubscriptionClient } from '../../src/main/agents/subscriptionGrok'
import { builtGitLauncherWorker } from '../fixtures/gitLauncherWorker'

// Claude Code and Codex start on the provider launcher's worker in the app (#2550); under the test runner there is no
// built worker, so each case runs once started in this thread and once through the worker.
let worker: Awaited<ReturnType<typeof builtGitLauncherWorker>>
beforeAll(async () => { worker = await builtGitLauncherWorker() })
afterAll(async () => { await useProviderLauncher(null); await worker?.dispose() })

it.each([['Codex', 'in this thread'], ['Codex', 'on the worker'], ['Claude', 'in this thread'], ['Claude', 'on the worker'], ['Grok', 'in this thread']] as const)('%s started %s settles after exit while a descendant holds its output pipes', async (provider, launcher) => {
  await useProviderLauncher(launcher === 'on the worker' ? worker.path : null)
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

it.each(['in this thread', 'on the worker'] as const)('Claude started %s refuses an answer a descendant writes after the CLI exited', async launcher => {
  await useProviderLauncher(launcher === 'on the worker' ? worker.path : null)
  const root = await mkdtemp(join(tmpdir(), 'sotto-inherited-pipes-'))
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-inherited-pipes-')) throw new Error('Unexpected fixture directory')
  const script = join(root, 'provider.cjs'), pidFile = join(root, 'descendant.pid')
  // The CLI hands the request's id to a descendant that keeps its output, exits, and the descendant answers 100 ms later:
  // a reply that arrives once the CLI has gone is not the CLI's, so the request still fails (ADR-0038).
  await writeFile(script, `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
createInterface({ input: process.stdin }).once('line', line => {
  const answer = JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: JSON.parse(line).request_id, response: {} } });
  const descendant = spawn(process.execPath, ['-e', 'process.send("ready"); setTimeout(() => process.stdout.write(process.argv[1] + String.fromCharCode(10)), 100); setTimeout(() => {}, 5000)', answer],
    { stdio: ['ignore', process.stdout, process.stderr, 'ipc'], windowsHide: true, detached: true });
  descendant.once('message', () => { writeFileSync(${JSON.stringify(pidFile)}, String(descendant.pid)); process.exit(0) });
});
`)
  const protocol = new ClaudeProtocol(process.execPath, [script], root, process.env, 60_000, () => {}, () => {})
  try {
    await expect(protocol.control({ subtype: 'initialize' })).rejects.toThrow(/disconnected before acknowledg/)
  } finally {
    protocol.stop()
    const pid = Number(await readFile(pidFile, 'utf8').catch(() => '0'))
    if (pid) { try { process.kill(pid) } catch { /* Already stopped. */ } }
    await protocol.closed
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  }
})
