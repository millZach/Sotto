import { z } from 'zod'
import { COUNCIL_KINDS, type CouncilKind } from './council'

/**
 * The Council's result blocks (ADR-0177 decision 4): each answer, review, crux result and fairness answer ends with one
 * fenced block of fixed fields, using only the IDs its prompt lists. Sotto reads each block once, where it arrives, and
 * asks once for a repair when it is missing or unreadable. The framing, a crux check's plan and the chair's answer to an
 * objection have blocks of their own, read the same way.
 *
 * A block is the last fence in the reply whose info string names it, holding one `field: value` per line; a value with
 * parts separates them with ` | `. What a block may say is checked here, against the IDs the prompt listed. A reason a
 * block could not be read goes back to the thread in its repair prompt, so it is written for the agent, in English.
 */

export const COUNCIL_BLOCK_NAMES = {
  framing: 'council-framing',
  answer: 'council-answer',
  review: 'council-review',
  crux: 'council-crux',
  cruxResult: 'council-crux-result',
  fairness: 'council-fairness',
  amend: 'council-amend',
} as const
export type CouncilBlockName = typeof COUNCIL_BLOCK_NAMES[keyof typeof COUNCIL_BLOCK_NAMES]

export type BlockRead<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string; readonly missing: boolean }

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w-]+)?\s*$/u
const FIELD = /^([a-z_]+)\s*:\s*(.*)$/u
const LETTER = /^[A-E]$/u
/** The most one field holds; the record and the window's view keep a field whole up to this. */
export const COUNCIL_FIELD_MAX = 2_000

interface Fenced { readonly fields: readonly (readonly [string, string])[]; readonly start: number; readonly end: number; readonly bad?: string }

/** Every fenced block in a reply, with its lines' offsets, in order. A fence left open runs to the end. */
function fences(reply: string): { name: string | undefined; body: string[]; start: number; end: number }[] {
  const lines = reply.split(/\r?\n/u)
  const found: { name: string | undefined; body: string[]; start: number; end: number }[] = []
  let open: { mark: string; name: string | undefined; body: string[]; start: number } | undefined
  lines.forEach((line, index) => {
    const fence = FENCE.exec(line)
    if (!open) {
      if (fence) open = { mark: fence[1]!, name: fence[2], body: [], start: index }
      return
    }
    if (fence && fence[2] === undefined && fence[1]![0] === open.mark[0] && fence[1]!.length >= open.mark.length) {
      found.push({ name: open.name, body: open.body, start: open.start, end: index })
      open = undefined
      return
    }
    open.body.push(line)
  })
  if (open) found.push({ name: open.name, body: open.body, start: open.start, end: lines.length - 1 })
  return found
}

/** The last block of this name in the reply, as its fields in order; undefined when the reply has none. */
export function findCouncilBlock(reply: string, name: CouncilBlockName): Fenced | undefined {
  const block = fences(reply).findLast(item => item.name === name)
  if (!block) return undefined
  const fields: [string, string][] = []
  for (const [index, line] of block.body.entries()) {
    if (!line.trim()) continue
    const field = FIELD.exec(line.trim())
    if (!field) return { fields, start: block.start, end: block.end, bad: `line ${index + 1} of the block is not "field: value"` }
    fields.push([field[1]!, field[2]!.trim().slice(0, COUNCIL_FIELD_MAX)])
  }
  return { fields, start: block.start, end: block.end }
}

/** The reply without its Council blocks: the words a reader is shown, such as the verdict above its block. */
export function withoutCouncilBlocks(reply: string): string {
  const names = new Set<string>(Object.values(COUNCIL_BLOCK_NAMES))
  const lines = reply.split(/\r?\n/u)
  const drop = new Set<number>()
  for (const block of fences(reply)) if (block.name !== undefined && names.has(block.name)) for (let line = block.start; line <= block.end; line++) drop.add(line)
  return lines.filter((_, index) => !drop.has(index)).join('\n').trim()
}

