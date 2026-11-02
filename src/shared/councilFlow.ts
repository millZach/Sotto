import type { CouncilCounts, CouncilKind } from './council'
import type { CouncilAnswer, CouncilReview } from './councilBlocks'

/**
 * Who reads whose answer in a Council's review, and in what order (ADR-0177 decision 4). Answers keep their letters for
 * every reader; only the order each reader sees them in varies. With two or three answers each reader reviews all the
 * others; with four or five, two each, so reviews grow with the panel rather than its square. Reader i takes the answers
 * after its own, in letter order around the table, so each answer is read the same number of times and comes first for
 * one reader and second for another: position bias is spread rather than given to one answer.
 */
export function reviewAssignments(answers: readonly string[], readers: readonly string[]): Map<string, string[]> {
  const sorted = [...answers].sort()
  const each = sorted.length >= 4 ? 2 : sorted.length - 1
  const plan = new Map<string, string[]>()
  for (const reader of readers) {
    const at = sorted.indexOf(reader)
    const around = at < 0 ? sorted : [...sorted.slice(at + 1), ...sorted.slice(0, at)]
    plan.set(reader, around.slice(0, Math.max(0, each)))
  }
  return plan
}

/** One reader's review as Sotto counts it: the answers it was given, and its block, or null when unavailable. */
export interface CountedReview { readonly reader: string; readonly assigned: readonly string[]; readonly block: CouncilReview | null }

/**
 * Sotto's counts beside the verdict (decision 5), read from the result blocks alone, each with its denominator: the
 * reviews that could have given it. A block that was unavailable leaves its counts short, which `partial` says; it never
 * counts as disagreement or as zero. With two answers each panelist reviews only the other, so nothing is counted.
 */
export function councilCounts(input: { readonly kinds: readonly CouncilKind[]; readonly answers: ReadonlyMap<string, CouncilAnswer | null>; readonly reviews: readonly CountedReview[] }): CouncilCounts {
  const answered = input.answers.size
  const empty: CouncilCounts = { answered, partial: false, rankings: [], findings: [], supports: [], favourites: [], changed: [] }
  if (answered <= 2) return empty
  const valid = input.reviews.filter((review): review is CountedReview & { block: CouncilReview } => review.block !== null)
  const partial = input.reviews.some(review => review.block === null) || [...input.answers.values()].some(answer => answer === null)
  const readersOf = (letter: string) => valid.filter(review => review.assigned.includes(letter))
  const letters = [...input.answers.keys()].sort()
  const rankings = letters.flatMap(letter => {
    const ranked = readersOf(letter).filter(review => review.block.ranking?.includes(letter))
    return ranked.length ? [{ letter, first: ranked.filter(review => review.block.ranking![0] === letter).length, of: ranked.length }] : []
  })
  const findings: CouncilCounts['findings'] = [], favourites: CouncilCounts['favourites'] = []
  for (const letter of letters) {
    const answer = input.answers.get(letter)
    const readers = readersOf(letter)
    for (const finding of answer?.findings ?? []) {
      const verdicts = readers.flatMap(review => review.block.findings.filter(item => item.id === finding.id).map(item => item.verdict))
      if (verdicts.length) findings.push({ finding: finding.id, confirmed: verdicts.filter(item => item === 'confirmed').length,
        rejected: verdicts.filter(item => item === 'rejected').length, unchecked: verdicts.filter(item => item === 'unchecked').length, of: readers.length })
      const liked = readers.filter(review => review.block.favourites.includes(finding.id)).length
      if (liked) favourites.push({ finding: finding.id, count: liked, of: readers.length })
    }
  }
  const said = valid.flatMap(review => review.block.supports === undefined ? [] : [review.block.supports])
  const supports = [...new Set(said)].sort().map(letter => ({ letter, count: said.filter(item => item === letter).length, of: said.length }))
  const changed = valid.filter(review => review.block.answer === 'changed').map(review => review.reader).sort()
  return { answered, partial, rankings, findings, supports, favourites, changed }
}
