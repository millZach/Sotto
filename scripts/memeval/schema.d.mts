// The Zod schema in sibling schema.mjs is the source of truth; keep this declaration in step by hand.
import type { z } from 'zod'

export type Category = 'recall' | 'abstain' | 'temporal' | 'exception' | 'project-leak' | 'authority-leak'
export const CATEGORIES: readonly Category[]
export const ANSWER_CATEGORIES: readonly Category[]
export const PATTERN_FLAGS: 'is'
export type Expected =
  | { kind: 'recall'; pattern: string }
  | { kind: 'abstain' }
  | { kind: 'temporal' | 'exception'; pattern: string; stalePattern: string }
  | { kind: 'project-leak' | 'authority-leak'; leakPattern: string }
export interface HistoryEvent {
  at: string
  provider: 'claude' | 'codex' | 'grok'
  project: string
  role: 'user' | 'assistant'
  text: string
}
export interface MemoryCase {
  id: string
  category: Category
  status: 'draft' | 'reviewed'
  project: string
  asOf: string
  history: HistoryEvent[]
  question: string
  expected: Expected
}
export interface CaseSet { version: string; cases: MemoryCase[] }
export const caseSetSchema: z.ZodType<CaseSet>
// Adds authoring rules: 20 to 30 cases with every category present.
export const authoredCaseSetSchema: z.ZodType<CaseSet>
