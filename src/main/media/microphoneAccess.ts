export type MediaAccessStatus =
  | 'not-determined'
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'unknown'

export interface MicrophoneAccessAdapter {
  status(): MediaAccessStatus
  request(): Promise<boolean>
}

export interface MicrophoneAccessGate {
  ensure(onWaiting?: (waiting: boolean) => void): Promise<boolean>
  /** Synchronous OS read for Chromium's permission check, which must not pre-grant. */
  isGranted(): boolean
}

export function createMicrophoneAccessGate(
  adapter: MicrophoneAccessAdapter,
): MicrophoneAccessGate {
  let prompt: Promise<boolean> | null = null
  let pending = false

  // The OS shows its consent dialog at most once per install, so the first
  // request owns the answer: concurrent callers share it, and a later caller
  // that still reads 'not-determined' must reuse it rather than ask again.
  const requestOnce = (): Promise<boolean> => {
    if (prompt === null) {
      try {
        const requested = adapter.request()
        pending = true
        prompt = requested.catch(() => false).finally(() => { pending = false })
      } catch {
        prompt = Promise.resolve(false)
      }
    }
    return prompt
  }

  return {
    isGranted: (): boolean => {
      // Fail closed: a true here skips the OS prompt, so an unreadable status
      // must never become a grant. The request handler can still ask.
      try {
        return adapter.status() === 'granted'
      } catch {
        return false
      }
    },
    ensure: async (onWaiting): Promise<boolean> => {
      let status: MediaAccessStatus
      try {
        status = adapter.status()
      } catch {
        return true
      }

      switch (status) {
        case 'granted':
          return true
        case 'denied':
        case 'restricted':
          return false
        case 'not-determined': {
          const requested = requestOnce()
          if (!pending) return await requested
          onWaiting?.(true)
          try {
            return await requested
          } finally {
            onWaiting?.(false)
          }
        }
        default:
          // Fail open: Chromium still gates the capture itself, so an
          // unreadable OS status must not be the thing that blocks dictation.
          return true
      }
    },
  }
}
