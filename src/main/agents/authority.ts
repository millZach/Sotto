import { z } from 'zod'

export const riskyActionSchema = z.enum(['spend', 'publish', 'destroy', 'relax-verification'])
export type RiskyAction = z.infer<typeof riskyActionSchema>
export const approvalWords: readonly string[] = ['allow', 'approve']
export const denialWords: readonly string[] = ['deny', 'reject']

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
