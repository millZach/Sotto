import { z } from 'zod'

export const OMARCHY_SETUP_GET = 'omarchy-setup:get'
export const OMARCHY_SETUP_COMMAND = 'omarchy-setup:command'
export const OMARCHY_SETUP_FOCUS = 'omarchy-setup:focus'
export const OMARCHY_SETUP_CHANGED = 'omarchy-setup:changed'
export const OMARCHY_PIECES = ['keys', 'owl', 'theme'] as const
export type OmarchyPiece = typeof OMARCHY_PIECES[number]

export const omarchyPieceStateSchema = z.object({
  status: z.enum(['missing', 'done', 'manual', 'stale', 'conflict', 'failed', 'working', 'queued', 'skipped']),
  message: z.string().max(8000),
  owned: z.boolean(),
  retry: z.enum(['setup', 'remove', 'inspect']).optional(),
}).strict()
export type OmarchyPieceState = z.infer<typeof omarchyPieceStateSchema>
export const omarchySetupStateSchema = z.object({
  pieces: z.object({ keys: omarchyPieceStateSchema, owl: omarchyPieceStateSchema, theme: omarchyPieceStateSchema }).strict(),
  busy: z.boolean(),
  operation: z.enum(['setup', 'remove', 'update-owl']).optional(),
  keyConflicts: z.array(z.string().max(1000)).max(100),
  voxtype: z.boolean(),
  shellRunning: z.boolean(),
  notice: z.string().max(2000),
}).strict()
export type OmarchySetupState = z.infer<typeof omarchySetupStateSchema>

export const omarchySetupCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('setup'), pieces: z.array(z.enum(OMARCHY_PIECES)).min(1).max(3),
    keys: z.enum(['give', 'keep', 'unconfirmed']) }).strict(),
  z.object({ type: z.literal('remove'), pieces: z.array(z.enum(OMARCHY_PIECES)).min(1).max(3) }).strict(),
  z.object({ type: z.literal('update-owl') }).strict(),
])
export type OmarchySetupCommand = z.infer<typeof omarchySetupCommandSchema>

export interface OmarchySetupBridge {
  get(): Promise<OmarchySetupState>
  command(command: OmarchySetupCommand): Promise<OmarchySetupState>
  onFocus(listener: () => void): () => void
  onChanged(listener: (state: OmarchySetupState) => void): () => void
}

/**
 * Why Sotto's keys can't take a new shortcut right now, in the row's words, or null when they can: only keys Sotto set up
 * and still owns are rewritten (ADR-0062, ADR-0097).
 */
export function shortcutsBlocked(keys: OmarchyPieceState): string | null {
  if (keys.owned && (keys.status === 'done' || keys.status === 'stale')) return null
  if (keys.status === 'working' || keys.status === 'queued') return 'Sotto is still changing its Omarchy setup. Try again in a moment.'
  if (keys.status === 'manual') return 'Your bindings.lua gives Sotto its keys by hand, so Sotto leaves them alone. Change them there.'
  if (keys.owned && keys.status === 'conflict') return 'Sotto’s keys changed outside Sotto, so Sotto leaves them alone. Nothing was changed.'
  if (keys.status === 'failed' && keys.message) return keys.message
  return 'Sotto’s keys aren’t set up in Hyprland yet, so these shortcuts don’t work. Set them up first. Nothing was changed.'
}
