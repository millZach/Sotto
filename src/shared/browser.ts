import { z } from 'zod'
import type { BrowserInputRequest, BrowserWatchRequest, HostBrowserFrame } from './hostBrowser'
import { UNSAFE_URL_CHARACTERS } from './externalLinks'
import { fileWorkspaceSchema } from './files'
import { SECRET_REF_PATTERN } from './secretRequests'
import { toolTargetSchema, type ToolsResult } from './tools'

export const BROWSER_CHANNEL = 'sotto:browser:'
export const BROWSER_EVENT = `${BROWSER_CHANNEL}event`
/** Pictures of a paired host's pages this window watches (ADR-0198), apart from the browser's other events. */
export const BROWSER_FRAME_EVENT = `${BROWSER_CHANNEL}frame`
/** What a page an agent asked to open says until it is opened: by the user's answer, the browser grant, or the user loading it. */
export const BROWSER_WAITING_TO_OPEN = 'Waiting for you to open and share this page.'

export function safeBrowserUrl(input: string): string | null {
  if (UNSAFE_URL_CHARACTERS.test(input) || input.length > 8192) return null
  try {
    const url = new URL(input)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null
  } catch { return null }
}
/**
 * The test iPhone (ADR-0045): a page in Sotto's browser drawn at an iPhone 15 Pro's size, 393 by 852 CSS pixels,
 * with iOS Safari's user agent and touch. It is not iOS, and nothing on it runs native code.
 */
export const TEST_IPHONE = {
  name: 'iPhone 15 Pro', width: 393, height: 852,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
} as const
/** Which kind of page: absent or null is an ordinary browser page; `iphone` is the thread's test iPhone. */
export const browserDeviceSchema = z.literal('iphone')
export type BrowserDevice = z.infer<typeof browserDeviceSchema>
/**
 * Device presets for a page's size (ADR-0220): the sizes T3 Code's browser offers, in CSS pixels, upright. `mobile`
 * pages lay out as a phone or tablet does, honouring the page's own viewport tag. Landscape swaps width and height.
 */
