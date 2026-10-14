// @vitest-environment node
import { execFile } from 'node:child_process'
import { win32 } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { terminalImageInput } from '../../src/main/terminals/clipboard'

const run = promisify(execFile)
// Match the existing native-process probe's failure bound, with time to drain the child before the case ends.
const shellTimeoutMs = 60_000
const sensitive = "Review $(1+1) $name `literal` 'quoted' ‘smart’ project"

it('round trips shell-sensitive folder names through the actual platform shell', async ({ signal, onTestFinished }) => {
  const path = process.platform === 'win32' ? `D:\\${sensitive}\\.sotto\\clipboard\\image.png` : `/tmp/${sensitive}/.sotto/clipboard/image.png`
  const literal = terminalImageInput(path)
  const options = { encoding: 'utf8' as const, windowsHide: true, timeout: shellTimeoutMs, signal,
    killSignal: 'SIGKILL' as const, maxBuffer: 64 * 1024 }
  const execution = process.platform === 'win32'
    ? run(win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); [Console]::Write([string] ${literal})`], options)
    : run('/bin/sh', ['-c', `printf '%s' ${literal}`], options)
  const child = execution.child
  const phase = { spawned: false, output: false, errorOutput: false, exited: false, closed: false }
  child.once('spawn', () => { phase.spawned = true })
  child.stdout?.once('data', () => { phase.output = true })
  child.stderr?.once('data', () => { phase.errorOutput = true })
  child.once('exit', () => { phase.exited = true })
  const closed = new Promise<void>(done => child.once('close', () => { phase.closed = true; done() }))
  onTestFinished(async () => {
    if (!phase.closed && child.pid) child.kill('SIGKILL')
    await closed
  })
  // No input belongs to this command; EOF also prevents an accidental interactive read from waiting forever.
  child.stdin?.end()
  const result = await execution.catch(async (error: unknown) => {
    await closed
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown'
    // Fixed phase facts locate a future stall without logging command arguments or output.
    throw new Error(`Terminal shell fixture failed: platform=${process.platform} code=${code} cancelled=${signal.aborted} ${JSON.stringify(phase)}`)
  })
  await closed
  expect(result.stdout).toBe(path)
}, shellTimeoutMs + 15_000)
