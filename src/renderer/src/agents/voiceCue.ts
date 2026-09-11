/** A short local acknowledgement that never pauses capture or loads a speech model. */
export function playWakeCue(): void {
  let context: AudioContext | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  const close = () => {
    clearTimeout(timeout)
    if (context !== undefined && context.state !== 'closed') void context.close().catch(() => undefined)
  }
  try {
    context = new AudioContext()
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    const start = context.currentTime
    oscillator.frequency.value = 880
    gain.gain.setValueAtTime(0, start)
    gain.gain.linearRampToValueAtTime(0.045, start + 0.008)
    gain.gain.linearRampToValueAtTime(0, start + 0.07)
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.onended = close
    oscillator.start(start)
    oscillator.stop(start + 0.075)
    // Also release a context whose playback remains suspended by the browser.
    timeout = setTimeout(close, 2_000)
    if (context.state === 'suspended') void context.resume().catch(close)
  } catch {
    // Listening state still acknowledges activation when local audio is unavailable.
    close()
  }
}
