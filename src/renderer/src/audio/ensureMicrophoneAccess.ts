/** Asks the operating system for the microphone before Chromium getUserMedia. */
export async function ensureMicrophoneAccess(): Promise<boolean> {
  const ensure = (globalThis as {
    sotto?: { ensureMicrophoneAccess?: () => Promise<boolean> }
  }).sotto?.ensureMicrophoneAccess
  if (ensure === undefined) return true
  try {
    return await ensure()
  } catch {
    return false
  }
}
