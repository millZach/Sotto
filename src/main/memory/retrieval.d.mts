import type { DatabaseSync } from 'node:sqlite'
import type { MemoryTopic } from '../../shared/memory'

export const RETRIEVAL_CONTEXT_CHARACTERS: 8000
export const RETRIEVAL_MIN_COVERAGE: 0.5
export const RETRIEVAL_CANDIDATES_PER_SCOPE: 64
export interface RetrievalQuery { query: string; projectId?: string; threadId?: string; at?: string }
export interface RetrievedPreference { id: string; content: string; topic?: MemoryTopic }
export function threadMemoryScope(projectId: string, threadId: string): string
export function retrieveExplicitMemories(database: DatabaseSync, input: RetrievalQuery): RetrievedPreference[]
