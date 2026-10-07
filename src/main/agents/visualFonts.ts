import figtreeLatin from '../../renderer/src/assets/fonts/figtree-latin.woff2?inline'
import figtreeLatinExt from '../../renderer/src/assets/fonts/figtree-latin-ext.woff2?inline'
import { figtreeFontFaces } from '../../shared/figtreeFaces'

/** Figtree for an interactive visual's sealed page, as data URLs, so showing it fetches nothing (ADR-0060). */
export const VISUAL_PAGE_FONT_CSS = figtreeFontFaces(figtreeLatin, figtreeLatinExt)
