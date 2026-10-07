import { z } from 'zod'

/**
 * How Sotto's window asks for an interactive visual's page (ADR-0056). The window names a visual by its thread and ID
 * and sends the theme to start it in; main reads the page from its own store and answers with a one-time address on
 * the `sotto-visual:` scheme. The window never sends a page. This file does not import `visualGuest.ts`, so the two
 * preloads share no module (see that file).
 */

export const VISUAL_PAGE_OPEN = 'sotto:visuals:open-page'
export const VISUAL_SCHEME = 'sotto-visual'
/** The in-memory session every interactive visual runs in: no `persist:` prefix, so nothing it holds reaches disk. */
export const VISUAL_PARTITION = 'sotto-visual'

const TOKEN_NAMES = ['--sotto-text', '--sotto-muted', '--sotto-line', '--sotto-background', '--sotto-surface', '--sotto-border', '--sotto-group', '--sotto-note', '--sotto-accent'] as const
const hex = z.string().regex(/^#[0-9a-f]{6}$/u)

export const visualPageThemeSchema = z.object({
  tokens: z.object(Object.fromEntries(TOKEN_NAMES.map(name => [name, hex])) as Record<typeof TOKEN_NAMES[number], typeof hex>).strict(),
  mode: z.enum(['light', 'dark']),
  reducedMotion: z.boolean(),
}).strict()

export const visualPageRequestSchema = z.object({
  threadId: z.string().min(1).max(512),
  visualId: z.string().min(1).max(256),
  theme: visualPageThemeSchema,
}).strict()
export type VisualPageRequest = z.infer<typeof visualPageRequestSchema>

export const visualPageResultSchema = z.union([
  z.object({ ok: z.literal(true), url: z.string().startsWith(`${VISUAL_SCHEME}://page/`).max(256) }).strict(),
  z.object({ ok: z.literal(false), reason: z.string().max(500) }).strict(),
])
export type VisualPageResult = z.infer<typeof visualPageResultSchema>

export interface VisualPagesBridge {
  /** A one-time address for this visual's sealed page, or why it cannot be shown. */
  open(request: VisualPageRequest): Promise<VisualPageResult>
}