export const BROWSER_DEVICE_PRESETS = [
  { id: 'iphone-se', name: 'iPhone SE', width: 375, height: 667, mobile: true },
  { id: 'iphone-xr', name: 'iPhone XR', width: 414, height: 896, mobile: true },
  { id: 'iphone-12-pro', name: 'iPhone 12 Pro', width: 390, height: 844, mobile: true },
  { id: 'iphone-14-pro-max', name: 'iPhone 14 Pro Max', width: 430, height: 932, mobile: true },
  { id: 'pixel-7', name: 'Pixel 7', width: 412, height: 915, mobile: true },
  { id: 'samsung-galaxy-s8-plus', name: 'Samsung Galaxy S8+', width: 360, height: 740, mobile: true },
  { id: 'samsung-galaxy-s20-ultra', name: 'Samsung Galaxy S20 Ultra', width: 412, height: 915, mobile: true },
  { id: 'samsung-galaxy-a51-71', name: 'Samsung Galaxy A51/71', width: 412, height: 914, mobile: true },
  { id: 'galaxy-z-fold-5', name: 'Galaxy Z Fold 5', width: 344, height: 882, mobile: true },
  { id: 'surface-duo', name: 'Surface Duo', width: 540, height: 720, mobile: true },
  { id: 'ipad-mini', name: 'iPad Mini', width: 768, height: 1024, mobile: true },
  { id: 'ipad-air', name: 'iPad Air', width: 820, height: 1180, mobile: true },
  { id: 'ipad-pro', name: 'iPad Pro', width: 1024, height: 1366, mobile: true },
  { id: 'surface-pro-7', name: 'Surface Pro 7', width: 912, height: 1368, mobile: true },
  { id: 'asus-zenbook-fold', name: 'Asus Zenbook Fold', width: 853, height: 1280, mobile: true },
  { id: 'nest-hub', name: 'Nest Hub', width: 1024, height: 600, mobile: true },
  { id: 'nest-hub-max', name: 'Nest Hub Max', width: 1280, height: 800, mobile: true },
] as const
export type BrowserDevicePreset = typeof BROWSER_DEVICE_PRESETS[number]
export const browserPresetSchema = z.enum(['iphone-se', 'iphone-xr', 'iphone-12-pro', 'iphone-14-pro-max', 'pixel-7', 'samsung-galaxy-s8-plus', 'samsung-galaxy-s20-ultra', 'samsung-galaxy-a51-71', 'galaxy-z-fold-5', 'surface-duo', 'ipad-mini', 'ipad-air', 'ipad-pro', 'surface-pro-7', 'asus-zenbook-fold', 'nest-hub', 'nest-hub-max'])
export const browserOrientationSchema = z.enum(['portrait', 'landscape'])
export type BrowserOrientation = z.infer<typeof browserOrientationSchema>
/** A preset's size in an orientation. */
export function presetSize(id: BrowserDevicePreset['id'], orientation: BrowserOrientation = 'portrait'): { width: number; height: number; mobile: boolean } {
  const preset = BROWSER_DEVICE_PRESETS.find(entry => entry.id === id)!
  return orientation === 'landscape' ? { width: preset.height, height: preset.width, mobile: preset.mobile } : { width: preset.width, height: preset.height, mobile: preset.mobile }
}
/** The size a page is drawn at when someone set one: freeform, or a preset in an orientation. */
export const browserPageViewportSchema = z.object({ width: z.number(), height: z.number(), preset: browserPresetSchema.optional(), orientation: browserOrientationSchema.optional() })
export type BrowserPageViewport = z.infer<typeof browserPageViewportSchema>
/** `prefers-color-scheme` as the page sees it; absent or null follows the computer. */
export const browserAppearanceSchema = z.enum(['light', 'dark', 'no-preference'])
export type BrowserAppearance = z.infer<typeof browserAppearanceSchema>
/** A JavaScript dialog the page has open, waiting for an answer from the user or, through `dialog`, the agent. */
export const browserDialogSchema = z.object({ type: z.enum(['alert', 'confirm', 'prompt', 'beforeunload']), message: z.string().max(2000), defaultPrompt: z.string().max(2000).optional() }).strict()
export type BrowserDialog = z.infer<typeof browserDialogSchema>
/** A **browser profile** (ADR-0221): sign-ins the user keeps between runs, in a session of its own on disk. */
export const BROWSER_PROFILE_NAME_MAX = 48
export const BROWSER_PROFILES_MAX = 24
// eslint-disable-next-line no-control-regex -- A name the user typed, shown in Sotto's own chrome.
const profileName = z.string().trim().min(1).max(BROWSER_PROFILE_NAME_MAX).refine(value => !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(value), 'Use a name without control characters.')
export const browserProfileSchema = z.object({ id: z.string().uuid(), name: profileName }).strict()
export type BrowserProfile = z.infer<typeof browserProfileSchema>
/** Another browser's profile on this computer whose sign-ins the user may copy into a new profile; its folder stays in main. */
export const browserImportSourceSchema = z.object({ id: z.string().regex(/^[0-9a-f]{16}$/u), browser: z.enum(['Firefox', 'Zen']), name: z.string().max(200) }).strict()
export type BrowserImportSource = z.infer<typeof browserImportSourceSchema>
export const browserProfilesSchema = z.object({ profiles: z.array(browserProfileSchema).max(BROWSER_PROFILES_MAX), sources: z.array(browserImportSourceSchema).max(40) }).strict()
export const browserAddProfileSchema = z.object({ name: profileName, importFrom: browserImportSourceSchema.shape.id.optional() }).strict()
export const browserAddProfileResultSchema = z.object({ profile: browserProfileSchema, imported: z.number().int().min(0), skipped: z.number().int().min(0) }).strict()
export const browserRemoveProfileSchema = z.object({ id: z.string().uuid() }).strict()
export const browserNoPayloadSchema = z.object({}).strict()
/**
 * Page zoom steps (ADR-0222): Chromium's own zoom, at the steps T3 Code's and Chrome's browsers take. It is the user's,
 * and Chromium keeps it per site within a session, as Chrome does.
 */
/**
 * Whether a waiting action asks every time, so only Allow once answers it and "Allow this thread" is not offered: an
 * upload (ADR-0220, decision 5), or an agent taking a page in a browser profile to another site (ADR-0221). A host
 * that does not say so still has its uploads asked about every time.
 */
export const asksEveryTime = (pending: { readonly action: { readonly type: string }; readonly everyTime?: true | undefined }): boolean => pending.everyTime === true || pending.action.type === 'upload'
export const BROWSER_ZOOM_LEVELS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5] as const
/** The zoom one step in or out from `current`, or 100% again. */
export function nextZoom(current: number, direction: 'in' | 'out' | 'reset'): number {
  if (direction === 'reset') return 1
  if (direction === 'in') return BROWSER_ZOOM_LEVELS.find(level => level > current + 0.001) ?? 5
  return [...BROWSER_ZOOM_LEVELS].reverse().find(level => level < current - 0.001) ?? 0.25
}
/**
 * A download a page started (ADR-0222). It waits, paused in Sotto's own data folder, until the user saves it to a
 * folder they choose or cancels it; `byAgent` when an agent's action started it. `folder` is where the user saved it.
 */
