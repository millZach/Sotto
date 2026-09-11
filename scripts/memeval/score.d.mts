// Sibling score.mjs is the source of truth; keep this declaration in step by hand.
import type { Category, Expected } from './schema.mjs'
import type { BackendAnswer } from './backends/index.mjs'

export interface CaseScore { pass: boolean; reason?: string }
export interface CategoryRow { category: Category; cases: number; passed: number; rate: number; meanMemoryIds?: number }
export function scoreCase(caseObj: { expected: Expected }, result: BackendAnswer): CaseScore
export function buildCategoryTable(results: { category: Category; pass: boolean; memoryIds: string[] }[]): CategoryRow[]
