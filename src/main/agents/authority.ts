export type RiskyAction = 'spend' | 'publish' | 'destroy' | 'relax-verification'

export interface AuthorizationQuery {
  action: RiskyAction; resource: string; scope: string; at?: string
}
export interface AuthorizationResult {
  allowed: boolean; policyId?: string
  reason: 'allowed' | 'always-confirm' | 'no-policy' | 'expired' | 'revoked'
}
export interface Authority {
  authorizes(query: AuthorizationQuery): AuthorizationResult
}

const riskyKeywords: [RiskyAction, RegExp][] = [
  ['destroy', /\b(?:delete|remove|rm\s+-rf|force\s+push|drop\s+(?:table|database)|reset\s+--hard|wipe|purge)\b|(?<![\w-])--force\b/iu],
  ['relax-verification', /\b(?:skip\s+(?:the\s+)?tests|disable\s+checks|bypass|without\s+verification|skip\s+verification)\b|(?<![\w-])--no-verify\b/iu],
  ['publish', /\b(?:publish|release|deploy|push\s+to\s+(?:main|master)|merge\s+to\s+main)\b/iu],
  ['spend', /\b(?:spend|spending|billing|payment|purchase|buy|credits|upgrade\s+the\s+plan|charge)\b/iu],
]

export function classifyRiskyAction(
  request: { kind: 'question' | 'permission'; text: string },
  approved: boolean | undefined, projectId: string,
): { action: RiskyAction; resource: '*'; scope: string } | null {
  if (request.kind !== 'permission' || approved !== true) return null
  const match = riskyKeywords.find(([, keywords]) => keywords.test(request.text))
  return match ? { action: match[0], resource: '*', scope: projectId } : null
}

export function isExplicitApproval(answer: string): boolean {
  return ['allow', 'approve', 'approved', 'yes'].includes(answer.trim().toLowerCase().replace(/\p{P}+$/gu, '').trim())
}
