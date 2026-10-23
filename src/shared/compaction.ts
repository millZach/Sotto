import { z } from 'zod'

/** IDs identify Sotto's request, never a native provider session or turn. */
/** `idle` marks Sotto's own idle compaction (ADR-0123) rather than the user's, so the thread can say who compacted it. */
export const compactionSchema = z.object({ commandId: z.string(), status: z.enum(['running', 'completed', 'failed', 'uncertain']), error: z.string().optional(), idle: z.literal(true).optional() })
export type Compaction = z.infer<typeof compactionSchema>
/** Carries the idle mark from one state of a compaction to the next. */
export const idleMark = (state?: Compaction): { idle?: true } => state?.idle ? { idle: true } : {}
export const compactionPending = (state?: Compaction): boolean => state?.status === 'running' || state?.status === 'uncertain'
