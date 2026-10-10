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
  ['link', ['surface', 'sidebar', 'selected']],
  ['primary-hover', ['surface', 'sidebar', 'selected']],
  ['warning', ['canvas', 'surface', 'surface-elevated', 'sidebar']],
  ['warning-text', ['sidebar', 'warning-surface']],
  ['error', ['canvas', 'surface', 'surface-elevated', 'sidebar']],
  ['error-text', [...room, 'error-surface', 'diff-remove']],
  ['error-contrast', ['error', 'danger-hover']],
  ['success', [...room, 'diff-add']],
  ['on-accent', ['accent']], ['primary-contrast', ['primary', 'primary-hover']],
  ['pill-ink', ['pill']], ['bubble-text', ['bubble']],
  ['code-text', ['code-bg', 'diff-add', 'diff-remove']],
  ['update-text', ['update-surface']],
  ['terminal-foreground', ['terminal-background', 'terminal-selection']],
  ['effort-text-fill', ['surface-elevated', 'field', 'sidebar', 'sidebar-control']],
  ['provider-ink', ['provider-codex', 'provider-claude', 'provider-grok', 'provider-devin']],
]
/** These color: declarations paint SVG/provider marks only; their children override inherited text. */
export const OMARCHY_GRAPHIC_COLOR_TOKENS = ['surface', 'primary', 'attention', 'provider-codex', 'provider-claude', 'provider-grok', 'provider-devin'] as const
