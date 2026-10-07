/** Count diagnostic bytes in one-second windows without retaining native stderr. */
export function stderrRateExceeded(): (bytes: number) => boolean {
  let started = performance.now()
  let total = 0
  return bytes => {
    const now = performance.now()
    if (now - started >= 1000) { started = now; total = 0 }
    total += bytes
    return total > 1024 * 1024
  }
}