export const browserDownloadSchema = z.object({
  id: z.string().uuid(), threadId: z.string(), workspaceId: z.string(), pageId: z.string().uuid().nullable(),
  file: z.string().min(1).max(255), host: z.string().max(300),
  state: z.enum(['asking', 'saving', 'saved', 'cancelled', 'failed']),
  receivedBytes: z.number().int().min(0), totalBytes: z.number().int().min(0),
  byAgent: z.boolean(), folder: z.string().max(4096).nullable(),
  /** Open is offered: a program or script is only shown in its folder. */
  opens: z.boolean(), startedAt: z.number(),
}).strict()
export type BrowserDownload = z.infer<typeof browserDownloadSchema>
export const browserDownloadActionSchema = toolTargetSchema.extend({ downloadId: z.string().uuid(), action: z.enum(['save', 'save-as', 'cancel', 'open', 'show', 'dismiss']) })
/** The agent's cursor as the window draws it (ADR-0222): the theme's accent, and whether it glides or jumps. */
export const browserCursorStyleSchema = z.object({ color: z.object({ r: z.number().int().min(0).max(255), g: z.number().int().min(0).max(255), b: z.number().int().min(0).max(255) }).strict(), reducedMotion: z.boolean() }).strict()
export type BrowserCursorStyle = z.infer<typeof browserCursorStyleSchema>
/** What ADR-0220 adds to a page: its dialog, colour scheme, recording, and whether it opened behind the one shown. */
const browserPageParityShape = {
  /** The browser profile the user opened it in (ADR-0221); absent or null is the thread's own session, which keeps nothing. */
  profile: browserProfileSchema.nullable().optional(),
  dialog: browserDialogSchema.nullable().optional(),
  appearance: browserAppearanceSchema.nullable().optional(),
  recording: z.object({ startedAt: z.number() }).strict().nullable().optional(),
  /** Opened by an agent in the background: listed in Tools, never brought forward for it. */
  background: z.boolean().optional(),
  /** An agent opened it, so the agent may close it with `browser_close`. */
  agentOpened: z.boolean().optional(),
  /** The user is using this page now (ADR-0220): an agent's input waits until they stop. */
  userActive: z.boolean().optional(),
  /** The page's zoom (ADR-0222), 1 at 100%; absent on the test iPhone, whose zoom only fits it to the player. */
  zoom: z.number().min(0.2).max(5.1).optional(),
}
const browserUrlSchema = z.string().refine(value => safeBrowserUrl(value) !== null, 'Use a complete HTTP or HTTPS URL without credentials.').transform(value => safeBrowserUrl(value)!)
/** The pane's new page. Only the user names a profile (ADR-0221): no agent tool takes `profileId`. */
export const browserCreateSchema = toolTargetSchema.extend({ url: browserUrlSchema, device: browserDeviceSchema.optional(), profileId: z.string().uuid().optional() })
export const browserRequestSchema = toolTargetSchema.extend({ pageId: z.string().uuid() })
export const browserZoomSchema = browserRequestSchema.extend({ zoom: z.enum(['in', 'out', 'reset']) })
export const browserNavigateSchema = browserRequestSchema.extend({ url: browserUrlSchema })
export const browserBoundsSchema = z.object({ x: z.number().finite().min(0).max(32768), y: z.number().finite().min(0).max(32768), width: z.number().finite().positive().max(32768), height: z.number().finite().positive().max(32768) }).strict()
export const browserMountSchema = browserRequestSchema.extend({ bounds: browserBoundsSchema.nullable() })
export const browserOpenLinkSchema = z.object({ url: browserUrlSchema, destination: z.enum(['external', 'embedded']).optional(), target: toolTargetSchema.optional() }).strict()
export const browserPageSchema = z.object({ id: z.string().uuid(), workspace: fileWorkspaceSchema, url: browserUrlSchema, title: z.string().max(512), status: z.enum(['loading', 'ready', 'unavailable']), error: z.string().max(2000).nullable(), canGoBack: z.boolean(), canGoForward: z.boolean(), sharedOrigin: z.string().nullable().optional(), viewport: browserPageViewportSchema.nullable().optional(), device: browserDeviceSchema.nullable().optional(),
  ...browserPageParityShape }).strict()
