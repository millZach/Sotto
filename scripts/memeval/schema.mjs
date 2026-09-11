// Ground-truth validation for the hand-authored SottoMemEval case sets.
import { z } from 'zod'

export const CATEGORIES = Object.freeze([
  'recall', 'abstain', 'temporal', 'exception', 'project-leak', 'authority-leak',
])
export const ANSWER_CATEGORIES = Object.freeze(['recall', 'temporal', 'exception'])
export const PATTERN_FLAGS = 'is'

const text = z.string().min(1)
const timestamp = z.union([z.iso.date(), z.iso.datetime({ offset: true, local: true })])
const pattern = text.refine((value) => {
  try {
    new RegExp(value, PATTERN_FLAGS)
    return true
  } catch {
    return false
  }
}, 'Expected a valid regular expression')

const expectedSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('recall'), pattern }),
  z.object({ kind: z.literal('abstain') }),
  z.object({ kind: z.literal('temporal'), pattern, stalePattern: pattern }),
  z.object({ kind: z.literal('exception'), pattern, stalePattern: pattern }),
  z.object({ kind: z.literal('project-leak'), leakPattern: pattern }),
  z.object({ kind: z.literal('authority-leak'), leakPattern: pattern }),
])

const caseSchema = z.object({
  id: text,
  category: z.enum(CATEGORIES),
  status: z.enum(['draft', 'reviewed']),
  project: text,
  asOf: timestamp,
  history: z.array(z.object({
    at: timestamp,
    provider: z.enum(['claude', 'codex', 'grok']),
    project: text,
    role: z.enum(['user', 'assistant']),
    text,
  })).min(3).max(8),
  question: text,
  expected: expectedSchema,
}).superRefine((entry, context) => {
  if (entry.category !== entry.expected.kind) {
    context.addIssue({ code: 'custom', path: ['expected', 'kind'], message: 'Expected kind must equal the case category' })
  }
})

export const caseSetSchema = z.object({
  version: text,
  cases: z.array(caseSchema).min(1),
}).superRefine((set, context) => {
  const ids = new Set()
  set.cases.forEach((entry, index) => {
    if (ids.has(entry.id)) {
      context.addIssue({ code: 'custom', path: ['cases', index, 'id'], message: `Duplicate case id: ${entry.id}` })
    }
    ids.add(entry.id)
  })
})

export const authoredCaseSetSchema = caseSetSchema.superRefine((set, context) => {
  if (set.cases.length < 20 || set.cases.length > 30) {
    context.addIssue({ code: 'custom', path: ['cases'], message: 'Expected 20 to 30 authored cases' })
  }
  for (const category of CATEGORIES) {
    if (!set.cases.some((entry) => entry.category === category)) {
      context.addIssue({ code: 'custom', path: ['cases'], message: `Missing category: ${category}` })
    }
  }
})
