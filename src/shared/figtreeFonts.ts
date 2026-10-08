import figtreeLatin from './fonts/figtree-latin.woff2?inline'
import figtreeLatinExt from './fonts/figtree-latin-ext.woff2?inline'
import { figtreeFontFaces } from './figtreeFaces'

/**
 * Figtree's two faces as `@font-face` rules with the font files inlined as data URLs, for a document that cannot see
 * the window's fonts: a drawn diagram's image in the renderer and an interactive visual's sealed page in main.
 */
export const FIGTREE_FONT_FACES = figtreeFontFaces(figtreeLatin, figtreeLatinExt)
