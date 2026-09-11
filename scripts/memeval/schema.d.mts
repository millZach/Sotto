import type { z } from 'zod'

export type Category = 'recall' | 'abstain' | 'temporal' | 'exception' | 'project-leak' | 'authority-leak'
export const CATEGORIES: readonly Category[]
export type Expected =
  | { kind: 'recall'; pattern: string }
  | { kind: 'abstain' }
  | { kind: 'temporal' | 'exception'; pattern: string; stalePattern: string }
  | { kind: 'project-leak' | 'authority-leak'; leakPattern: string }
export interface HistoryEvent {
  at: string
  agent: 'claude' | 'codex' | 'grok'
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
