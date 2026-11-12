import { addressOf, bodyOf, saidBy, TIMEOUT_MS, VERCEL_API, withoutToken, type VercelFetch } from './read'

/** A deployment's ID as Vercel writes them. It goes into an address, so nothing else is taken. */
export const VERCEL_DEPLOYMENT_ID = /^dpl_[A-Za-z0-9]{1,64}$/u
/** A team's ID as Vercel writes them. */
export const VERCEL_TEAM_ID = /^team_[A-Za-z0-9]{1,64}$/u
/** A project's ID as Vercel writes them. It goes into an address, so nothing else is taken. */
export const VERCEL_PROJECT_ID = /^prj_[A-Za-z0-9]{1,64}$/u

/** What Vercel says of a deployment, as far as a card shows it. Every part is the service's words: shown, never trusted. */
export interface VercelDeployment {
  readonly project?: string; readonly target?: string; readonly url?: string; readonly state?: string
  /** Vercel's own ID for the deployment's project, kept only when it is shaped as one. Promote and roll back address the project by it. */
  readonly projectId?: string
}

export type VercelChange =
  | { readonly ok: true; readonly state: string | null }
  | { readonly ok: false; readonly reason: 'no-secret' | 'locked' | 'refused' | 'unreachable' | 'too-late' | 'busy' | 'failed'; readonly said?: string }

/** What is known of a deployment for its card, or why its account's token could not be read at all. */
export type VercelDescribed = VercelDeployment | 'locked' | 'no-secret'

interface Options { readonly base?: string; readonly signal?: AbortSignal }

/**
 * A short plain line of the service's, safe to show on a card: one line, no control characters, never long, and
 * without the account's token, which a service can echo. The token goes first, so cutting the line cannot leave part of it.
 */
const shown = (value: unknown, token: string): string | undefined => {
  if (typeof value !== 'string') return undefined
  const line = [...withoutToken(value, token)].filter(character => character.charCodeAt(0) >= 0x20 && character.charCodeAt(0) !== 0x7f).join('').trim().slice(0, 120)
  return line || undefined
}

async function call(fetcher: VercelFetch, token: string, method: 'GET' | 'PATCH' | 'POST', path: string, teamId: string | undefined, options: Options): Promise<{ readonly response: Response; readonly body: string | null } | 'unreachable'> {
  const address = addressOf(options.base ?? VERCEL_API, path, teamId ? { teamId } : {})
  if (!address) return 'unreachable'
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  try {
    const response = await fetcher(address, { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, redirect: 'manual',
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout })
    return { response, body: await bodyOf(response) }
  } catch { return 'unreachable' }
}

/**
 * Reads one deployment so a card can say what it is in words rather than as an ID: its project, whether it is a
 * production or a preview deployment, its address and where its build stands. A read, so it asks nobody. When Vercel
 * says nothing readable the card shows the ID alone; nothing here decides whether the change may go.
 */
export async function describeVercelDeployment(fetcher: VercelFetch, token: string, deploymentId: string, teamId: string | undefined, options: Options = {}): Promise<VercelDeployment> {
  if (!token || !VERCEL_DEPLOYMENT_ID.test(deploymentId) || (teamId !== undefined && !VERCEL_TEAM_ID.test(teamId))) return {}
  const answered = await call(fetcher, token, 'GET', `v13/deployments/${deploymentId}`, teamId, options)
  if (answered === 'unreachable' || !answered.response.ok) return {}
  try {
    const deployment = JSON.parse(answered.body ?? '') as Record<string, unknown>
    const project = shown(deployment['name'], token), url = shown(deployment['url'], token), state = shown(deployment['readyState'] ?? deployment['state'], token)
    // Vercel leaves the target out of a preview deployment and names it for production.
    const target = shown(deployment['target'], token) ?? (deployment['target'] === null ? 'preview' : undefined)
    // The ID is shown and sent, so it is kept only when it is shaped as one and holds nothing of the token, which a
    // service can echo anywhere: with the token taken out, an ID that held it no longer has an ID's shape.
    const named = typeof deployment['projectId'] === 'string' ? withoutToken(deployment['projectId'], token) : ''
    const projectId = VERCEL_PROJECT_ID.test(named) ? named : undefined
    return { ...(project ? { project } : {}), ...(target ? { target } : {}), ...(url ? { url } : {}), ...(state ? { state } : {}), ...(projectId ? { projectId } : {}) }
  } catch { return {} }
}

