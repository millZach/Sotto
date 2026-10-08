import { visualThemeCss, type VisualTheme } from '../../shared/visualGuest'

/**
 * What an interactive visual's page is served as (ADR-0060): its headers, and the document Sotto wraps the agent's
 * page in. Nothing here decides who gets a page; `visualPageStore.ts` does.
 */

/** The page's own policy. No report-uri: a violation report would itself be a request. */
export const VISUAL_PAGE_CSP = [
  "default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'", 'img-src data: blob:', 'font-src data:',
  "connect-src 'none'", "frame-src 'none'", "child-src 'none'", "worker-src 'none'", "object-src 'none'", "manifest-src 'none'",
  "media-src 'none'", "form-action 'none'", "base-uri 'none'",
  // An opaque origin with scripts and nothing else: no popups, forms, modals, downloads, storage or top navigation.
  'sandbox allow-scripts',
].join('; ')

const OFF_FEATURES = ['accelerometer', 'ambient-light-sensor', 'autoplay', 'bluetooth', 'camera', 'clipboard-read', 'clipboard-write',
  'display-capture', 'encrypted-media', 'fullscreen', 'gamepad', 'geolocation', 'gyroscope', 'hid', 'idle-detection', 'local-fonts',
  'magnetometer', 'microphone', 'midi', 'payment', 'picture-in-picture', 'publickey-credentials-get', 'screen-wake-lock', 'serial',
  'usb', 'web-share', 'window-management', 'xr-spatial-tracking']

export const VISUAL_PAGE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': VISUAL_PAGE_CSP,
  'X-DNS-Prefetch-Control': 'off',
  'Permissions-Policy': OFF_FEATURES.map(feature => `${feature}=()`).join(', '),
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
})

/** The document a page is served as: Sotto's charset, colour scheme, fonts and theme first, then the agent's page. */
export function visualPageDocument(source: string, theme: VisualTheme, fontCss: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="${theme.mode}">`
    + `<style id="sotto-visual-fonts">${fontCss}</style><style id="sotto-visual-theme">${visualThemeCss(theme)}</style>\n${source}`
}

/** The page, served with its headers. */
export function visualPageResponse(source: string, theme: VisualTheme, fontCss: string): Response {
  return new Response(visualPageDocument(source, theme, fontCss), { status: 200, headers: { ...VISUAL_PAGE_HEADERS } })
}

/** What any other address gets: nothing, under the same headers. */
export function visualPageNotFound(): Response {
  return new Response('Not found', { status: 404, headers: { ...VISUAL_PAGE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' } })
}
