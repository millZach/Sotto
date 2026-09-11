export function shouldSkipCleanup(text: string): boolean
export function scoreProperNouns(hypothesis: string, names: readonly string[]): {
  matched: number
  total: number
  accuracy: number | null
  spans: { name: string; matched: boolean }[]
}
