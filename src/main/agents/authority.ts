import { z } from 'zod'

import type { ClientIdentity } from './hostService'

export const riskyActionSchema = z.enum(['spend', 'publish', 'destroy', 'relax-verification'])
export type RiskyAction = z.infer<typeof riskyActionSchema>
/** Every action a policy record can be written about: the risky classes, plus who may grant remotely. */
export type PolicyAction = RiskyAction | 'remote-answer'
export const approvalWords: readonly string[] = ['allow', 'approve']
export const denialWords: readonly string[] = ['deny', 'reject']

export interface AuthorizationQuery {
  action: PolicyAction; resource: string; scope: string; at?: string
}
export interface AuthorizationResult {
  allowed: boolean; policyId?: string
  reason: 'allowed' | 'always-confirm' | 'no-policy' | 'expired' | 'revoked'
}
/**
 * Whether this client's answer may count as a grant at all. `local-window` is the desktop window on
 * this machine, which always may. `paired-client` is a remote client a policy record names.
 * `no-policy` is a remote client nothing was ever written about, and `unpaired` is one whose record
 * no longer grants: revoked, expired, or held behind an always-confirm boundary.
 */
export interface ClientGrantResult {
  allowed: boolean; policyId?: string
  reason: 'local-window' | 'paired-client' | 'unpaired' | 'no-policy'
}
export interface Authority {
  authorizes(query: AuthorizationQuery): AuthorizationResult
  mayGrant(client: ClientIdentity): ClientGrantResult
}

/** Said to a client whose answer is refused. Plain words: what happened, and what to do next. */
export const UNPAIRED_CLIENT_ERROR = 'This client is not paired with Sotto. Pair it on this PC first.'

/** The scope a `remote-answer` policy record is written under, so one record names exactly one client. */
export function remoteAnswerScope(clientId: string): string { return `client:${clientId}` }

/**
 * What holds when no policy store is available: the local window may answer, and nothing else may.
 * An unreachable memory store must never widen who can grant.
 */
export function mayGrantLocally(client: ClientIdentity): ClientGrantResult {
  return client.transport === 'ipc'
    ? { allowed: true, reason: 'local-window' }
    : { allowed: false, reason: 'no-policy' }
}

const riskyKeywords: [RiskyAction, RegExp][] = [
  ['spend', /(?<![\w./-])(?:spend|pay|purchase|subscribe|buy|charge|upgrade\s+the\s+plan)(?![\w/-]|\.\w)/iu],
  ['publish', /(?<![\w./-])(?:publish|deploy|(?:create|cut)\s+(?:a\s+)?(?:GitHub\s+)?release|merge\s+to\s+main)(?![\w/-]|\.\w)/iu],
  ['destroy', /(?<![\w./-])(?:push\s+(?:--force|-f|(?:to\s+|[\w.-]+\s+)?(?:main|master))|git\s+clean\s+-fd|rm\s+-rf|force\s+push|drop\s+(?:table|database)|reset\s+--hard|overwrite|truncate|wipe|purge)(?![\w/-]|\.\w)/iu],
  ['relax-verification', /(?<![\w./-])(?:skip\s+(?:the\s+)?(?:tests|CI|verification)|disable\s+(?:the\s+)?checks|bypass|without\s+verification|--no-verify|--no-gpg-sign)(?![\w/-]|\.\w)/iu],
]

export function classifyRiskyAction(
  request: { kind: 'question' | 'permission'; text: string },
): RiskyAction[] {
  if (request.kind !== 'permission') return []
  return riskyKeywords.filter(([, keywords]) => keywords.test(request.text)).map(([action]) => action)
}
