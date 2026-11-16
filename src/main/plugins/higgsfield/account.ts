import type { SecretCheck } from '../accounts'
import type { VercelFetch } from '../vercel/read'

/**
 * Higgsfield's API (ADR-0205; the plugins plan's slice 13): every call goes to `api.higgsfield.ai` with the account's
 * key ID and key secret in the `Authorization: Key <KEY_ID>:<KEY_SECRET>` header, and to no other host. A key is
 * checked by reading the account's usage report, `GET /models/usage`, which makes nothing and so spends nothing,
 * before it is kept. Higgsfield documents no balance or account read, and this is the read that makes nothing.
 */
export const HIGGSFIELD_API = 'https://api.higgsfield.ai'
const USAGE_PATH = '/models/usage'
const TIMEOUT_MS = 15_000

/** How Higgsfield is reached: the same narrow `fetch` the other plugins use, with no redirect followed. */
export type HiggsfieldFetch = VercelFetch

/**
 * A Higgsfield secret as Sotto keeps it: a key ID and a key secret joined by one colon, each one line of characters a
 * header can carry and neither holding a colon. Anything else is not a key pair Higgsfield issued.
 */
const KEY_PAIR = /^[\x21-\x39\x3b-\x7e]{1,400}:[\x21-\x39\x3b-\x7e]{1,400}$/u

/**
 * Whether Higgsfield takes a key ID and key secret, given as `<KEY_ID>:<KEY_SECRET>`. A pair it does not know, or one
 * kept from reading the account (401 or 403), is refused. A pair turned away for now (429) is busy. Anything else,
 * including no answer, is unreachable, and nothing is kept. Nothing of the answer is kept either: what the account has
 * spent is Sotto's own count.
 */
export async function checkHiggsfieldKey(fetcher: HiggsfieldFetch, secret: string, options: { readonly base?: string; readonly signal?: AbortSignal } = {}): Promise<SecretCheck> {
  if (!KEY_PAIR.test(secret)) return { ok: false, problem: 'refused' }
  let address: string
  try { address = new URL(USAGE_PATH, options.base ?? HIGGSFIELD_API).toString() } catch { return { ok: false, problem: 'unreachable' } }
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  try {
    const response = await fetcher(address, { method: 'GET', headers: { Authorization: `Key ${secret}`, Accept: 'application/json' }, redirect: 'manual',
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout })
    await response.body?.cancel().catch(() => undefined)
    if (response.status === 401 || response.status === 403) return { ok: false, problem: 'refused' }
    if (response.status === 429) return { ok: false, problem: 'busy' }
    if (response.status !== 200) return { ok: false, problem: 'unreachable' }
    return { ok: true, signedInAs: null }
  } catch { return { ok: false, problem: 'unreachable' } }
}
