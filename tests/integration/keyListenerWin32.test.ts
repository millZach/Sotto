// @vitest-environment node
import { spawn } from 'node:child_process'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { keyListenerWin32Invocation } from '../../src/main/hotkeys/keyListenerWin32'

const CS_PATH = join(__dirname, '../../native/key-listener/win32.cs')
const LIVE = process.env.SOTTO_KEY_LISTENER_LIVE === '1'

interface Helper {
  lines: string[]
  waitFor(line: string, timeoutMs: number): Promise<void>
  send(line: string): void
  closeAndExit(timeoutMs: number): Promise<number | null>
}

function startHelper(acceptSynthetic: boolean): Helper {
  const invocation = keyListenerWin32Invocation(CS_PATH, acceptSynthetic)
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
  it('compiles, installs the hook, prints only protocol lines and exits when stdin closes', async () => {
    const helper = startHelper(false)

    await helper.waitFor('permission granted', 10_000)
    helper.send('keys F13')
    helper.send('request')

    expect(await helper.closeAndExit(5_000)).toBe(0)
    expect(helper.lines).toEqual(['permission granted'])
  }, 20_000)

  it.runIf(LIVE)('reports a watched F13 sent with SendInput when synthetic input is accepted', async () => {
    const helper = startHelper(true)
    await helper.waitFor('permission granted', 10_000)
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
  }, 30_000)
})
