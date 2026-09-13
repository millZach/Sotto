import { z } from 'zod'

/** Message links may open a browser or mail composer, never an OS command/file handler. */
export const externalLinkSchema = z.string().min(1).max(4096).refine(value => {
  if (Array.from(value).some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127 || character === '\\')) return false
  try {
    const url = new URL(value)
    if (url.username || url.password) return false
    if (url.protocol === 'http:' || url.protocol === 'https:') return /^https?:\/\//iu.test(value) && Boolean(url.hostname)
    return url.protocol === 'mailto:' && Boolean(url.pathname) && !url.pathname.startsWith('//')
  } catch { return false }
})
