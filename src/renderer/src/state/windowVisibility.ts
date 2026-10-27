/**
 * Marks the window root `data-window-hidden` while nobody can see the window (minimised, in the tray or behind another
 * page), so stylesheets can stop motion that would otherwise keep running for no one. The effort trace's lap reads it.
 */
export function startWindowVisibility(root: HTMLElement = document.documentElement): () => void {
  const update = (): void => { root.toggleAttribute('data-window-hidden', document.visibilityState === 'hidden') }
  update()
  document.addEventListener('visibilitychange', update)
  return () => document.removeEventListener('visibilitychange', update)
}
