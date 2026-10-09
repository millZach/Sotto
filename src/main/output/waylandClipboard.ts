import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import type { ClipboardAdapter } from './outputService'

export const CLIPBOARD_PROCESS_TIMEOUT_MS = 5_000
export const CLIPBOARD_TERMINATE_GRACE_MS = 250

type ClipboardSpawn = (executable: string, args: readonly string[], options: SpawnOptions) => ChildProcess

interface TextClipboard extends ClipboardAdapter {
  readText(): string | Promise<string>
}

/** wl-copy forks its selection owner. Only wait for the parent, never its stdout. */
export function createWaylandClipboard(
  fallback: TextClipboard,
  onFallback: () => void,
  spawnProcess: ClipboardSpawn = spawn,
): TextClipboard {
  let desktopClipboardWritten = false
  let fallbackReported = false
  const reportFallback = (): void => {
    if (fallbackReported) return
    fallbackReported = true
    onFallback()
  }
  const run = (executable: string, args: readonly string[], text?: string): Promise<string> =>
    new Promise((resolve, reject) => {
      let child: ChildProcess | undefined
      let timeout: ReturnType<typeof setTimeout> | undefined
      let killTimeout: ReturnType<typeof setTimeout> | undefined
      let exited = false
      let settled = false
      let output = ''
      const finish = (success: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (success) resolve(output)
        else {
          // A broken stdin can leave the transport alive indefinitely.
          if (child?.pid !== undefined && !exited) {
            try { child.kill('SIGTERM') } catch { /* Still escalate if termination failed. */ }
            if (!exited) {
              killTimeout = setTimeout(() => {
                if (!exited) {
                  try { child?.kill('SIGKILL') } catch { /* The failure is already settled. */ }
                }
              }, CLIPBOARD_TERMINATE_GRACE_MS)
              killTimeout.unref()
            }
          }
          reject(new Error('Desktop clipboard unavailable'))
        }
      }
      try {
        child = spawnProcess(executable, args, {
          shell: false,
          stdio: text === undefined ? ['ignore', 'pipe', 'ignore'] : ['pipe', 'ignore', 'ignore'],
        })
        child.once('error', () => finish(false))
        child.once('exit', () => { exited = true; clearTimeout(killTimeout) })
        // close waits for wl-paste's entire output; wl-copy has no output pipe to hold open.
        child.once('close', (code, signal) => {
          exited = true
          clearTimeout(killTimeout)
          finish(code === 0 && signal === null)
        })
        child.stdout?.setEncoding('utf8')
        child.stdout?.on('data', (chunk: string) => { output += chunk })
        child.stdin?.once('error', () => finish(false))
        if (!settled) {
          timeout = setTimeout(() => {
            finish(false)
          }, CLIPBOARD_PROCESS_TIMEOUT_MS)
          if (text !== undefined) child.stdin?.end(text, 'utf8')
        }
      } catch {
        finish(false)
      }
    })

  return {
    async writeText(text): Promise<void> {
      desktopClipboardWritten = false
      try {
        await run('wl-copy', ['--type', 'text/plain;charset=utf-8'], text)
        desktopClipboardWritten = true
        fallbackReported = false
      } catch {
        reportFallback()
        await fallback.writeText(text)
      }
    },
    canPaste: () => desktopClipboardWritten,
    async readText(): Promise<string> {
      try {
        return await run('wl-paste', ['--no-newline'])
      } catch {
        reportFallback()
        return fallback.readText()
      }
    },
  }
}
