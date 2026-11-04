/** Asks the operating system for the microphone before Chromium getUserMedia. */
export async function ensureMicrophoneAccess(onWaiting?: (waiting: boolean) => void): Promise<boolean> {
  const ensure = (globalThis as {
    sotto?: { ensureMicrophoneAccess?: (onWaiting?: (waiting: boolean) => void) => Promise<boolean> }
  }).sotto?.ensureMicrophoneAccess
  if (ensure === undefined) return true
  try {
    return await ensure(onWaiting)
  } catch {
    return false
  }
}
