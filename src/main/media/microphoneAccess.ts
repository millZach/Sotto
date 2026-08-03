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
  ensure(): Promise<boolean>
}

export function createMicrophoneAccessGate(
  adapter: MicrophoneAccessAdapter,
): MicrophoneAccessGate {
  let prompt: Promise<boolean> | null = null

  // The OS shows its consent dialog at most once per install, so the first
  // request owns the answer: concurrent callers share it, and a later caller
  // that still reads 'not-determined' must reuse it rather than ask again.
  const requestOnce = (): Promise<boolean> => {
    if (prompt === null) {
      try {
        prompt = adapter.request().catch(() => false)
      } catch {
        prompt = Promise.resolve(false)
      }
    }
    return prompt
  }

  return {
    ensure: async (): Promise<boolean> => {
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
        case 'not-determined':
          return await requestOnce()
        default:
          // Fail open: Chromium still gates the capture itself, so an
          // unreadable OS status must not be the thing that blocks dictation.
          return true
      }
    },
  }
}
