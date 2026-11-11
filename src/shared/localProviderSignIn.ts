import { z } from 'zod'
import type { ProviderId } from './agents'
import { PASTED_CODE_MAX, PROVIDER_SIGN_IN_SHAPES, type ProviderSignInView } from './hostProviders'

/**
 * Signing a provider in on this computer from its row in Settings › Providers (ADR-0200): the dialog a paired host's
 * tile opens (ADR-0037), run against this computer's own client. Main runs the client's sign-in, holds the page's
 * address and opens it, checked, in the browser; the window sees where the sign-in stands and the code to show.
 */
export const LOCAL_PROVIDER_SIGN_IN = 'sotto:providers:sign-in'

/** The providers whose own sign-in prints a page and a code Sotto can show: Codex, Claude Code and Grok Build. Cursor signs in from its own row (ADR-0128). */
export const LOCAL_SIGN_IN_PROVIDERS = ['codex', 'claude', 'grok'] as const
export const localSignInProviderSchema = z.enum(LOCAL_SIGN_IN_PROVIDERS)
export type LocalSignInProvider = z.infer<typeof localSignInProviderSchema>

/** Whether Sign in on this computer can run this provider's sign-in, rather than showing its command. */
export function signsInHere(provider: ProviderId): provider is LocalSignInProvider {
  return (LOCAL_SIGN_IN_PROVIDERS as readonly ProviderId[]).includes(provider) && PROVIDER_SIGN_IN_SHAPES[provider] !== null
}

/** What the dialog asks of a sign-in: a host's request (`hostSignInRequestSchema`) without the host. */
export const localSignInRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start'), provider: localSignInProviderSchema }).strict(),
  z.object({ type: z.literal('read'), signInId: z.uuid() }).strict(),
  z.object({ type: z.literal('code'), signInId: z.uuid(), code: z.string().min(1).max(PASTED_CODE_MAX) }).strict(),
  z.object({ type: z.literal('cancel'), signInId: z.uuid() }).strict(),
  /** Open sign-in page: main opens the page it holds, checked, in the default browser. */
  z.object({ type: z.literal('open'), signInId: z.uuid() }).strict(),
])
export type LocalSignInRequest = z.infer<typeof localSignInRequestSchema>

export interface LocalProviderSignInBridge {
  /** A provider's sign-in on this computer: start, read, hand in a pasted code, cancel, or open its page. */
  signIn(request: LocalSignInRequest): Promise<ProviderSignInView | null>
}
