import { z } from 'zod'

/**
 * Antigravity's own account actions from its row in Settings › Providers (ADR-0211). A Google account signs in through
 * the provider sign-in dialog's paste-code shape, as Claude Code does, and a key or a Google Cloud project is a setting;
 * these two are what is left: Gemini Enterprise's sign-in, which `agy` finishes in a browser on this computer, and Sign
 * out. The window learns only how each went.
 */
export const ANTIGRAVITY_ENTERPRISE_SIGN_IN = 'sotto:antigravity:enterprise-sign-in'
export const ANTIGRAVITY_SIGN_OUT = 'sotto:antigravity:sign-out'

/** What a press did: done, or Sotto's sentence for what happened instead. */
export const antigravityAccountDoneSchema = z.object({ ok: z.boolean(), message: z.string().min(1).max(600).optional() }).strict()
export type AntigravityAccountDone = z.infer<typeof antigravityAccountDoneSchema>

export const ANTIGRAVITY_ACCOUNT_WORDS = {
  notRunning: 'Antigravity’s sign-in is not available right now. Nothing was changed.',
  enterpriseFailed: 'Gemini Enterprise did not finish signing in. Nothing was signed in. Try Sign in again.',
  signOutFailed: 'Antigravity could not sign out. Your threads are kept. Try Sign out again.',
} as const

export interface AntigravityAccountBridge {
  /** Runs `agy`'s Gemini Enterprise sign-in, which opens its page in the browser, and connects Antigravity once it is done. */
  enterpriseSignIn(): Promise<AntigravityAccountDone>
  /** Stops Antigravity's threads' processes and signs `agy` out of Sotto's own folder. Threads are kept. */
  signOut(): Promise<AntigravityAccountDone>
}
