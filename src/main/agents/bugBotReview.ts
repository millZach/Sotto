import { z } from 'zod'
import type { WatcherBugBotReview } from '../../shared/watcher'

/** Only Watcher's detail read asks for these bodies. Classification discards them before the answer leaves the parser. */
export const BUG_BOT_REVIEWS_SELECTION = `bugBotReviews: reviews(last: 100) @include(if: $bugBotReviews) {
  pageInfo { hasPreviousPage }
  nodes { body state submittedAt url commit { oid } author { login } }
}`
export const bugBotReviewsSchema = z.object({
  pageInfo: z.object({ hasPreviousPage: z.boolean() }).nullish(),
  nodes: z.array(z.object({
    body: z.string().nullish(), state: z.string(), submittedAt: z.string().nullish(),
    url: z.string().url().max(2_048).nullish(), commit: z.object({ oid: z.string().min(1).max(512) }).nullish(),
    author: z.object({ login: z.string() }).nullish(),
  }).nullable()).nullish(),
}).nullish()

/** The review's own commit is authoritative. Inline comments can be remapped to a later head by GitHub. */
export function readBugBotReview(reviews: z.infer<typeof bugBotReviewsSchema>, head: string | null, refused: boolean): WatcherBugBotReview {
  const unknown: WatcherBugBotReview = { coverage: 'unknown', commit: null, url: null }
  if (refused || !reviews?.nodes || !reviews.pageInfo) return unknown
  let latest: (typeof reviews.nodes)[number] = null
  for (const review of reviews.nodes) {
    if (review?.state === 'PENDING') continue
    if (!review) return unknown
    // Bug Bot submits through millZach's account, not a GitHub Bot actor. A quoted marker is not its review.
    if (review.author?.login !== 'millZach') continue
    if (review.body == null || !review.submittedAt) return unknown
    if (review.body.startsWith('<!-- sotto-bug-bot -->') && (!latest || review.submittedAt > latest.submittedAt!)) latest = review
  }
  if (!latest) return reviews.pageInfo.hasPreviousPage ? unknown : { coverage: 'missing', commit: null, url: null }
  const commit = latest.commit?.oid ?? null, url = latest.url ?? null
  return { coverage: !head || !commit ? 'unknown' : commit === head ? 'current' : 'stale', commit, url }
}