/** What the renderer may know of a thread's browser grant (ADR-0029): that it is live, since when, and where it came from. */
export const browserGrantSchema = z.object({ grantedAt: z.number(), source: z.enum(['settings', 'user']) }).strict()
export const browserListingSchema = z.object({ workspace: fileWorkspaceSchema, pages: z.array(browserPageSchema).max(32), grant: browserGrantSchema.nullable().optional() }).strict()
export const browserOpenResultSchema = z.object({ destination: z.enum(['external', 'embedded']), page: browserPageSchema.optional() }).strict()
const coordinate = z.number().finite().min(0).max(8192)
/** The keys a `key` action can press: the ones a form and a list need, never a shortcut chord. */
export const BROWSER_KEYS = ['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'] as const
export const browserPointSchema = z.object({ x: coordinate, y: coordinate }).strict()
const viewportShape = { width: z.number().int().min(240).max(2560), height: z.number().int().min(240).max(2560) }
export const browserViewportSchema = browserRequestSchema.extend(viewportShape).or(browserRequestSchema.extend({ reset: z.literal(true) }))
export const browserShareSchema = browserRequestSchema.extend({ enabled: z.boolean() })
export const browserCaptureSchema = browserRequestSchema.extend({ point: browserPointSchema.optional(), region: browserBoundsSchema.optional(), captureId: z.string().uuid().optional() })
export const browserCaptureResultSchema = z.object({ captureId: z.string().uuid().optional(), image: z.string().max(16_000_000), url: browserUrlSchema, width: z.number(), height: z.number(), element: z.object({ tag: z.string(), role: z.string(), name: z.string(), text: z.string(), selector: z.string() }).nullable() }).strict()
/**
 * Point at something (ADR-0154): the user turns Chromium's own inspect overlay on or off for the page Tools shows.
 * `color` is the theme's accent, which turning it on needs, so the tint is the room's colour rather than DevTools' blue.
 */
export const browserPointModeSchema = browserRequestSchema.extend({ on: z.boolean(), color: z.object({ r: z.number().int().min(0).max(255), g: z.number().int().min(0).max(255), b: z.number().int().min(0).max(255) }).strict().optional() })
/** Where the element sits in the picture, in its pixels. Part of it may lie outside the picture. */
const pointBoxSchema = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite().min(0), height: z.number().finite().min(0) }).strict()
/**
 * What point mode tells the window: the element under the pointer by its tag and accessible name, the element the
 * user clicked or picked with Enter, with a picture of the page at that moment, or that point mode ended and why.
 */
export const browserPointStateSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('hover'), tag: z.string().max(100), name: z.string().max(500) }).strict(),
  z.object({ state: z.literal('picked'), capture: browserCaptureResultSchema, box: pointBoxSchema.nullable() }).strict(),
  z.object({ state: z.literal('ended'), reason: z.enum(['navigated', 'hidden', 'escape', 'unavailable']) }).strict(),
])
/** The actions the stable catalog offers, and the only ones Antigravity's compact catalog lists (ADR-0220). */
export const browserStableActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('inspect') }).strict(), z.object({ type: z.literal('screenshot') }).strict(),
  z.object({ type: z.literal('navigate'), url: browserUrlSchema }).strict(),
  z.object({ type: z.literal('click'), x: coordinate, y: coordinate }).strict(),
  // A secret request's one-use reference (ADR-0219) is typed in its place: the value is looked up as it is typed, never sent or shown.
  z.object({ type: z.literal('type'), text: z.string().max(4000).optional(), secretRef: z.string().regex(SECRET_REF_PATTERN).optional() }).strict()
    .refine(action => (action.text === undefined) !== (action.secretRef === undefined), 'Pass text or secretRef, not both.'),
  z.object({ type: z.literal('scroll'), x: coordinate, y: coordinate, deltaX: z.number().finite().min(-4096).max(4096), deltaY: z.number().finite().min(-4096).max(4096) }).strict(),
  z.object({ type: z.literal('viewport'), ...viewportShape }).strict(),
  z.object({ type: z.literal('tap'), x: coordinate, y: coordinate }).strict(),
  z.object({ type: z.literal('swipe'), x: coordinate, y: coordinate, toX: coordinate, toY: coordinate }).strict(),
  z.object({ type: z.literal('key'), key: z.enum(BROWSER_KEYS) }).strict(),
])

/**
 * The keys a parity `key` action names besides one printable character (ADR-0220): editing, moving and function keys,
 * with the Windows virtual key code Chromium wants. A printable character is its own key.
 */
