import type { Category } from './schema.mjs'
import type { BackendAnswer } from './backends/index.mjs'
import type { CaseScore, CategoryRow } from './score.mjs'

export interface CaseResult extends BackendAnswer, CaseScore { id: string; category: Category }
export interface MemEvalResults {
  backend: string
  caseSet: { path: string; version: string }
  generatedAt: string
  cases: CaseResult[]
  table: CategoryRow[]
  totals: { cases: number; passed: number; rate: number }
}
export function runMemEval(options: { backend: string; casesPath: string; outDir?: string }): Promise<{ results: MemEvalResults; outPath: string }>
