import { climbJudgmentSchema, type ClimbJudgment, type ClimbRound, type ClimbSpec } from '../../shared/councilClimb'
import { type CouncilEvidenceStore } from './councilEvidence'
import type { CouncilFrozenEvidence } from '../../shared/councilEvidence'

export function climbBlock(text: string): unknown {
  const match = /<climb-result>\s*([\s\S]*?)\s*<\/climb-result>/u.exec(text)
  if (!match || text.indexOf('<climb-result>', match.index + 1) !== -1) throw new Error('Return exactly one climb-result JSON block.')
  return JSON.parse(match[1]!) as unknown
}
export async function readClimbJudgment(text: string, spec: ClimbSpec, round: ClimbRound, store: CouncilEvidenceStore, evidence: readonly CouncilFrozenEvidence[]): Promise<ClimbJudgment> {
  const result = climbJudgmentSchema.parse(climbBlock(text)), seen = new Set<string>()
  for (const row of result.scores) {
    const criterion = spec.criteria.find(item => item.id === row.criterion), exhibit = round.exhibits.find(item => item.letter === row.exhibit)
    const key = `${row.criterion}:${row.exhibit}`
    if (!criterion || !exhibit || seen.has(key)) throw new Error('Judgments need every criterion and exhibit exactly once.')
    seen.add(key)
    if (row.score !== null && (row.score < criterion.min || row.score > criterion.max)) throw new Error('A score is outside its approved range.')
    if (row.score !== null && row.citations.length === 0) throw new Error('A measured score needs frozen-evidence citations.')
    const frozen = evidence.find(item => item.id === exhibit.evidence)!
    for (const citation of row.citations) {
      const entry = (await store.manifest(frozen)).entries.find(entry => entry.path === citation.path)
      if (entry?.mediaType.startsWith('image/') && citation.start === 1 && citation.end === 1
        && /^Image [1-8]: /u.test(citation.quote) && citation.quote.slice(9) === `${entry.path} (${entry.mediaType}, ${entry.bytes} bytes, SHA-256 ${entry.hash})`) { await store.readEntry(frozen, entry); continue }
      if (await store.citation(frozen, citation.path, citation.start, citation.end, citation.quote) !== 'matches') throw new Error('A citation does not match the frozen exhibit.')
    }
  }
  if (seen.size !== spec.criteria.length * round.exhibits.length) throw new Error('A required judgment is missing.')
  return result
}
/** Every required seat votes from matched exhibits in this round. No averaging or cross-round scores. */
export function assessClimb(spec: ClimbSpec, round: ClimbRound): { targetMet: boolean; improved: boolean } {
  if (round.judgments.length !== 3) return { targetMet: false, improved: false }
  const letter = (id: string | undefined): string | undefined => round.exhibits.find(item => item.evidence === id)?.letter
  let targetMet = true, improved = true
  for (const judge of round.judgments) {
    let gained = false
    for (const criterion of spec.criteria) {
      const score = (id: string | undefined): number | null => judge.result.scores.find(row => row.criterion === criterion.id && row.exhibit === letter(id))?.score ?? null
      const candidate = score(round.candidate), incumbent = score(round.incumbent)
      const reference = score(criterion.target === 'reference' ? round.reference : round.baseline)
      const sign = criterion.direction === 'higher' ? 1 : -1
      if (candidate === null || incumbent === null) { targetMet = false; improved = false; continue }
      if ((candidate - incumbent) * sign < -criterion.tolerance) improved = false
      if (criterion.kind === 'goal' && (candidate - incumbent) * sign >= criterion.meaningfulGain) gained = true
      const pass = criterion.target === 'absolute' ? (candidate - criterion.threshold) * sign >= -criterion.tolerance
        : reference !== null && (candidate - reference) * sign >= criterion.threshold - criterion.tolerance
      if (!pass) targetMet = false
    }
    if (!gained) improved = false
  }
  return { targetMet, improved }
}
