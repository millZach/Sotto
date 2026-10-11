import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { contrast, over, parseTokenBlocks, resolveColor, type Rgba } from './themeTokenResolver'

/**
 * The text the main window really paints, on the surfaces it really sits on (#936). Each pair names its ink and the
 * surface under it: a token, then the translucent layers painted over it, bottom first. Names without a leading `--`
 * are `--tt-*` tokens; the rest are the stylesheets' own properties, read from the stylesheet that declares them.
 *
 * The list came from following every `color:` that paints text to the backgrounds behind it, states included
 * (hover, the current row, picked Changes lines, open menus). Icons are left out: they need 3:1, which the
 * finished, focus and boundary checks hold. Disabled controls are exempt. themeTokens.test.ts holds every built-in
 * half to it, and omarchyThemes.test.ts every stock Omarchy palette.
 */
export interface PaintedTextPair {
  readonly ink: string
  readonly surface: readonly [string, ...string[]]
  readonly where: string
}

const hover = '--tt-hover'
const picked = '--changes-picked'
const pair = (ink: string, surface: readonly [string, ...string[]], where: string): PaintedTextPair => ({ ink, surface, where })
const each = (ink: string, surfaces: ReadonlyArray<readonly [string, ...string[]]>, where: string) => surfaces.map(surface => pair(ink, surface, where))

const rooms = [['canvas'], ['surface'], ['surface-elevated'], ['surface-overlay'], ['surface-sunken'], ['field'], ['sidebar'], ['code-bg']] as const
const glass = [['canvas', '--tt-glass'], ['sidebar', '--tt-glass'], ['canvas', '--tt-glass-field']] as const
const hovered = [['sidebar', hover], ['surface-elevated', hover], ['surface-overlay', hover], ['field', hover]] as const
const lines = ['code-bg', 'diff-add', 'diff-remove'] as const
const RICH_CODE_INKS = ['--rich-code-keyword', '--rich-code-string', '--rich-code-number', '--rich-code-title', '--rich-code-type', '--rich-code-comment', '--rich-code-meta'] as const

export const PAINTED_TEXT_PAIRS: readonly PaintedTextPair[] = [
  // Body and secondary text: titles, labels, message bodies (a user's bubble is secondary text), keycaps.
  ...['text', 'text-2'].flatMap(ink => each(ink, [...rooms, ['selected'], ['hover-strong'], ['bubble'], ['kbd'], ...hovered, ...glass], 'body and secondary text')),
  pair('text-2', ['code-bg', 'accent-wash'], 'Changes hunk header'),
  // Muted text: timestamps on the current and hovered rows and in the bubble, subtitles on a highlighted choice,
  // metadata on cards, menus and glass, Changes line numbers, and ghost buttons on the bubble and warning card.
  ...each('text-muted', [...rooms, ['selected'], ['hover-strong'], ['bubble'], ['warning-surface'], ['followups'], ...hovered, ...glass], 'muted text'),
  ...lines.flatMap(line => each('text-muted', [[line], [line, hover]], 'Changes line number')),
  // Faint text: ghost buttons and placeholders.
  ...each('text-faint', [['canvas'], ['surface'], ['surface-elevated'], ['surface-overlay'], ['surface-sunken'], ['field'], ['followups'], ...glass], 'ghost button or placeholder'),
  // Changes lines: the code, and on a picked line the numbers and signs (changes.css).
  ...lines.flatMap(line => each('code-text', [[line], [line, hover], [line, picked]], 'Changes code')),
  ...lines.map(line => pair('text', [line, picked], 'picked line number')),
  ...each('success', [['diff-add'], ['diff-add', hover]], 'added line sign'),
  pair('--changes-picked-add', ['diff-add', picked], 'picked added line sign'),
  ...each('error-text', [['diff-remove'], ['diff-remove', hover]], 'removed line sign'),
  pair('--changes-picked-remove', ['diff-remove', picked], 'picked removed line sign'),
  // Status text.
  ...each('success', [['sidebar'], ['sidebar', hover], ['surface-overlay'], ['canvas']], 'file badges, done and updated'),
  ...each('warning', [['sidebar'], ['sidebar', hover], ['surface-elevated'], ['canvas'], ['code-bg'], ['field']], 'warning text and code strings'),
  pair('--thread-nav-current-warning', ['selected'], 'branch problem on the current row'),
  pair('warning-text', ['warning-surface'], 'warning card'),
  ...each('error-text', [['canvas'], ['surface'], ['surface-elevated'], ['surface-overlay'], ['surface-sunken'], ['field'], ['sidebar'], ['error-surface'], ['terminal-background'], ...hovered.slice(0, 3), glass[0]], 'error text'),
  pair('--terminal-tabs-selected-error', ['selected'], 'unavailable browser tab, selected'),
  // Answers: highlighted code on its block and message text in the room and the bubble (rich-messages.css).
  ...RICH_CODE_INKS.map(ink => pair(ink, ['code-bg'], 'highlighted code')),
  ...['--rich-text', '--rich-strong', '--rich-muted', '--rich-link-hover'].flatMap(ink => each(ink, [['canvas'], ['bubble']], 'message text')),
  ...each('primary-hover', [['canvas'], ['surface'], ['bubble'], ['code-bg'], ['surface-sunken'], ['field'], ['field', hover], ['selected']], 'link hover'),
  ...each('link', [['canvas'], ['surface'], ['bubble'], ['sidebar'], ['selected']], 'links'),
  ...each('accent-text', [['canvas'], ['surface'], ['surface-elevated'], ['sidebar'], ['selected'], ['field'], ['hover-strong']], 'accent text'),
  // Text on its own fill.
  pair('bubble-text', ['bubble'], 'bubble'), pair('sidebar-text', ['sidebar'], 'sidebar'), pair('update-text', ['update-surface'], 'update chip'),
  pair('on-accent', ['accent'], 'accent fill'), pair('primary-contrast', ['primary'], 'primary action'), pair('primary-contrast', ['primary-hover'], 'primary action, hovered'),
  pair('pill-ink', ['pill'], 'pill'), pair('error-contrast', ['error'], 'danger action'), pair('accent-surface-text', ['hover-strong'], 'pressed host'),
  pair('terminal-foreground', ['terminal-background'], 'terminal'), pair('terminal-foreground', ['terminal-selection'], 'terminal selection'),
]