export const BROWSER_NAMED_KEYS: Readonly<Record<string, number>> = {
  Enter: 13, Backspace: 8, Tab: 9, Escape: 27, Delete: 46, Insert: 45, Home: 36, End: 35, PageUp: 33, PageDown: 34,
  ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Space: 32, ContextMenu: 93,
  F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117, F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
}
export const BROWSER_MODIFIERS = ['Alt', 'Control', 'Meta', 'Shift'] as const
/** A key a parity `key` action may press: a named key, or one printable character. */
export function isBrowserKey(key: string): boolean { return Object.hasOwn(BROWSER_NAMED_KEYS, key) || /^[\x21-\x7e]$/u.test(key) }
const elementRef = z.string().regex(/^e[0-9]{1,6}$/u).describe('An element ref from your latest snapshot, such as e12.')
const elementSelector = z.string().min(1).max(1000).describe('A CSS selector; the first match is used.')
const optionalCoordinate = coordinate.optional()
const modifierList = z.array(z.enum(BROWSER_MODIFIERS)).max(4).optional()
/** Where an action reaches: a point in page CSS pixels, a snapshot ref, or a CSS selector, exactly one. */
const targetShape = { x: optionalCoordinate, y: optionalCoordinate, ref: elementRef.optional(), selector: elementSelector.optional() }
export interface BrowserTargetFields { x?: number | undefined; y?: number | undefined; ref?: string | undefined; selector?: string | undefined }
/** How many ways `value` names its target; a point counts once. */
export function targetWays(value: BrowserTargetFields): number {
  return Number(value.x !== undefined || value.y !== undefined) + Number(value.ref !== undefined) + Number(value.selector !== undefined)
}
const oneTarget = (value: BrowserTargetFields): boolean => targetWays(value) === 1 && (value.x === undefined) === (value.y === undefined)
const atMostOneTarget = (value: BrowserTargetFields): boolean => targetWays(value) <= 1 && (value.x === undefined) === (value.y === undefined)
const ONE_TARGET = 'Name one target: x and y, a ref, or a selector.'
export const browserTargetSchema = z.object(targetShape).strict().refine(oneTarget, ONE_TARGET)
const viewportMode = (action: { width?: number | undefined; height?: number | undefined; preset?: string | undefined; orientation?: string | undefined; fill?: true | undefined }): boolean =>
  Number(action.width !== undefined && action.height !== undefined) + Number(action.preset !== undefined) + Number(action.fill === true) === 1
  && (action.width === undefined) === (action.height === undefined) && (action.orientation === undefined || action.preset !== undefined)
/**
 * Every action of the full catalog (ADR-0220): the stable ones with targets by ref or selector, any key with modifiers,
 * presets and the pane's own size; and the actions T3 Code's browser has that Sotto's had not.
 */
export const browserActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('inspect') }).strict(),
  z.object({ type: z.literal('snapshot'), includeImage: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('screenshot'), save: z.boolean().optional(), fullPage: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('navigate'), url: browserUrlSchema, waitUntil: z.enum(['load', 'domContentLoaded', 'none']).optional(), timeoutMs: z.number().int().min(500).max(60_000).optional() }).strict(),
  z.object({ type: z.literal('click'), ...targetShape, button: z.enum(['left', 'right', 'middle']).optional(), clickCount: z.number().int().min(1).max(3).optional(), modifiers: modifierList }).strict().refine(oneTarget, ONE_TARGET),
  // A secret request's one-use reference (ADR-0219) is typed in its place: the value is looked up as it is typed, never sent or shown.
  z.object({ type: z.literal('type'), text: z.string().max(4000).optional(), secretRef: z.string().regex(SECRET_REF_PATTERN).optional(), ref: elementRef.optional(), selector: elementSelector.optional(), clear: z.boolean().optional() }).strict()
    .refine(action => (action.text === undefined) !== (action.secretRef === undefined), 'Pass text or secretRef, not both.').refine(action => !(action.ref && action.selector), 'Name the field by ref or by selector, not both.'),
  z.object({ type: z.literal('scroll'), ...targetShape, deltaX: z.number().finite().min(-4096).max(4096), deltaY: z.number().finite().min(-4096).max(4096) }).strict().refine(atMostOneTarget, 'Name at most one place to scroll: x and y, a ref, or a selector.'),
  z.object({ type: z.literal('viewport'), width: viewportShape.width.optional(), height: viewportShape.height.optional(), preset: browserPresetSchema.optional(), orientation: browserOrientationSchema.optional(), fill: z.literal(true).optional() }).strict()
    .refine(viewportMode, 'Pass width and height, a preset (with an orientation if you like), or fill: true.'),
  z.object({ type: z.literal('tap'), x: coordinate, y: coordinate }).strict(),
  z.object({ type: z.literal('swipe'), x: coordinate, y: coordinate, toX: coordinate, toY: coordinate }).strict(),
  z.object({ type: z.literal('key'), key: z.string().min(1).max(16).refine(isBrowserKey, 'Use a key name such as Enter, Delete, PageDown or F5, or one printable character.'), modifiers: modifierList }).strict(),
  z.object({ type: z.literal('hover'), ...targetShape }).strict().refine(oneTarget, ONE_TARGET),
  z.object({ type: z.literal('select'), ...targetShape, values: z.array(z.string().max(500)).min(1).max(50) }).strict().refine(oneTarget, ONE_TARGET),
  z.object({ type: z.literal('drag'), from: browserTargetSchema, to: browserTargetSchema }).strict(),
  z.object({ type: z.literal('upload'), ...targetShape, paths: z.array(z.string().min(1).max(4096)).max(10) }).strict().refine(atMostOneTarget, 'Name the file input by one target, or none to answer the file chooser that is open.'),
  z.object({ type: z.literal('wait_for'), ref: elementRef.optional(), selector: elementSelector.optional(), text: z.string().min(1).max(500).optional(), urlIncludes: z.string().min(1).max(2000).optional(), state: z.enum(['visible', 'hidden']).optional(), timeoutMs: z.number().int().min(100).max(30_000).optional() }).strict()
    .refine(action => [action.ref, action.selector, action.text, action.urlIncludes].filter(value => value !== undefined).length === 1, 'Wait for one thing: a ref, a selector, text or urlIncludes.'),
  z.object({ type: z.literal('evaluate'), expression: z.string().min(1).max(20_000), awaitPromise: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('dialog'), accept: z.boolean(), promptText: z.string().max(4000).optional() }).strict(),
  z.object({ type: z.literal('appearance'), colorScheme: z.enum(['light', 'dark', 'no-preference', 'auto']) }).strict(),
  z.object({ type: z.literal('record_start') }).strict(),
  z.object({ type: z.literal('record_stop') }).strict(),
])
/** The actions only the full catalog has; a build without it refuses them in words (ADR-0220). */
export const PARITY_ONLY_ACTIONS: ReadonlySet<string> = new Set(['snapshot', 'hover', 'select', 'drag', 'upload', 'wait_for', 'evaluate', 'dialog', 'appearance', 'record_start', 'record_stop'])
export const browserTaskRequestSchema = browserRequestSchema.extend({ taskId: z.string().uuid() })
export const browserDialogAnswerSchema = browserRequestSchema.extend({ accept: z.boolean(), promptText: z.string().max(4000).optional() })
/** The pane's colour scheme and preset menus: `appearance` null follows the computer; a preset with its orientation. */
export const browserEmulateSchema = browserRequestSchema.extend({ appearance: browserAppearanceSchema.nullable().optional(), preset: browserPresetSchema.optional(), orientation: browserOrientationSchema.optional() })
/** A server on this computer's loopback that answered with a web page (ADR-0220). */
export const localServerSchema = z.object({ port: z.number().int(), url: z.string(), title: z.string().max(300), process: z.string().max(200) }).strict()
export type LocalServer = z.infer<typeof localServerSchema>
export const browserStartTaskSchema = browserRequestSchema.extend({ description: z.string().min(1).max(300) })
/** `browser_open` and `iphone_open` take the same input; which tool was called decides the kind of page. */
/**
 * What an agent opens: a web address, or an HTML file in its thread's folder, which Sotto serves on this computer's loopback
 * (ADR-0085, October 27, 2026 amendment). The browser service tells them apart and says in words what it will not open.
 */
