/**
 * The menu bar owl's two choices (ADR-0112): the colour of its body and of its eyes. Shared by main, which picks the
 * frames to show, and the renderer, which draws the swatches in Settings → Appearance. The swatches are the colours the
 * frames are drawn in (`scripts/lib/trayOwlDraw.mjs`), so what the user presses is what the bar will show.
 */
export type MenuBarOwlBody = 'slate' | 'ink' | 'light'
export const MENU_BAR_OWL_BODIES = ['slate', 'ink', 'light'] as const satisfies readonly MenuBarOwlBody[]
export const MENU_BAR_OWL_BODY_LABELS: Record<MenuBarOwlBody, string> = { slate: 'Slate', ink: 'Ink', light: 'Light' }

export type MenuBarOwlEyes = 'teal' | 'ice' | 'amber'
export const MENU_BAR_OWL_EYES = ['teal', 'ice', 'amber'] as const satisfies readonly MenuBarOwlEyes[]
export const MENU_BAR_OWL_EYES_LABELS: Record<MenuBarOwlEyes, string> = { teal: 'Sotto teal', ice: 'Ice blue', amber: 'Amber' }

/** The swatch for each choice: the body's mid tone, the eyes' glow. */
export const MENU_BAR_OWL_BODY_SWATCHES: Record<MenuBarOwlBody, string> = { slate: '#7f8fa6', ink: '#2c3748', light: '#dde2ea' }
export const MENU_BAR_OWL_EYES_SWATCHES: Record<MenuBarOwlEyes, string> = { teal: '#47b8a9', ice: '#5ec8ff', amber: '#ffb44a' }

export const DEFAULT_MENU_BAR_OWL_BODY: MenuBarOwlBody = 'slate'
export const DEFAULT_MENU_BAR_OWL_EYES: MenuBarOwlEyes = 'teal'