function stylesheetProperty(path: string, name: string): string {
  const block = parseTokenBlocks(readFileSync(join(process.cwd(), path), 'utf8')).find(candidate => candidate.declarations.has(name))
  if (!block) throw new Error(`${path} declares no ${name}`)
  return block.declarations.get(name)!
}

/**
 * Adds the surfaces and inks the stylesheets compose on top of tokens.css. The Changes tints are 12% of the status
 * colour over the code background, and the follow-ups queue is the field at 70% over the room (composer.css).
 */
export function withPaintedLayers(declarations: Map<string, string>): Map<string, string> {
  declarations.set('--tt-diff-add', 'color-mix(in srgb, var(--tt-success) 12%, var(--tt-code-bg))')
  declarations.set('--tt-diff-remove', 'color-mix(in srgb, var(--tt-error) 12%, var(--tt-code-bg))')
  declarations.set('--tt-followups', 'color-mix(in srgb, var(--tt-field) 70%, var(--tt-canvas))')
  for (const name of ['--changes-picked', '--changes-picked-add', '--changes-picked-remove']) declarations.set(name, stylesheetProperty('src/renderer/src/tools/changes.css', name))
  declarations.set('--thread-nav-current-warning', stylesheetProperty('src/renderer/src/agents/threadSidebar.css', '--thread-nav-current-warning'))
  declarations.set('--terminal-tabs-selected-error', stylesheetProperty('src/renderer/src/tools/tools.css', '--terminal-tabs-selected-error'))
  for (const name of [...RICH_CODE_INKS, '--rich-text', '--rich-strong', '--rich-muted', '--rich-link-hover']) declarations.set(name, stylesheetProperty('src/renderer/src/agents/rich-messages.css', name))
  return declarations
}

/**
 * The pair's contrast as CSS composites it, and as the rounded sRGB pixel the screen shows: each translucent layer is
 * painted over the one beneath without rounding, and the ink over the result. The lower of the two is returned.
 */
export function paintedContrast(declarations: ReadonlyMap<string, string>, { ink, surface }: PaintedTextPair): number {
  const token = (name: string): Rgba => resolveColor(name.startsWith('--') ? name : `--tt-${name}`, declarations)
  const canvas = token('canvas')
  const [base, ...layers] = surface
  let background = over(token(base), canvas)
  for (const layer of layers) background = over(token(layer), background)
  const pixel = { r: Math.round(background.r), g: Math.round(background.g), b: Math.round(background.b), a: 1 }
  const foreground = over(token(ink), background)
  return Math.min(contrast(foreground, background), contrast(foreground, pixel))
}
