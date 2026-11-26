import { z } from 'zod'

/**
 * Mods (ADR-0217): folders in Sotto's mods folder that change how the main window looks. Main reads them, checks each
 * look, and sends the window the list; the window paints the looks of the mods that are on. An Owl feature, `mods`.
 */

/** A mod's id is its folder's name. */
export const MOD_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/
/** At most this many mods are read. */
export const MOD_LIMIT = 64
/** At most this many bytes of one mod's `look.css` are read. */
export const MOD_CSS_BYTES_MAX = 64 * 1024
export const MOD_MANIFEST_FILE = 'mod.json'
export const MOD_LOOK_FILE = 'look.css'
/** The longest Make a mod request the window sends. */
export const MOD_WORDS_MAX = 4000

export const modManifestSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(200).optional(),
})
export type ModManifest = z.infer<typeof modManifestSchema>

/**
 * Why a mod paints nothing: its `mod.json` is missing or unreadable, its look loads something from outside Sotto, or
 * its look is longer than `MOD_CSS_BYTES_MAX`. The window says each one in words.
 */
export const MOD_PROBLEMS = ['manifest', 'outside', 'too-large'] as const
export type ModProblem = (typeof MOD_PROBLEMS)[number]

export const modListedSchema = z.object({
  id: z.string().regex(MOD_ID_PATTERN),
  name: z.string().max(60),
  description: z.string().max(200).optional(),
  /** The look as written, for View its code; empty where the mod has none. */
  look: z.string().max(MOD_CSS_BYTES_MAX),
  problem: z.enum(MOD_PROBLEMS).optional(),
})
export type ModListed = z.infer<typeof modListedSchema>

export const modsListSchema = z.object({
  /** The mods folder on this computer, shown on the page. */
  folder: z.string(),
  mods: z.array(modListedSchema).max(MOD_LIMIT),
})
export type ModsList = z.infer<typeof modsListSchema>

export const modMakeRequestSchema = z.object({
  words: z.string().trim().min(1).max(MOD_WORDS_MAX),
})
export type ModMakeRequest = z.infer<typeof modMakeRequestSchema>
/** The thread Make a mod started, as the window addresses it, or why none started. */
export const modMakeResultSchema = z.union([z.object({ threadId: z.string() }), z.object({ error: z.string() })])
export type ModMakeResult = z.infer<typeof modMakeResultSchema>

export const modIdRequestSchema = z.object({ id: z.string().regex(MOD_ID_PATTERN) })
/** Remove's answer: whether the mod's folder went to the bin. */
export const modRemoveResultSchema = z.boolean()
/** Turn off every mod carries nothing. */
export const modsAllOffSchema = z.null()

export const MODS_LIST = 'sotto:mods:list'
export const MODS_MAKE = 'sotto:mods:make'
export const MODS_OPEN_FOLDER = 'sotto:mods:open-folder'
export const MODS_REVEAL = 'sotto:mods:reveal'
export const MODS_REMOVE = 'sotto:mods:remove'
/** Main sends the list again whenever a file in the mods folder changes. */
export const MODS_CHANGED = 'sotto:mods:changed'
/** Main asks the window to switch every mod off: the View menu's Turn off every mod. */
export const MODS_ALL_OFF = 'sotto:mods:all-off'
/** The main window's argument while the `mods` Owl feature is on: without it, preload builds no bridge. */
export const MODS_RENDERER_ARGUMENT = '--sotto-mods-enabled'

export interface ModsBridge {
  list(): Promise<ModsList>
  make(request: ModMakeRequest): Promise<ModMakeResult>
  openFolder(): Promise<void>
  reveal(id: string): Promise<void>
  /** Moves the mod's folder to the bin; false where it could not. */
  remove(id: string): Promise<boolean>
  onChanged(listener: (list: ModsList) => void): () => void
  onAllOff(listener: () => void): () => void
}

/**
 * CSS escapes decoded and comments dropped, so a check reads what the browser will: `\75 rl(` is `url(`.
 * Escapes inside strings decode too, which only makes the check stricter.
 */
function cssAsRead(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?(\*\/|$)/g, ' ')
    .replace(/\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?/g, (_, hex: string) => {
      const code = Number.parseInt(hex, 16)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '�'
    })
    .replace(/\\(.)/g, '$1')
}

/**
 * Whether a look loads anything from outside Sotto: an `@import`, an `image-set()`, a `src()`, or a `url()` that is
 * not a `data:` address or a `#fragment`. Such a look is refused whole rather than trimmed, so what paints is exactly
 * what was written. The window's content security policy refuses those loads too; this is the second fence.
 */
export function modLookReachesOutside(css: string): boolean {
  const read = cssAsRead(css)
  if (/@import\b/i.test(read) || /image-set\s*\(/i.test(read) || /(^|[^\w-])src\s*\(/i.test(read)) return true
  for (const match of read.matchAll(/url\s*\(\s*(['"]?)\s*([^'")\s]*)/gi)) {
    const address = (match[2] ?? '').trim().toLowerCase()
    if (!(address.startsWith('data:') || address.startsWith('#'))) return true
  }
  return false
}