/** The block's fields as a reader of it takes them: single fields once, list fields in order. */
function fieldsOf(block: Fenced, single: readonly string[], lists: readonly string[]): { one: Map<string, string>; many: Map<string, string[]> } | string {
  const one = new Map<string, string>(), many = new Map<string, string[]>()
  for (const [key, value] of block.fields) {
    if (lists.includes(key)) many.set(key, [...many.get(key) ?? [], value])
    else if (single.includes(key)) { if (one.has(key)) return `the field "${key}" is given twice`; one.set(key, value) }
    else return `"${key}" is not a field of this block; use only ${[...single, ...lists].join(', ')}`
  }
  return { one, many }
}
const parts = (value: string): string[] => value.split('|').map(part => part.trim())
const list = (value: string): string[] => value.split(/[,;]/u).map(part => part.trim()).filter(Boolean)
const missing = <T>(name: string): BlockRead<T> => ({ ok: false, reason: `the reply has no \`\`\`${name} block`, missing: true })
const bad = <T>(reason: string): BlockRead<T> => ({ ok: false, reason, missing: false })
function opened(reply: string, name: CouncilBlockName): Fenced | BlockRead<never> {
  const block = findCouncilBlock(reply, name)
  if (!block) return missing(name)
  return block.bad ? bad(block.bad) : block
}
const isRead = (value: Fenced | BlockRead<never>): value is BlockRead<never> => 'ok' in value

// A cited place in the snapshot.

