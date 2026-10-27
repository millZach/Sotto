/**
 * Marks the window root `data-window-hidden` while nobody can see the window, so stylesheets can stop motion that
 * would otherwise keep running for no one; the effort trace's lap reads it. The page's own visibility covers a window
 * hidden after it was shown. Main's word covers the rest: a window made hidden reports its page visible until it is
 * first shown, which Start minimized may never do, and a capture can keep the page visible after the window hides.
 */
export function startWindowVisibility(
  root: HTMLElement = document.documentElement,
  onWindowVisible: ((listener: (visible: boolean) => void) => () => void) | undefined = window.sotto?.onWindowVisible,
): () => void {
  let shown = true
  const update = (): void => { root.toggleAttribute('data-window-hidden', !shown || document.visibilityState === 'hidden') }
  update()
  document.addEventListener('visibilitychange', update)
  const unsubscribe = onWindowVisible?.(visible => { shown = visible; update() })
  return () => { document.removeEventListener('visibilitychange', update); unsubscribe?.() }
}
