/**
 * Figtree as `@font-face` rules for a document that cannot see the window's fonts: a drawn diagram's image and an
 * interactive visual's sealed page. Each caller inlines the two font files as data URLs its own way (Vite's `?inline`
 * in both builds) and hands them here, so the faces and their ranges are written once.
 */

export const FIGTREE_FONT_STACK = '"Figtree", ui-sans-serif, system-ui, sans-serif'

const LATIN = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'
const LATIN_EXT = 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF'

const face = (dataUrl: string, range: string): string =>
  `@font-face{font-family:"Figtree";font-style:normal;font-weight:300 900;src:url(${dataUrl}) format("woff2");unicode-range:${range}}`

/** The latin and latin-ext faces, from the two files as data URLs. */
export function figtreeFontFaces(latinDataUrl: string, latinExtDataUrl: string): string {
  return face(latinDataUrl, LATIN) + face(latinExtDataUrl, LATIN_EXT)
}
