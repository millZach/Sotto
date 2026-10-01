import type { PasteProcessAdapter } from './outputService'

/** The macOS permission a failed `osascript` paste reported as missing. */
export type PastePermissionDenial = 'automation' | 'accessibility'

/** Stable event names: the only trace a darwin paste leaves in the log. */
export type OsascriptPasteEvent =
  | 'paste-automation-denied'
  | 'paste-accessibility-denied'
  | 'paste-osascript-failed'
  | 'paste-osascript-timeout'

export interface OsascriptChildLike {
  readonly stderr: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null
  once(event: 'error', listener: (error: Error) => void): unknown
  // 'close' rather than 'exit': it fires after stderr has drained, so the reason is complete.
  once(event: 'close', listener: (code: number | null, signal: string | null) => void): unknown
  kill(): boolean
}

export type SpawnOsascript = (
  executable: string,
  args: readonly string[],
  options: {
    readonly shell: false
    readonly windowsHide: true
    readonly stdio: readonly ['ignore', 'ignore', 'pipe']
  },
) => OsascriptChildLike

export interface OsascriptPasteOptions {
  readonly spawn: SpawnOsascript
  readonly onDenied: (denial: PastePermissionDenial) => void
  readonly log: (event: OsascriptPasteEvent) => void
  readonly timeoutMs?: number
}

/**
 * The first Automation prompt ("Sotto wants to control System Events") holds
 * osascript open until the user answers it, so the darwin paste waits far
 * longer than the Windows one before giving up and leaving the text copied.
 */
export const DARWIN_PASTE_PROCESS_TIMEOUT_MS = 60_000

// Only enough of stderr to find the error number; it is never logged or kept.
const STDERR_LIMIT = 4_096

/**
 * -1743 is "Not authorized to send Apple events" (Automation). -1719, -25211
 * and 1002 are the forms "not allowed assistive access" and "not allowed to
 * send keystrokes" take (Accessibility).
 */
export function classifyOsascriptFailure(stderr: string): PastePermissionDenial | null {
  if (/\(-1743\)/u.test(stderr) || /not authori[sz]ed to send apple events/iu.test(stderr)) {
    return 'automation'
  }
  if (
    /\((?:-1719|-25211|1002)\)/u.test(stderr)
    || /assistive access|not allowed to send keystrokes/iu.test(stderr)
  ) {
    return 'accessibility'
  }
  return null
}

export function createOsascriptPasteAdapter(options: OsascriptPasteOptions): PasteProcessAdapter {
  const timeoutMs = options.timeoutMs ?? DARWIN_PASTE_PROCESS_TIMEOUT_MS
  const report = (callback: () => void): void => {
    try {
      callback()
    } catch {
      // Reporting a failure must never turn a copied outcome into a thrown one.
    }
  }

  return {
    run(invocation): Promise<boolean> {
      return new Promise((resolve) => {
        let settled = false
        let timeout: ReturnType<typeof setTimeout> | undefined
        let stderr = ''
        const finish = (successful: boolean): void => {
          if (settled) return
          settled = true
          if (timeout !== undefined) clearTimeout(timeout)
          resolve(successful)
        }

        try {
          const child = options.spawn(invocation.executable, invocation.args, {
            shell: false,
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'pipe'],
          })
          child.stderr?.on('data', (chunk) => {
            if (stderr.length < STDERR_LIMIT) {
              stderr = `${stderr}${String(chunk)}`.slice(0, STDERR_LIMIT)
            }
          })
          child.once('error', () => {
            if (!settled) report(() => options.log('paste-osascript-failed'))
            finish(false)
          })
          child.once('close', (code, signal) => {
            if (settled) return
            if (code === 0 && signal === null) {
              finish(true)
              return
            }
            const denial = classifyOsascriptFailure(stderr)
            stderr = ''
            report(() => options.log(
              denial === 'automation'
                ? 'paste-automation-denied'
                : denial === 'accessibility'
                  ? 'paste-accessibility-denied'
                  : 'paste-osascript-failed',
            ))
            if (denial !== null) report(() => options.onDenied(denial))
            finish(false)
          })
          if (!settled) {
            timeout = setTimeout(() => {
              report(() => options.log('paste-osascript-timeout'))
              finish(false)
              try {
                child.kill()
              } catch {
                // Timeout remains a finite copied outcome even if termination fails.
              }
            }, timeoutMs)
          }
        } catch {
          report(() => options.log('paste-osascript-failed'))
          finish(false)
        }
      })
    },
  }
}
