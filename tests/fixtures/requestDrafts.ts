import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach } from 'vitest'
import { requestDraftSchema, type RequestDraft, type RequestDraftTarget } from '../../src/shared/requestDrafts'
import type { AgentRequest } from '../../src/shared/agents'

export const questions = [
  { id: 'choice', question: 'Destination?', multiSelect: true, allowFreeText: true, options: [{ id: 'coast', label: 'Coast' }, { id: 'hills', label: 'Hills' }] },
  { id: 'notes', question: 'Notes?', multiSelect: false, allowFreeText: true, options: [] },
]

export const target: RequestDraftTarget = { kind: 'thread', ownerId: 'owner', providerId: 'codex', requestId: 'request', questions }

export const submittedAnswers = { choice: { optionIds: ['coast'], text: 'A quiet beach' }, notes: { optionIds: [], text: 'Keep this unsent' } }

export const owner = { kind: target.kind, ownerId: target.ownerId, providerId: target.providerId }

export const request: AgentRequest = { id: target.requestId, kind: 'question', text: 'Native context', options: [], questions }

export const draft = (patch: Partial<RequestDraft> = {}): RequestDraft => requestDraftSchema.parse({ target, revision: 1, held: false,
  selections: { choice: { optionIds: ['coast'], other: true, text: 'A quiet beach' }, notes: { optionIds: [], other: false, text: 'Keep this unsent' } }, ...patch })

export let directory: string

export const disk = async (): Promise<{ drafts: RequestDraft[] }> => JSON.parse(await readFile(join(directory, 'request-drafts.json'), 'utf8'))

export function registerRequestDraftFixture(): void {
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'sotto-request-drafts-')) })

  afterEach(async () => { await rm(directory, { recursive: true, force: true }) })
}
