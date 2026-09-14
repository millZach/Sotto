import { z } from 'zod'

/** IDs identify Sotto's request, never a native provider session or turn. */
export const compactionSchema = z.object({ commandId: z.string(), status: z.enum(['running', 'completed', 'failed', 'uncertain']), error: z.string().optional() })
export type Compaction = z.infer<typeof compactionSchema>
export const compactionPending = (state?: Compaction): boolean => state?.status === 'running' || state?.status === 'uncertain'
