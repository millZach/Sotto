// @vitest-environment node
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { keyListenerWin32Invocation, powerShellSingleQuoted } from '../../src/main/hotkeys/keyListenerWin32'

const CS_PATH = join(__dirname, '../../native/key-listener/win32.cs')
const LIVE = process.env.SOTTO_KEY_LISTENER_LIVE === '1'
// 17 passing Windows CI samples took 4.65–22.54 s including shutdown and the compile
// (docs/perf/2026-11-03-git-worktree-tests.md). The compile now runs once in beforeAll, so this
// covers only PowerShell starting, loading the compiled helper and installing the hook.
const HELPER_START_MS = 45_000
// A budget only a hung compiler reaches. On a loaded runner csc has stalled past 45 s here and past
// 60 s for the askpass helper in the same shard at the same minute (#1771, #1410).
const COMPILE_MS = 180_000

// Compiles win32.cs with the Add-Type the app runs, to an assembly the timed starts load instead.
function compileHelper(outputPath: string): Promise<void> {
  // Progress records would otherwise reach stderr as CLIXML and hide a compile error.
  const script = `$ProgressPreference = 'SilentlyContinue'; Add-Type -LiteralPath ${powerShellSingleQuoted(CS_PATH)} -OutputAssembly ${powerShellSingleQuoted(outputPath)} -OutputType Library`
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: COMPILE_MS - 5_000 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`the key listener did not compile: ${error.message}; stdout ${stdout}; stderr ${stderr}`))
        else resolve()
      },
    )
  })
}

interface Helper {
  lines: string[]
  waitFor(line: string, timeoutMs: number): Promise<void>
  send(line: string): void
  closeAndExit(timeoutMs: number): Promise<number | null>
}

function startHelper(assemblyPath: string, acceptSynthetic: boolean): Helper {
  // The app's own invocation; Add-Type -LiteralPath loads a compiled assembly as it compiles a source file.
  const invocation = keyListenerWin32Invocation(assemblyPath, acceptSynthetic)
  const child = spawn(invocation.executable, [...invocation.args], {
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines: string[] = []
  let buffered = ''
  let stderr = ''
  const waiters: (() => void)[] = []
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk
    const parts = buffered.split('\n')
    buffered = parts.pop() ?? ''
    lines.push(...parts)
    for (const wake of waiters.splice(0)) wake()
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))

  return {
    lines,
    waitFor(line, timeoutMs) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill()
          reject(new Error(`no "${line}" within ${timeoutMs} ms; stdout ${JSON.stringify(lines)}; stderr ${stderr}`))
        }, timeoutMs)
        const check = (): void => {
          if (lines.includes(line)) {
            clearTimeout(timer)
            resolve()
          } else {
            waiters.push(check)
          }
        }
        check()
      })
    },
    send(line) {
      child.stdin.write(`${line}\n`)
    },
    closeAndExit(timeoutMs) {
      child.stdin.end()
      const timeout = new Promise<number | null>((_, reject) =>
        setTimeout(() => {
          child.kill()
          reject(new Error('the key listener did not exit after stdin closed'))
        }, timeoutMs),
      )
      return Promise.race([exited, timeout])
    },
  }
}

describe.runIf(process.platform === 'win32')('Windows key listener helper', () => {
  let directory = ''
  let assemblyPath = ''

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'sotto-key-listener-'))
    assemblyPath = join(directory, 'SottoKeyListener.dll')
    await compileHelper(assemblyPath)
  }, COMPILE_MS)

  afterAll(async () => {
    // A killed helper can hold the assembly a moment longer; a leftover temp folder is harmless.
    if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined)
  })

  // Shutdown has its own 5 s deadline; leave another 5 s for protocol checks and scheduling.
  it('compiles, installs the hook, prints only protocol lines and exits when stdin closes', async () => {
    const helper = startHelper(assemblyPath, false)

    await helper.waitFor('permission granted', HELPER_START_MS)
    helper.send('keys F13')
    helper.send('request')

    expect(await helper.closeAndExit(5_000)).toBe(0)
    expect(helper.lines).toEqual(['permission granted'])
  }, HELPER_START_MS + 10_000)

  it.runIf(LIVE)('reports a watched F13 sent with SendInput when synthetic input is accepted', async () => {
    const helper = startHelper(assemblyPath, true)
    await helper.waitFor('permission granted', HELPER_START_MS)
    helper.send('keys F13')
    // Give the writer thread time to apply `keys` before the injected key arrives.
    await new Promise((resolve) => setTimeout(resolve, 300))

    const inject = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$s = New-Object -ComObject WScript.Shell; $s.SendKeys('{F13}')",
      ],
      { shell: false, windowsHide: true, stdio: 'ignore' },
    )
    await new Promise((resolve) => inject.once('exit', resolve))

    await helper.waitFor('up F13', 5_000)
    expect(await helper.closeAndExit(5_000)).toBe(0)
    expect(helper.lines).toEqual(['permission granted', 'down F13', 'up F13'])
  }, HELPER_START_MS + 30_000)
})
