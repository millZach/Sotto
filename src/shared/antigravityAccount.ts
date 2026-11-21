import { z } from 'zod'

/**
 * Antigravity's own account actions from its row in Settings › Providers (ADR-0211). A Google account signs in through
 * the provider sign-in's paste-code shape, as Claude Code does, and a key or a Google Cloud project is a setting; these
 * are the rest: Gemini Enterprise's sign-in, which `agy` finishes in a browser on this computer, Sign out, and Sotto's own
 * download of `agy` (Install, its progress, Cancel and Remove downloaded). The window learns only how each went.
 */
export const ANTIGRAVITY_ENTERPRISE_SIGN_IN = 'sotto:antigravity:enterprise-sign-in'
export const ANTIGRAVITY_SIGN_OUT = 'sotto:antigravity:sign-out'
export const ANTIGRAVITY_INSTALL = 'sotto:antigravity:install'
export const ANTIGRAVITY_INSTALL_PROGRESS = 'sotto:antigravity:install-progress'
export const ANTIGRAVITY_CANCEL_INSTALL = 'sotto:antigravity:cancel-install'
export const ANTIGRAVITY_REMOVE_DOWNLOADED = 'sotto:antigravity:remove-downloaded'

/** What a press did: done, or Sotto's sentence for what happened instead. */
export const antigravityAccountDoneSchema = z.object({ ok: z.boolean(), message: z.string().min(1).max(600).optional() }).strict()
export type AntigravityAccountDone = z.infer<typeof antigravityAccountDoneSchema>
/** How far Install has got, in plain words, while it runs. */
export const antigravityInstallProgressSchema = z.object({ installing: z.boolean(), text: z.string().min(1).max(600).optional() }).strict()
export type AntigravityInstallProgress = z.infer<typeof antigravityInstallProgressSchema>

export const ANTIGRAVITY_ACCOUNT_WORDS = {
  notRunning: 'Antigravity’s sign-in is not available right now. Nothing was changed.',
  enterpriseFailed: 'Gemini Enterprise did not finish signing in. Nothing was signed in. Try Sign in again.',
  signOutFailed: 'Antigravity could not sign out. Your threads are kept. Try Sign out again.',
  installFailed: 'Antigravity could not be installed. Nothing was changed. Try Install again.',
  removeFailed: 'The downloaded Antigravity could not be removed. Nothing was changed.',
} as const

export interface AntigravityAccountBridge {
  /** Runs `agy`'s Gemini Enterprise sign-in, which opens its page in the browser, and connects Antigravity once it is done. */
  enterpriseSignIn(): Promise<AntigravityAccountDone>
  /** Stops Antigravity's threads' processes and signs `agy` out of Sotto's own folder. Threads are kept. */
  signOut(): Promise<AntigravityAccountDone>
  /** Downloads Google's `agy`, checks it against Google's SHA-512 and connects Antigravity (about 1.25 GiB free is needed while it unpacks). */
  install(): Promise<AntigravityAccountDone>
  installProgress(): Promise<AntigravityInstallProgress>
  cancelInstall(): Promise<AntigravityAccountDone>
  /** Removes the `agy` Sotto downloaded; a version a running thread uses goes once the thread lets go. */
  removeDownloaded(): Promise<AntigravityAccountDone>
}
