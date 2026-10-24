import { z } from 'zod'
import { hostSignInSchema } from './hostProviders'

/**
 * Signing Cursor in and out on this computer from its provider tile (ADR-0127, variant A of the prototype). Main runs
 * Cursor's own `agent login`, opens the cursor.com page it prints in the browser, and connects Cursor once the client
 * says it signed in; the window sees where the sign-in stands and never the page's address. The bridge exists only
 * while Cursor's Owl feature is on.
 */
export const CURSOR_RENDERER_ARGUMENT = '--sotto-cursor-enabled'
export const CURSOR_SIGN_IN_START = 'sotto:cursor:sign-in-start'
export const CURSOR_SIGN_IN_READ = 'sotto:cursor:sign-in-read'
export const CURSOR_SIGN_IN_REOPEN = 'sotto:cursor:sign-in-reopen'
export const CURSOR_SIGN_IN_CANCEL = 'sotto:cursor:sign-in-cancel'
export const CURSOR_SIGN_OUT = 'sotto:cursor:sign-out'

/** Where a sign-in stands, as the window sees it: the host sign-in's own view, shape `page`, without the page's address. */
export const cursorSignInViewSchema = hostSignInSchema.omit({ url: true })
export type CursorSignInView = z.infer<typeof cursorSignInViewSchema>
/** A start: the sign-in under way, or Sotto's sentence for why none could start. */
export const cursorSignInStartSchema = z.object({ view: cursorSignInViewSchema.optional(), message: z.string().min(1).max(600).optional() }).strict()
export type CursorSignInStart = z.infer<typeof cursorSignInStartSchema>
export const cursorSignInRequestSchema = z.object({ id: z.uuid() }).strict()
export type CursorSignInRequest = z.infer<typeof cursorSignInRequestSchema>
/** What a press did: done, or Sotto's sentence for what happened instead. */
export const cursorSignInDoneSchema = z.object({ ok: z.boolean(), message: z.string().min(1).max(600).optional() }).strict()
export type CursorSignInDone = z.infer<typeof cursorSignInDoneSchema>

/** The words the tile and main share. */
export const CURSOR_SIGN_IN_WORDS = {
  waiting: 'Finish signing in on cursor.com in your browser.',
  notRunning: 'Cursor’s sign-in is not available right now. Nothing was changed.',
  pageRefused: 'Cursor asked to sign in on a page Sotto does not open. Nothing was signed in. Run agent login in a terminal instead.',
  signedOut: 'Cursor is signed out on this computer.',
  signOutFailed: 'Cursor could not sign out. Nothing was changed. Run agent logout in a terminal to try again.',
} as const

export interface CursorSignInBridge {
  /** Runs `agent login`, opens its cursor.com page, and answers once the page is open or the sign-in ended. */
  start(): Promise<CursorSignInStart>
  read(request: CursorSignInRequest): Promise<CursorSignInView | null>
  /** Open the page again in the browser. */
  reopen(request: CursorSignInRequest): Promise<CursorSignInDone>
  cancel(request: CursorSignInRequest): Promise<CursorSignInDone>
  /** Runs `agent logout`. Cursor's own sign-in, which every Cursor on this computer shares, is what it ends. */
  signOut(): Promise<CursorSignInDone>
}
