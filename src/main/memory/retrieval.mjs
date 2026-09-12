// Shared executable retrieval seam: production profile, evaluation and latency probe.
import { z } from 'zod'

export const RETRIEVAL_CONTEXT_CHARACTERS = 8_000
export const RETRIEVAL_MIN_COVERAGE = 0.5
export const RETRIEVAL_CANDIDATES_PER_SCOPE = 64
const topics = new Set(['communication', 'autonomy', 'verification', 'git', 'agents', 'workflow', 'privacy'])
const stopWords = new Set(('a an and are as at be been by can could do does for from had has have how i if in into is it me my of on or our please preference preferences should that the their them there these they this to use was we were what when where which who will with would you your').split(' '))
const optionsSchema = z.object({
  query: z.string(), projectId: z.string().min(1).optional(), threadId: z.string().min(1).optional(),
  at: z.iso.datetime().optional(),
})

// Project IDs keep their existing raw encoding; thread scopes reserve this prefix.
export function threadMemoryScope(projectId, threadId) {
  return `thread:${JSON.stringify([projectId, threadId])}`
}

function tokens(text) {
  return [...new Set((text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter(term => !stopWords.has(term)))]
}

export function retrieveExplicitMemories(database, input) {
  const { query, projectId, threadId, at = new Date().toISOString() } = optionsSchema.parse(input)
  const terms = tokens(query.slice(0, 4_096)).slice(0, 32)
  if (terms.length === 0) return []
  const scopes = []
  if (projectId !== undefined && threadId !== undefined) scopes.push(threadMemoryScope(projectId, threadId))
  // Never interpret a reserved thread encoding as a legacy project ID.
  if (projectId !== undefined && projectId !== 'global' && !projectId.startsWith('thread:')) scopes.push(projectId)
  scopes.push('global')
  // Keep FTS on the outer side. The scope index otherwise makes SQLite repeat
  // the full-text scan per scoped row (measured 52 ms vs 3 ms for one 10k-row query).
  const statement = database.prepare(`SELECT memories.id, memories.content, memories.tags FROM memories_fts
    CROSS JOIN memories ON memories.rowid = memories_fts.rowid
    WHERE memories_fts MATCH ? AND memories.scope = ?
      AND memories.sourceClass = 'explicit' AND memories.authority = 'preference'
      AND memories.state IN ('active', 'temporary') AND memories.supersededBy IS NULL
      AND memories.validFrom <= ? AND (memories.validTo IS NULL OR memories.validTo > ?)
    ORDER BY bm25(memories_fts), memories.lastConfirmedAt DESC, memories.id LIMIT ?`)
  // All tokens are quoted literals. OR widens candidates; coverage sets the acceptance bar.
  const match = terms.map(term => `"${term}"`).join(' OR ')
  const result = []
  let characters = 2 // JSON array brackets; budget includes escaping, keys, IDs and separators.
  for (const scope of scopes) {
    const candidates = statement.all(match, scope, at, at, RETRIEVAL_CANDIDATES_PER_SCOPE).map(row => {
      const tags = JSON.parse(row.tags)
      const evidence = new Set(tokens(`${row.content} ${tags.join(' ')}`))
      const coverage = terms.filter(term => evidence.has(term)).length / terms.length
      return { row, tags, coverage }
    }).filter(candidate => candidate.coverage >= RETRIEVAL_MIN_COVERAGE)
      .sort((a, b) => b.coverage - a.coverage) // Stable ties retain FTS rank, date, ID.
    for (const { row, tags } of candidates) {
      const topic = tags.find(tag => topics.has(tag))
      const preference = { id: row.id, content: row.content, ...(topic === undefined ? {} : { topic }) }
      const size = JSON.stringify(preference).length + (result.length === 0 ? 0 : 1)
      if (characters + size > RETRIEVAL_CONTEXT_CHARACTERS) continue
      result.push(preference)
      characters += size
      if (result.length === 20) return result
    }
  }
  return result
}
