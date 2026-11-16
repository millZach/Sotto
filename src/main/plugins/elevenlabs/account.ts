import type { SecretCheck } from '../accounts'
import type { VercelFetch } from '../vercel/read'

/**
 * ElevenLabs' API (ADR-0205; the plugins plan's slice 12): every call goes to `api.elevenlabs.io` with the account's
 * key in the `xi-api-key` header, and to no other host. A key is checked by reading the account's subscription,
 * `GET /v1/user/subscription`, which makes nothing and so spends nothing, before it is kept.
 */
export const ELEVENLABS_API = 'https://api.elevenlabs.io'
const SUBSCRIPTION_PATH = '/v1/user/subscription'
const TIMEOUT_MS = 15_000

/** How ElevenLabs is reached: the same narrow `fetch` the other plugins use, with no redirect followed. */
export type ElevenLabsFetch = VercelFetch

/**
 * Whether ElevenLabs takes a key. A key it does not know, or one kept from reading the account (401 or 403), is
 * refused. A key turned away for now (429) is busy. Anything else, including no answer, is unreachable, and nothing
 * is kept. Nothing of the answer is kept either: what the account has spent is Sotto's own count.
 */
export async function checkElevenLabsKey(fetcher: ElevenLabsFetch, key: string, options: { readonly base?: string; readonly signal?: AbortSignal } = {}): Promise<SecretCheck> {
  // A key is one line of letters a header can carry: anything else is not one ElevenLabs issued.
  if (!/^[\x21-\x7e]{1,500}$/u.test(key)) return { ok: false, problem: 'refused' }
  let address: string
  try { address = new URL(SUBSCRIPTION_PATH, options.base ?? ELEVENLABS_API).toString() } catch { return { ok: false, problem: 'unreachable' } }
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  try {
    const response = await fetcher(address, { method: 'GET', headers: { 'xi-api-key': key, Accept: 'application/json' }, redirect: 'manual',
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout })
    await response.body?.cancel().catch(() => undefined)
    if (response.status === 401 || response.status === 403) return { ok: false, problem: 'refused' }
    if (response.status === 429) return { ok: false, problem: 'busy' }
    if (response.status !== 200) return { ok: false, problem: 'unreachable' }
    return { ok: true, signedInAs: null }
  } catch { return { ok: false, problem: 'unreachable' } }
}