/**
 * Cancels a deployment whose build is under way (ADR-0205): `PATCH /v12/deployments/{id}/cancel` on api.vercel.com,
 * with the account's token in the header and nowhere else. It is called only after the user allowed it. Vercel answers
 * 400 for a deployment that has already finished, which is said as too late with Vercel's own short code beside it,
 * since a 400 can mean something else.
 */
export async function cancelVercelDeployment(fetcher: VercelFetch, token: string, deploymentId: string, teamId: string | undefined, options: Options = {}): Promise<VercelChange> {
  if (!token) return { ok: false, reason: 'no-secret' }
  if (!VERCEL_DEPLOYMENT_ID.test(deploymentId) || (teamId !== undefined && !VERCEL_TEAM_ID.test(teamId))) return { ok: false, reason: 'failed' }
  const answered = await call(fetcher, token, 'PATCH', `v12/deployments/${deploymentId}/cancel`, teamId, options)
  if (answered === 'unreachable') return { ok: false, reason: 'unreachable' }
  const { response, body } = answered
  if (response.status === 401 || (response.status === 403 && /invalidToken|missingToken/u.test(body ?? ''))) return { ok: false, reason: 'refused' }
  if (response.status === 400) return { ok: false, reason: 'too-late', said: withoutToken(saidBy(response.status, body), token) }
  if (!response.ok) return { ok: false, reason: 'failed', said: withoutToken(saidBy(response.status, body), token) }
  let state: string | null = null
  try { state = shown((JSON.parse(body ?? '') as Record<string, unknown>)['readyState'], token) ?? null } catch { /* Cancelled, with nothing readable said of it. */ }
  return { ok: true, state }
}

/**
 * Moves a project's production to a deployment that already exists (ADR-0205), called only after the user allowed it.
 * Promote is `POST /v10/projects/{projectId}/promote/{deploymentId}`: production addresses serve the deployment, and it
 * is not built again. Roll back is `POST /v1/projects/{projectId}/rollback/{deploymentId}`: the same move to an earlier
 * production deployment, after which Vercel holds new pushes back from production until a deployment is promoted.
 * Both are Vercel's documented paths (November 12, 2026), and neither takes a body. Vercel answers 409 while another
 * promotion or rollback for the project is still under way.
 */
export async function moveVercelProduction(fetcher: VercelFetch, token: string, action: 'promote' | 'rollback', projectId: string, deploymentId: string, teamId: string | undefined, options: Options = {}): Promise<VercelChange> {
  if (!token) return { ok: false, reason: 'no-secret' }
  if (!VERCEL_PROJECT_ID.test(projectId) || !VERCEL_DEPLOYMENT_ID.test(deploymentId) || (teamId !== undefined && !VERCEL_TEAM_ID.test(teamId))) return { ok: false, reason: 'failed' }
  const path = action === 'promote' ? `v10/projects/${projectId}/promote/${deploymentId}` : `v1/projects/${projectId}/rollback/${deploymentId}`
  const answered = await call(fetcher, token, 'POST', path, teamId, options)
  if (answered === 'unreachable') return { ok: false, reason: 'unreachable' }
  const { response, body } = answered
  if (response.status === 401 || (response.status === 403 && /invalidToken|missingToken/u.test(body ?? ''))) return { ok: false, reason: 'refused' }
  if (response.status === 409) return { ok: false, reason: 'busy' }
  if (!response.ok) return { ok: false, reason: 'failed', said: withoutToken(saidBy(response.status, body), token) }
  return { ok: true, state: null }
}
