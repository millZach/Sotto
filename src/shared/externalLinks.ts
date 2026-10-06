import { z } from 'zod'

/** Reject URL parser stripping, separator aliases and display spoofing. */
// eslint-disable-next-line no-control-regex -- Untrusted URLs must reject control bytes.
export const UNSAFE_URL_CHARACTERS = /[\\\x00-\x20\x7f\u202a-\u202e\u2066-\u2069]/u

/** Message links may open a browser or mail composer, never an OS command/file handler. */
export const externalLinkSchema = z.string().min(1).max(4096).refine(value => {
  if (UNSAFE_URL_CHARACTERS.test(value)) return false
  try {
    const url = new URL(value)
    if (url.username || url.password) return false
    if (url.protocol === 'http:' || url.protocol === 'https:') return /^https?:\/\//iu.test(value) && Boolean(url.hostname)
    return url.protocol === 'mailto:' && Boolean(url.pathname) && !url.pathname.startsWith('//')
  } catch { return false }
})
