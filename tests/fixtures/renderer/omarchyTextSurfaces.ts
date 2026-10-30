/** Audited color: uses in renderer stylesheets, including inherited room text and tinted diff rows. */
const room = ['canvas', 'surface', 'surface-elevated', 'surface-overlay', 'surface-sunken', 'field', 'secondary', 'kbd', 'selected', 'hover-strong', 'sidebar', 'sidebar-control', 'sidebar-row-hover', 'sidebar-row-active', 'sidebar-row-selected', 'bubble', 'code-bg'] as const
export const OMARCHY_CSS_TEXT_PAIRS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['text', [...room, 'error-surface', 'warning-surface', 'update-surface', 'accent-wash']],
  ['text-2', [...room, 'accent-wash', 'diff-hunk']],
  ['text-muted', [...room, 'error-surface', 'warning-surface', 'update-surface', 'diff-add', 'diff-remove']],
  ['text-faint', room],
  ['sidebar-text', ['sidebar', 'sidebar-control', 'sidebar-row-hover', 'sidebar-row-active', 'sidebar-row-selected']],
  ['sidebar-text-muted', ['sidebar', 'sidebar-control', 'sidebar-row-hover', 'sidebar-row-active', 'sidebar-row-selected']],
  ['accent-text', [...room, 'accent-wash']],
  ['accent-surface-text', ['hover-strong']],
  ['activity', ['canvas', 'surface', 'surface-elevated', 'sidebar', 'sidebar-row-selected']],
  ['working-light', ['canvas', 'surface']],
  ['link', ['surface', 'sidebar', 'selected']],
  ['primary-hover', ['surface', 'sidebar', 'selected']],
  ['warning', ['canvas', 'surface', 'surface-elevated', 'sidebar']],
  ['attention', ['sidebar', 'sidebar-control', 'sidebar-row-hover', 'sidebar-row-active', 'sidebar-row-selected']],
  ['warning-text', ['sidebar', 'warning-surface']],
  ['warning-on-tint', ['selected', 'bubble']],
  ['error', ['canvas', 'surface', 'surface-elevated', 'sidebar']],
  ['error-text', [...room, 'error-surface', 'diff-remove']],
  ['error-on-tint', ['selected', 'bubble']],
  ['error-contrast', ['error', 'danger-hover']],
  ['success', [...room, 'diff-add']],
  ['on-accent', ['accent']], ['primary-contrast', ['primary', 'primary-hover']],
  ['pill-ink', ['pill']], ['bubble-text', ['bubble']],
  ['code-text', ['code-bg', 'diff-add', 'diff-remove']],
  ['update-text', ['update-surface']],
  ['terminal-foreground', ['terminal-background', 'terminal-selection']],
  ['effort-text-fill', ['surface-elevated', 'field', 'sidebar', 'sidebar-control']],
  // Ultracode's workflow mark (ADR-0148): the colourway's opaque ink, where the word's fill may be a clipped gradient's transparent one.
  ['effort-text', ['surface-elevated', 'field', 'sidebar', 'sidebar-control']],
  ['provider-ink', ['provider-codex', 'provider-claude', 'provider-grok', 'provider-devin', 'provider-muse', 'provider-opencode-badge', 'provider-cursor-badge']],
]
/** These color: declarations paint SVG/provider marks only; their children override inherited text.
 * Quiet-pill permission shields use accent and chart-6 for Automatic and Full access. */
export const OMARCHY_GRAPHIC_COLOR_TOKENS = ['surface', 'primary', 'accent', 'chart-6', 'provider-codex', 'provider-claude', 'provider-grok', 'provider-devin', 'provider-opencode', 'provider-cursor'] as const
