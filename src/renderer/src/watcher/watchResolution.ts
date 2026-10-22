/**
 * Calls `onChange` whenever the window's device pixel ratio changes, as when it moves to a display with other scaling.
 * The query names the ratio it was made for, so it is made again for the new one after each change. Returns the stop.
 */
export function watchResolution(onChange: () => void): () => void {
  let query: MediaQueryList | null = null
  const changed = (): void => { arm(); onChange() }
  function arm(): void {
    query?.removeEventListener('change', changed)
    query = window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`) ?? null
    query?.addEventListener('change', changed)
  }
  arm()
  return () => { query?.removeEventListener('change', changed); query = null }
}