export const browserAgentOpenSchema = toolTargetSchema.extend({
  url: z.string().min(1).max(8192).describe('The page to open: an http or https address, or an HTML file in this thread\'s folder as a file:// URL, an absolute path or a path relative to the folder. A query string and #fragment are kept.'),
  description: z.string().min(1).max(300),
})
/**
 * The full catalog's `browser_open` (ADR-0220): an address, or a server on this computer by its port, and a page opened
 * behind the one the user is looking at.
 */
const parityOpenShape = {
  url: z.string().min(1).max(8192).optional().describe('The page to open: an http or https address, or an HTML file in this thread\'s folder as a file:// URL, an absolute path or a path relative to the folder. A query string and #fragment are kept. Pass url or port.'),
  port: z.number().int().min(1).max(65535).optional().describe('A server on this computer\'s loopback instead of url: opens http://localhost:<port><path>.'),
  protocol: z.enum(['http', 'https']).optional(),
  path: z.string().max(4000).regex(/^\//u, 'Start the path with /.').optional(),
  background: z.boolean().optional().describe('Open it without bringing it forward in Tools.'),
  description: z.string().min(1).max(300),
}
type ParityOpenFields = { url?: string | undefined; port?: number | undefined; protocol?: string | undefined; path?: string | undefined }
const urlOrPort = (request: ParityOpenFields): boolean => (request.url === undefined) !== (request.port === undefined)
const portParts = (request: ParityOpenFields): boolean => request.port !== undefined || (request.protocol === undefined && request.path === undefined)
export const browserParityOpenSchema = toolTargetSchema.extend(parityOpenShape).refine(urlOrPort, 'Pass url or port.').refine(portParts, 'protocol and path go with port.')
/** The same, as an agent passes it: the thread comes from the transport. */
export const browserParityOpenInputSchema = z.object(parityOpenShape).strict().refine(urlOrPort, 'Pass url or port.').refine(portParts, 'protocol and path go with port.')
/** `browser_close`: a page the agent opened, by its ID (ADR-0220). */
export const browserAgentCloseSchema = browserRequestSchema
/** The address a full-catalog open names: its url, or its loopback port. */
export function parityOpenUrl(request: { url?: string | undefined; port?: number | undefined; protocol?: 'http' | 'https' | undefined; path?: string | undefined }): string {
  return request.url ?? `${request.protocol ?? 'http'}://localhost:${request.port}${request.path ?? '/'}`
}
export const browserStableAgentActionSchema = browserTaskRequestSchema.extend({ action: browserStableActionSchema })
export const browserAgentActionSchema = browserTaskRequestSchema.extend({ action: browserActionSchema })
export const browserControlTaskSchema = browserTaskRequestSchema.extend({ control: z.enum(['pause', 'resume']) })
/** `forThread` answers with a browser grant (ADR-0029) for the rest of the session, not just this once. */
export const browserAnswerActionSchema = browserTaskRequestSchema.extend({ actionId: z.string().uuid(), allow: z.boolean(), forThread: z.literal(true).optional() })
export const browserFinishTaskSchema = browserTaskRequestSchema.extend({ status: z.enum(['completed', 'failed']), summary: z.string().max(2000), unchecked: z.array(z.string().max(500)).max(20) })
export const browserTaskSchema = z.object({
  id: z.string().uuid(), threadId: z.string(), workspaceId: z.string(), pageId: z.string().uuid(),
  status: z.enum(['working', 'paused', 'completed', 'failed']), description: z.string().max(300), updatedAt: z.number(),
  steps: z.array(z.object({ id: z.string(), action: z.string(), status: z.enum(['completed', 'failed']), at: z.number(), detail: z.string().max(2000), url: z.string().optional(), viewport: z.object({ width: z.number(), height: z.number() }).nullable().optional() })).max(40),
  thumbnail: z.string().nullable(), summary: z.string().nullable(), unchecked: z.array(z.string()),
  // `everyTime`: the action asks every time, whatever grant the thread holds, so only Allow once answers it (ADR-0220, ADR-0221).
  pendingAction: z.object({ id: z.string().uuid(), action: browserActionSchema, description: z.string(), expiresAt: z.number(), everyTime: z.literal(true).optional() }).nullable(),
  output: z.string().max(200_000).nullable(),
  /** The task's page kind, so a task on the test iPhone floats in the phone player before its page is listed. */
  device: browserDeviceSchema.nullable().optional(),
  /** A page the agent opened in the background (ADR-0220): it never takes the pane or floats the player on its own. */
  background: z.boolean().optional(),
  evidence: z.array(z.object({ id: z.string(), at: z.number(), url: z.string(), viewport: z.object({ width: z.number(), height: z.number() }).nullable(), image: z.string().max(2_000_000), width: z.number(), height: z.number() })).max(3).optional(),
}).strict()
export const browserAgentResultSchema = z.object({ task: browserTaskSchema, output: z.string().max(200_000).optional(), image: z.string().max(16_000_000).optional(), approvalRequired: z.boolean() }).strict()
export const browserEventSchema = z.discriminatedUnion('type', [z.object({ type: z.literal('page'), page: browserPageSchema }).strict(), z.object({ type: z.literal('closed'), threadId: z.string(), workspaceId: z.string(), pageId: z.string().uuid() }).strict(), z.object({ type: z.literal('task'), task: browserTaskSchema }).strict(), z.object({ type: z.literal('browser-grant'), threadId: z.string(), grant: browserGrantSchema.nullable() }).strict(), z.object({ type: z.literal('point'), threadId: z.string(), workspaceId: z.string(), pageId: z.string().uuid(), point: browserPointStateSchema }).strict(), z.object({ type: z.literal('download'), download: browserDownloadSchema, gone: z.literal(true).optional() }).strict()])
export type BrowserTask = z.infer<typeof browserTaskSchema>
export type BrowserAction = z.infer<typeof browserActionSchema>
export type BrowserAgentResult = z.infer<typeof browserAgentResultSchema>
export type BrowserCapture = z.infer<typeof browserCaptureResultSchema>
export type BrowserPage = z.infer<typeof browserPageSchema>
export type BrowserEvent = z.infer<typeof browserEventSchema>
export type BrowserBounds = z.infer<typeof browserBoundsSchema>
export type BrowserPointState = z.infer<typeof browserPointStateSchema>
export type BrowserPointPick = Extract<BrowserPointState, { state: 'picked' }>
export type BrowserGrantView = z.infer<typeof browserGrantSchema>
export interface BrowserBridge {
  tasks(request: { threadId: string }): Promise<ToolsResult<BrowserTask[]>>
  share(request: z.infer<typeof browserShareSchema>): Promise<ToolsResult<BrowserPage>>
  controlTask(request: z.infer<typeof browserControlTaskSchema>): Promise<ToolsResult<BrowserTask>>
  answerAction(request: z.infer<typeof browserAnswerActionSchema>): Promise<ToolsResult<BrowserTask>>
  /** The user answers the page's own dialog (ADR-0220): OK or Cancel, with a prompt's text. */
  answerDialog?(request: z.infer<typeof browserDialogAnswerSchema>): Promise<ToolsResult<BrowserPage>>
  /** The user sets the page's colour scheme, or a preset size (ADR-0220). */
  emulate?(request: z.infer<typeof browserEmulateSchema>): Promise<ToolsResult<BrowserPage>>
  /** The user stops a recording an agent started (ADR-0220); the file stays where the agent was told. */
  stopRecording?(request: z.infer<typeof browserRequestSchema>): Promise<ToolsResult<BrowserPage>>
  /** Loopback servers started from Sotto, for the pane's empty state (ADR-0220). */
  localServers?(request: z.infer<typeof toolTargetSchema>): Promise<ToolsResult<LocalServer[]>>
  /** The user opens Chromium's developer tools for a page on this computer, in a window of their own (ADR-0220). */
  devtools?(request: z.infer<typeof browserRequestSchema>): Promise<ToolsResult<void>>
  /** The user's browser profiles, and the other browsers' profiles on this computer they may copy sign-ins from (ADR-0221). */
  profiles?(): Promise<ToolsResult<z.infer<typeof browserProfilesSchema>>>
  /** The user adds a profile, copying another browser's sign-ins into it once when they choose one (ADR-0221). */
  addProfile?(request: z.infer<typeof browserAddProfileSchema>): Promise<ToolsResult<z.infer<typeof browserAddProfileResultSchema>>>
  /** The user removes a profile: its pages close and its sign-ins and site data are deleted (ADR-0221). */
  removeProfile?(request: z.infer<typeof browserRemoveProfileSchema>): Promise<ToolsResult<z.infer<typeof browserProfilesSchema>>>
  /** The user zooms a page on this computer in, out or back to 100% (ADR-0222). */
  zoom?(request: z.infer<typeof browserZoomSchema>): Promise<ToolsResult<BrowserPage>>
  /** This thread's downloads this run (ADR-0222). */
  downloads?(request: z.infer<typeof toolTargetSchema>): Promise<ToolsResult<BrowserDownload[]>>
  /** The user's answer to a download: save it, choose where, cancel it, open it, show it in its folder, or take it off the list. */
  download?(request: z.infer<typeof browserDownloadActionSchema>): Promise<ToolsResult<BrowserDownload | null>>
  /** How the agent's cursor is drawn: the theme's accent, and reduced motion (ADR-0222). */
  cursorStyle?(request: BrowserCursorStyle): Promise<ToolsResult<void>>
  /** The user's Stop: ends the thread's browser grant, so it asks again (ADR-0029). */
  stopGrant(request: z.infer<typeof toolTargetSchema>): Promise<ToolsResult<void>>
  viewport(request: z.infer<typeof browserViewportSchema>): Promise<ToolsResult<BrowserPage>>
  capture(request: z.infer<typeof browserCaptureSchema>): Promise<ToolsResult<BrowserCapture>>
  /** Point at something: whether the overlay is on now. Off, or a page nobody shows, answers false. */
  point(request: z.infer<typeof browserPointModeSchema>): Promise<ToolsResult<{ pointing: boolean }>>
  list(request: { threadId: string }): Promise<ToolsResult<z.infer<typeof browserListingSchema>>>
  create(request: z.infer<typeof browserCreateSchema>): Promise<ToolsResult<BrowserPage>>
  navigate(request: z.infer<typeof browserNavigateSchema>): Promise<ToolsResult<BrowserPage>>
  back(request: z.infer<typeof browserRequestSchema>): Promise<ToolsResult<BrowserPage>>
  forward(request: z.infer<typeof browserRequestSchema>): Promise<ToolsResult<BrowserPage>>
  reload(request: z.infer<typeof browserRequestSchema>): Promise<ToolsResult<BrowserPage>>
  close(request: z.infer<typeof browserRequestSchema>): Promise<ToolsResult<void>>
  mount(request: z.infer<typeof browserMountSchema>): Promise<ToolsResult<void>>
  openLink(request: z.infer<typeof browserOpenLinkSchema>): Promise<ToolsResult<z.infer<typeof browserOpenResultSchema>>>
  onEvent(listener: (event: BrowserEvent) => void): () => void
  /** A paired host's page (ADR-0198): the user's own input in the pane, sent on to the page. */
  input(request: BrowserInputRequest): Promise<ToolsResult<void>>
  /** A paired host's page: pictures of it at the pane's size until `unwatch`, heard through `onFrame`. */
  watch(request: BrowserWatchRequest): Promise<ToolsResult<void>>
  unwatch(request: z.infer<typeof browserRequestSchema>): Promise<ToolsResult<void>>
  onFrame(listener: (frame: HostBrowserFrame) => void): () => void
  /** A paired host's thread: whether that host has a browser for its pages. */
  available(request: { threadId: string }): Promise<ToolsResult<{ available: boolean }>>
}
