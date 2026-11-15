import type { SecretCheck } from '../accounts'
import type { VercelFetch } from '../vercel/read'

/**
 * Meshy's API (ADR-0141, ADR-0205): every call goes to `api.meshy.ai` with the account's key as a bearer token, and to
 * no other host. Its balance is read from `GET /openapi/v1/balance`, which Meshy's docs say is free to call
 * (docs.meshy.ai/api/balance, read on November 15, 2026), so a key is checked there before it is kept without spending
 * a credit.
 */
export const MESHY_API = 'https://api.meshy.ai'
const BALANCE_PATH = '/openapi/v1/balance'
const TIMEOUT_MS = 15_000

/** How Meshy is reached: the same narrow `fetch` the other plugins use, with no redirect followed. */
export type MeshyFetch = VercelFetch

/**
 * Whether Meshy takes a key. A key it does not know (401) is refused, and so is one on a plan without API access
 * (402): Meshy's free plan has none (ADR-0141). A key turned away for now (429) is busy. Anything else, including no
 * answer, is unreachable, and nothing is kept.
 */
export async function checkMeshyKey(fetcher: MeshyFetch, key: string, options: { readonly base?: string; readonly signal?: AbortSignal } = {}): Promise<SecretCheck> {
  // A key is one line of letters a header can carry: anything else is not one Meshy issued.
  if (!/^[\x21-\x7e]{1,500}$/u.test(key)) return { ok: false, problem: 'refused' }
  let address: string
  try { address = new URL(BALANCE_PATH, options.base ?? MESHY_API).toString() } catch { return { ok: false, problem: 'unreachable' } }
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  try {
    const response = await fetcher(address, { method: 'GET', headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, redirect: 'manual',
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout })
    // Nothing of the answer is kept: the balance is read again when something is to be spent.
    await response.body?.cancel().catch(() => undefined)
    if (response.status === 401 || response.status === 402 || response.status === 403) return { ok: false, problem: 'refused' }
    if (response.status === 429) return { ok: false, problem: 'busy' }
    if (response.status !== 200) return { ok: false, problem: 'unreachable' }
    return { ok: true, signedInAs: null }
  } catch { return { ok: false, problem: 'unreachable' } }
}
