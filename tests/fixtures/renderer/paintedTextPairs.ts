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
 * finished, focus and boundary checks hold. Disabled controls are exempt. So is the next prompt's ghost, suggestion
 * ink (muted ink at 55% in nextPrompt.css): words nobody has typed yet, read as unaccepted, which speech hears in the
 * prompt's description. The prompt editor's placeholder is not exempt (#1819): it is read here from threads.css.
 * themeTokens.test.ts holds every built-in half to it, and omarchyThemes.test.ts every stock Omarchy palette.
 */
export interface PaintedTextPair {
  readonly ink: string
  readonly surface: readonly [string, ...string[]]
  readonly where: string
}

const hover = '--tt-hover'
const picked = '--changes-picked'
const followups = '--followups-surface'
const pair = (ink: string, surface: readonly [string, ...string[]], where: string): PaintedTextPair => ({ ink, surface, where })
const each = (ink: string, surfaces: ReadonlyArray<readonly [string, ...string[]]>, where: string) => surfaces.map(surface => pair(ink, surface, where))

const rooms = [['canvas'], ['surface'], ['surface-elevated'], ['surface-overlay'], ['surface-sunken'], ['field'], ['sidebar'], ['code-bg'], ['card'], ['card-selected']] as const
const glass = [['canvas', '--tt-glass'], ['sidebar', '--tt-glass'], ['canvas', '--tt-glass-field']] as const
// The composer's text buttons and its branch line take the hover wash on the card and on the room (ADR-0113).
const hovered = [['sidebar', hover], ['surface-elevated', hover], ['surface-overlay', hover], ['field', hover], ['card', hover], ['canvas', hover]] as const
/** Changes lines: context on the code background, and added and removed lines with their tint over it. */
const context = ['code-bg'] as const, added = ['code-bg', '--changes-added'] as const, removed = ['code-bg', '--changes-removed'] as const
const lines = [context, added, removed] as const
const RICH_CODE_INKS = ['--rich-code-keyword', '--rich-code-string', '--rich-code-number', '--rich-code-title', '--rich-code-type', '--rich-code-comment', '--rich-code-meta'] as const
const RICH_TEXT_INKS = ['--rich-text', '--rich-strong', '--rich-muted', '--rich-link-hover'] as const

export const PAINTED_TEXT_PAIRS: readonly PaintedTextPair[] = [
  // Body and secondary text: titles, labels, message bodies (a user's bubble is secondary text), keycaps.
  ...['text', 'text-2'].flatMap(ink => each(ink, [...rooms, ['selected'], ['hover-strong'], ['bubble'], ['kbd'], ...hovered, ...glass], 'body and secondary text')),
  pair('text-2', ['code-bg', 'accent-wash'], 'Changes hunk header'),
  // Muted text: timestamps on the current and hovered rows and in the bubble, subtitles on a highlighted choice,
  // metadata on cards, menus and glass, Changes line numbers, and ghost buttons on the bubble and warning card.
  ...each('text-muted', [...rooms, ['selected'], ['hover-strong'], ['bubble'], ['warning-surface'], [followups], ...hovered, ...glass], 'muted text'),
  ...lines.flatMap(line => each('text-muted', [line, [...line, hover]], 'Changes line number')),
  // The prompt editor's placeholder, as threads.css paints it: on the composer card, where while a turn runs it is the
  // only thing that says what typing will do, and in the field a queued message is edited in (#1819).
  ...each('--placeholder-ink', [['card'], ['field']], "the prompt editor's placeholder"),
  // Faint text: ghost buttons and input placeholders.
  ...each('text-faint', [['canvas'], ['surface'], ['surface-elevated'], ['surface-overlay'], ['surface-sunken'], ['field'], ['card'], [followups], ...glass], 'ghost button or placeholder'),
  // Changes lines: the code, and on a picked line the numbers and signs (changes.css).
  ...lines.flatMap(line => each('code-text', [line, [...line, hover], [...line, picked]], 'Changes code')),
  ...lines.map(line => pair('text', [...line, picked], 'picked line number')),
  ...each('success', [added, [...added, hover]], 'added line sign'),
  pair('--changes-picked-add', [...added, picked], 'picked added line sign'),
  ...each('error-text', [removed, [...removed, hover]], 'removed line sign'),
  pair('--changes-picked-remove', [...removed, picked], 'picked removed line sign'),
  // Status text, and its on-tint tones on the selection and in the bubble.
  ...each('success', [['sidebar'], ['sidebar', hover], ['surface-overlay'], ['canvas']], 'file badges, done and updated'),
  ...each('success', [['bubble'], ['bubble', hover], ['canvas', hover]], 'Copied, on a message and in the bubble'),
  ...each('warning', [['sidebar'], ['sidebar', hover], ['surface-elevated'], ['canvas'], ['code-bg'], ['field'], ['card'], ['card-selected'], [followups], [followups, hover]], 'warning text and code strings'),
  pair('warning-text', ['warning-surface'], 'warning card'),
  // Needs you (ADR-0135): what a thread needs, on its entry's card and on the card its press pops open over the sidebar.
  ...each('warning-text', [['card'], ['surface-elevated']], 'Needs you entry and popped card'),
  // The sidebar's Needs attention line and its Dismiss all, and the pane's failed turn notice (ADR-0092).
  ...each('text', [['warning-surface'], ['warning-surface', hover]], 'Dismiss all and the lead of the failed turn notice'),
  pair('text-2', ['warning-surface'], 'failed turn notice'),
  ...each('warning-on-tint', [['selected'], ['bubble']], 'needs you or a branch problem on the current row, a failed send'),
  ...each('error-text', [['canvas'], ['surface'], ['surface-elevated'], ['card'], ['surface-overlay'], ['surface-sunken'], ['field'], ['sidebar'], ['error-surface'], ['terminal-background'], ...hovered.slice(0, 3), glass[0]], 'error text'),
  ...each('error-on-tint', [['selected'], ['bubble']], 'unavailable tab, selected; a link that would not open'),
  // Tools › Agents: a delegated thread's outcome on the roster (the panel is the sidebar's tone), on a waiting row's tint
  // and on the opened row's selected tone, where failed and unknown take their on-tint tones (agentsSurface.css).
  ...['activity', 'error-text', 'warning-text', 'warning-on-tint', 'text-muted', 'text-2'].map(ink => pair(ink, ['sidebar'], 'delegated thread outcome')),
  ...['activity', 'error-on-tint', 'warning-on-tint', 'text-muted', 'text-2', 'text'].map(ink => pair(ink, ['sidebar', 'selected'], 'delegated thread on the opened row')),
  // A waiting row's word is always Needs your approval or Needs your answer.
  ...['warning-on-tint', 'text-muted', 'text-2', 'text'].map(ink => pair(ink, ['sidebar', '--delegated-needs'], 'delegated thread on the waiting row')),
  // Answers: highlighted code on its block and message text in the room and the bubble (rich-messages.css).
  ...RICH_CODE_INKS.map(ink => pair(ink, ['code-bg'], 'highlighted code')),
  ...RICH_TEXT_INKS.flatMap(ink => each(ink, [['canvas'], ['bubble']], 'message text')),
  ...each('primary-hover', [['canvas'], ['surface'], ['bubble'], ['code-bg'], ['surface-sunken'], ['field'], ['field', hover], ['selected']], 'link hover'),
  ...each('link', [['canvas'], ['surface'], ['bubble'], ['sidebar'], ['selected']], 'links'),
  ...each('accent-text', [['canvas'], ['surface'], ['surface-elevated'], ['card'], ['card-selected'], ['sidebar'], ['selected'], ['bubble'], ['field'], ['hover-strong']], 'accent text and activity'),
  // Steer now, in the composer and on a queued message, keeps the accent while pointed at.
  ...each('accent-text', [['card', hover], ['canvas', hover]], 'Steer now, hovered'),
  // The effort offer's level on the accent's wash, on the composer card (ADR-0172).
  pair('accent-text', ['card', '--effort-offer-wash'], 'the effort offer'),
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

/** Adds the layers and inks the stylesheets compose on top of tokens.css, read from the stylesheets that declare them. */
export function withPaintedLayers(declarations: Map<string, string>): Map<string, string> {
  for (const name of ['--changes-added', '--changes-removed', '--changes-picked', '--changes-picked-add', '--changes-picked-remove']) declarations.set(name, stylesheetProperty('src/renderer/src/tools/changes.css', name))
  for (const name of [...RICH_CODE_INKS, ...RICH_TEXT_INKS]) declarations.set(name, stylesheetProperty('src/renderer/src/agents/rich-messages.css', name))
  // threads.css aliases the field with a fallback colour the resolver does not read.
  declarations.set('--threads-field', 'var(--tt-field)')
  declarations.set(followups, stylesheetProperty('src/renderer/src/agents/composer.css', followups))
  declarations.set('--delegated-needs', stylesheetProperty('src/renderer/src/tools/agentsSurface.css', '--delegated-needs'))
  declarations.set('--placeholder-ink', stylesheetProperty('src/renderer/src/agents/threads.css', '--placeholder-ink'))
  declarations.set('--effort-offer-wash', stylesheetProperty('src/renderer/src/agents/quietComposer.css', '--effort-offer-wash'))
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

/**
 * How far the prompt editor's placeholder stands from typed text on the composer card, as a contrast ratio between the
 * two inks. The placeholder is a hint, so it must read as dimmer than what the user types, not as the same ink.
 */
export function placeholderApartFromText(declarations: ReadonlyMap<string, string>): number {
  const token = (name: string): Rgba => resolveColor(name.startsWith('--') ? name : `--tt-${name}`, declarations)
  const card = over(token('card'), token('canvas'))
  return contrast(over(token('--placeholder-ink'), card), over(token('text'), card))
}
