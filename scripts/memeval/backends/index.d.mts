import type { HistoryEvent } from '../schema.mjs'

export interface BackendAnswer { answer: string | null; memoryIds: string[] }
export interface Question { question: string; project: string; asOf: string }
export interface Backend {
  name: string
  reset(): void | Promise<void>
  observe(event: HistoryEvent): void | Promise<void>
  answer(query: Question): BackendAnswer | Promise<BackendAnswer>
}
export function createBackend(name: string): Backend | Promise<Backend>
