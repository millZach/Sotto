// @vitest-environment node
import { requestQuestionsDigest } from '../../src/main/agents/requestDrafts'
import type { AgentRequest } from '../../src/shared/agents'

export const questions = [{ id: 'q', question: 'Which color?', options: [], multiSelect: false, allowFreeText: true }]
export const request: AgentRequest = { id: 'question', kind: 'question', text: '', options: [], questions, delivery: 'uncertain' }
export const target = { threadId: 'workshop', providerId: 'claude' as const, requestId: request.id, questionsDigest: requestQuestionsDigest(questions) }