/** A `path:lines` citation: a path inside the snapshot and a line or a range, 1-based. */
export interface CouncilCitationPlace { readonly path: string; readonly start: number; readonly end: number }
const CITATION = /^(.+?):(\d{1,7})(?:\s*[-–]\s*(\d{1,7}))?$/u
/** The most lines one citation may name, so a check reads a bounded part of one file. */
export const CITATION_LINES_MAX = 400
/** Reads a citation, or undefined when it is not one: an absolute path, one that climbs out with `..`, or bad lines. */
export function parseCitation(text: string): CouncilCitationPlace | undefined {
  const match = CITATION.exec(text.trim().replace(/^`|`$/gu, ''))
  if (!match) return undefined
  const path = match[1]!.replaceAll('\\', '/').replace(/^\.\//u, '')
  const start = Number(match[2]), end = Number(match[3] ?? match[2])
  if (!path || path.length > 1_024 || path.startsWith('/') || /^[a-z]:/iu.test(path) || path.split('/').includes('..') || start < 1 || end < start || end - start >= CITATION_LINES_MAX) return undefined
  return { path, start, end }
}
const normal = (text: string): string => text.replace(/\s+/gu, ' ').trim()
/**
 * Whether a reply quotes what a citation names: at least one of the cited lines with words in it appears in the reply,
 * whitespace aside. Undefined when the file does not have those lines.
 */
export function citationQuoted(fileText: string, place: CouncilCitationPlace, reply: string): boolean | undefined {
  const lines = fileText.split(/\r?\n/u)
  if (place.end > lines.length) return undefined
  const said = normal(reply)
  const cited = lines.slice(place.start - 1, place.end).map(normal).filter(line => line.length >= 4)
  return cited.length === 0 ? true : cited.some(line => said.includes(line))
}

// Framing (the chair).

export const framingSchema = z.object({
  kinds: z.array(z.enum(COUNCIL_KINDS)).min(1).max(2),
  criteria: z.array(z.object({ id: z.string(), source: z.enum(['question', 'assumed']), text: z.string().min(1) }).strict()).min(1).max(5),
  headings: z.array(z.string().min(1).max(200)).max(8),
  words: z.number().int().min(50).max(5_000),
  angles: z.array(z.object({ seat: z.string(), text: z.string().min(1) }).strict()).max(5),
  /** Whether answering needs outside research, web pages, papers or library docs, and why in a line (Drake, November 2, 2026). */
  research: z.object({ needed: z.boolean(), reason: z.string() }).strict(),
}).strict()
export type CouncilFraming = z.infer<typeof framingSchema>

/** A link Sotto takes as a source: http or https, with a host. Sotto checks only its shape; reviewers open it. */
export function isSourceLink(text: string): boolean {
  try { const url = new URL(text.trim()); return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname.length > 0 && text.length <= 2_048 } catch { return false }
}

export function readFramingBlock(reply: string, letters: readonly string[]): BlockRead<CouncilFraming> {
  const block = opened(reply, COUNCIL_BLOCK_NAMES.framing)
  if (isRead(block)) return block
  const fields = fieldsOf(block, ['kind', 'headings', 'words', 'research'], ['criterion', 'angle'])
  if (typeof fields === 'string') return bad(fields)
  // Left out, the question needs none: research is asked for, never assumed.
  const [needed = 'no', ...why] = parts(fields.one.get('research') ?? 'no').map(part => part.toLowerCase() === 'yes' || part.toLowerCase() === 'no' ? part.toLowerCase() : part)
  if (needed !== 'yes' && needed !== 'no') return bad('"research" is yes or no, then | and why in a line')
  const kinds = list(fields.one.get('kind') ?? '').map(kind => kind.toLowerCase())
  if (!kinds.length || kinds.some(kind => !(COUNCIL_KINDS as readonly string[]).includes(kind)) || new Set(kinds).size !== kinds.length) {
    return bad(`"kind" must be one or two of ${COUNCIL_KINDS.join(', ')}`)
  }
  const criteria: { id: string; source: string; text: string }[] = []
  for (const value of fields.many.get('criterion') ?? []) {
    const [source = '', ...rest] = parts(value)
    if (source !== 'question' && source !== 'assumed') return bad('each "criterion" starts with question or assumed, then | and the criterion')
    criteria.push({ id: `C${criteria.length + 1}`, source, text: rest.join(' | ') })
  }
  const angles: { seat: string; text: string }[] = []
  for (const value of fields.many.get('angle') ?? []) {
    const [seat = '', ...rest] = parts(value)
    if (!letters.includes(seat) || angles.some(angle => angle.seat === seat)) return bad(`each "angle" names one of ${letters.join(', ')} once, then | and the angle`)
    angles.push({ seat, text: rest.join(' | ') })
  }
  const parsed = framingSchema.safeParse({ kinds, criteria, headings: list(fields.one.get('headings') ?? '').map(heading => heading.slice(0, 200)), words: Number(fields.one.get('words')), angles,
    research: { needed: needed === 'yes', reason: why.join(' | ') } })
  return parsed.success ? { ok: true, value: parsed.data } : bad('give "kind", one to five "criterion" lines, "headings" and "words" between 50 and 5000')
}

// Answers (each panelist).

/**
 * The kinds of evidence a claim carries: observed in the snapshot, inferred from that, judgement, or a source outside
 * it, a link and the passage it supports, quoted. Sotto checks a source's shape only; reviewers open it.
 */
export const FINDING_KINDS = ['observed', 'inferred', 'judgement', 'source'] as const
export const answerSchema = z.object({
  answer: z.string().min(1),
  findings: z.array(z.object({ id: z.string(), kind: z.enum(FINDING_KINDS), evidence: z.string().optional(), quote: z.string().min(1).optional(), claim: z.string().min(1) }).strict()).min(1).max(30),
  challenges: z.array(z.object({ criterion: z.string(), problem: z.enum(['missing', 'wrong', 'false-premise']), why: z.string() }).strict()).max(10),
}).strict()
export type CouncilAnswer = z.infer<typeof answerSchema>

/** `letter` is the panelist's own; its findings are named `<letter><n>`. `criteria` are the framing's IDs. */
export function readAnswerBlock(reply: string, letter: string, criteria: readonly string[]): BlockRead<CouncilAnswer> {
  const block = opened(reply, COUNCIL_BLOCK_NAMES.answer)
  if (isRead(block)) return block
  const fields = fieldsOf(block, ['answer'], ['finding', 'challenge'])
  if (typeof fields === 'string') return bad(fields)
  const findings: CouncilAnswer['findings'] = []
  for (const value of fields.many.get('finding') ?? []) {
    const [findingId = '', kind = '', ...rest] = parts(value)
    if (!new RegExp(`^${letter}\\d{1,3}$`, 'u').test(findingId) || findings.some(item => item.id === findingId)) return bad(`each "finding" is named ${letter}1, ${letter}2 and so on, once each`)
    if (!(FINDING_KINDS as readonly string[]).includes(kind)) return bad(`a finding is ${FINDING_KINDS.join(', ')}`)
    if (kind === 'observed') {
      const [evidence = '', ...claim] = rest
      if (evidence !== 'command' && !parseCitation(evidence)) return bad(`an observed finding gives path:lines inside the snapshot, or "command", before its claim (${findingId})`)
      findings.push({ id: findingId, kind, evidence, claim: claim.join(' | ') })
    } else if (kind === 'source') {
      const [link = '', ...more] = rest
      // The passage is quoted, so a bar inside it never splits it from the claim.
      const quoted = /^["“](.+?)["”]\s*\|\s*(.+)$/su.exec(more.join(' | '))
      if (!isSourceLink(link) || !quoted) return bad(`a source finding gives its link, then the passage it supports in quotes, then its claim (${findingId})`)
      findings.push({ id: findingId, kind, evidence: link, quote: quoted[1]!.trim(), claim: quoted[2]!.trim() })
    } else findings.push({ id: findingId, kind: kind as 'inferred' | 'judgement', claim: rest.join(' | ') })
  }
  const challenges: CouncilAnswer['challenges'] = []
  for (const value of fields.many.get('challenge') ?? []) {
    const [criterion = '', problem = '', ...why] = parts(value)
    if (!criteria.includes(criterion)) return bad(`a "challenge" names one of the criteria ${criteria.join(', ') || '(there are none)'}`)
    challenges.push({ criterion, problem: problem as 'missing', why: why.join(' | ') })
  }
  const parsed = answerSchema.safeParse({ answer: fields.one.get('answer') ?? '', findings, challenges })
  return parsed.success ? { ok: true, value: parsed.data } : bad('give "answer" in a line and at least one "finding"; a challenge\'s problem is missing, wrong or false-premise')
}

// Reviews (each panelist).

export const REVIEW_VERDICTS = ['confirmed', 'rejected', 'unchecked'] as const
export const reviewSchema = z.object({
  ranking: z.array(z.string()).optional(),
  findings: z.array(z.object({ id: z.string(), verdict: z.enum(REVIEW_VERDICTS) }).strict()).max(100),
  supports: z.string().optional(),
  added: z.array(z.object({ id: z.string(), claim: z.string().min(1) }).strict()).max(20),
  scores: z.array(z.object({ id: z.string(), score: z.number().int().min(1).max(5) }).strict()).max(100),
  favourites: z.array(z.string()).max(3),
  answer: z.enum(['same', 'changed']).optional(),
  newAnswer: z.string().optional(),
  evidence: z.array(z.string()).max(10),
}).strict()
export type CouncilReview = z.infer<typeof reviewSchema>

export interface ReviewContext {
  readonly letter: string
  /** The kind whose review this is: a question of two kinds is reviewed as its first. */
  readonly kind: CouncilKind
  /** The answers it reviews, by letter, and the finding IDs each may be referred to by; an answer whose block was unavailable has only its letter. */
  readonly reviewed: ReadonlyMap<string, readonly string[]>
}

/** What each kind of review must give (the plan's "What a review does"). */
export function reviewRules(context: ReviewContext): { ranking: boolean; findings: boolean; supports: boolean; ideas: boolean; mayChange: boolean } {
  const kind = context.kind
  return { ranking: kind === 'decision' && context.reviewed.size >= 2, findings: kind === 'review', supports: kind === 'fact', ideas: kind === 'ideas',
    mayChange: kind === 'decision' || kind === 'fact' }
}

export function readReviewBlock(reply: string, context: ReviewContext): BlockRead<CouncilReview> {
  const block = opened(reply, COUNCIL_BLOCK_NAMES.review)
  if (isRead(block)) return block
  const fields = fieldsOf(block, ['ranking', 'findings', 'supports', 'scores', 'favourites', 'answer', 'new_answer'], ['new', 'evidence'])
  if (typeof fields === 'string') return bad(fields)
  const rules = reviewRules(context)
  const letters = [...context.reviewed.keys()]
  const ids = new Set([...context.reviewed.values()].flat())
  const listed = (key: string, allowed: ReadonlySet<string>): string[] | string => {
    const values = list(fields.one.get(key) ?? '')
    if (values.some(value => !allowed.has(value)) || new Set(values).size !== values.length) return `"${key}" uses only ${[...allowed].join(', ') || 'no IDs'}, each once`
    return values
  }
  let ranking: string[] | undefined
  if (fields.one.has('ranking')) {
    const order = (fields.one.get('ranking') ?? '').split('>').map(item => item.trim()).filter(Boolean)
    if (order.length !== letters.length || new Set(order).size !== order.length || order.some(item => !letters.includes(item))) return bad(`"ranking" orders ${letters.join(', ')}, each once, with >`)
    ranking = order
  }
  if (rules.ranking && !ranking) return bad(`give "ranking" of ${letters.join(', ')}, best first, with >`)
  const findings: CouncilReview['findings'] = []
  for (const entry of list(fields.one.get('findings') ?? '')) {
    const [findingId = '', verdict = ''] = entry.split(/\s+/u)
    const said = verdict === 'refuted' ? 'rejected' : verdict
    if (!ids.has(findingId) || findings.some(item => item.id === findingId)) return bad(`"findings" names only ${[...ids].join(', ')}, each once`)
    if (!(REVIEW_VERDICTS as readonly string[]).includes(said)) return bad('each entry in "findings" is an ID then confirmed, rejected or unchecked')
    findings.push({ id: findingId, verdict: said as CouncilReview['findings'][number]['verdict'] })
  }
  if (rules.findings && ids.size > 0 && !findings.length) return bad('give "findings": each finding you reviewed, confirmed, rejected or unchecked')
  const supports = fields.one.get('supports')
  if (rules.supports && supports === undefined) return bad(`give "supports": the letter of the answer the evidence supports, ${context.letter} for your own, or none`)
  if (supports !== undefined && supports !== 'none' && !LETTER.test(supports)) return bad('"supports" is one letter or none')
  if (supports !== undefined && supports !== 'none' && supports !== context.letter && !letters.includes(supports)) return bad(`"supports" names ${[...letters, context.letter].join(', ')} or none`)
  const added: CouncilReview['added'] = []
  for (const value of fields.many.get('new') ?? []) {
    const [findingId = '', ...claim] = parts(value)
    if (!new RegExp(`^${context.letter}\\d{1,3}$`, 'u').test(findingId) || added.some(item => item.id === findingId)) return bad(`a "new" finding is named under your own letter, ${context.letter}, once`)
    added.push({ id: findingId, claim: claim.join(' | ') })
  }
  const scores: CouncilReview['scores'] = []
  for (const entry of list(fields.one.get('scores') ?? '')) {
    const [findingId = '', score = ''] = entry.split(/\s+/u)
    if (!ids.has(findingId) || scores.some(item => item.id === findingId)) return bad(`"scores" names only ${[...ids].join(', ')}, each once`)
    scores.push({ id: findingId, score: Number(score) })
  }
  const favourites = fields.one.has('favourites') ? listed('favourites', ids) : []
  if (typeof favourites === 'string') return bad(favourites)
  if (rules.ideas && (!scores.length || !favourites.length)) return bad('give "scores" for each option you reviewed and up to three "favourites"')
  const answer = fields.one.get('answer')
  if (answer !== undefined && answer !== 'same' && answer !== 'changed') return bad('"answer" is same or changed')
  if (answer === 'changed' && !rules.mayChange) return bad('an answer to this kind of question is not changed in review; leave "answer" out')
  const newAnswer = fields.one.get('new_answer'), evidence = fields.many.get('evidence') ?? []
  if (answer === 'changed' && (!newAnswer || !evidence.length)) return bad('a changed answer gives "new_answer" in a line and the "evidence" that changed it')
  if (evidence.some(item => item !== 'command' && !parseCitation(item) && !isSourceLink(item))) return bad('"evidence" is path:lines inside the snapshot, command, or a source\'s link')
  if (rules.mayChange && answer === undefined) return bad('give "answer": same, or changed')
  const parsed = reviewSchema.safeParse({ ...ranking ? { ranking } : {}, findings, ...supports !== undefined ? { supports } : {}, added, scores, favourites,
    ...answer ? { answer } : {}, ...newAnswer ? { newAnswer } : {}, evidence })
  return parsed.success ? { ok: true, value: parsed.data } : bad('a score is a whole number from 1 to 5')
}

// The crux check: the chair's plan, then a neutral panelist's result.

/**
 * The chair's crux check: a test to run in the snapshot, or a lookup of a source (`lookup`), with what each result or
 * finding would mean, written before it runs.
 */
export const cruxSchema = z.object({
  test: z.string().min(1),
  lookup: z.boolean(),
  sides: z.tuple([z.array(z.string()).min(1), z.array(z.string()).min(1)]),
  meanings: z.array(z.object({ result: z.string().min(1), meaning: z.string().min(1) }).strict()).min(2).max(4),
}).strict()
export type CouncilCrux = z.infer<typeof cruxSchema>

/** `letters` are the answers in play. */
export function readCruxBlock(reply: string, letters: readonly string[]): BlockRead<CouncilCrux> {
  const block = opened(reply, COUNCIL_BLOCK_NAMES.crux)
  if (isRead(block)) return block
  const fields = fieldsOf(block, ['test', 'lookup', 'sides'], ['if'])
  if (typeof fields === 'string') return bad(fields)
  if (fields.one.has('test') === fields.one.has('lookup')) return bad('give either "test", a command to run, or "lookup", a source to check, not both')
  const sides = (fields.one.get('sides') ?? '').split('|').map(list)
  if (sides.length !== 2 || sides.flat().some(letter => !letters.includes(letter)) || new Set(sides.flat()).size !== sides.flat().length) {
    return bad(`"sides" gives the letters on each side, from ${letters.join(', ')}, separated by |`)
  }
  const meanings: CouncilCrux['meanings'] = []
  for (const value of fields.many.get('if') ?? []) {
    const [result = '', meaning = ''] = value.split('=>').map(part => part.trim())
    meanings.push({ result, meaning })
  }
  const parsed = cruxSchema.safeParse({ test: fields.one.get('test') ?? fields.one.get('lookup') ?? '', lookup: fields.one.has('lookup'), sides, meanings })
  return parsed.success ? { ok: true, value: parsed.data } : bad('give "test" or "lookup", "sides", and two to four "if" lines: a result => what it would mean')
}

export const cruxResultSchema = z.object({ result: z.string().min(1), outcome: z.union([z.number().int().min(1).max(4), z.literal('inconclusive')]) }).strict()
export type CouncilCruxResult = z.infer<typeof cruxResultSchema>
export function readCruxResultBlock(reply: string, meanings: number): BlockRead<CouncilCruxResult> {
  const block = opened(reply, COUNCIL_BLOCK_NAMES.cruxResult)
  if (isRead(block)) return block
  const fields = fieldsOf(block, ['result', 'outcome'], [])
  if (typeof fields === 'string') return bad(fields)
  const said = fields.one.get('outcome') ?? ''
  const outcome = said === 'inconclusive' ? said : Number(said)
  if (outcome !== 'inconclusive' && !(Number.isInteger(outcome) && outcome >= 1 && outcome <= meanings)) return bad(`"outcome" is the number of the result that came out, 1 to ${meanings}, or inconclusive`)
  const parsed = cruxResultSchema.safeParse({ result: fields.one.get('result') ?? '', outcome })
  return parsed.success ? { ok: true, value: parsed.data } : bad('give "result" in a line and "outcome"')
}

// The fairness check (each panelist), and the chair's answer to its objections.

export const fairnessSchema = z.object({ fair: z.boolean(), claim: z.string().min(1).optional(), passage: z.string().min(1).optional() }).strict()
export type CouncilFairness = z.infer<typeof fairnessSchema>
const unquoted = (text: string): string => text.trim().replace(/^["“'‘«]+|["”'’»]+$/gu, '').trim()
/** Whether the verdict holds a passage, whitespace and case aside, so an objection can stay attached to it. */
export function verdictHolds(verdict: string, passage: string): boolean {
  const said = normal(passage).toLowerCase()
  return said.length > 0 && normal(verdict).toLowerCase().includes(said)
}
export function readFairnessBlock(reply: string, verdict: string): BlockRead<CouncilFairness> {
  const block = opened(reply, COUNCIL_BLOCK_NAMES.fairness)
  if (isRead(block)) return block
  const fields = fieldsOf(block, ['fair', 'claim', 'passage'], [])
  if (typeof fields === 'string') return bad(fields)
  const fair = (fields.one.get('fair') ?? '').toLowerCase()
  if (fair !== 'yes' && fair !== 'no') return bad('"fair" is yes or no')
  if (fair === 'yes') return { ok: true, value: { fair: true } }
  const claim = unquoted(fields.one.get('claim') ?? ''), passage = unquoted(fields.one.get('passage') ?? '')
  if (!claim || !passage) return bad('an unfair answer quotes your own "claim" and the verdict "passage" that misstates it')
  if (!verdictHolds(verdict, passage)) return bad('"passage" must quote the verdict exactly as it is written')
  return { ok: true, value: fairnessSchema.parse({ fair: false, claim, passage }) }
}

export const amendSchema = z.object({
  objections: z.array(z.object({ seat: z.string(), answer: z.enum(['amended', 'stands']), reason: z.string().optional() }).strict()).min(1).max(5),
}).strict()
export type CouncilAmend = z.infer<typeof amendSchema>
/** `seats` are the letters whose objections the chair was sent. */
export function readAmendBlock(reply: string, seats: readonly string[]): BlockRead<CouncilAmend> {
  const block = opened(reply, COUNCIL_BLOCK_NAMES.amend)
  if (isRead(block)) return block
  const fields = fieldsOf(block, [], ['objection'])
  if (typeof fields === 'string') return bad(fields)
  const objections: CouncilAmend['objections'] = []
  for (const value of fields.many.get('objection') ?? []) {
    const [seat = '', answer = '', ...reason] = parts(value)
    if (!seats.includes(seat) || objections.some(item => item.seat === seat)) return bad(`each "objection" names one of ${seats.join(', ')} once`)
    if (answer !== 'amended' && answer !== 'stands') return bad('each objection is amended or stands')
    objections.push({ seat, answer, ...reason.length ? { reason: reason.join(' | ') } : {} })
  }
  if (objections.length !== seats.length) return bad(`answer every objection: ${seats.join(', ')}`)
  return amendSchema.safeParse({ objections }).success ? { ok: true, value: { objections } } : bad('answer every objection')
}
